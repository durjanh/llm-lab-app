"""Claude on Microsoft Foundry with the Anthropic SDK's Foundry client, signed in with Entra ID (no API key).

Needs: a Foundry resource with a Claude deployment, the Azure RBAC role "Foundry User" or "Cognitive Services
User" on it, Entra ID authentication enabled on the resource, and `az login` (or a managed identity).

    FOUNDRY_RESOURCE=my-resource python foundry.py
"""
import os

from anthropic import AnthropicFoundry
from azure.identity import DefaultAzureCredential, get_bearer_token_provider

RESOURCE = os.environ["FOUNDRY_RESOURCE"]  # the {resource} in https://{resource}.services.ai.azure.com/anthropic
DEPLOYMENT = os.environ.get("FOUNDRY_DEPLOYMENT", "claude-haiku-5-5")  # the model parameter is the DEPLOYMENT name

# The token provider fetches and refreshes Entra tokens; the scope is the one Claude on Foundry documents.
token_provider = get_bearer_token_provider(DefaultAzureCredential(), "https://ai.azure.com/.default")
client = AnthropicFoundry(resource=RESOURCE, azure_ad_token_provider=token_provider)

message = client.messages.create(
    model=DEPLOYMENT,
    max_tokens=512,
    messages=[{"role": "user", "content": "In one sentence, what is a managed deployment of an LLM?"}],
)
print(next(block.text for block in message.content if block.type == "text"))
print(f"tokens in/out: {message.usage.input_tokens}/{message.usage.output_tokens}")
