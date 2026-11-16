"""Publishes a saved LoRA adapter to Hugging Face, under the account signed in with `hf auth login` in this folder's
.venv. The lab never sees the token: huggingface_hub reads it from its own cache.

It reads one job as JSON on stdin and writes one JSON line on stdout (a result or an error):

    {"action": "whoami"}
    {"action": "check", "repo_id": "you/name"}           whether it exists, and whether it is private
    {"action": "publish", "adapter_dir": ..., "model_id": ..., "repo_id": "you/name", "private": true, "card": "...",
     "replace_existing": false}

An existing repo is never written to unless replace_existing says the person saw what it replaces, and never when
they asked for private and it is public (an upload does not change a repo's visibility).

What is uploaded: adapter_model.safetensors, adapter_config.json (with the base model named by its Hugging Face id,
not the local folder it was loaded from) and README.md (the card). Never result.json or anything else in the folder.
A file that would still show a folder on this machine stops the upload before anything is sent.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

import lora_data  # noqa: E402  (beside this script)

SIGN_IN = "Not signed in to Hugging Face. Run: examples/lora/.venv/bin/hf auth login (a token with write access)."


def emit(event: dict) -> None:
    print(json.dumps(event), flush=True)


def main() -> int:
    job = json.loads(sys.stdin.read())
    try:
        from huggingface_hub import HfApi
        from huggingface_hub.errors import LocalTokenNotFoundError, RepositoryNotFoundError

        api = HfApi()
        try:
            me = api.whoami()
        except LocalTokenNotFoundError:
            emit({"type": "error", "message": SIGN_IN, "signed_in": False})
            return 1
        if job["action"] == "whoami":
            emit({"type": "result", "name": me["name"], "orgs": [o["name"] for o in me.get("orgs", [])]})
            return 0
        repo_id = job["repo_id"]
        if not lora_data.REPO_ID.match(repo_id):
            raise ValueError(f"{repo_id!r} is not a repo name like you/name.")
        try:
            existing = api.repo_info(repo_id)
        except RepositoryNotFoundError:  # also someone else's private repo; create_repo then says it is taken
            existing = None
        if job["action"] == "check":
            emit({"type": "result", "exists": existing is not None,
                  "private": bool(existing.private) if existing else None})
            return 0
        if existing is not None and not job.get("replace_existing"):
            raise ValueError(f"{repo_id} already exists. Choose another name, or agree to replace its README and "
                             "adapter files.")
        if existing is not None and job["private"] and not existing.private:
            raise ValueError(f"{repo_id} is public, and an upload would not make it private. Make it private on its "
                             "settings page first, or choose another name.")
        with tempfile.TemporaryDirectory() as stage:
            # Strings that must not appear in anything published: this machine's home folder and the repo's own path.
            private_strings = [s for s in (str(Path.home()), str(Path(job["adapter_dir"]).resolve().parents[3]))
                               if len(s) > 1]
            files = lora_data.stage(job["adapter_dir"], stage, job["model_id"], job["card"], private_strings)
            if existing is None:
                api.create_repo(repo_id, private=bool(job["private"]), repo_type="model")
            commit = api.upload_folder(repo_id=repo_id, folder_path=stage, repo_type="model",
                                       commit_message="Upload LoRA adapter")
        info = api.repo_info(repo_id)  # an existing repo keeps its own visibility: report what it is, not what was asked
        emit({"type": "result", "url": f"https://huggingface.co/{repo_id}", "private": bool(info.private),
              "commit": getattr(commit, "oid", ""), "files": files, "account": me["name"]})
        return 0
    except Exception as exc:  # noqa: BLE001  (every failure becomes one line the page can show)
        emit({"type": "error", "message": f"{type(exc).__name__}: {exc}"[:600]})
        return 1


if __name__ == "__main__":
    sys.exit(main())
