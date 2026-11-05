import unittest
from datetime import date
from decimal import Decimal

from ledger import Transaction, month_key, total_by_category, total_by_month


def t(day: str, amount: str, category: str) -> Transaction:
    return Transaction(date.fromisoformat(day), "x", Decimal(amount), category)


class ReportTests(unittest.TestCase):
    def test_money_out_by_category_is_exact(self):
        rows = [t("2026-01-02", "-0.10", "food"), t("2026-01-03", "-0.20", "food"), t("2026-01-04", "-5.00", "travel"),
                t("2026-01-05", "100.00", "salary")]
        self.assertEqual(total_by_category(rows), [("travel", Decimal("5.00")), ("food", Decimal("0.30"))])

    def test_month_key(self):
        self.assertEqual(month_key(date(2026, 1, 31)), "2026-01")

    def test_net_by_month(self):
        rows = [t("2026-01-31", "-10.00", "food"), t("2026-02-01", "50.00", "salary"), t("2026-02-02", "-20.00", "food")]
        self.assertEqual(total_by_month(rows), [("2026-01", Decimal("-10.00")), ("2026-02", Decimal("30.00"))])


if __name__ == "__main__":
    unittest.main()
