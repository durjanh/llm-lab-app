"""Temporal: the triage workflow as a durable workflow with activities and a retry policy.

Runs against the local dev server that temporalio downloads on first use (no Docker, no account).
"""
import asyncio
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # examples/stack
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # automation
from common import checks  # noqa: E402

import shared  # noqa: E402

NAME = "automation/temporal"
QUEUE = "triage"


async def main() -> None:
    from temporalio.testing import WorkflowEnvironment
    from temporalio.worker import Worker
    from workflows import TriageWorkflow, classify, draft_reply, log_to_crm

    async with await WorkflowEnvironment.start_local() as env:
        with ThreadPoolExecutor(8) as pool:
            async with Worker(env.client, task_queue=QUEUE, workflows=[TriageWorkflow],
                              activities=[classify, draft_reply, log_to_crm], activity_executor=pool):
                out = await env.client.execute_workflow(TriageWorkflow.run, shared.EMAILS,
                                                        id=f"triage-{uuid.uuid4().hex[:8]}", task_queue=QUEUE)
    path = shared.write_results(shared.output_dir("temporal"), out["results"], out["flaky_attempts"])
    ok, detail = shared.check(out["results"], out["flaky_attempts"])
    print("results:", path)
    checks.report(NAME, ok, detail)


if __name__ == "__main__":
    if not shared.need_key():
        checks.skip(NAME, "set ANTHROPIC_API_KEY")
    else:
        asyncio.run(main())
