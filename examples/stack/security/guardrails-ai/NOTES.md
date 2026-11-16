# Guardrails AI

An open-source framework (`guardrails-ai`) that wraps validators around inputs and outputs. A `Guard` runs validators and applies an on-fail action (fix, reask, filter, exception, noop). Ready-made validators live on the Guardrails Hub.

## What ran and what was skipped
- **Skipped: the Hub validators** (`detect_pii`, `detect_jailbreak`, `unusual_prompt`). `guardrails hub install` needs a `GUARDRAILS_TOKEN` (free, from hub.guardrailsai.com/keys), and on this machine `hub.api.guardrailsai.com` did not resolve at all. `run.py` tries the install when a token is set and says why it skipped otherwise.
- **Ran: two custom validators** written with `@register_validator`. `PiiPresidio` wraps Presidio (the engine the hub's DetectPII uses) and fixes the text by anonymising it. `JailbreakPatterns` is a list of regexes for well-known jailbreak phrases. It is a baseline, not a model, and the patterns were written knowing the attack set, so 92% is optimistic. It missed d7 (a translation-task injection).
- **Ran: output validation.** A Pydantic `Answer` schema (answer, section, confidence between 0 and 1) with the PII validator on the answer field, through `Guard.for_pydantic(...).parse(...)`. A valid answer passes, a confidence of 7 is rejected, and an email and name inside the answer field are redacted. No model call is needed for this.

## Limits
- Telemetry is on by default; `run.py` turns it off in code (`settings.rc.enable_metrics = False`).
- The Pydantic `Field(validators=...)` form prints a deprecation warning under Pydantic 2.14.

Ran on 2026-11-15: PASS, detection 92% (11/12), false positives 0%, PII 23/23, schema checks 3/3, hub validators skipped. guardrails-ai 0.11.0, presidio 2.2.366, spaCy en_core_web_sm.
