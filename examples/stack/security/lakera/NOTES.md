# Lakera Guard

A hosted API (Lakera; Check Point announced in September 2025 that it was buying the company: https://www.checkpoint.com/press-releases/check-point-acquires-lakera/) that screens text for prompt attacks, PII, moderated content and unknown links. A free tier exists at platform.lakera.ai.

## How it does the task
`run.py` posts to `https://api.lakera.ai/v2/guard` with `{"messages": [...], "breakdown": true, "payload": true}` and a bearer key. The response has `flagged`, a `breakdown` list of detectors (each with `detector_type` and `detected`) and, with payload, the matched spans. We count only the `prompt_attack` detector as a detection, so a PII hit does not look like a caught attack. Indirect attacks go as a second user message. PII spans come from the payload.

## Status
Not run: no `LAKERA_GUARD_API_KEY`. The code path builds its request and was checked for that, but it has not been tried against the live service, so the response field names are from Lakera's v2 documentation as we know it and may need a small fix on first use. The flagging policy is set in the Lakera dashboard (project and policy), which the API call does not control.

Ran on 2026-11-15: SKIP (no key).
