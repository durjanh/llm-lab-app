# Prompt Security

A commercial AI security platform (SentinelOne announced in August 2025 that it was buying the company: https://siliconangle.com/2025/08/05/sentinelone-acquires-ai-security-startup-prompt-security/). It protects employees' use of GenAI tools and companies' own AI apps.

## What we verified
- There is **no public self-serve SDK, package or free tier** that we could find. Access is through a tenant that the vendor provisions (an admin portal at `https://<region>.prompt.security/`, regions eu, useast, apac).
- **Deployment surfaces**, from the vendor's blog and from integration docs: a browser extension (watches typing, pasting and file uploads in GenAI web apps; rolled out by MDM with an API domain and key), an endpoint agent, an API or gateway for homegrown apps (a "protect" call before and after the model), and integrations with gateways such as LiteLLM and Portkey.
- **API shape.** We could not find a public API reference. The only readable description is open source: NVIDIA's NeMo Guardrails has a Prompt Security rail. It POSTs JSON `{"prompt", "system_prompt", "response", "user"}` to `PS_PROTECT_URL` (`https://<region>.prompt.security/api/protect`) with an `APP-ID` header, and reads `result.action` as `log`, `block` or `modify` (with `result.prompt.modified_text` or `result.response.modified_text`). That client fails open on errors. Treat this as how NeMo uses it, not as the vendor's contract.

## What run.py does
It skips and says what is needed. If you set `PS_PROTECT_URL` and `PS_APP_ID` it sends each test text in that shape and scores `block` as a detection. That path is untested: we have no tenant. Nothing here was invented beyond the NeMo client's shape.

Ran on 2026-11-15: SKIP (no tenant).
