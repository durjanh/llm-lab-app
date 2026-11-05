# The coding agent's sandbox in Azure

The coding agent (Lab 46, `python/19_coding_agent.py`) runs without asking in auto mode, because its shell is contained. On a Mac that is `sandbox-exec`, and on Linux bubblewrap. Neither works inside an Azure Container Apps container. Commands must not run there anyway, because the backend's container holds the managed identity and the API key.

In Azure the boundary is a separate container for each agent session: Azure Container Apps **dynamic sessions** with a custom container. Each session is Hyper-V isolated, made on first use and destroyed after five idle minutes. It has no Azure credentials of its own.

```
backend (Container App)                         session pool (one container per agent session)
  harness: the project, checkpoints,   POST /run?identifier=<random>    server.py
  diffs, file tools                    ───────────────────────────────▶  makes /work/project match the archive,
  bash ─────────────────────────────── Bearer token (managed identity)  runs the command in the project's .venv,
                                       ◀───────────────────────────────  sends the project back
                                        the project, changed files only
```

The harness keeps the project, so undo, diffs and the read-before-edit rule are unchanged. Each command sends the project there and back as a `.tar.gz`, leaving `.venv` behind. Only files whose content changed are written back, so the agent's earlier reads stay valid. The session keeps its `.venv`, so a `pip install` lasts while the session lives. A reply cannot write outside the project, because each path is checked before it is written.

| File | What it is |
|---|---|
| `server.py` | The session's HTTP server: `POST /run`, `POST /screenshot` (rendered by the image's Chromium) and `GET /health`. Standard library only. The harness loads its `pack` and `unpack`, so both ends use the same code. |
| `Dockerfile` | Python 3.12, git, curl and Chromium, run as a non-root user on port 8080. The user can install system packages with `apt-get`, through `sudo` for apt only. |
| `app-registration.sh` | Makes or deletes the sandbox's app registration; used by `setup-app.sh` and by azd's hooks. |
| `publish-image.sh` | Builds the image on your Mac and pushes it to GitHub Container Registry. |
| `setup.sh` | Builds the image in your registry and creates the pool, keyless. It also grants you, and the backend's identity if given, the **Azure ContainerApps Session Executor** role. |

## Installing at runtime

Nothing in a session asks anyone. The agent installs what it needs as it goes. Python packages go in with `pip`. System programs go in with `apt-get install`, which the image runs as root through `sudo`, for apt only. That's how it gets LibreOffice to render a deck and check the slides. An install lasts as long as the session. Each new session starts again from the image, so add to the `Dockerfile` whatever every session should have from the start.

## What later sessions keep

When an install succeeds, the harness writes the package to `generated/agent-tools/installed.json`. Every new session's `CLAUDE.md` then lists it under "Installed by earlier sessions". On your own machine, recorded Python packages also go into one shared environment that every project's `.venv` can read, so they import at once. A new cloud session installs the recorded list before its first command. To build them into the image instead, run `python python/19_coding_agent.py --export-installed examples/coding-sandbox` and rebuild. That writes `extra-requirements.txt` and `extra-apt.txt`, which the Dockerfile installs. Review those two files before you build: anything an agent installed, including something a malicious input file talked it into, would go into every session.

## Cost

A custom container pool runs on the Dedicated plan, on E16 machines (16 vCPU, 128 GB). In UK South that is about £1.69 an hour while a machine is up, roughly £1,200 a month if one is kept ready. `setup.sh` keeps no sessions ready, has at most three, and stops a session after five idle minutes. So you pay only while an agent is working, and the first command waits for a machine to start. Delete the pool when you are not using it: `az containerapp sessionpool delete -n coding-sandbox -g <group>`.

## Two ways to run it

The same image, server and protocol work both ways, so moving between them changes two settings, nothing else.

| | B: one container app (Consumption) | A: a dynamic session pool |
|---|---|---|
| Script | `setup-app.sh` | `setup.sh` |
| Between agent sessions | One shared container, a folder per session (`/work/sessions/<id>`). One agent could reach another's folder. | A Hyper-V container per session |
| Installs | Shared by every session while the container runs | Last only for that session |
| Sign-in | Container Apps' built-in sign-in: a token for the sandbox's app registration, from an allowed principal | A token for `https://dynamicsessions.io` with the Session Executor role |
| Size | One replica, because sessions keep state in it | Scales per session |
| Cost | Per second while running, nothing when scaled to zero | About £1.69 an hour while an E16 machine is up |

In both, the image is pulled with a managed identity that no container can use. For B, `setup-app.sh` sets identity lifecycle `None`; for A, it is the pool's default. So the agent's commands get no Azure credentials.

### B: set it up

```sh
examples/coding-sandbox/setup-app.sh     # rg-llm-lab in uksouth; asks before it starts
```

It creates a Basic registry, builds the image there, then creates a Consumption environment, the app registration `llm-lab-coding-sandbox` and the container app. Running it again is safe: it creates what is missing and updates the rest. It prints three settings for the lab's `.env`:

```
LLM_LAB_SANDBOX=sessions
LLM_LAB_SESSIONS_ENDPOINT=https://coding-sandbox.<environment>.uksouth.azurecontainerapps.io
LLM_LAB_SESSIONS_SCOPE=api://<app id>/.default
```

When the backend is deployed, run it again with `BACKEND_PRINCIPAL_ID=<the backend's managed identity object id>` so the backend is on the allowed list.

### Moving from B to A

1. Run `setup.sh` with your environment and registry (`ENVIRONMENT=cae-llm-lab REGISTRY=<the registry setup-app.sh made>`). It needs a workload-profiles environment, which `setup-app.sh` creates by default.
2. Set `LLM_LAB_SESSIONS_ENDPOINT` to the pool's endpoint, and remove `LLM_LAB_SESSIONS_SCOPE`.
3. Delete the container app once nothing uses it: `az containerapp delete -n coding-sandbox -g rg-llm-lab`.

### B without an Azure registry

Container Apps can only pull an image, so some registry is needed. GitHub Container Registry is free, and a public image needs no pull identity at all:

```sh
gh auth refresh -h github.com -s write:packages                   # once: let the GitHub CLI publish packages
examples/coding-sandbox/publish-image.sh                          # builds for linux/amd64 on your Mac, pushes ghcr.io/<you>/coding-sandbox:1
# on GitHub: the package's settings > Change visibility > Public   (once; a new package is private)
IMAGE=ghcr.io/<you>/coding-sandbox:1 examples/coding-sandbox/setup-app.sh
```

`setup-app.sh` checks that the image can be pulled without credentials before it switches the app. When it switches, it removes the Azure registry and the identity from the app, and tells you how to delete them. The image is public, which is fine: it holds the server and public tools, nothing secret. On an Apple silicon Mac the build runs under emulation, so it is slow, and it uploads about 3 GB. Use a new `TAG` for each publish so the app starts a new revision.

### Take it down

```sh
examples/coding-sandbox/teardown.sh                   # lists what it found, asks, then deletes
KEEP_REGISTRY=1 examples/coding-sandbox/teardown.sh   # keep the registry and image, to set up again faster
```

It deletes only what the two setup scripts create: the container app, the session pool, the app registration, the pull identity, the registry, and the environment if nothing else runs in it. The resource group and the lab's AI, Speech and Search resources stay.

### A: set it up

You need an existing resource group, Container Apps environment and container registry. Check `az account show` first, because the script creates billable resources there. It asks before it starts.

```sh
RESOURCE_GROUP=rg-llm-lab ENVIRONMENT=cae-llm-lab REGISTRY=acrllmlab ./setup.sh
```

Then set what it prints, in the lab's `.env` or the backend container app's settings:

```
LLM_LAB_SANDBOX=sessions
LLM_LAB_SESSIONS_ENDPOINT=https://coding-sandbox.<environment-id>.uksouth.azurecontainerapps.io
```

Locally the token comes from `az login`. In Azure it comes from the backend's managed identity: set `AZURE_CLIENT_ID` for a user-assigned identity.

## Try it without Azure

The same image runs under Docker. Bind it to `127.0.0.1` only, because anyone who can reach it can run commands:

```sh
docker build -t coding-sandbox:local examples/coding-sandbox
docker run --rm -p 127.0.0.1:8099:8080 coding-sandbox:local
LLM_LAB_SANDBOX=sessions LLM_LAB_SESSIONS_ENDPOINT=http://127.0.0.1:8099 \
  python python/19_coding_agent.py --task excel --mode auto
```

An `http://127.0.0.1` or `http://localhost` endpoint is called without a token.

## Limits

- Egress is on so `pip` works, and it is not filtered by domain. Claude Code filters through a proxy. Here you could put the pool's environment in a virtual network with a firewall.
- A large project costs a transfer each way per command. The server refuses archives over 25 MB.
- When a session is destroyed after five idle minutes, its `.venv` goes with it. The next command starts a new session, and the project arrives with the request as always.
