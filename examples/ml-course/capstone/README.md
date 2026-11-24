# Capstone: optimise a black box

Five invented black boxes, from a two-dial oven to a six-gain drone controller. Each takes inputs scaled to 0–1 and
returns a score, sometimes with noise. You see only what you ask for, and every box has a budget: a few starting
points, then ten rounds of two or three queries. Find the best settings you can within it, and explain how.

These are the same boxes as the lab's `/capstone` page, to the last decimal: a query here returns what it returns
there (`test_capstone.py` checks this against values computed by the page's own code). Use whichever you prefer, or
both: plan on the page, run your optimiser here.

## Run it

From `examples/ml-course`:

```sh
.venv/bin/python capstone/starter.py oven --rounds 1     # one round with the starter optimiser
.venv/bin/python capstone/starter.py oven                # the rest of the rounds
.venv/bin/pytest capstone                                # the checks
```

Or from your own code:

```python
import sys; sys.path.insert(0, "capstone")
from blackbox import Challenge

ch = Challenge("greenhouse")
print(ch.xs, ch.ys)                       # the starting points and their readings
ch.query_round([[0.3, 0.7, 0.5], [0.7, 0.3, 0.4]])
print(ch.best())
```

Every query is logged to `generated/ml-course/capstone/<box>.csv` at the repo root (gitignored), and a new
`Challenge` picks up where the log stops. Delete the file to start again. The outputs are always recomputed from the
points, so editing a number in the log changes nothing.

## The project

`starter.py` is a plain Gaussian process with expected improvement and a fixed length scale. It works on the oven
and struggles as the boxes get wider. Improving it is the project. Some directions:

- Fit the length scale and noise to the data (maximise the marginal likelihood) instead of fixing them.
- Try other acquisition functions: upper confidence bound with a schedule, or Thompson sampling.
- Choose a round's points jointly, so a batch explores more than one idea.
- Narrow the search to a trust region round the best point once one region clearly wins.
- Account for noise: a single lucky reading is not a good point. Re-measure, or judge by the model's mean.

## Writing it up

A portfolio repository that someone can read in five minutes:

1. **The problem.** The box, its inputs and output, and the budget, in a paragraph.
2. **The approach.** Your surrogate model, the acquisition function and its settings, and why. One diagram of the
   loop helps.
3. **Round by round.** A table of what you tried and what you learnt. The page's "Copy as Markdown" button and the
   CSV log give you the raw material.
4. **The result.** The best reading, and the regret once the optimum is revealed on the page. A chart of best value
   against round, with a random-search baseline for comparison.
5. **What you would change.** Honest: what did not work, and what you would try with a bigger budget.
6. **How to run it.** One command that reproduces your rounds from the log.

## If the page's functions change

The reference values come from running the page's `capstone/functions.ts` and `tuning/gp.ts` under Node (with type
stripping) and printing `mulberry32(42)`'s first three numbers, `tidy` on a few values, and each box's starting
points, its clean value at the centre and its readings at query 3 and 9. Rerun that and replace
`reference_values.json`; the tests then show whether the port still matches.
