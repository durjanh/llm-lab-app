# A tour of the Microsoft Foundry SDK

`tour.py` runs the parts of the Foundry project client (`azure-ai-projects`) that the lab's other examples do not use. It runs against your own project. MedAssist (`examples/medassist`) already covers agents, tools, vector stores and conversations.

```sh
source .venv/bin/activate
pip install -r examples/foundry-sdk/requirements.txt
python examples/foundry-sdk/tour.py all        # or one of: project, respond, data, evaluate, trace
```

It reads `FOUNDRY_PROJECT_ENDPOINT` and `FOUNDRY_MODEL` from the lab's `.env` and signs in with `az login`. The project client accepts Entra ID only, never a key. A full run costs about a penny. Everything it creates it deletes again, except the latest evaluation, which stays so its portal report opens.

| Section | SDK calls | What it shows |
|---|---|---|
| `project` | `connections.list`, `deployments.list` | The resources the project can reach, and the models it can call by deployment name. With no connections, it lists what each kind would add. |
| `respond` | `get_openai_client()`, `responses.create(previous_response_id=...)` | A model called through the project, with the service keeping the thread. The second turn's input tokens include the first turn's, which is not sent again. |
| `data` | `datasets.upload_file`, `datasets.get`, `datasets.delete`, `indexes.list` | Versioned datasets in the project's own storage, so no storage connection is needed. Agents' File Search vector stores appear as `ManagedAzureSearch` indexes. |
| `evaluate` | `evals.create`, `evals.runs.create`, `evals.runs.output_items.list` with `TestingCriterionAzureAIEvaluator` | A cloud evaluation over four answers with five built-in evaluators: groundedness, relevance, coherence, F1 and violence. One answer contradicts its policy text. |
| `trace` | `AIProjectInstrumentor`, `telemetry.get_application_insights_connection_string` | OpenTelemetry spans for each model call, with model and tokens, under the app's own span. |

## What a run against the lab's project showed (5 November 2026)

- **Connections:** none. Adding an Azure AI Search connection would let you register your own search index. An Application Insights connection would send the traces to the portal's Tracing page.
- **Evaluation:**
  - Groundedness scored the made-up answer 2 out of 5 and failed it, with a reason that cites the context. Relevance passed it, which is right: it does answer the question. Only groundedness checks an answer against its source.
  - F1 failed a correct answer ("The excess for escape of water is £350." against "£350"), because it measures word overlap. It is a weak gate.
  - Violence returned errors: the safety (content harm) evaluators are not offered in UK South, where the lab's project is. To use them, put the project in a region that offers them.
- **Tracing:** four spans. `answer a policy question` (the app's span) contains `get_openai_client` and two `chat gpt-5.4-mini` spans, each with its token counts. Content recording is off, so prompts and answers, which can hold personal data, stay out of the spans.

## What this does not cover

- Agents, tools, File Search and conversations: see `examples/medassist/medassist.py`.
- Hosted agents: see `examples/medassist/hosted/`.
- Making connections: they are created in the portal or in Bicep, not through this client.
- Preview operation groups under `project.beta`, such as memory stores, red teams, evaluator generation and schedules. The tour uses `beta.evaluators` only to look up the built-in evaluators' inputs when it was written.
