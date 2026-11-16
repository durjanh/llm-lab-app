# Amazon Bedrock Guardrails

AWS's managed guardrails. A guardrail is a saved definition (content filters, denied topics, word filters, sensitive-information filters, contextual grounding). `ApplyGuardrail` checks text against one without calling a model, so it works with any model, including ones not on Bedrock.

## How it does the task
`DEFINITION` in `run.py` is the `create_guardrail` request: a PROMPT_ATTACK filter at HIGH strength on input (its output strength must be NONE), hate and violence filters, and PII entities (name, email, phone, address, UK national insurance number, card number) set to ANONYMIZE. The run creates the guardrail and a version, calls `apply_guardrail` for each text with the `guard_content` qualifier, reads the PROMPT_ATTACK filter result and the PII matches, scores them, then deletes the guardrail. It needs AWS credentials with create, apply and delete rights on Bedrock guardrails and a Bedrock region (`AWS_REGION`, default eu-west-2).

## Status
No AWS credentials here, so the live part was skipped. Before skipping, `run.py` checks both requests against boto3's service model with a stubbed client (so a wrong field name or PII type name would fail), and they pass. Behaviour of the filters (how many of the attacks it blocks) is unmeasured.

## Limits
Charged per text unit. The prompt-attack filter is aimed at jailbreaks and injections in the user input; it needs the guard_content qualifier on the text to check.

Ran on 2026-11-15: SKIP (no AWS credentials); request shape validated offline against boto3 1.44.3.
