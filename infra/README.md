# The lab's Azure resources, with azd

`azd up` creates everything the lab uses in Azure, in one resource group, and writes the lab's `.env`. `azd down --purge` removes it all. Everything is keyless: each resource has key sign-in switched off, and the lab signs in with your Azure login.

| What | For |
|---|---|
| Azure AI Services, with a Foundry project `llm-lab` and `gpt-5.4-mini`, `gpt-4.1-mini`, `text-embedding-3-small` and `text-embedding-3-large` | GPT, embeddings, Language, Content Safety, Translator, the MedAssist and Aftercare agents, and the speech fallback |
| A second AI Services account in Sweden Central, with `gpt-image-2` | The image generation lab |
| Speech (S0, pay per use) | The tutor's voice |
| Azure AI Search (free) | The case-handling lab, which makes its index on first use |
| A Container Apps environment, and the coding sandbox container app from `ghcr.io/durjanh/coding-sandbox:1`, scaled to zero, with Entra sign-in | The coding agent's auto mode, run in the cloud |
| The app registration `llm-lab-coding-sandbox-<env>` (made by a hook, because Entra objects are not in a resource group) | The sandbox's sign-in |
| Roles for you: Cognitive Services OpenAI User, Speech User and User, Foundry User, Search Index Data Contributor, Search Service Contributor, and Reader on the group | The labs' data-plane calls. Owner alone does not grant these. |

The lab itself still runs on your machine (`python -m backend`). Hosting the backend in Azure is a separate step: the API only answers pages served from localhost.

## Run it

```sh
azd config set auth.useAzCliAuth true    # once: azd uses your az login, the same account the hooks use
azd auth login --check-status            # or: az login
azd up                                    # asks for an environment name (e.g. lab: not llm-lab, which is the hand-made group) and the subscription
```

It takes about ten minutes. The hooks then:
- **Before:** check the free tiers. A subscription has one free search service, and one free Speech resource per region.
- **Before:** make the sandbox's app registration and pass its id to the Bicep.
- **After:** write the endpoints, ids and sandbox settings into `.env`. Every other line, such as `ANTHROPIC_API_KEY`, is kept. The first time, your old file is copied to `.env.before-azd`.

Restart the backend to use the new values. MedAssist's prompt agent is not part of the infrastructure: create it with `python examples/medassist/medassist.py create`.

Settings you can change before `azd up`:

```sh
azd env set AZURE_LOCATION uksouth              # everything but image generation
azd env set AZURE_MEDIA_LOCATION swedencentral  # where gpt-image-2 is offered
azd env set AZURE_SEARCH_SKU basic              # if the subscription's free search service is taken
azd env set AZURE_SPEECH_SKU F0                 # free, if the region's free Speech resource is not taken
azd env set SANDBOX_IMAGE ghcr.io/<you>/coding-sandbox:2
```

## Run it from GitHub Actions

`.github/workflows/infra.yml` keeps the resources in step with the repository:
- **Pull request:** it checks that the Bicep compiles and the hooks parse. A pull request gets no Azure sign-in, so a branch cannot reach the subscription. Merging is the approval.
- **Push to main, or a manual run:** it shows what would change (`azd provision --preview`), provisions, then runs the evaluation gate (`examples/foundry-cicd/eval_gate.py`). A score under the thresholds fails the run.

Set it up once, after your first `azd up`, in the same azd environment:

```sh
gh auth login                 # the script sets the workflow's repository variables
infra/pipeline.sh
```

It signs in with OpenID Connect: GitHub issues a token for each run, and Entra trusts tokens for this repository's main branch only. No secret is stored anywhere. The script makes the app registration `llm-lab-pipeline-<env>` and gives it:

| Role | Where | Why |
|---|---|---|
| Contributor | The subscription | The template creates the resource group. Contributor cannot grant access to anyone. |
| Role Based Access Control Administrator, with a condition | The lab's resource group | The template grants roles. The condition allows only the lab's seven roles, only to you or the pipeline, so a changed template cannot make anyone an Owner. |
| Cognitive Services OpenAI User | The AI account (from the Bicep, `LAB_PIPELINE_PRINCIPAL_ID`) | The gate calls `gpt-5.4-mini`. |

In the pipeline the hooks do not touch Entra or `.env`. The sandbox's app registration and your object id come from repository variables (`SANDBOX_APP_ID`, `LAB_PRINCIPAL_ID`), so the roles still go to you, not to the pipeline. azd fills `AZURE_PRINCIPAL_ID` with whoever is signed in, which is why the lab uses its own `LAB_PRINCIPAL_ID`.

On a public repository, or with GitHub Enterprise, you can add a human approval before provisioning. Put `environment: production` on the job, give that environment required reviewers, and change the federated credential's subject to `repo:<owner>/<repo>:environment:production`.

`infra/pipeline.sh --delete` removes the registration, its roles and the variables. `azd down` runs it too.

## Take it down

```sh
azd down --purge
```

This deletes the resource group, and purges the two AI accounts and the Speech resource, which Azure would otherwise keep soft-deleted for 48 hours. The `postdown` hook then deletes the app registrations (the sandbox's and the pipeline's, with its roles and repository variables) and takes the azd lines out of `.env`. The sandbox image stays on GitHub until you delete the package there.

## Moving over from the hand-made `rg-llm-lab`

The first lab resources were made by hand in `rg-llm-lab`. azd makes a new group, `rg-<env>`, with new names, so the two can exist side by side, except for the free tiers:

1. Free up the free search service, or use the paid tier for the new one. The old service holds the case-handling index, which the lab rebuilds on first use:
   ```sh
   az search service delete -n srch-llm-lab-kvpjs7 -g rg-llm-lab --yes
   ```
2. Run `azd up`, restart the backend, and check the labs work.
3. Take down the old sandbox with `examples/coding-sandbox/teardown.sh`, then delete what is left in `rg-llm-lab` once nothing uses it. Re-create the MedAssist agent in the new project first.
