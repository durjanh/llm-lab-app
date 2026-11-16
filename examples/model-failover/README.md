# Model failover

An agent that keeps working when its model is rate limited (429) or overloaded (529, 5xx), by switching to another deployment
or a similar model in the middle of a conversation. The lab page is `/model-failover` (backend: `backend/app/services/
model_failover.py`, `model_router.py` and `conversation_store.py`). These two examples show the same rules in two frameworks.

The one rule: the model holds no state. The conversation of record is in your own store, and every call is built from it.

What the examples share (`shared/`):

- `rules.py`: the error table, a circuit breaker and the compaction settings, in plain Python.
  - 429 with a retry-after of 2 s or less: retry once on the same model.
  - 429 with a long or no retry-after, 529, any 5xx, a timeout: open the breaker and switch.
  - 400, 401, 403, 404, 413, 422: never switch; raise it.
- `lab_store.py`: loads the lab's own `conversation_store.py`, so the layout is the page's layout. Blob
  `conversations/{user}/{conv}/steps/{turn}-{step}.json`, Table `ModelFailoverConversations` and `ModelFailoverSteps`. With
  nothing set it writes files; with `MODEL_FAILOVER_STORAGE_ACCOUNT` it signs in with `DefaultAzureCredential` (no keys); with
  `MODEL_FAILOVER_STORAGE_CONNECTION_STRING` set to Azurite's published development string (`UseDevelopmentStorage=true`) it
  runs locally. Any other connection string is refused.
- `catalog.py`: the model names. Nothing in the examples names a model: the first Claude model and the first GPT deployment
  for the `run.py` scripts, and the summary model, come from the lab's `config/model-failover.json` (a model of `$GPT_DEPLOYMENTS`
  stands for the deployments in `AZURE_OPENAI_DEPLOYMENTS`). Edit that file to change them.
- Compaction settings, the lab's names: `MODEL_FAILOVER_COMPACT_AT` (0.7 of the current model's window),
  `MODEL_FAILOVER_COMPACT_MAX_TOKENS` (60000, the smaller counts), `MODEL_FAILOVER_KEEP_RECENT` (4 turns word for word),
  `MODEL_FAILOVER_COMPACT_MODEL` (an optional override; by default the `compact_model` of `config/model-failover.json`). An empty, refused or cut-off summary is ignored.

## agent_framework/ (Microsoft Agent Framework 1.23)

- `FallbackChatClient`: wraps two chat clients (Claude on the Anthropic API, GPT on Azure OpenAI) behind `get_response`.
- `BlobTableHistoryProvider`: a `HistoryProvider` (`get_messages`, `save_messages`) over the Blob + Table layout, compacting
  inside `get_messages`. `AgentSession.to_dict()` holds only the session id.
- `ClaudeChatClient` is a small text-only client, because `agent-framework-anthropic` needs a newer core than 1.23.

```sh
cd examples/model-failover/agent_framework
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt   # its own venv, not the root one
.venv/bin/python -m pytest -q        # fake clients, no network
.venv/bin/python run.py              # live: needs ANTHROPIC_API_KEY (and Azure OpenAI settings for the switch)
```

## langgraph/ (LangGraph 1.2)

- `failover_model`: `model.with_fallbacks([...], exceptions_to_handle=(Switch,))` over models guarded by the same rules.
- A `RetryPolicy` on the agent node, so a pass where every model failed is tried once more.
- `BlobTableSaver`: a `BaseCheckpointSaver` (`put`, `put_writes`, `get_tuple`, `list`) with checkpoints in Blob and an index in a Table.
- A summarising node before the model that trims the state's messages and keeps the summary in the state.

```sh
cd examples/model-failover/langgraph
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest -q
.venv/bin/python run.py
```

Both `run.py` scripts read only the environment (they never open `.env`), inject one 429 on Claude, and make a few short calls.
