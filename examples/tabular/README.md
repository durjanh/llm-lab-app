# Tabular foundation models

`run_tabular.py` compares TabPFN with gradient boosting (scikit-learn's `HistGradientBoosting`) on one CSV. The
lab's `/tabular` page runs it as a subprocess and adds an agent that suggests what to predict and explains the results.

TabPFN was pre-trained on millions of synthetic tables. It reads the training rows as its context and predicts the
test rows in one forward pass: there is no training step for each dataset.

## Set up

From the repo root:

```sh
cd examples/tabular && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

About 1.3 GB, mostly PyTorch (CPU build). The first run downloads the TabPFN v2 weights (about 75 MB, no sign-in)
into `~/Library/Caches/tabpfn` on macOS.

## Run it on its own

```sh
echo '{"csv": "data.csv", "target": "churned", "task": "classification"}' | .venv/bin/python run_tabular.py
```

It prints progress lines, then one JSON result with each model's metrics (accuracy, balanced accuracy and ROC AUC,
or RMSE, MAE and R²), fit and predict times, and a few test rows with their predictions.

## Limits

- CPU only here: at most 3,000 training rows (a fixed random sample of a larger table) and 100 columns. TabPFN v2
  predicts at most 10 classes.
- Text columns with very many different values (identifiers, free text) are left out and reported.
- One train/test split: a small test set gives results that vary from split to split.

## Weights and licence

The script loads the TabPFN v2 weights (`ModelVersion.V2`), released under the Prior Labs License 1.1: Apache 2.0
with an attribution clause, so commercial use is allowed with attribution. The library's newer default weights
(v2.5 and later) download without a sign-in too, but their licence allows only non-commercial, non-production use.
