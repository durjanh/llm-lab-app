"""Orchestrator and workers: agents as tools, the way Claude Code uses subagents.

The orchestrator stays in charge and calls each worker like a function, with a job it writes itself. Each worker
starts with an empty context and returns only its answer, so the orchestrator's context stays small. Compare handoff,
where control passes over and doesn't come back.

    python 08_orchestrator_workers.py
"""
from agent_framework import function_middleware

from _wf import SHOP, Lab, main

TITLE = "Orchestrator and workers"
TASK = f"Prepare a five-line brief for {SHOP} on whether to offer free e-bike servicing for the first year."
WORKERS = {
    "cost_worker": "Estimate the cost side of the question you are given, with stated assumptions. Under 50 words.",
    "customer_worker": "Say how customers would likely respond to what you are given. Under 50 words.",
}


async def run(lab: Lab, task: str) -> None:
    trace = lab.trace
    trace.event("graph", start="orchestrator", nodes=[{"id": "orchestrator", "agent": True}, *[{"id": w, "agent": True} for w in WORKERS]],
                edges=[{"from": "orchestrator", "to": w, "kind": "tool"} for w in WORKERS])

    @function_middleware
    async def watch(context, call_next) -> None:
        trace.step(context.function.name, "start")
        await call_next()
        trace.step(context.function.name, "done", "".join(c.text or "" for c in context.result))

    tools = [lab.agent(name, prompt).as_tool(name=name, description=prompt, arg_description="The job for this worker")
             for name, prompt in WORKERS.items()]
    orchestrator = lab.agent("orchestrator", "Split the task into jobs and give each worker one. Call workers in the "
                                             "same turn when the jobs are independent. Then write the brief yourself.",
                             tools=tools, middleware=[watch])
    trace.step("orchestrator", "start")
    reply = await orchestrator.run(task)
    trace.step("orchestrator", "done", reply.text)
    trace.event("output", node="orchestrator", text=reply.text)


if __name__ == "__main__":
    main(__file__)
