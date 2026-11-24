"""The Python black boxes give exactly what the page gives, and the budget and the log behave.

reference_values.json was computed by running frontend/src/pages/capstone/functions.ts and tuning/gp.ts under
Node. If those files change, recompute it the same way (see the README) and these tests will say whether the port
still matches.
"""

import json
import pathlib
import sys

import numpy as np
import pytest

HERE = pathlib.Path(__file__).parent
sys.path.insert(0, str(HERE))

import blackbox  # noqa: E402
import starter  # noqa: E402

REF = json.loads((HERE / "reference_values.json").read_text())


def test_generator_matches_javascript():
    rand = blackbox.mulberry32(42)
    assert [rand(), rand(), rand()] == REF["mulberry42"]


def test_first_draw_matches_the_page_test():
    # The same number the page's own TypeScript test pins.
    assert blackbox.mulberry32(1)() == 0.6270739405881613


def test_rounding_matches_javascript():
    assert blackbox.tidy([0.12345, 1.2, -0.1, 0.0005, 0.2225]) == REF["tidy"]


@pytest.mark.parametrize("box_id", sorted(blackbox.BLACK_BOXES))
def test_box_matches_the_page(box_id):
    box, ref = blackbox.BLACK_BOXES[box_id], REF[box_id]
    mid = [0.5] * len(box.inputs)
    assert blackbox.starting_points(box) == ref["start"]
    assert blackbox.clean(box, mid) == pytest.approx(ref["cleanMid"], abs=1e-12)
    assert blackbox.measure(box, mid, 3) == pytest.approx(ref["measureMid3"], abs=1e-12)
    assert blackbox.measure(box, mid, 9) == pytest.approx(ref["measureMid9"], abs=1e-12)


def test_budget_and_log(tmp_path):
    ch = blackbox.Challenge("oven", log=tmp_path / "oven.csv")
    assert len(ch.xs) == 4 and ch.rounds_done == 0
    with pytest.raises(ValueError):
        ch.query_round([[0.5, 0.5]])  # a round is two points
    with pytest.raises(ValueError):
        ch.query_round([[0.5, 1.5], [0.1, 0.1]])
    ys = ch.query_round([[0.6, 0.35], [0.1, 0.9]])
    again = blackbox.Challenge("oven", log=tmp_path / "oven.csv")  # restart from the log
    assert again.ys[-2:] == ys and again.rounds_done == 1


def test_starter_improves_on_the_starting_points(tmp_path):
    ch = blackbox.Challenge("oven", log=tmp_path / "oven.csv")
    start_best = max(ch.ys)
    for _ in range(ch.box.rounds):
        ch.query_round(starter.propose(np.array(ch.xs), np.array(ch.ys), ch.box.per_round, seed=len(ch.xs)))
    assert ch.best()[1] > start_best
    with pytest.raises(RuntimeError):
        ch.query_round([[0.5, 0.5], [0.5, 0.5]])
