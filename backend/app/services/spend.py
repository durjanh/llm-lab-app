"""Spend tracking for one run of the server: every Claude response is charged here."""
from __future__ import annotations

import logging
import threading
from typing import Any

from ..shared import cost_usd

log = logging.getLogger("llm_lab")


class SpendTracker:
    def __init__(self, budget_usd: float):
        self.budget_usd = budget_usd
        self.spent_usd = 0.0
        self.calls = 0
        self._lock = threading.Lock()

    @property
    def over_budget(self) -> bool:
        return self.spent_usd >= self.budget_usd

    @property
    def remaining_usd(self) -> float:
        return max(0.0, self.budget_usd - self.spent_usd)

    def charge(self, message: Any, model: str) -> float | None:
        cost = cost_usd(message.usage, model)
        with self._lock:
            self.calls += 1
            self.spent_usd += cost or 0
        u = message.usage
        log.info("%s: in %s out %s cache read %s $%.4f · session total $%.4f", model, f"{u.input_tokens:,}",
                 f"{u.output_tokens:,}", f"{getattr(u, 'cache_read_input_tokens', 0) or 0:,}", cost or 0, self.spent_usd)
        return cost

    def charge_usd(self, cost: float, what: str) -> float:
        """A charge in dollars, for services billed by something other than tokens (Azure Language text records)."""
        with self._lock:
            self.calls += 1
            self.spent_usd += cost
        log.info("%s: $%.4f · session total $%.4f", what, cost, self.spent_usd)
        return cost


def money(value: float) -> str:
    return f"${value:.4f}" if value < 0.1 else f"${value:.2f}"
