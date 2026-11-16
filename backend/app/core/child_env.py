"""The environment for a program the backend starts that runs third-party packages (the local voice, image to 3D).

It gets what a program needs to run, never the keys and endpoints the backend loaded from .env. Reading os.environ
here is passing the machine's own settings through, not configuration, which stays in python/settings.py.
"""
from __future__ import annotations

import os

BASE = ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
        # how this machine reaches the internet: without them a download fails behind a proxy or a company CA
        "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE")


HF = ("HF_HOME", "HF_TOKEN", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "HF_ENDPOINT")  # the person's Hugging Face login


def child_env(*extra: str, **set_: str) -> dict[str, str]:
    """BASE and the `extra` names that are set here, plus `set_` (values the backend chooses)."""
    return {k: os.environ[k] for k in (*BASE, *extra) if k in os.environ} | set_
