"""MLOps end to end on one machine: point-in-time features, tracked runs, a registry alias and a drift check.

Invented churn data goes through the steps the /mlops page explains: features joined as of each label date, three
runs tracked in MLflow, the best by validation AUC registered and given the alias `champion`, a batch scored by
loading `models:/churn-model@champion`, and a PSI check on a shifted batch that says whether to retrain.
Everything is written to the repo's gitignored `generated/mlops/`.

    .venv/bin/python run_mlops.py
"""

from __future__ import annotations

import hashlib
import logging
import os
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "generated" / "mlops"
OUT.mkdir(parents=True, exist_ok=True)

# Keep MLflow's own output to warnings, so the steps below are what is printed.
os.environ.setdefault("MLFLOW_ENABLE_ARTIFACTS_PROGRESS_BAR", "false")
os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")
logging.getLogger("mlflow").setLevel(logging.WARNING)
logging.getLogger("alembic").setLevel(logging.WARNING)
warnings.filterwarnings("ignore")

import mlflow  # noqa: E402  (after the logging set-up above)
from mlflow import MlflowClient  # noqa: E402
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.pipeline import make_pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

TRACKING_URI = f"sqlite:///{OUT / 'mlflow.db'}"
ARTIFACTS = (OUT / "artifacts").as_uri()
EXPERIMENT = "churn"
MODEL_NAME = "churn-model"
FEATURES = ["logins_30d", "tickets_90d", "tenure_months", "monthly_spend"]


def make_data(seed: int = 7) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Monthly feature snapshots per customer, and one label per customer: did they leave in the next 30 days."""
    rng = np.random.default_rng(seed)
    months = pd.date_range("2025-07-31", "2026-06-30", freq="ME")
    snapshots, labels = [], []
    for cid in range(1500):
        risk = rng.normal(0, 1)
        label_month = int(rng.integers(3, len(months) - 1))
        p = 1 / (1 + np.exp(-(1.4 * risk - 1.0)))
        churned = rng.random() < p
        tenure0 = int(rng.integers(1, 48))
        for m, date in enumerate(months):
            gone = churned and m > label_month
            snapshots.append(
                {
                    "customer_id": cid,
                    "snapshot_date": date,
                    # After a customer leaves, their activity stops: a value from then would give the answer away.
                    "logins_30d": 0 if gone else max(0, round(rng.normal(14 - 3 * risk, 4))),
                    "tickets_90d": max(0, round(rng.normal(1 + 0.8 * risk, 1))),
                    "tenure_months": tenure0 + m,
                    "monthly_spend": max(5.0, round(rng.normal(42 - 4 * risk, 10), 2)),
                }
            )
        labels.append({"customer_id": cid, "label_date": months[label_month], "churned": int(churned)})
    return pd.DataFrame(snapshots), pd.DataFrame(labels)


def point_in_time(snapshots: pd.DataFrame, labels: pd.DataFrame) -> pd.DataFrame:
    """Each label joined to the latest snapshot on or before its label date, never one from after it."""
    left = labels.sort_values("label_date")
    right = snapshots.sort_values("snapshot_date")
    return pd.merge_asof(
        left, right, left_on="label_date", right_on="snapshot_date", by="customer_id", direction="backward"
    )


def latest_value(snapshots: pd.DataFrame, labels: pd.DataFrame) -> pd.DataFrame:
    """The common mistake: join each customer's newest snapshot, which was taken after the outcome was known."""
    newest = snapshots.sort_values("snapshot_date").groupby("customer_id").tail(1)
    return labels.merge(newest, on="customer_id")


def split_by_time(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Train on older labels, choose on the next block, report on the newest: the order production sees them in."""
    df = df.sort_values("label_date")
    n = len(df)
    return df.iloc[: int(n * 0.6)], df.iloc[int(n * 0.6) : int(n * 0.8)], df.iloc[int(n * 0.8) :]


def data_hash(df: pd.DataFrame) -> str:
    """A short fingerprint of the training table, logged as a tag so a run can be traced to its exact data."""
    return hashlib.sha256(pd.util.hash_pandas_object(df, index=False).values.tobytes()).hexdigest()[:12]


def psi(reference: np.ndarray, current: np.ndarray, bins: int = 10) -> float:
    """Population stability index over the reference sample's deciles."""
    edges = np.quantile(reference, np.linspace(0, 1, bins + 1)[1:-1])
    e = np.bincount(np.searchsorted(edges, reference, side="right"), minlength=bins) / len(reference)
    a = np.bincount(np.searchsorted(edges, current, side="right"), minlength=bins) / len(current)
    e, a = np.clip(e, 1e-4, None), np.clip(a, 1e-4, None)
    return float(np.sum((a - e) * np.log(a / e)))


def auc(model, frame: pd.DataFrame) -> float:
    return float(roc_auc_score(frame["churned"], model.predict_proba(frame[FEATURES])[:, 1]))


def main() -> None:
    mlflow.set_tracking_uri(TRACKING_URI)
    if mlflow.get_experiment_by_name(EXPERIMENT) is None:
        mlflow.create_experiment(EXPERIMENT, artifact_location=ARTIFACTS)
    mlflow.set_experiment(EXPERIMENT)

    snapshots, labels = make_data()
    table = point_in_time(snapshots, labels)
    train, val, test = split_by_time(table)
    fingerprint = data_hash(table[["customer_id", "label_date", "churned", *FEATURES]])
    print(f"1. Features: {len(table)} labelled rows, joined as of each label date (data {fingerprint})")

    # The same model on the leaky join, to show what it does to the offline score.
    leaky_train, leaky_val, _ = split_by_time(latest_value(snapshots, labels))
    leaky = make_pipeline(StandardScaler(), LogisticRegression()).fit(leaky_train[FEATURES], leaky_train["churned"])
    honest = make_pipeline(StandardScaler(), LogisticRegression()).fit(train[FEATURES], train["churned"])
    print(
        f"   Latest-value join: validation AUC {auc(leaky, leaky_val):.3f} (inflated). "
        f"Point-in-time join: {auc(honest, val):.3f}."
    )

    candidates = {
        "logistic-regression": (make_pipeline(StandardScaler(), LogisticRegression(C=1.0)), {"C": 1.0}),
        "random-forest": (
            RandomForestClassifier(n_estimators=300, max_depth=6, random_state=0),
            {"n_estimators": 300, "max_depth": 6},
        ),
        "gradient-boosting": (
            GradientBoostingClassifier(n_estimators=300, learning_rate=0.05, max_depth=3, random_state=0),
            {"n_estimators": 300, "learning_rate": 0.05, "max_depth": 3},
        ),
    }

    print("2. Tracked runs (AUC):")
    results = []
    for name, (model, params) in candidates.items():
        with mlflow.start_run(run_name=name) as run:
            model.fit(train[FEATURES], train["churned"])
            metrics = {"train_auc": auc(model, train), "val_auc": auc(model, val), "test_auc": auc(model, test)}
            mlflow.log_params(params)
            mlflow.log_metrics(metrics)
            mlflow.set_tags({"data_hash": fingerprint, "features": ",".join(FEATURES)})
            # MLflow saves scikit-learn models with skops, which loads only the types it is told to trust. Tree models
            # need their node storage named; that is safe here because this script trained them.
            trusted = None if name == "logistic-regression" else ["sklearn.tree._tree.Tree"]
            info = mlflow.sklearn.log_model(
                model, name="model", input_example=train[FEATURES].head(3), skops_trusted_types=trusted
            )
            results.append((name, run.info.run_id, info.model_uri, metrics))
            print(
                f"   {name:20s} train {metrics['train_auc']:.3f}  val {metrics['val_auc']:.3f}  "
                f"test {metrics['test_auc']:.3f}"
            )

    # Choose on validation only; the test score is read once, afterwards, as the number to report.
    best = max(results, key=lambda r: r[3]["val_auc"])
    version = mlflow.register_model(best[2], MODEL_NAME)
    client = MlflowClient()
    client.set_registered_model_alias(MODEL_NAME, "champion", version.version)
    client.set_model_version_tag(MODEL_NAME, version.version, "data_hash", fingerprint)
    print(
        f"3. Registered {MODEL_NAME} version {version.version} from {best[0]} "
        f"(best validation AUC {best[3]['val_auc']:.3f}, test {best[3]['test_auc']:.3f}); alias champion set"
    )

    champion = mlflow.sklearn.load_model(f"models:/{MODEL_NAME}@champion")
    batch = test.head(5)
    scores = champion.predict_proba(batch[FEATURES])[:, 1]
    print("4. Scored a batch with models:/churn-model@champion:")
    for cid, s in zip(batch["customer_id"], scores):
        print(f"   customer {cid:4d}  churn risk {s:.2f}")

    print("5. Drift check on monthly_spend:")
    rng = np.random.default_rng(1)
    reference = train["monthly_spend"].to_numpy()
    batches = {
        "this month": reference + rng.normal(0, 1, len(reference)),
        "after a price rise": reference * 1.25 + 4,
    }
    for label, current in batches.items():
        value = psi(reference, current)
        verdict = (
            "stable, leave it"
            if value < 0.1
            else "watch it"
            if value < 0.25
            # Drift is a reason to look, not to retrain: check the feed, then the live metric once labels arrive.
            else "real shift: check the feed, and retrain only if the live metric has fallen"
        )
        print(f"   {label:20s} PSI {value:.3f}  {verdict}")

    print(f"\nOpen the runs: .venv/bin/mlflow ui --backend-store-uri {TRACKING_URI}")


if __name__ == "__main__":
    main()
