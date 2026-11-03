"""Task 1 in Semantic Kernel: one call that returns a typed object (response_format on the execution settings)."""
import asyncio

from sk_common import azure_service  # also puts examples/sdks on the path
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai.open_ai import AzureChatPromptExecutionSettings
from semantic_kernel.functions import KernelArguments
from shared import checks, tasks


async def main() -> None:
    agent = ChatCompletionAgent(service=azure_service(), name="triage", instructions="You triage housing complaints.",
                                arguments=KernelArguments(settings=AzureChatPromptExecutionSettings(response_format=tasks.Triage)))
    response = await agent.get_response(messages=tasks.TRIAGE_PROMPT)
    triage = tasks.Triage.model_validate_json(str(response.content))
    print(triage)
    checks.triage_ok(triage)


asyncio.run(main())
