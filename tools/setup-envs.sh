#!/usr/bin/env bash
# Sets up the separate Python environments that some labs run in, for a fresh clone of the repo.
#
# These labs need packages the lab's main .venv must not get (PyTorch above all), so each has its own .venv in its
# example folder, and the backend runs its script as a subprocess from there. A lab whose environment is missing says
# what to run; this script runs it for you.
#
#   tools/setup-envs.sh                  list the environments and whether each is set up
#   tools/setup-envs.sh lora tabular     set up those (again, if they exist: it reinstalls the pinned packages)
#   tools/setup-envs.sh all              set up every one
#   tools/setup-envs.sh check-hf         check the Hugging Face sign-in and the gated models Idol needs
#
# Needs Python 3.12 (python3.12 on the PATH, or PYTHON=/path/to/python3.12). Run it from anywhere in the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PYTHON:-python3.12}"

# name | folder | lab page | what it is
ENVS=(
  "claude-agent-sdk|examples/claude-agent-sdk|/coding-agent|the coding agent on the Claude Agent SDK (about 350 MB)"
  "tabular|examples/tabular|/tabular|TabPFN and gradient boosting (about 1.3 GB, PyTorch)"
  "lora|examples/lora|/lora|LoRA fine-tuning of SmolLM2 (about 1 GB, PyTorch)"
  "image-to-3d|examples/image-to-3d|/image-to-3d|Idol, one photo to a 3D object (about 1 GB, PyTorch; 5 GB of weights on first use)"
  "voice-agent|examples/voice-agent|/voice-agent|the local Kokoro voice (about 170 MB, plus 340 MB of model files)"
)

GATED=("facebook/dinov3-vith16plus-pretrain-lvd1689m" "black-forest-labs/FLUX.2-dev")

field() { echo "$1" | cut -d'|' -f"$2"; }

list() {
  echo "Environments (set up with: tools/setup-envs.sh <name>... or all):"
  for e in "${ENVS[@]}"; do
    local name folder state
    name=$(field "$e" 1); folder=$(field "$e" 2)
    if [[ -x "$ROOT/$folder/.venv/bin/python" ]]; then state="set up"; else state="missing"; fi
    printf "  %-17s %-8s %-14s %s\n" "$name" "$state" "$(field "$e" 3)" "$(field "$e" 4)"
  done
}

need_python() {
  if ! command -v "$PY" >/dev/null 2>&1; then
    echo "Python 3.12 not found as '$PY'. Install it (macOS: brew install python@3.12) or set PYTHON=/path/to/python3.12." >&2
    exit 1
  fi
}

# Checks the Hugging Face sign-in, and that this account may download the gated models Idol needs. The token is read
# by huggingface_hub from its own cache (~/.cache/huggingface/token), shared by every environment, and never printed.
check_hf() {
  local py=""
  for f in image-to-3d lora; do
    [[ -x "$ROOT/examples/$f/.venv/bin/python" ]] && { py="$ROOT/examples/$f/.venv/bin/python"; break; }
  done
  if [[ -z "$py" ]]; then
    echo "Set up lora or image-to-3d first: the check runs in one of their environments." >&2
    return 1
  fi
  "$py" -I - "${GATED[@]}" <<'EOF'
import sys
from huggingface_hub import auth_check, whoami
from huggingface_hub.errors import GatedRepoError, HfHubHTTPError, LocalTokenNotFoundError

try:
    me = whoami()
except (LocalTokenNotFoundError, HfHubHTTPError):
    print("Not signed in to Hugging Face. Run: examples/image-to-3d/.venv/bin/hf auth login")
    sys.exit(1)
token = me.get("auth", {}).get("accessToken", {})
role = token.get("role", "?")
scoped = [p for s in token.get("fineGrained", {}).get("scoped", []) for p in s.get("permissions", [])]
print(f"Signed in as {me['name']} (token: {role}).")
if role == "fineGrained":
    can_write = "repo.write" in scoped
else:
    can_write = role == "write"
print("  Publishing a LoRA adapter (/lora):", "allowed" if can_write else "needs a token with write access to your repos")
ok = True
for repo in sys.argv[1:]:
    try:
        auth_check(repo)
        print(f"  {repo}: access granted")
    except GatedRepoError:
        ok = False
        print(f"  {repo}: no access yet. Accept its terms at https://huggingface.co/{repo} (approval can take a while;"
              " see https://huggingface.co/settings/gated-repos). A fine-grained token also needs 'Read access to"
              " contents of all public gated repos you can access'.")
    except HfHubHTTPError as e:
        ok = False
        print(f"  {repo}: could not check ({e.__class__.__name__})")
sys.exit(0 if ok else 1)
EOF
}

setup() {
  local e="$1" name folder
  name=$(field "$e" 1); folder="$ROOT/$(field "$e" 2)"
  echo
  echo "== $name: $(field "$e" 4)"
  [[ -x "$folder/.venv/bin/python" ]] || "$PY" -m venv "$folder/.venv"
  "$folder/.venv/bin/python" -m pip install --quiet --upgrade pip
  "$folder/.venv/bin/pip" install -r "$folder/requirements.txt"

  case "$name" in
    voice-agent)  # the model files the voice server reads (see examples/voice-agent/README.md)
      local dir="$ROOT/generated/voice-agent/kokoro"
      mkdir -p "$dir"
      for f in kokoro-v1.0.onnx voices-v1.0.bin; do
        [[ -s "$dir/$f" ]] || curl -fL -o "$dir/$f" "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$f"
      done ;;
    lora)
      echo "To publish adapters from /lora: examples/lora/.venv/bin/hf auth login (a token with write access)." ;;
    image-to-3d)
      echo "Idol needs two gated models. See examples/image-to-3d/README.md, then run: tools/setup-envs.sh check-hf" ;;
  esac
  echo "== $name: ready. Open $(field "$e" 3) with the backend running."
}

if [[ $# -eq 0 ]]; then list; exit 0; fi
if [[ "$1" == "check-hf" ]]; then check_hf; exit $?; fi

need_python
wanted=("$@")
if [[ "$1" == "all" ]]; then
  wanted=()
  for e in "${ENVS[@]}"; do wanted+=("$(field "$e" 1)"); done
fi
for w in "${wanted[@]}"; do
  found=""
  for e in "${ENVS[@]}"; do [[ "$(field "$e" 1)" == "$w" ]] && found="$e"; done
  if [[ -z "$found" ]]; then echo "Unknown environment '$w'." >&2; list; exit 1; fi
  setup "$found"
done
