"""Reading a bank export: one transaction per line, as date,description,amount,category."""
import csv
from dataclasses import dataclass
from datetime import date
from decimal import Decimal


@dataclass(frozen=True)
class Transaction:
    day: date
    description: str
    amount: Decimal  # negative for money going out
    category: str


def parse_amount(text: str) -> Decimal:
    """An amount such as '£1,234.50' or '-12.00' as a Decimal."""
    return Decimal(text.strip().replace("£", ""))


def parse_date(text: str) -> date:
    """A date written day first, as DD/MM/YYYY."""
    day, month, year = text.strip().split("/")
    return date(int(year), int(day), int(month))


def read_csv(path: str) -> list[Transaction]:
    """Every transaction in a bank export. A blank category becomes 'uncategorised'."""
    with open(path, newline="", encoding="utf-8") as f:
        return [Transaction(parse_date(row["date"]), row["description"].strip(), parse_amount(row["amount"]),
                            row["category"].strip() or "uncategorised")
                for row in csv.DictReader(f)]
