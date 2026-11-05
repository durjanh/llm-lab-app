"""Totals by category and by month."""
from collections import defaultdict
from datetime import date
from decimal import Decimal

from .parse import Transaction


def total_by_category(transactions: list[Transaction]) -> list[tuple[str, Decimal]]:
    """Money out per category, as positive amounts, largest first."""
    totals: dict[str, float] = defaultdict(float)
    for t in transactions:
        if t.amount < 0:
            totals[t.category] += float(-t.amount)
    return sorted(totals.items(), key=lambda kv: kv[1], reverse=True)


def month_key(day: date) -> str:
    """'2026-01' for any day in January 2026."""
    return day.strftime("%Y-%m")


def total_by_month(transactions: list[Transaction]) -> list[tuple[str, Decimal]]:
    """The net amount (money in minus money out) per month, oldest first."""
    totals: dict[str, Decimal] = defaultdict(Decimal)
    for t in transactions:
        totals[month_key(t.day)] += t.amount
    return sorted(totals.items())
