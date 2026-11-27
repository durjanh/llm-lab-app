# Shared by the tool scripts (sourced, not run). Run from the repo root.

# Prints the calling script's header comment, so its help is always the comment at its top, however long.
usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

# Stops with the next step when the lab's Python environment is missing.
need_venv() {
  [ -x .venv/bin/python ] || {
    echo "No .venv here. Set it up first: python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt" >&2
    exit 1
  }
}
