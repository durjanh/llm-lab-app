"""The triage workflow and its activities. Kept apart from run.py because Temporal re-imports this module in a sandbox."""
from datetime import timedelta

from temporalio import activity, workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    # run.py puts automation/ on sys.path, so shared imports here
    import shared


@activity.defn
def classify(email: dict) -> dict:
    return shared.classify(email)


@activity.defn
def draft_reply(email: dict) -> str:
    return shared.draft_reply(email)


@activity.defn
def log_to_crm(results: list[dict]) -> int:
    """Flaky on purpose: fails on attempt 1. Temporal numbers attempts for us, so the activity keeps no state."""
    attempt = activity.info().attempt
    if attempt == 1:
        raise RuntimeError("CRM unavailable (deliberate first-call failure)")
    return attempt


@workflow.defn
class TriageWorkflow:
    @workflow.run
    async def run(self, emails: list[dict]) -> dict:
        retry = RetryPolicy(initial_interval=timedelta(milliseconds=200), backoff_coefficient=2.0, maximum_attempts=4)
        opts = dict(start_to_close_timeout=timedelta(seconds=90), retry_policy=retry)
        results = []
        for e in emails:
            c = await workflow.execute_activity(classify, e, **opts)
            action = shared.route(c)  # deterministic, so safe inside the workflow
            reply = await workflow.execute_activity(draft_reply, e, **opts) if action == "reply" else ""
            results.append(shared.record(e, c, action, reply))
        attempts = await workflow.execute_activity(log_to_crm, results, **opts)
        return {"results": results, "flaky_attempts": attempts}
