# Custom speech: product names the base model mishears

A support line's recordings use product names the base speech model has never seen. It hears them as near words: "Tessaline" becomes "Miteseline" and "Quorvex" becomes "Corvex". A **custom speech** model adapts the base model with your own data. One model then serves both kinds of call:

| Calls | How they reach the custom model |
|---|---|
| Stored recordings | Batch transcription, with the custom model named in the request. It needs no endpoint. |
| Live calls | Real-time recognition through a **deployed endpoint**: set `endpoint_id` on the Speech SDK config. |

This answers a common exam question. You have audio samples, reference transcripts and a vocabulary problem, and you need better accuracy for live and stored calls. The answer is the **Custom speech** project type. Real-time and batch speech to text only choose how audio reaches a model. Custom voice is for text to speech.

```sh
source .venv/bin/activate
pip install -r examples/custom-speech/requirements.txt
python examples/custom-speech/custom_speech.py all      # data, train, test, deploy, live
python examples/custom-speech/custom_speech.py delete   # remove what it made in Azure
```

| Step | What it does |
|---|---|
| `data` | Writes 70 training sentences that use five invented product names. Synthesises 8 test calls with different US voices, as 16 kHz mono WAV, with `trans.txt` (the reference transcripts) in a zip. The files go to `generated/custom-speech/`. |
| `train` | Uploads the text as a **Language** dataset and the calls as an **Acoustic** dataset (audio plus transcripts), using block upload. Then it adapts the newest en-US base model with the text. |
| `test` | Runs an **evaluation**: both models transcribe the test calls in batch, and each is scored against the reference transcripts as a word error rate. |
| `deploy` | Creates an **endpoint** for the custom model, for live calls. |
| `live` | Recognises each call as a live stream three ways: the base model, the base model with a **phrase list** (no training), and the custom endpoint. |
| `delete` | Deletes the endpoint, evaluation, model and both datasets. |

## What has run (5 November 2026)

- **`data`:** done. **`live`** without a custom model: the base model heard 1 of the 10 product names right, and the phrase list heard 8. The two misses were "Kestermine" and "corvex".
- **`train`, `test` and `deploy`:** not yet run. The lab's Speech resource is on the free **F0** tier, which refuses custom speech ("Principal does not have access to API/Operation", even with Speech Contributor). The S0 AI Services account accepts it. To use that account, add `CUSTOM_SPEECH_RESOURCE_ID=<its resource id>` and `CUSTOM_SPEECH_REGION` to `.env`. On S0, training is billed at £7.52 per compute hour, an endpoint at £0.04 an hour while it exists, and recognition at £0.90 per audio hour.

## Kinds of training data

| Data | Fixes | Here |
|---|---|---|
| Plain text (Language): sentences as people say them | Vocabulary: product names, codes, jargon | Trained on |
| Structured text (LanguageMarkdown): patterns with lists | Vocabulary in many combinations, such as `{product} {part}` | Not used |
| Audio with human transcripts (Acoustic) | Accents, line noise, microphones. This is what real support calls need for regional accents. | Used to **test** only. Training on it costs compute time, and testing on what you trained on proves nothing. |
| Pronunciation | How a word is said, when its spelling misleads | Not used |
| Output formatting | How it is written, such as "QX 220" as "QX-220" | Not used |

A **phrase list** is the quick alternative. You pass the words with each request, with no training and no endpoint. It boosts those words for that one recognition, and it only works with real-time recognition. Use it for a short, changing list such as today's customer names. Use custom speech for a lasting vocabulary, for accents, and when stored recordings need the same fix.

## Signing in and roles

There is no key: Entra sign-in with `az login`. REST calls go to the resource's own subdomain with a bearer token. The Speech SDK takes `aad#<resource id>#<token>`.

- **Cognitive Services Speech User** can transcribe, including with a custom endpoint.
- **Cognitive Services Speech Contributor** is needed to create datasets, models, evaluations and endpoints, on a paid (S0) resource. F0 refuses them. Owner alone does not grant it, because these are data actions.

To grant yourself the contributor role on the lab's Speech resource:

```sh
az role assignment create --assignee "$(az ad signed-in-user show --query id -o tsv)" \
  --role "Cognitive Services Speech Contributor" --scope "$(grep ^AZURE_SPEECH_RESOURCE_ID= .env | cut -d= -f2-)"
```

The azd template (`infra/`) grants it already.

## Notes

- **Releasing the synthesiser.** The Speech SDK finishes writing a WAV file only when the synthesiser is released. Reading the file before that crashed the process (a segmentation fault), so `data` releases each synthesiser first.
- **Synthetic audio.** The test calls are synthetic, so they are cleaner than real calls, and the voices are US voices, not real regional accents. With real recordings, the same steps apply. Put your audio and transcripts in an Acoustic dataset, use some of it to train and keep the rest to test.
