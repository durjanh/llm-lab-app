"""Week 20 checks: the scaling law is recovered, the prompt is well formed, LoRA's saving, a model that learns."""

import pytest

from conftest import need_torch


def test_power_law_recovered(mod):
    a, b = mod.fit_power_law(mod.SIZES, mod.LOSSES, floor=1.7)
    assert b == pytest.approx(0.34, abs=1e-6)
    assert a == pytest.approx(410, rel=1e-6)
    bigger = mod.predict_loss(1e9, a, b, 1.7)
    assert 1.7 < bigger < mod.LOSSES[-1]  # better than any model trained, never below the floor


def test_few_shot_prompt(mod):
    p = mod.few_shot_prompt([("cheap", "positive"), ("broke", "negative")], "lovely", "Label the sentiment.")
    assert p == (
        "Label the sentiment.\n\nInput: cheap\nOutput: positive\n\nInput: broke\nOutput: negative"
        "\n\nInput: lovely\nOutput:"
    )


def test_lora_saving(mod):
    full, lora = mod.lora_params(4096, 4096, 8)
    assert full == 16_777_216 and lora == 65_536
    assert full / lora == 256


def test_char_model_learns(mod):
    need_torch()
    text = "the kettle sang on the stove. the cat watched the kettle. " * 3
    first, last = mod.train_char_model(text)
    assert last < first / 2
