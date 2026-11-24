"""Week 0 checks: the tools work and each function matches a library answer."""

import numpy as np
import pandas as pd


def test_mean_of(mod):
    assert mod.mean_of([2.0, 4.0, 9.0]) == 5.0


def test_word_counts(mod):
    assert mod.word_counts("The cat sat. The CAT ran!") == {"the": 2, "cat": 2, "sat": 1, "ran": 1}


def test_standardise(mod):
    x = np.array([[1.0, 10.0], [2.0, 20.0], [3.0, 60.0]])
    z = mod.standardise(x)
    assert np.allclose(z.mean(axis=0), 0)
    assert np.allclose(z.std(axis=0), 1)


def test_mean_by_group(mod):
    df = pd.DataFrame({"shop": ["a", "b", "a", "b"], "sales": [1.0, 10.0, 3.0, 20.0]})
    assert mod.mean_by_group(df, "shop", "sales") == {"a": 2.0, "b": 15.0}
