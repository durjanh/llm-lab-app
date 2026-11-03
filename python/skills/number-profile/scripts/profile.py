"""Profile whole numbers: prime or not, prime factors, digit sum and number of divisors.

Part of the number-profile skill. Prints one JSON object per number.

    python profile.py 12 17 360
    python profile.py --range 2 20
"""
from __future__ import annotations

import argparse
import json


def factorise(n: int) -> list[int]:
    factors, d = [], 2
    while d * d <= n:
        while n % d == 0:
            factors.append(d)
            n //= d
        d += 1
    return factors + ([n] if n > 1 else [])


def profile(n: int) -> dict:
    factors = factorise(n) if n >= 2 else []
    divisors = 1
    for p in set(factors):
        divisors *= factors.count(p) + 1
    return {"n": n, "prime": len(factors) == 1, "factors": factors,
            "digit_sum": sum(map(int, str(abs(n)))), "divisors": divisors}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("numbers", nargs="*", type=int)
    parser.add_argument("--range", nargs=2, type=int, metavar=("FROM", "TO"), help="every number from FROM to TO")
    args = parser.parse_args()
    numbers = list(range(args.range[0], args.range[1] + 1)) if args.range else args.numbers
    if not numbers:
        parser.error("give some numbers, or --range FROM TO")
    for n in numbers:
        print(json.dumps(profile(n)))


if __name__ == "__main__":
    main()
