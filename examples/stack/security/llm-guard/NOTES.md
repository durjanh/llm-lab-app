# LLM Guard

Protect AI's open-source scanner library. Input scanners screen prompts, output scanners screen replies. The models run locally.

## How it does the task
- `PromptInjection` (threshold 0.5, whole text): the `protectai/deberta-v3-base-prompt-injection-v2` classifier. Indirect attacks are scored on the prompt plus the retrieved chunk together.
- `Anonymize`: NER (`Isotonic/deberta-v3-base_finetuned_ai4privacy_v2`) plus patterns, with a `Vault` that remembers what it replaced; we read the vault to see which values were found.
- `Secrets`: caught an AWS example key and a GitHub-token-shaped string.
- Output: `Sensitive` flagged a reply that leaks a name, email and phone; `NoRefusalLight` flagged a refusal.

## Scores
Detection 12/12, false positives 0/12, PII 17/23. Anonymize missed all three NI numbers and three of the UK postcodes. All three NI numbers use the invented QQ prefix, so the real-world miss rate is unknown, but three core NI values were left in the output. Names, emails, phones and cards were all found.

## Limits and surprises
- About 1.4 GB of model downloads (two DeBERTa models, around 710 MB each), into the Hugging Face cache.
- On a Mac the models picked the GPU (MPS) and ran out of memory next to other work. `run.py` pins every model to the CPU by editing the `Model` objects' `pipeline_kwargs` after import. Without that it failed in one of three runs.
- It logs a great deal at debug level; `run.py` quietens structlog.
- The injection model is trained on English text and a fixed notion of "injection". It scored perfectly here on 12 mild attacks, which says little about attacks written to evade it.
- Importing it pulls torch, transformers and spaCy: a large environment.

Ran on 2026-11-15: PASS, detection 100%, false positives 0%, PII 17/23 (74%), secrets caught. llm-guard 0.3.16, torch 2.15.0, transformers 4.51.3.
