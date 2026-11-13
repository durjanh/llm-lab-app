"""Claude on Amazon Bedrock with the Anthropic SDK's Mantle client (the Messages API on bedrock-mantle).

Needs: an AWS account, Bedrock model access for the Claude model, and AWS credentials the SDK can find
(`aws configure`, `aws sso login`, environment variables, or an instance role). No Anthropic API key.

    AWS_REGION=us-east-1 python bedrock.py
"""
import os

from anthropic import AnthropicBedrockMantle

REGION = os.environ.get("AWS_REGION", "us-east-1")
MODEL = os.environ.get("BEDROCK_MODEL", "anthropic.claude-haiku-5-5")  # Bedrock ids carry an "anthropic." prefix

client = AnthropicBedrockMantle(aws_region=REGION)  # signs each request with SigV4 from the default AWS credential chain

message = client.messages.create(
    model=MODEL,
    max_tokens=512,
    messages=[{"role": "user", "content": "In one sentence, what is a managed deployment of an LLM?"}],
)
print(next(block.text for block in message.content if block.type == "text"))
print(f"tokens in/out: {message.usage.input_tokens}/{message.usage.output_tokens}")
