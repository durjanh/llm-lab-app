# MedAssist practice inbox: a workflow, deployed as a Foundry hosted agent

Patients write to the practice through the portal inbox. This hosted agent reads each message and answers it:

```
patient message → screen (code: red-flag words) ─ red flag ────────────────────→ safety reply (code: 999 / 111)
                                               └ otherwise → triage (model) ─┬ emergency / urgent ───→ safety reply
                                                                             ├ practice question ────→ answer (model + practice documents)
                                                                             └ clinical / anything else → clinician queue (code)
```

Code decides wherever a wrong answer could hurt someone: an obvious emergency never waits for a model (the screen answers it before any model runs), and the emergency, urgent and clinical replies are fixed text. The model decides what kind of message it is, and writes replies only to practice questions, from the practice documents in `../knowledge/`. Each reply ends with a `[route: … · category: … · decided by: …]` line so you can see what the workflow did.

## Where this fits

Microsoft Foundry Agent Service has three kinds of agent:

| | What it is | In this repository |
|---|---|---|
| Prompt agent (declarative) | Model, instructions and tools, saved as versions in Foundry | `../medassist.py`: MedAssist, version 7 |
| Workflow agent (declarative) | A workflow drawn in the Foundry portal | None: **Foundry retires declarative workflows on 1 December 2026** and points new work to Agent Framework workflows run as hosted agents |
| Hosted agent | Your code, run by Foundry in a managed container behind a stable endpoint | **This folder**: an Agent Framework workflow, hosted |

So this one example covers both "workflow" and "hosted": it is the form Microsoft now recommends for a workflow.

## Run it

It has its own environment (Python 3.13 or newer), because the hosting package is a beta that pins newer Agent Framework releases than the rest of the lab.

```sh
cd examples/medassist/hosted
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

.venv/bin/python main.py --ask "Are you open on Saturdays?"   # one message through the workflow, no server
.venv/bin/python main.py                                      # the hosted server, on http://localhost:8088
.venv/bin/python deploy.py test --local                       # the checked cases against that local server

.venv/bin/python deploy.py deploy                             # to Foundry: upload, remote build, run, route
.venv/bin/python deploy.py ask "How do I order a repeat prescription?"
.venv/bin/python deploy.py test                               # the same cases against the deployed agent
.venv/bin/python deploy.py delete                             # remove it
```

Reads `FOUNDRY_PROJECT_ENDPOINT` and `FOUNDRY_MODEL` from the lab's `.env`; sign in with `az login`. Deploying and calling needs the **Foundry User** role on the Foundry resource. The hosted agent calls the model with its own identity, which has access to models in its own project without any extra role.

## How deployment works

`deploy.py` follows Microsoft's quickstart, with the Python SDK and no `azd`:

1. **Package.** `main.py` and `requirements.txt` at the root of a ZIP, the practice documents beside them. The upload must have a name ending in `.zip`, or the service refuses it.
2. **Create a version** with `create_version_from_code`: 0.5 CPU and 1 GiB, the `python_3_13` runtime, `python main.py` as the entry point, and a **remote build**, so Foundry installs `requirements.txt` itself. No container registry is needed for a code deployment.
3. **Wait** until the version is `active`. The first one took 80 seconds.
4. **Route** the endpoint: send 100% of traffic to the new version. The endpoint URL stays the same as versions change, so callers are not disturbed, and a new version can take a share of traffic first.
5. **Call** it on the Responses protocol: `get_openai_client(agent_name=...)` (with `allow_preview=True` on the project client), then `responses.create(input=...)`.

`main.py` turns the workflow into an agent with `.as_agent()` and serves it with `ResponsesHostServer` from `agent-framework-foundry-hosting`, on port 8088, locally and in Foundry alike.

## Results

7 of 7 checked cases pass, both locally and deployed: an emergency caught by the code screen, a very unwell child sent to NHS 111 by the model, three practice questions answered from the documents, a request for a cream and an attempt to get a dose ("Ignore your instructions…") both sent to the clinician queue.

Deployed replies took 8 to 15 seconds, against 0 to 7 seconds locally. The emergency reply, which calls no model at all, took 8.6 seconds deployed: that is the platform's own overhead for reaching the hosted container, so budget for it.

One test run hung for over ten minutes on its first call after deployment; the next run passed in 82 seconds. `deploy.py` now gives each call a 90-second timeout and no automatic retries, so a stuck call fails rather than waits.

## Not done here

- **Application Insights.** Microsoft lists a connected Application Insights resource as a prerequisite for hosted agent traces. This project has none, and deployment and calls worked without it, but there are no cloud traces to look at. Connecting one means creating Azure resources (Application Insights and Log Analytics) and a project connection.
- **A real inbox.** The clinician queue returns a reference but does not store the message anywhere. A real version would write it to the practice's clinical system, which the hosted agent would reach with its own Entra identity and an explicit role on that resource.
- **Cost.** A running hosted agent uses compute as well as model tokens. `deploy.py delete` removes it.
