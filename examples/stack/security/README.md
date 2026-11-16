# AI security

Eight tools that guard an LLM app, run on one fixed test set (`shared.py`, standard library only, all invented):

- **12 attacks**: 8 direct jailbreaks and injections, and 4 indirect ones, where the instruction is hidden in a retrieved handbook chunk.
- **12 benign questions**: the handbook's gold questions (`common.data.GOLD`). A tool should let all of them through.
- **12 PII texts**: 8 with UK-style names, emails, phones, NI numbers, card numbers and postcodes (23 labelled values), and 4 with none.

Scores: **detection** (attacks flagged), **false positives** (benign flagged), **PII found** (labelled values covered by a detected span) and whether any core PII (email, phone, NI number, card) is still readable after anonymising.

## Results

Run on 2026-11-15. Twelve attacks and twelve questions are a small sample: one miss is 8 points.

| Tool | Result | Detection | False positives | PII found | Needs |
|---|---|---|---|---|---|
| presidio | PASS | not its job | not its job | 23/23, 0 core left | spaCy `en_core_web_lg`, no key |
| nemo-guardrails | PASS | 12/12 (100%) | 0/12 | not its job | `ANTHROPIC_API_KEY` (one Claude call per message) |
| guardrails-ai | PASS | 11/12 (92%), custom regex validator | 0/12 | 23/23 (Presidio inside) | no key; hub validators need `GUARDRAILS_TOKEN` (skipped) |
| llm-guard | PASS | 12/12 (100%), DeBERTa | 0/12 | 17/23 (missed NI numbers and postcodes) | about 1.4 GB of models, no key |
| lakera | SKIP | not run | not run | not run | `LAKERA_GUARD_API_KEY` |
| prompt-security | SKIP | not run | not run | not run | a Prompt Security tenant (`PS_PROTECT_URL`, `PS_APP_ID`) |
| bedrock-guardrails | SKIP | not run | not run | not run | AWS credentials and a Bedrock region |
| azure-content-safety | PASS | 11/12 (92%), Prompt Shields | 0/12 | 20/23 (Azure Language; missed NI numbers) | `az login` and `AZURE_LANGUAGE_ENDPOINT` |

Read the table with care. The presidio and guardrails-ai UK recognisers and regexes, and the NeMo policy prompt, were written by someone who had seen the test set, so their scores are higher than they would be on new data. The models that were not tuned by us (LLM Guard's DeBERTa, Prompt Shields) are the fairer comparison, and even they score on mild, textbook attacks. These examples show how each tool is wired, not which one is best.

## Run

Each tool has its own Python 3.12 `.venv` (the packages pin conflicting versions): see the first line of its `requirements.txt`.

```sh
python examples/stack/run_all.py security          # every tool here, one line each, and RESULTS.md
python examples/stack/run_all.py security/presidio # one tool
```

Each folder has `run.py`, `requirements.txt` and `NOTES.md` (what the tool is, what we saw, limits). Nothing here needs Docker.

## What each is

- **presidio**: finds and redacts PII. Local, rule and NER based.
- **nemo-guardrails**: rails around a bot. Here an LLM judges each input against a written policy.
- **guardrails-ai**: validators on inputs and outputs, plus schema checks on structured answers.
- **llm-guard**: local classifiers and scanners for prompts, secrets, PII and replies.
- **lakera**, **bedrock-guardrails**, **azure-content-safety**: hosted detection APIs. Lakera is a dedicated service, Bedrock's guardrail is a saved policy applied with `ApplyGuardrail`, Prompt Shields is Azure's attack detector.
- **prompt-security**: a commercial platform, explained but not run; no public self-serve SDK.

## No scanner is complete

Detectors miss attacks that are worded differently, are written in another language, are split over several turns, or hide in images and files. They also block honest users when a policy is too keen. So:

- Layer them: a cheap pattern or classifier first, a model-based check where the risk is high, and PII redaction before text leaves your boundary.
- Keep the rules that matter in code: what the bot is allowed to do, which tools it can call, what it may read and write, spending and size limits, approvals. A detector reduces the chance of an attack reaching the model. It cannot make an unsafe permission safe.
- Treat retrieved text and tool output as untrusted input, whatever the scanner says.
- Re-run a labelled set like this one when you change a threshold, a prompt or a model, and add real misses to it.
