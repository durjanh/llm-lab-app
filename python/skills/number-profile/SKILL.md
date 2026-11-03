---
name: number-profile
description: Profiles whole numbers with a bundled script - whether each is prime, its prime factors, its digit sum and how many divisors it has. Use whenever a task asks to profile, analyse, tabulate or chart whole numbers.
---

# Number profile

Never work these values out by hand. Run the bundled script and use its output.

## Run it

```bash
python scripts/profile.py 12 17 360      # specific numbers
python scripts/profile.py --range 2 20   # every number from 2 to 20
```

Run it from this skill's folder, or give the full path to `scripts/profile.py`.

It prints one JSON object per line:

```json
{"n": 12, "prime": false, "factors": [2, 2, 3], "digit_sum": 3, "divisors": 6}
```

## When you make a document from it

- Keep the columns in this order: n, prime, factors, digit_sum, divisors.
- Write the factors as a product, for example `2 × 2 × 3`.
- Say in the document that the values came from the number-profile skill.
