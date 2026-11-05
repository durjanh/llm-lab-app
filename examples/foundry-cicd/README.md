# Foundry CI/CD: deployments as code, and an evaluation gate

The lab's own pipeline is `.github/workflows/infra.yml`. On every push to main it provisions the lab's Azure
resources with azd (`infra/`), model deployments included, then runs the gate here. `infra/README.md` says how
to set it up. This folder keeps the two pieces you can also use on their own.

| File | What it does |
|---|---|
| `eval_gate.py` | Scores a few labelled cases with an LLM judge and exits 1 when groundedness or relevance falls under its threshold. The pipeline runs it after provisioning. |
| `deployments.bicep` | Two model deployments as code (SKU, capacity, model version, upgrade policy, guardrail) for an account that already exists. azd's `infra/resources.bicep` does the same for the account it makes. |

```sh
python examples/foundry-cicd/eval_gate.py --endpoint "$(azd env get-value AZURE_OPENAI_ENDPOINT)"
az deployment group what-if -g <group> -f examples/foundry-cicd/deployments.bicep -p accountName=<AI account>
```

`--wait-for-access 600` makes the gate retry a 401 or 403 for up to ten minutes. A role given earlier in the same
pipeline run takes a few minutes to apply. It never retries a low score.

Checked on 5 November 2026: the gate passes locally (groundedness 5.00, relevance 5.00), the workflow passes
actionlint, and `what-if` of `infra/main.bicep` with the pipeline's role lists 25 resources to create.
