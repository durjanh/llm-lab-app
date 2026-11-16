# NeMo Guardrails

NVIDIA's open-source toolkit for putting rails around an LLM app: input rails, output rails, dialogue flows (Colang), retrieval and execution rails.

## How it does the task
`config/config.yml` sets Claude (claude-haiku-5-5, overridden by `config.CLAUDE_MODEL`) as the bot model and turns on the `self check input` flow. `config/prompts.yml` holds the policy prompt the rail sends to Claude: "should this message be blocked, Yes or No". An LLMRails object is built from the folder. Attacks are scored with only the input rail run (a blocked message returns the refusal text), so no answers are generated for them. The 12 benign questions go through the full bot with their handbook section as context, and the answers are checked against GOLD.

## Limits
- The rail is only as good as the policy prompt, which we wrote after seeing the attack types. It adds one model call to every message (cost and latency).
- It judges the whole message, including retrieved text, so an indirect attack is caught only if the rail prompt tells it to look for them.
- Version 0.24 defaults to OpenAI-style endpoints. To use Anthropic we set `NEMOGUARDRAILS_LLM_FRAMEWORK=langchain` and install `langchain`, `langchain-community` and `langchain-anthropic`.
- This Claude model rejects the `temperature` parameter, and NeMo sends one for self-check tasks. `lowest_temperature: null` in the config stops that.
- NeMo also ships a Prompt Security rail, which is where we read that vendor's request shape (see ../prompt-security).

Ran on 2026-11-15: PASS, detection 100% (12/12), false positives 0% (0/12), 12/12 benign answers correct. nemoguardrails 0.24.1. About 50 small Claude calls.
