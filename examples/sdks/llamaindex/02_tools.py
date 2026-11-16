"""Task 2 with LlamaIndex: Python functions as tools (FunctionTool); a FunctionAgent runs the tool loop."""
import asyncio

from _li import llm
from llama_index.core.agent.workflow import FunctionAgent

from shared import checks, engagements, tasks

# tools=[...] takes plain functions: each becomes a FunctionTool, the schema from the signature and docstring.
agent = FunctionAgent(tools=engagements.READ_TOOLS, llm=llm(), system_prompt=tasks.SYSTEM)


async def main() -> None:
    answer = str(await agent.run(tasks.QUESTION))  # agent.run needs a running event loop
    print(answer)
    checks.answer_ok("02_tools", answer)


asyncio.run(main())
