"""Gives every week's tests a `mod` fixture: the week's exercise, or its solution when ML_COURSE_SOLUTIONS=1."""

import importlib.util
import os
import pathlib

import pytest

SOLUTIONS = os.environ.get("ML_COURSE_SOLUTIONS") == "1"


def load(folder: pathlib.Path, name: str):
    """Imports `<folder>/<name>.py` under a unique module name, so weeks never clash."""
    spec = importlib.util.spec_from_file_location(f"{folder.name}_{name}", folder / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def mod(request):
    """The code under test for the folder this test file is in."""
    folder = pathlib.Path(request.path).parent
    return load(folder, "solution" if SOLUTIONS else "exercise")


def need_torch():
    """Skips the calling test, with a message, when PyTorch is not installed."""
    return pytest.importorskip("torch", reason="PyTorch is optional: pip install -r requirements-torch.txt")
