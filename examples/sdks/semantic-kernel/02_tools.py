"""Task 2 in Semantic Kernel: a plugin of @kernel_function tools; the kernel runs the tool loop (auto function calling)."""
import asyncio

from sk_common import EngagementsPlugin, azure_service
from semantic_kernel.agents import ChatCompletionAgent
from shared import checks, tasks


async def main() -> None:
    # Plugins on an agent default to FunctionChoiceBehavior.Auto(): the model picks tools, the kernel invokes them.
    agent = ChatCompletionAgent(service=azure_service(), name="analyst", instructions=tasks.SYSTEM, plugins=[EngagementsPlugin()])
    response = await agent.get_response(messages=tasks.QUESTION)
    print(response.content)
    checks.answer_ok("02_tools", str(response.content))


asyncio.run(main())
