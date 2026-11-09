"""Checkpoints and resume: survive a crash without paying twice.

The framework saves the workflow's state after every superstep. The third step here fails once on purpose. A brand-new
workflow object then resumes from the last checkpoint: the first two steps don't run again and aren't paid for again.

    python 11_checkpoint_resume.py
"""
from __future__ import annotations

import tempfile

from agent_framework import Agent, Executor, FileCheckpointStorage, WorkflowBuilder, WorkflowContext, handler
from typing_extensions import Never

from _wf import Lab, drive, graph, main

TITLE = "Checkpoint and resume"
TASK = "Write a two-line announcement of a summer sale on e-bike helmets."


class Step(Executor):
    def __init__(self, id: str, agent: Agent):
        super().__init__(id=id)
        self.agent = agent

    @handler
    async def work(self, text: str, ctx: WorkflowContext[str]) -> None:
        await ctx.send_message((await self.agent.run(text)).text)


class Publish(Executor):
    def __init__(self, crash: bool):
        super().__init__(id="publish")
        self.crash = crash

    @handler
    async def publish(self, text: str, ctx: WorkflowContext[Never, str]) -> None:
        if self.crash:
            raise ConnectionError("The publishing system is down.")
        await ctx.yield_output(text)


def make(lab: Lab, storage: FileCheckpointStorage, crash: bool):
    draft = Step("draft", lab.agent("drafter", "Write what is asked. Two lines at most."))
    polish = Step("polish", lab.agent("polisher", "Tighten this text. Return only the text."))
    publish = Publish(crash)
    return (WorkflowBuilder(start_executor=draft, name="checkpointed_post", checkpoint_storage=storage)
            .add_edge(draft, polish).add_edge(polish, publish).build())


async def run(lab: Lab, task: str) -> None:
    trace = lab.trace
    with tempfile.TemporaryDirectory() as folder:
        storage = FileCheckpointStorage(folder)
        workflow = make(lab, storage, crash=True)
        trace.event("graph", **graph(workflow))
        try:
            await drive(workflow, task, trace)
        except Exception as exc:  # the framework may wrap the step's error
            trace.event("note", text=f"First attempt crashed: {exc}. Calls so far: {trace.calls}.")
        latest = await storage.get_latest(workflow_name=workflow.name)
        calls = trace.calls
        trace.event("note", text=f"Resuming from checkpoint {latest.checkpoint_id[:8]}, in a new workflow object.")
        await drive(make(lab, storage, crash=False), None, trace, checkpoint_id=latest.checkpoint_id)
        trace.event("note", text=f"Model calls made while resuming: {trace.calls - calls}. Drafting and polishing were not repeated.")


if __name__ == "__main__":
    main(__file__)
