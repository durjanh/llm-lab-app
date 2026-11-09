"""Runs before any test module imports the backend."""
import os

# The tests describe the lab with Claude as the default and the only models offered, whatever .env says: a local model
# or GPT deployments in .env would change the default model and the model list. Tests that need GPT pass a fake.
# setdefault in python/settings.py keeps these empty values over the ones in .env.
os.environ["LLM_LAB_LOCAL_MODEL"] = ""
os.environ["AZURE_OPENAI_DEPLOYMENTS"] = ""
os.environ["MEDASSIST_SMS_TO"] = ""  # never a real text from a test
os.environ["AFTERCARE_CALL_TO"] = ""  # nor a real call

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def private_transcripts(tmp_path, monkeypatch):
    """Each test keeps its transcripts in its own temporary folder, never in the lab's generated/transcripts."""
    from backend.app.services import transcripts

    original = transcripts.TranscriptArchive.__init__
    monkeypatch.setattr(transcripts.TranscriptArchive, "__init__",
                        lambda self, root: original(self, tmp_path / "transcripts"))
