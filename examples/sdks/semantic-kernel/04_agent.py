"""Task 4 in Semantic Kernel: an autonomous agent with a step limit, a trace of every tool call, and human approval
before the write tool runs. Approval and tracing are an auto-function-invocation filter: it wraps every tool call
the kernel makes, and can refuse one by setting a result instead of calling next().

    python 04_agent.py [--auto-approve]
"""
import argparse
import asyncio

from sk_common import EngagementsPlugin, WritePlugin, azure_service
from semantic_kernel import Kernel
from semantic_kernel.agents import ChatCompletionAgent
from semantic_kernel.connectors.ai import FunctionChoiceBehavior
from semantic_kernel.connectors.ai.open_ai import AzureChatPromptExecutionSettings
from semantic_kernel.filters import AutoFunctionInvocationContext, FilterTypes
from semantic_kernel.functions import FunctionResult, KernelArguments
from shared import checks, engagements, tasks

MAX_STEPS = 10  # model round trips that may call tools


async def main(auto_approve: bool) -> None:
    kernel = Kernel()

    @kernel.filter(FilterTypes.AUTO_FUNCTION_INVOCATION)
    async def approval_and_trace(context: AutoFunctionInvocationContext, next):  # noqa: A002 (SK's name)
        args = {k: v for k, v in (context.arguments or {}).items()}
        print(f"  step {context.request_sequence_index + 1}: {context.function.name}({args})")
        if context.function.name in engagements.WRITE_TOOLS and not checks.approve(context.function.name, args, auto_approve):
            context.function_result = FunctionResult(function=context.function.metadata,
                                                     value="A person declined this call. Do not retry it.")
            return  # not calling next(): the tool never runs
        await next(context)

    settings = AzureChatPromptExecutionSettings(
        function_choice_behavior=FunctionChoiceBehavior.Auto(maximum_auto_invoke_attempts=MAX_STEPS))
    agent = ChatCompletionAgent(kernel=kernel, service=azure_service(), name="reviewer", instructions=tasks.SYSTEM,
                                plugins=[EngagementsPlugin(), WritePlugin()], arguments=KernelArguments(settings=settings))
    response = await agent.get_response(messages=tasks.GOAL)
    print(f"\n{response.content}")
    checks.agent_ok()


parser = argparse.ArgumentParser()
parser.add_argument("--auto-approve", action="store_true")
asyncio.run(main(parser.parse_args().auto_approve))
