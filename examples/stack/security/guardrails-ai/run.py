"""Guardrails AI: input validation with custom validators, and output validation against a schema.

The Guardrails Hub (hub://guardrails/detect_pii, detect_jailbreak, unusual_prompt) is where the ready-made validators
live. Installing one needs the hub API and a GUARDRAILS_TOKEN; this run tries the hub, and if it cannot be reached or
no token is set it SKIPS that part and uses validators written here with `@register_validator`:
  - PiiPresidio: PII found with Presidio (what the hub's DetectPII wraps), on a fail the text is fixed by anonymising
  - JailbreakPatterns: a pattern heuristic over well-known jailbreak phrases (a baseline, not a model)
Output validation checks a structured answer against a Pydantic schema, and runs the PII validator on its fields.
No model calls, so this costs nothing.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
sys.path.insert(0, str(HERE.parent))
from common import checks, config  # noqa: E402
import shared  # noqa: E402

NAME = "security/guardrails-ai"
SPACY = "en_core_web_sm"
ENTITIES = ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD", "UK_POSTCODE", "UK_NINO", "UK_PHONE"]
JAILBREAK = [
    r"ignore (all )?(your |the )?(previous|prior|above)? ?(instructions|rules|guidelines)",
    r"disregard (your|the|all)?\s?(guidelines|instructions|rules|above|restrictions)?",
    r"forget (everything|all|the above)",
    r"\bDAN\b", r"no (rules|restrictions|safety)", r"developer mode|system override|debug mode",
    r"(reveal|print|output|show).{0,40}(system (prompt|message)|hidden instructions|configuration|instructions you were)",
    r"(bypass|disable).{0,30}(restrictions|filters|safety)",
    r"new instructions|jailbreak|stay in character", r"you are now",
]


def analyzer():
    from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer
    from presidio_analyzer.nlp_engine import NlpEngineProvider

    nlp = NlpEngineProvider(nlp_configuration={"nlp_engine_name": "spacy", "models": [
        {"lang_code": "en", "model_name": SPACY}]}).create_engine()
    engine = AnalyzerEngine(nlp_engine=nlp, supported_languages=["en"])
    for entity, regex in (("UK_POSTCODE", r"\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b"),
                          ("UK_NINO", r"\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b"),
                          ("UK_PHONE", r"(?<!\w)(?:\+44\s?\d{3,4}|\(?0\d{2,4}\)?)[\s-]?\d{3,4}[\s-]?\d{3,4}\b")):
        engine.registry.add_recognizer(PatternRecognizer(supported_entity=entity, patterns=[Pattern(entity, regex, 0.6)]))
    return engine


def try_hub() -> str:
    """Try to install the hub's DetectPII. Returns "" on success, or the reason it could not be used."""
    if not config.env("GUARDRAILS_TOKEN"):
        return "no GUARDRAILS_TOKEN (get one at hub.guardrailsai.com/keys, then `guardrails configure --token ...`)"
    try:
        out = subprocess.run([str(HERE / ".venv/bin/guardrails"), "hub", "install", "hub://guardrails/detect_pii",
                              "--no-install-local-models"], capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return "the hub install timed out"
    return "" if out.returncode == 0 else "the hub could not be reached or refused the install"


def main() -> None:
    from guardrails import Guard, OnFailAction
    from guardrails.settings import settings
    from guardrails.validators import FailResult, PassResult, Validator, register_validator

    settings.rc.enable_metrics = False
    try:
        engine = analyzer()
    except OSError:
        return checks.skip(NAME, f"spaCy model missing: .venv/bin/python -m spacy download {SPACY}")
    from presidio_anonymizer import AnonymizerEngine

    anonymizer = AnonymizerEngine()
    hub = try_hub()
    print(f"  hub DetectPII: SKIPPED, {hub}" if hub else "  hub DetectPII installed")

    @register_validator(name="stack/pii-presidio", data_type="string")
    class PiiPresidio(Validator):
        """Fails when Presidio finds personal data, and offers the anonymised text as the fix."""

        def validate(self, value, metadata):
            found = engine.analyze(text=value, language="en", entities=ENTITIES, score_threshold=0.4)
            if not found:
                return PassResult()
            return FailResult(error_message="contains personal data: " + ", ".join(sorted({r.entity_type for r in found})),
                              fix_value=anonymizer.anonymize(text=value, analyzer_results=found).text)

    @register_validator(name="stack/jailbreak-patterns", data_type="string")
    class JailbreakPatterns(Validator):
        """Fails when the text matches a known jailbreak phrase."""

        def validate(self, value, metadata):
            hit = next((p for p in JAILBREAK if re.search(p, value, re.I)), None)
            return FailResult(error_message=f"jailbreak pattern: {hit}") if hit else PassResult()

    jail_guard = Guard().use(JailbreakPatterns(on_fail=OnFailAction.NOOP))
    pii_guard = Guard().use(PiiPresidio(on_fail=OnFailAction.FIX))

    def classify(prompt: str, document: str) -> bool:
        text = prompt if not document else f"{prompt}\n\n{document}"
        return not jail_guard.validate(text).validation_passed

    scores, notes = shared.evaluate_injection(classify)
    for n in notes:
        print(" ", n)

    results = {}
    for case in shared.PII_CASES:
        out = pii_guard.validate(case.text)
        anon = out.validated_output or case.text
        found = engine.analyze(text=case.text, language="en", entities=ENTITIES, score_threshold=0.4)
        results[case.id] = ([case.text[r.start:r.end] for r in found], anon)
    pii = shared.pii_score(results)
    print(f"  PII validator: {pii.found}/{pii.total} found, {pii.core_left} core left, {pii.false_alarms} false alarms")

    # Output validation: a structured answer checked against a schema, with PII caught in a free-text field.
    from pydantic import BaseModel, Field

    class Answer(BaseModel):
        answer: str = Field(validators=[PiiPresidio(on_fail=OnFailAction.FIX)])
        section: str
        confidence: float = Field(ge=0, le=1)

    schema_guard = Guard.for_pydantic(Answer)
    good = json.dumps({"answer": "Up to five days can be carried over.", "section": "Annual leave", "confidence": 0.9})
    bad_range = json.dumps({"answer": "Five days.", "section": "Annual leave", "confidence": 7})
    leaky = json.dumps({"answer": "Ask Margaret Bell on m.bell@example.com.", "section": "Annual leave", "confidence": 0.5})
    ok_good = schema_guard.parse(good).validation_passed
    ok_bad = not schema_guard.parse(bad_range).validation_passed
    fixed = schema_guard.parse(leaky).validated_output or {}
    ok_leak = "m.bell@example.com" not in json.dumps(fixed)
    print(f"  schema: valid accepted={ok_good}, out-of-range rejected={ok_bad}, PII in field redacted={ok_leak}")

    ok = scores["detection"] >= 0.8 and scores["false_positive"] <= 0.1 and ok_good and ok_bad and ok_leak
    skipped = " (hub validators skipped: " + ("no token" if "TOKEN" in hub else "hub unreachable") + ")" if hub else ""
    checks.report(NAME, ok, f"{shared.fmt(scores)} (custom pattern validator); PII {pii.found}/{pii.total} found; "
                            f"schema checks {sum([ok_good, ok_bad, ok_leak])}/3{skipped}")


if __name__ == "__main__":
    main()
