/* The code and commands on the page, from the repository (trimmed where marked), highlighted for CodeBlock. */
import { highlight } from '@/components/highlight';

export const provision = highlight(
  `# Once. Open Docker Desktop first.
./tools/local-model.sh                                     # enable Model Runner on :12434, pull the model (6.9 GB),
                                                           # set a 32k context, check it answers
echo 'LLM_LAB_LOCAL_MODEL=ai/qwen3.5:9b-q4_K_XL' >> .env   # then restart the backend`,
  'shell',
);

export const script = highlight(
  `# tools/local-model.sh (trimmed)
MODEL="\${LLM_LAB_LOCAL_MODEL:-ai/qwen3.5:9b-q4_K_XL}"
PORT="\${PORT:-12434}"
CONTEXT="\${CONTEXT:-32768}"   # agent pages send long prompts; the server's default is smaller

if ! docker model status >/dev/null 2>&1; then
  docker desktop enable model-runner --tcp="$PORT"
fi
docker model pull "$MODEL"
docker model configure --context-size "$CONTEXT" --keep-alive 30m "$MODEL"

curl -sf "http://localhost:$PORT/anthropic/v1/messages" -H 'content-type: application/json' \\
  -d '{"model": "...", "max_tokens": 20, "messages": [{"role": "user", "content": "Say ready."}],
       "chat_template_kwargs": {"enable_thinking": false}}'`,
  'shell',
);

export const env = highlight(
  `# .env (read only by python/settings.py)
LLM_LAB_LOCAL_MODEL=ai/qwen3.5:9b-q4_K_XL     # the default model wherever the work allows

# The defaults, for Docker Model Runner:
# LLM_LAB_LOCAL_URL=http://localhost:12434/anthropic          Anthropic-compatible API
# LLM_LAB_LOCAL_OPENAI_URL=http://localhost:12434/engines/v1  OpenAI-compatible API (JSON-schema replies)

# Ollama instead:
# LLM_LAB_LOCAL_URL=http://localhost:11434
# LLM_LAB_LOCAL_OPENAI_URL=http://localhost:11434/v1`,
  'shell',
);

export const common = highlight(`# python/common.py
CLAUDE_MODEL = ENV.model                     # the default for work that needs Claude
DEFAULT_MODEL = LOCAL_MODEL or CLAUDE_MODEL  # the default everywhere else

if LOCAL_MODEL:
    PRICES[LOCAL_MODEL] = LOCAL_PRICE        # runs on this machine: no charge per token`);

export const daily = highlight(
  `# After a restart of the machine or Docker Desktop: open Docker Desktop, then
./tools/local-model.sh                       # safe any time: sets the context again and checks it answers
source .venv/bin/activate
python -m backend --budget 1 --reload        # http://127.0.0.1:8000
cd frontend && npm run dev                   # http://localhost:5173

# From the command line: scripts default to the local model, or take --model
python examples/hotel/hotel_agent.py --model ai/qwen3.5:9b-q4_K_XL`,
  'shell',
);

export const curl = highlight(
  `curl -s http://localhost:12434/anthropic/v1/messages -H 'content-type: application/json' -d '{
  "model": "ai/qwen3.5:9b-q4_K_XL", "max_tokens": 40,
  "messages": [{"role": "user", "content": "Say ready."}],
  "chat_template_kwargs": {"enable_thinking": false}}'

# Measured on 11 November 2026, the model not yet loaded:
# "Ready."   input_tokens 15, output_tokens 3, 6.3 seconds including loading the model`,
  'shell',
);

export const routing = highlight(`# python/local_model.py: one client, three destinations, chosen by the model's name
def is_local(model) -> bool:
    return bool(LOCAL_MODEL) and model == LOCAL_MODEL

def is_gpt(model) -> bool:
    return isinstance(model, str) and model.startswith("gpt-")

def _other(self, model):
    """The local model or GPT, for a request to either; None for Claude."""
    if self._local and is_local(model):
        return self._local
    if self._gpt and is_gpt(model):
        return self._gpt
    return None`);

export const prepare = highlight(`# python/local_model.py: prepare (trimmed)
def prepare(params: dict) -> tuple[dict, dict | None]:
    """The request as the local server takes it, and the JSON schema the reply must match, if any."""
    _check(params)                                     # refuse what only Claude can do
    config = out.pop("output_config", None) or {}
    fmt = config.get("format") or {}
    if fmt.get("type") == "json_schema":
        schema = fmt.get("schema")                     # sent to the OpenAI-compatible endpoint instead
    thinking = _thinking_wanted(out)                   # off unless the request asks for it
    # Qwen-style templates read enable_thinking; gpt-oss reads reasoning_effort. Each ignores the other's.
    extra["chat_template_kwargs"] = {**extra.get("chat_template_kwargs", {}), "enable_thinking": thinking,
                                     "reasoning_effort": "medium" if thinking else "low"}
    return out, schema`);

export const schema = highlight(`# python/local_model.py: _create_json (trimmed)
payload = {"model": body["model"], "messages": chat, "max_tokens": body.get("max_tokens", 4096),
           "response_format": {"type": "json_schema",
                               "json_schema": {"name": "reply", "strict": True, "schema": schema}},
           "chat_template_kwargs": {"enable_thinking": False, "reasoning_effort": "low"}}
r = httpx.post(f"{self.openai_url}/chat/completions", json=payload, timeout=900.0)
# llama.cpp holds the reply to the schema with a grammar; the reply comes back as an ordinary Anthropic Message`);

export const refusals = highlight(`# python/local_model.py: what a local model is not sent
CLAUDE_ONLY_PARAMS = {"container": "a code execution container", "mcp_servers": "MCP connectors",
                      "skills": "Agent Skills"}
CLAUDE_ONLY_BLOCKS = {"document": "PDF and document blocks", "container_upload": "files for code execution",
                      "server_tool_use": "Anthropic's server tools", "web_search_tool_result": "web search",
                      "web_fetch_tool_result": "web fetch", "code_execution_tool_result": "code execution",
                      "mcp_tool_use": "MCP connectors", "search_result": "search result blocks"}
# Any tool whose type is not custom (web_search_..., code_execution_..., bash_..., memory_...) is refused too.

# The page then says, for example:
# ai/qwen3.5:9b-q4_K_XL runs on this machine and cannot use MCP connectors. Choose a Claude model for this.`);

export const switchModel = highlight(
  `docker model ls                    # downloaded: qwen3.5:9b-q4_K_XL, gpt-oss:20b
docker model ps                    # loaded now: only the one requests have used recently

# To make gpt-oss the lab's local model instead:
#   edit .env:  LLM_LAB_LOCAL_MODEL=ai/gpt-oss:20b
./tools/local-model.sh             # pulls it if needed, sets its context, checks it answers
# then restart the backend`,
  'shell',
);
