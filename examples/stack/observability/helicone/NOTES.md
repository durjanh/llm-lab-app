# Helicone

**What it is.** An LLM gateway and observability tool. You change the SDK's base URL to Helicone's proxy and add a `Helicone-Auth` header. Every request is logged with tokens, cost and latency, with no tracing code in the app. Custom properties (`Helicone-Property-*`) and sessions let you filter later. It can also cache and rate-limit.

**How it does this task.** `run.py` builds the Anthropic client with `base_url=https://anthropic.helicone.ai`, the auth header and two custom properties, sends the six questions, takes each `helicone-id` response header, and reads the requests back from Helicone's query API by property.

**Not run.** `HELICONE_API_KEY` is not set here, so this printed SKIP. Before the skip it builds the client and checks the base URL and header. The read-back call was written from the documentation and has not been run against the service.

**Self-hosting.** Helicone can be self-hosted, but the stack is large: the Next.js web app, a Cloudflare-Worker-style gateway (run under Wrangler), Supabase or Postgres, ClickHouse, MinIO and Kafka-style queues, in a multi-service Docker setup. It was not started here because it is far heavier than the other tools and the 8 GB Docker budget is shared. For a local gateway with similar logging, Langfuse (this area) plus LiteLLM's proxy is lighter.

Ran on 2026-11-15: SKIP. set HELICONE_API_KEY to route the six questions through Helicone (client and headers build fine).
