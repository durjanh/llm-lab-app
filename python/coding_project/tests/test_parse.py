import unittest
from datetime import date
from decimal import Decimal
from pathlib import Path

from ledger import parse_amount, parse_date, read_csv

SAMPLE = Path(__file__).resolve().parents[1] / "data" / "sample.csv"


class ParseTests(unittest.TestCase):
    def test_amounts(self):
        self.assertEqual(parse_amount("-12.00"), Decimal("-12.00"))
        self.assertEqual(parse_amount("£1,234.50"), Decimal("1234.50"))

    def test_dates_are_day_first(self):
        self.assertEqual(parse_date("03/02/2026"), date(2026, 2, 3))
        self.assertEqual(parse_date("31/01/2026"), date(2026, 1, 31))

    def test_reads_the_sample(self):
        rows = read_csv(SAMPLE)
        self.assertEqual(len(rows), 10)
        self.assertEqual(rows[-1].category, "uncategorised")


if __name__ == "__main__":
    unittest.main()
