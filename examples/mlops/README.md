# MLOps on one machine

The steps the lab's `/mlops` page explains, run for real with MLflow on invented churn data:

1. **Point-in-time features.** Monthly snapshots per customer are joined to each label as of its label date
   (`pandas.merge_asof`, backward). The same model on the latest snapshot instead scores a validation AUC of 1.0,
   because churned customers' later snapshots show no logins: the answer leaks into the features.
2. **Tracked runs.** Logistic regression, a random forest and gradient boosting, each logged with its parameters,
   train, validation and test AUC, the model, and a hash of the training table as a tag.
3. **Registry.** The best run by validation AUC (never by test AUC) is registered as `churn-model` and given the alias
   `champion`.
4. **Scoring.** A batch is scored by loading `models:/churn-model@champion`, so the scoring code never names a version.
5. **Drift.** PSI on `monthly_spend` for a normal month and for a month after an invented price rise, with the usual
   bands (under 0.1 stable, 0.1 to 0.25 watch, over 0.25 a real shift).

Data is split by time (train on older labels, choose on the next block, report on the newest), as production sees it.

## Set up and run

It has its own environment, so MLflow's dependencies never reach the lab's `.venv`:

```sh
cd examples/mlops
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python run_mlops.py
```

It takes about 15 seconds and needs no keys or network after installing. Everything is written to the repo's
gitignored `generated/mlops/`: the tracking and registry database (`mlflow.db`) and the model artifacts. Each run adds
three runs and a new registered version, and moves `champion` to it.

Browse the runs, compare them and see the registered versions and alias:

```sh
.venv/bin/mlflow ui --backend-store-uri sqlite:///$(cd ../.. && pwd)/generated/mlops/mlflow.db
```

## Notes

- MLflow 3 saves scikit-learn models with skops, which loads only types it is told to trust. The tree models pass
  `skops_trusted_types=["sklearn.tree._tree.Tree"]`; that is safe here because the script trained them. Never trust
  types for a model file from somewhere else.
- The same calls work against a shared tracking server, Azure Machine Learning or Databricks: change the tracking URI.
  The registry alias, not a version number, is what deployment code should load.
