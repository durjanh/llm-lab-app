"""Runs before any test module imports the backend."""
import os

# The tests describe the lab with Claude as the default, whatever .env says: a local model in .env would change the
# default model and the model list. setdefault in python/settings.py keeps this empty value over the one in .env.
os.environ["LLM_LAB_LOCAL_MODEL"] = ""
