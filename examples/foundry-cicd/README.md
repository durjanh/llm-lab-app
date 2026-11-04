# Foundry CI/CD: deployments as code, and an evaluation gate

The lab's model deployments as a Bicep template, a GitHub Actions workflow that deploys them and gates the release on
an evaluation, and the gate as a script you can run locally.

| File | What it does |
|---|---|
| `deployments.bicep` | The `gpt-5.4-mini` and `text-embedding-3-small` deployments: SKU, capacity, model version, upgrade policy and the guardrail (content filter) attached. |
| `foundry-deploy.yml` | GitHub Actions: sign in with OpenID Connect (no secrets), `what-if`, deploy, then run the gate. A protected `staging` environment adds a human approval. |
| `eval_gate.py` | Scores a few labelled cases with an LLM judge and exits 1 when groundedness or relevance falls under its threshold. |

```sh
az deployment group what-if -g rg-llm-lab -f examples/foundry-cicd/deployments.bicep -p accountName=ai-llm-lab-0eevth
python examples/foundry-cicd/eval_gate.py --endpoint https://ai-llm-lab-0eevth.cognitiveservices.azure.com
```

Checked on 3 November 2026: the Bicep compiles, `what-if` against the lab's resource group reports the two deployments
to deploy and nothing to delete, and the gate passes (groundedness 5.00, relevance 5.00). The workflow has not run in
GitHub Actions: it needs an Entra app registration with a federated credential for your repository.
