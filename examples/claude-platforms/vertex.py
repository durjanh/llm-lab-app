"""Claude on Google Cloud Vertex AI with the Anthropic SDK's Vertex client.

Needs: a Google Cloud project with the Vertex AI API on and Claude enabled in Model Garden, and Application
Default Credentials (`gcloud auth application-default login`, or a service account on the workload). No Anthropic API key.

    GOOGLE_CLOUD_PROJECT=my-project python vertex.py
"""
import os

from anthropic import AnthropicVertex

PROJECT = os.environ["GOOGLE_CLOUD_PROJECT"]
REGION = os.environ.get("GOOGLE_CLOUD_REGION", "global")  # "global", a multi-region ("us", "eu") or one region
MODEL = os.environ.get("VERTEX_MODEL", "claude-haiku-5-5")  # current models use the first-party id; older ones use "id@date"

client = AnthropicVertex(project_id=PROJECT, region=REGION)  # takes a token from Application Default Credentials

message = client.messages.create(
    model=MODEL,
    max_tokens=512,
    messages=[{"role": "user", "content": "In one sentence, what is a managed deployment of an LLM?"}],
)
print(next(block.text for block in message.content if block.type == "text"))
print(f"tokens in/out: {message.usage.input_tokens}/{message.usage.output_tokens}")
