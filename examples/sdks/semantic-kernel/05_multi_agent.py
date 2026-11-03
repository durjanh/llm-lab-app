"""Task 5 in Semantic Kernel: a SequentialOrchestration. The researcher (with the tools) runs first; its answer is
passed to the writer. Orchestrations run on an agent runtime (InProcessRuntime here)."""
import asyncio

from sk_common import EngagementsPlugin, azure_service
from semantic_kernel.agents import ChatCompletionAgent, SequentialOrchestration
from semantic_kernel.agents.runtime import InProcessRuntime
from shared import checks, tasks


async def main() -> None:
    service = azure_service()
    researcher = ChatCompletionAgent(service=service, name="researcher", instructions=tasks.RESEARCHER, plugins=[EngagementsPlugin()])
    writer = ChatCompletionAgent(service=service, name="writer", instructions=tasks.WRITER)
    orchestration = SequentialOrchestration(
        members=[researcher, writer],
        agent_response_callback=lambda m: print(f"  [{m.name}] {str(m.content)[:120]}…"))
    runtime = InProcessRuntime()
    runtime.start()
    result = await orchestration.invoke(task=tasks.UPDATE_BRIEF, runtime=runtime)
    update = await result.get(timeout=180)
    await runtime.stop_when_idle()
    print(f"\n{update}")
    checks.update_ok(str(update))


asyncio.run(main())
