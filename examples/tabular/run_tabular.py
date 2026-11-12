"""Runs TabPFN and a gradient-boosting baseline on one CSV and prints the results as JSON.

The lab's /tabular page starts this script from this folder's own Python 3.12 environment, because TabPFN needs
PyTorch, which the lab's main environment does not have. It reads one job from stdin:

    {"csv": "path/to/data.csv", "target": "churned", "task": "classification" | "regression",
     "test_size": 0.25, "seed": 0}

and writes progress lines ({"type": "progress", ...}) then one result line ({"type": "result", ...}) to stdout, each
as JSON on its own line. Every number on the page comes from here: the model on the page only explains them.

TabPFN reads the training rows as its context and predicts the test rows in one forward pass, so there is no training
step for each dataset. On a CPU it is limited to small tables: this script refuses more than MAX_TRAIN_ROWS training
rows or MAX_COLUMNS feature columns. The weights are TabPFN v2 (Prior Labs License 1.1: Apache 2.0 with an
attribution clause); the later v2.5 and v2.6 weights are for non-commercial use only.
"""
from __future__ import annotations

import json
import sys
import time
import warnings

MAX_TRAIN_ROWS = 3000
MAX_COLUMNS = 100
SAMPLE_ROWS = 8  # test rows shown with their predictions


def say(event: dict) -> None:
    print(json.dumps(event), flush=True)


def fail(message: str) -> None:
    say({"type": "error", "message": message})
    sys.exit(1)


def tabpfn_model(task: str):
    """TabPFN on the v2 weights, on the CPU."""
    from tabpfn import TabPFNClassifier, TabPFNRegressor
    cls = TabPFNClassifier if task == "classification" else TabPFNRegressor
    try:
        from tabpfn.constants import ModelVersion
        return cls.create_default_for_version(ModelVersion.V2, device="cpu")
    except (ImportError, AttributeError):  # older tabpfn releases load the v2 weights by default
        return cls(device="cpu")


def baseline_model(task: str, seed: int):
    from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
    if task == "classification":
        return HistGradientBoostingClassifier(random_state=seed)
    return HistGradientBoostingRegressor(random_state=seed)


def r(x: float, places: int = 4) -> float:
    return round(float(x), places)


def score(task: str, y_test, pred, proba, classes) -> dict:
    """The metrics for one model's predictions on the test rows."""
    from sklearn import metrics
    if task == "classification":
        out = {"accuracy": r(metrics.accuracy_score(y_test, pred)),
               "balanced_accuracy": r(metrics.balanced_accuracy_score(y_test, pred))}
        try:
            if len(classes) == 2:
                out["roc_auc"] = r(metrics.roc_auc_score(y_test, proba[:, 1]))
            else:
                out["roc_auc"] = r(metrics.roc_auc_score(y_test, proba, multi_class="ovr", labels=classes))
        except ValueError:  # a class missing from the test rows
            out["roc_auc"] = None
        out["confusion"] = {"labels": [str(c) for c in classes],
                            "matrix": metrics.confusion_matrix(y_test, pred, labels=classes).tolist()}
        return out
    return {"rmse": r(metrics.root_mean_squared_error(y_test, pred)),
            "mae": r(metrics.mean_absolute_error(y_test, pred)),
            "r2": r(metrics.r2_score(y_test, pred))}


def run(job: dict) -> dict:
    import numpy as np
    import pandas as pd
    from sklearn.model_selection import train_test_split

    task, target, seed = job["task"], job["target"], int(job.get("seed", 0))
    df = pd.read_csv(job["csv"])
    if target not in df.columns:
        fail(f"There is no column called {target!r}.")
    df = df.dropna(subset=[target])
    X, y = df.drop(columns=[target]), df[target]
    if X.shape[1] > MAX_COLUMNS:
        fail(f"TabPFN on a CPU here takes at most {MAX_COLUMNS} columns; this table has {X.shape[1]}.")
    # Text columns become pandas categories, which both models accept. Text with very many different values (an
    # identifier, a free-text note) cannot help either model and breaks the trees, so it is left out and reported.
    dropped = []
    for col in list(X.columns):
        if pd.api.types.is_numeric_dtype(X[col]):
            continue
        if X[col].nunique() > min(200, 0.5 * len(X)):
            dropped.append(col)
            X = X.drop(columns=[col])
        else:
            X[col] = X[col].astype("category")
    if dropped:
        say({"type": "progress", "step": f"Left out text columns with too many different values: {', '.join(dropped)}"})
    if X.shape[1] == 0:
        fail("No usable columns are left to predict from.")
    if task == "classification":
        y = y.astype(str)
        if y.nunique() < 2:
            fail("The target has only one value, so there is nothing to predict.")
        if y.nunique() > 10:
            fail("TabPFN v2 predicts at most 10 classes; this target has " f"{y.nunique()}.")
    else:
        y = pd.to_numeric(y, errors="coerce")
        keep = y.notna()
        X, y = X[keep], y[keep]
    test_size = float(job.get("test_size", 0.25))
    stratify = y if task == "classification" and y.value_counts().min() >= 2 else None
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=test_size, random_state=seed,
                                                        stratify=stratify)
    if len(X_train) > MAX_TRAIN_ROWS:  # TabPFN's context: a fixed random sample of the training rows
        X_train, y_train = X_train.sample(MAX_TRAIN_ROWS, random_state=seed), y_train.sample(MAX_TRAIN_ROWS, random_state=seed)
        say({"type": "progress", "step": f"Training rows cut to {MAX_TRAIN_ROWS}, TabPFN's limit here"})

    results = {}
    sample_idx = X_test.index[:SAMPLE_ROWS]
    for name, make in (("tabpfn", lambda: tabpfn_model(task)), ("gradient_boosting", lambda: baseline_model(task, seed))):
        say({"type": "progress", "step": f"{'TabPFN' if name == 'tabpfn' else 'Gradient boosting'}: fitting"})
        model = make()
        t0 = time.perf_counter()
        model.fit(X_train, y_train)
        fit_s = time.perf_counter() - t0
        say({"type": "progress", "step": f"{'TabPFN' if name == 'tabpfn' else 'Gradient boosting'}: predicting"})
        t0 = time.perf_counter()
        pred = model.predict(X_test)
        proba = model.predict_proba(X_test) if task == "classification" else None
        predict_s = time.perf_counter() - t0
        classes = list(model.classes_) if task == "classification" else []
        rows = []
        for i, idx in enumerate(X_test.index):
            if idx not in sample_idx:
                continue
            row = {"actual": y_test.loc[idx] if task == "classification" else r(y_test.loc[idx]),
                   "predicted": str(pred[i]) if task == "classification" else r(pred[i])}
            if proba is not None:
                row["probabilities"] = {str(c): r(p, 3) for c, p in zip(classes, proba[i])}
            rows.append(row)
        results[name] = {"metrics": score(task, y_test, pred, proba, classes), "fit_s": r(fit_s, 3),
                         "predict_s": r(predict_s, 3), "sample": rows}
        if task == "regression":
            results[name]["scatter"] = [[r(a), r(b)] for a, b in zip(y_test.to_numpy()[:200], np.asarray(pred)[:200])]
    import tabpfn
    return {"type": "result", "task": task, "target": target, "rows": int(len(df)), "train_rows": int(len(X_train)),
            "test_rows": int(len(X_test)), "columns": int(X.shape[1]), "dropped_columns": dropped, "results": results,
            "versions": {"tabpfn": getattr(tabpfn, "__version__", "?"), "weights": "TabPFN v2"}}


def main() -> None:
    warnings.filterwarnings("ignore")
    try:
        job = json.loads(sys.stdin.read())
    except json.JSONDecodeError:
        fail("The job must be JSON on stdin.")
    try:
        say(run(job))
    except SystemExit:
        raise
    except Exception as exc:  # the page shows the message; the traceback goes to stderr
        import traceback
        traceback.print_exc()
        fail(f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
