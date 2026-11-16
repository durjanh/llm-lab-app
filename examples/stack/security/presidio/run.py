"""Microsoft Presidio (Analyzer + Anonymizer) run locally with a spaCy model, on the shared PII set.

Names come from spaCy's NER; emails, cards and phones from Presidio's pattern recognisers. UK postcodes and NI numbers
get explicit recognisers here, because the built-in set is US-centred and the NI recogniser rejects prefixes (like the
invented QQ) that the test data uses. PASS needs 90% of entities found and no core PII left in the anonymised text.
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1]))
sys.path.insert(0, str(HERE.parent))
from common import checks  # noqa: E402
import shared  # noqa: E402

NAME = "security/presidio"
MODEL = "en_core_web_lg"


def build():
    from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer
    from presidio_analyzer.nlp_engine import NlpEngineProvider

    nlp = NlpEngineProvider(nlp_configuration={
        "nlp_engine_name": "spacy", "models": [{"lang_code": "en", "model_name": MODEL}]}).create_engine()
    engine = AnalyzerEngine(nlp_engine=nlp, supported_languages=["en"])
    engine.registry.add_recognizer(PatternRecognizer(
        supported_entity="UK_POSTCODE_X",
        patterns=[Pattern("uk postcode", r"\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b", 0.6)]))
    engine.registry.add_recognizer(PatternRecognizer(
        supported_entity="UK_NINO_X",
        patterns=[Pattern("ni number", r"\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b", 0.7)]))
    engine.registry.add_recognizer(PatternRecognizer(
        supported_entity="UK_PHONE_X",  # the built-in phone check rejects Ofcom's invented drama numbers
        patterns=[Pattern("uk phone", r"(?<!\w)(?:\+44\s?\d{3,4}|\(?0\d{2,4}\)?)[\s-]?\d{3,4}[\s-]?\d{3,4}\b", 0.6)]))
    return engine


# Only the entity types this task is about. Presidio also finds dates, places and organisations: noise here.
ENTITIES = ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "CREDIT_CARD", "UK_POSTCODE_X", "UK_NINO_X", "UK_PHONE_X"]


def main() -> None:
    from presidio_analyzer.nlp_engine import NlpEngineProvider  # noqa: F401  (import check)
    try:
        engine = build()
    except OSError:
        return checks.skip(NAME, f"spaCy model missing: .venv/bin/python -m spacy download {MODEL}")
    from presidio_anonymizer import AnonymizerEngine

    anonymizer = AnonymizerEngine()
    results = {}
    for case in shared.PII_CASES:
        found = engine.analyze(text=case.text, language="en", entities=ENTITIES, score_threshold=0.4)
        spans = [case.text[r.start:r.end] for r in found]
        results[case.id] = (spans, anonymizer.anonymize(text=case.text, analyzer_results=found).text)
    score = shared.pii_score(results)
    print(f"  entities found {score.found}/{score.total} ({score.recall:.0%}); missed {score.missed}")
    print(f"  core values left after anonymising: {score.core_left}; false alarms on clean texts: {score.false_alarms}")
    print("  example:", results["p8"][1])
    ok = score.recall >= 0.9 and score.core_left == 0
    checks.report(NAME, ok, f"{score.found}/{score.total} PII entities found ({score.recall:.0%}), "
                            f"{score.core_left} core values left, {score.false_alarms} false alarms on 4 clean texts")


if __name__ == "__main__":
    main()
