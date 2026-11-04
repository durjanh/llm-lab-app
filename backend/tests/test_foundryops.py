"""Foundry operations with a fake gateway: quota matched to deployments, metrics fallback, the release gate, tracing."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from backend.app.core.errors import ApiError
from backend.app.main import create_app
from backend.app.services.foundryops import EVAL_SET, f1
from backend.app.settings import Settings
from backend.tests.test_api import LAB, FakeClient

RID = "/subscriptions/sub/resourceGroups/g/providers/Microsoft.CognitiveServices/accounts/lab"


class FakeTools:
    resource_id, media_resource_id, media_endpoint, endpoint = RID, "", "", "https://lab"

    def arm(self, path: str, api_version: str, **params: Any) -> dict:
        if path.endswith("/deployments"):
            return {"value": [{"name": "gpt-5.4-mini", "sku": {"name": "GlobalStandard", "capacity": 100},
                               "properties": {"model": {"name": "gpt-5.4-mini", "version": "1"}, "raiPolicyName": "Microsoft.DefaultV2"}}]}
        if path.endswith("/models"):
            return {"value": [{"name": "gpt-5.4-mini", "version": "1", "lifecycleStatus": "GenerallyAvailable", "deprecation": {"inference": "2027-09-21"}}]}
        if path.endswith("/usages"):
            return {"value": [{"name": {"value": "OpenAI.GlobalStandard.gpt-5.4-mini"}, "currentValue": 200, "limit": 1000, "unit": "Count"},
                              {"name": {"value": "OpenAI.Standard.gpt-4o"}, "currentValue": 0, "limit": 50}]}
        if path.endswith("/metrics"):
            if "$filter" in params and params["metricnames"] == "Ratelimit":
                raise ApiError(502, "azure_error", "does not support requested dimension")
            return {"value": [{"name": {"value": params["metricnames"]}, "unit": "Count", "timeseries": [
                {"metadatavalues": [], "data": [{"timeStamp": "2026-11-03T10:00:00Z", "total": 5, "average": 2}]}]}]}
        return {"location": "uksouth", "name": "lab", "kind": "AIServices", "properties": {}}

    def chat(self, model: str, messages: list[dict], **params: Any) -> dict:
        bad = "all water damage" in messages[0]["content"] or "call centre" in messages[0]["content"]
        return {"choices": [{"message": {"content": json.dumps({"groundedness": 1 if bad else 5, "relevance": 5, "coherence": 5, "reason": "r"})}}],
                "usage": {"prompt_tokens": 300, "completion_tokens": 30}}


def lab(tmp_path: Path, tools: Any) -> TestClient:
    settings = Settings(port=8000, budget_usd=2.0, frontend_dist=tmp_path, models_dir=tmp_path / "none", generated_dir=tmp_path / "gen")
    return TestClient(create_app(settings, client=FakeClient(), tools=tools), base_url="http://localhost:8000")


def test_f1_rewards_overlap_and_punishes_padding() -> None:
    assert f1("£350", "£350") == 1.0 and f1("The excess is £350 for escape of water claims.", "£350") < 0.3


def test_quota_is_matched_to_what_is_deployed_and_metrics_fall_back_when_a_split_is_refused(tmp_path: Path) -> None:
    api = lab(tmp_path, FakeTools())
    [q] = api.get("/api/foundryops/quotas", headers=LAB).json()["quotas"]
    assert q["used"] == 200 and q["this_lab"] == 100  # the rest of the quota is used by other resources in the region
    m = api.get("/api/foundryops/metrics", headers=LAB).json()
    assert {s["metric"] for s in m["series"]} >= {"Ratelimit", "AzureOpenAIRequests"} and m["notes"] == []


def test_the_release_gate_fails_on_ungrounded_answers(tmp_path: Path) -> None:
    r = lab(tmp_path, FakeTools()).post("/api/foundryops/evaluate", headers=LAB).json()
    assert len(r["rows"]) == len(EVAL_SET) and not r["release"]
    assert [row["groundedness"] for row in r["rows"]].count(1) == 2  # the two planted bad answers
