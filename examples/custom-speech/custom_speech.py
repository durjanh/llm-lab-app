"""Custom speech: teach Azure Speech a support line's product names, then use the model for stored and live calls.

The base model hears invented product names as near words ("Tessaline" becomes "Miteseline"). A custom speech
model adapts the base model with your own data. Here that is text (sentences that use the names), which fixes
vocabulary. Audio with reference transcripts, the other kind of training data, adapts it to accents and line noise.

    python examples/custom-speech/custom_speech.py data     # training text, and test calls synthesised with US voices
    python examples/custom-speech/custom_speech.py train    # upload both datasets, adapt the newest base model
    python examples/custom-speech/custom_speech.py test     # word error rate, base against custom, on the test calls
    python examples/custom-speech/custom_speech.py deploy   # an endpoint, so live calls can use the model
    python examples/custom-speech/custom_speech.py live     # each call through base, base + phrase list, and custom
    python examples/custom-speech/custom_speech.py delete   # remove the endpoint, evaluation, model and datasets
    python examples/custom-speech/custom_speech.py all      # data, train, test, deploy, live (about 30 minutes)

Stored recordings need no endpoint: batch transcription takes the custom model directly (the test step does
exactly that, for both models). Live recognition needs a deployed endpoint, which is billed per hour on S0.

Reads AZURE_SPEECH_RESOURCE_ID and AZURE_SPEECH_REGION from the lab's .env and signs in with az login: no key.
Training and deploying need Cognitive Services Speech Contributor on the resource, and a paid (S0) tier: a free
(F0) Speech resource refuses custom speech. CUSTOM_SPEECH_RESOURCE_ID and CUSTOM_SPEECH_REGION point it at
another account, such as the lab's AI Services account.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import zipfile
from pathlib import Path

import httpx
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
LAB = HERE.parents[1]
load_dotenv(LAB / ".env")
WORK = LAB / "generated" / "custom-speech"
STATE = WORK / "state.json"
API = "2025-10-15"
LOCALE = "en-US"
NAME = "lab-custom-speech"

PRODUCTS = ["Tessaline", "Quorvex", "Brindlewave", "Vellacor", "Kestramine"]
WHAT = {"Tessaline": "router", "Quorvex": "filter cartridge", "Brindlewave": "hub", "Vellacor": "sensor",
        "Kestramine": "pump"}

# Training text: how callers and agents use the names. One utterance per line, as people say it.
TRAIN_TEMPLATES = [
    "My {p} {w} stopped working this morning.", "I need a replacement {p} {w}.", "Is the {p} still under warranty?",
    "How do I reset the {p} {w}?", "The {p} is showing an error light.", "I bought a {p} {w} last month.",
    "Can you check the order for my {p}?", "The {p} {w} is making a strange noise.", "Do you sell parts for the {p}?",
    "I'd like to return the {p} {w}.", "The new {p} firmware will not install.", "Which {p} fits my model?",
    "{p}", "{p} {w}",
]

# Test calls: different sentences from the training text, so the score is not just memory.
TEST_CALLS = [
    ("en-US-AvaNeural", "My Tessaline router keeps dropping the connection since the update."),
    ("en-US-AndrewNeural", "I ordered a Quorvex filter cartridge but got the wrong size."),
    ("en-US-EmmaNeural", "The Brindlewave hub shows a red light after I reset it."),
    ("en-US-BrianNeural", "Can you send a replacement Vellacor sensor for unit seven?"),
    ("en-US-JennyNeural", "The Kestramine pump is making a grinding noise."),
    ("en-US-GuyNeural", "Both the Vellacor and the Tessaline stopped after the power cut."),
    ("en-US-AriaNeural", "I want to know if the Quorvex works with the Brindlewave."),
    ("en-US-DavisNeural", "We have three Kestramine units on site and one of them leaks."),
]


# ----- signing in -----

def resource() -> tuple[str, str, str]:
    """The Speech resource id, its region, and its own endpoint (the custom subdomain Entra sign-in needs)."""
    # CUSTOM_SPEECH_RESOURCE_ID picks another account, such as an S0 AI Services account: a free (F0) Speech
    # resource transcribes, but refuses custom speech.
    rid = os.environ.get("CUSTOM_SPEECH_RESOURCE_ID") or os.environ.get("AZURE_SPEECH_RESOURCE_ID", "")
    region = os.environ.get("CUSTOM_SPEECH_REGION") or os.environ.get("AZURE_SPEECH_REGION", "")
    if not rid or not region:
        sys.exit("Set AZURE_SPEECH_RESOURCE_ID and AZURE_SPEECH_REGION in the lab's .env, and run az login.")
    return rid, region, f"https://{rid.rstrip('/').rsplit('/', 1)[-1]}.cognitiveservices.azure.com"


CREDENTIAL = DefaultAzureCredential()


def entra_token() -> str:
    return CREDENTIAL.get_token("https://cognitiveservices.azure.com/.default").token


def sdk_config(**settings):
    """A Speech SDK config signed in with Entra: the token in the form Speech expects, aad#<resource id>#<token>."""
    import azure.cognitiveservices.speech as sp
    rid, region, _ = resource()
    cfg = sp.SpeechConfig(auth_token=f"aad#{rid}#{entra_token()}", region=region)
    for key, value in settings.items():
        setattr(cfg, key, value)
    return cfg


class SpeechApi:
    """The speech-to-text REST API: datasets, models, evaluations and endpoints."""

    def __init__(self) -> None:
        self.base = f"{resource()[2]}/speechtotext"

    def call(self, method: str, url: str, **kw) -> dict:
        url = url if url.startswith("http") else f"{self.base}/{url}"
        params = {} if "api-version=" in url else {"api-version": API}
        headers = {"Authorization": f"Bearer {entra_token()}", **kw.pop("headers", {})}
        r = httpx.request(method, url, params=params, headers=headers, timeout=120, **kw)
        if r.status_code in (401, 403) and "PermissionDenied" in r.text:
            sys.exit(f"Azure refused: {r.json()['error']['message']}\n"
                     "Either your account lacks Cognitive Services Speech Contributor (Speech User can only transcribe),\n"
                     "or the resource is on the free F0 tier, which refuses custom speech. For the second, point\n"
                     "CUSTOM_SPEECH_RESOURCE_ID at an S0 Speech or AI Services account. See the README.")
        if r.status_code >= 400:
            sys.exit(f"{method} {url} failed ({r.status_code}): {r.text[:500]}")
        return r.json() if r.content else {}

    def wait(self, entity: dict, what: str) -> dict:
        """Poll a dataset, model, evaluation or endpoint until it has finished."""
        started = time.monotonic()
        while entity.get("status") in ("NotStarted", "Running", None):
            print(f"\r  {what}: {entity.get('status', 'starting')} ({time.monotonic() - started:.0f}s)", end="", flush=True)
            time.sleep(15)
            entity = self.call("GET", entity["self"])
        print(f"\r  {what}: {entity['status']} ({time.monotonic() - started:.0f}s)          ")
        if entity["status"] != "Succeeded":
            sys.exit(f"  {json.dumps(entity.get('properties', {}).get('error', entity), indent=1)}")
        return entity

    def upload(self, kind: str, path: Path, description: str) -> dict:
        """A dataset from a local file: create it, upload the file in blocks, commit, wait for processing."""
        ds = self.call("POST", "datasets", json={"displayName": f"{NAME} {kind.lower()}", "description": description,
                                                 "locale": LOCALE, "kind": kind})
        data, ids = path.read_bytes(), []
        for n, start in enumerate(range(0, len(data), 4 * 1024 * 1024)):
            block = base64.b64encode(f"block-{n:05d}".encode()).decode()
            r = httpx.put(ds["links"]["uploadBlocks"], params={"blockid": block},
                          headers={"Authorization": f"Bearer {entra_token()}", "Content-Type": "application/octet-stream"},
                          content=data[start:start + 4 * 1024 * 1024], timeout=300)
            r.raise_for_status()
            ids.append({"kind": "Latest", "id": block})
        self.call("POST", ds["links"]["commitBlocks"], json=ids)
        return self.wait(self.call("GET", ds["self"]), f"{kind} dataset")


def load_state() -> dict:
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save_state(**values) -> None:
    STATE.write_text(json.dumps({**load_state(), **values}, indent=1))


# ----- the steps -----

def make_data(_args=None) -> None:
    """Training text from the templates, and test calls synthesised with several US voices, with their transcripts."""
    import azure.cognitiveservices.speech as sp
    WORK.mkdir(parents=True, exist_ok=True)
    lines = [t.format(p=p, w=WHAT[p]) for p in PRODUCTS for t in TRAIN_TEMPLATES]
    (WORK / "training.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  training.txt: {len(lines)} sentences using {len(PRODUCTS)} product names")
    calls = WORK / "calls"
    calls.mkdir(exist_ok=True)
    rows = []
    for i, (voice, text) in enumerate(TEST_CALLS, 1):
        wav = calls / f"call{i:02d}.wav"
        if not wav.exists():
            cfg = sdk_config(speech_synthesis_voice_name=voice)
            cfg.set_speech_synthesis_output_format(sp.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm)
            synth = sp.SpeechSynthesizer(speech_config=cfg, audio_config=sp.audio.AudioOutputConfig(filename=str(wav)))
            result = synth.speak_text_async(text).get()
            del synth  # the file is finished only once the synthesiser is released; reading it earlier crashes the SDK
            if result.reason != sp.ResultReason.SynthesizingAudioCompleted:
                sys.exit(f"Synthesis failed: {result.cancellation_details.error_details}")
        rows.append(f"{wav.name}\t{text}")
    (calls / "trans.txt").write_text("\n".join(rows) + "\n", encoding="utf-8")
    with zipfile.ZipFile(WORK / "test-calls.zip", "w") as z:  # an Acoustic dataset: audio plus a transcript per file
        for f in sorted(calls.iterdir()):
            z.write(f, f.name)
    print(f"  test-calls.zip: {len(TEST_CALLS)} calls (16 kHz mono WAV) and trans.txt, the reference transcripts")


def newest_base_model(api: SpeechApi) -> dict:
    models = []
    url = f"models/base?filter=locale%20eq%20'{LOCALE}'"
    while url:
        page = api.call("GET", url)
        models += page.get("values", [])
        url = page.get("@nextLink")
    adaptable = [m for m in models if "Language" in m.get("properties", {}).get("features", {}).get("supportsAdaptationsWith", [])]
    return max(adaptable, key=lambda m: m["createdDateTime"])


def train(_args=None) -> None:
    """Upload the training text and the test calls, then adapt the newest base model with the text."""
    if not (WORK / "training.txt").exists():
        make_data()
    api, state = SpeechApi(), load_state()
    if "language" not in state:
        save_state(language=api.upload("Language", WORK / "training.txt", "Support-line sentences using product names")["self"])
    if "acoustic" not in state:
        save_state(acoustic=api.upload("Acoustic", WORK / "test-calls.zip", "Test calls with reference transcripts")["self"])
    state = load_state()
    if "model" not in state:
        base = newest_base_model(api)
        print(f"  base model: {base['displayName']} ({base['createdDateTime'][:10]})")
        model = api.call("POST", "models", json={"displayName": NAME, "locale": LOCALE, "baseModel": {"self": base["self"]},
                                                 "datasets": [{"self": state["language"]}],
                                                 "description": "Base model adapted with the product names"})
        save_state(base=base["self"], model=model["self"])
        state = load_state()
    api.wait(api.call("GET", state["model"]), "custom model training")


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def test(_args=None) -> None:
    """An evaluation: both models transcribe the test calls (in batch, as stored recordings), scored against the
    reference transcripts. No endpoint is needed for this."""
    api, state = SpeechApi(), load_state()
    if "model" not in state:
        sys.exit("Train a model first: custom_speech.py train")
    if "evaluation" not in state:
        ev = api.call("POST", "evaluations", json={"displayName": NAME, "locale": LOCALE, "model1": {"self": state["base"]},
                                                    "model2": {"self": state["model"]}, "dataset": {"self": state["acoustic"]}})
        save_state(evaluation=ev["self"])
    ev = api.wait(api.call("GET", load_state()["evaluation"]), "evaluation, base against custom")
    p = ev["properties"]
    print(f"\n  word error rate      base {p['wordErrorRate1']:5.1f}%   custom {p['wordErrorRate2']:5.1f}%")
    print(f"  sentences with errors base {p['sentenceErrorRate1']:5.1f}%   custom {p['sentenceErrorRate2']:5.1f}%")
    print(f"  substitutions        base {p['wordSubstitutionCount1']:5d}    custom {p['wordSubstitutionCount2']:5d}")
    files = api.call("GET", ev["links"]["files"]).get("values", [])
    details = [f for f in files if f.get("kind") == "EvaluationDetails"]
    if details:
        report = httpx.get(details[0]["links"]["contentUrl"], timeout=60).json()
        shown = 0
        for item in report.get("details", report if isinstance(report, list) else []):
            ref = item.get("reference") or item.get("referenceText") or ""
            heard = [item.get(k) for k in ("recognized1", "recognizedText1", "recognized2", "recognizedText2") if item.get(k)]
            if ref and len(heard) == 2 and shown < 4:
                print(f"\n  said:   {ref}\n  base:   {heard[0]}\n  custom: {heard[1]}")
                shown += 1
        if not shown:
            print(f"\n  per-call details: {details[0]['links']['contentUrl'][:80]}... (fields: {list(report)[:6]})")


def deploy(_args=None) -> None:
    """An endpoint for the custom model: what real-time recognition (live calls) connects to."""
    api, state = SpeechApi(), load_state()
    if "model" not in state:
        sys.exit("Train a model first: custom_speech.py train")
    if "endpoint" not in state:
        ep = api.call("POST", "endpoints", json={"displayName": NAME, "locale": LOCALE, "model": {"self": state["model"]},
                                                  "properties": {"loggingEnabled": False}})
        save_state(endpoint=ep["self"])
    ep = api.wait(api.call("GET", load_state()["endpoint"]), "endpoint deployment")
    print(f"  endpoint id {ep['self'].split('/')[-1].split('?')[0]}: set SpeechConfig.endpoint_id to it")


def live(_args=None) -> None:
    """Each test call recognised as a live stream three ways: the base model, the base model with a phrase list
    (no training), and the custom model's endpoint."""
    import azure.cognitiveservices.speech as sp
    state = load_state()
    endpoint_id = state.get("endpoint", "").split("/")[-1].split("?")[0]

    def recognise(wav: Path, how: str) -> str:
        cfg = sdk_config(speech_recognition_language=LOCALE)
        if how == "custom":
            cfg.endpoint_id = endpoint_id
        rec = sp.SpeechRecognizer(speech_config=cfg, audio_config=sp.audio.AudioConfig(filename=str(wav)))
        if how == "phrases":
            phrases = sp.PhraseListGrammar.from_recognizer(rec)
            for p in PRODUCTS:
                phrases.addPhrase(p)
        text = rec.recognize_once().text
        del rec
        return text

    ways = ["base", "phrases"] + (["custom"] if endpoint_id else [])
    if not endpoint_id:
        print("  No endpoint yet (custom_speech.py deploy), so only base and phrase list.")
    hits = {w: 0 for w in ways}
    for i, (_, said) in enumerate(TEST_CALLS, 1):
        print(f"\n  said:    {said}")
        for w in ways:
            heard = recognise(WORK / "calls" / f"call{i:02d}.wav", w)
            right = [p for p in PRODUCTS if p.lower() in words(said) and p.lower() in words(heard)]
            hits[w] += len(right)
            print(f"  {w + ':':9}{heard}")
    total = sum(1 for _, said in TEST_CALLS for p in PRODUCTS if p.lower() in words(said))
    print("\n  product names heard right: " + ", ".join(f"{w} {hits[w]}/{total}" for w in ways))


def delete(_args=None) -> None:
    """Everything the example made in Azure, newest first. The local files in generated/ stay."""
    api, state = SpeechApi(), load_state()
    for key in ("endpoint", "evaluation", "model", "language", "acoustic"):
        if key in state:
            r = httpx.delete(state[key], headers={"Authorization": f"Bearer {entra_token()}"}, timeout=60)
            print(f"  {key}: {'deleted' if r.status_code in (200, 204, 404) else f'HTTP {r.status_code} {r.text[:200]}'}")
    if STATE.exists():
        STATE.unlink()


STEPS = {"data": make_data, "train": train, "test": test, "deploy": deploy, "live": live, "delete": delete}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("step", choices=[*STEPS, "all"])
    args = ap.parse_args()
    resource()
    for name in (["data", "train", "test", "deploy", "live"] if args.step == "all" else [args.step]):
        print(f"\n== {name} ==")
        STEPS[name](args)


if __name__ == "__main__":
    main()
