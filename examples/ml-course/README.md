# Machine learning and AI in 25 weeks: the exercises

The Python half of the lab's course (`/ml-course`). Each week has a short exercise you complete, a worked solution
that explains its choices, and tests that tell you when you are done. Each week builds the idea from scratch with
NumPy first, then checks it against scikit-learn or SciPy. Everything runs on this machine, on generated or
invented data, with no downloads and no keys.

## Set up

Python 3.12, in this folder's own environment (it keeps scikit-learn and PyTorch out of the lab's main `.venv`):

```sh
cd examples/ml-course
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install -r requirements-torch.txt    # optional, about 700 MB: weeks 15, 16, 17 and 20
```

## Work through a week

```sh
.venv/bin/pytest week02                          # your exercise: fails until you fill in the TODOs
ML_COURSE_SOLUTIONS=1 .venv/bin/pytest week02    # the same tests against the worked solution
.venv/bin/pytest                                 # every week, including the capstone
```

Open `weekNN/exercise.py`. Its first lines are the brief; each function's docstring says what it must return. Fill
in the bodies until the tests pass, then read `solution.py` for the reasoning, which is in its comments. Weeks that
use PyTorch skip those tests, with a message, when it is not installed.

The exercises are generated from the solutions by `make_exercises.py`, which only writes missing files. To reset
one week, delete its `exercise.py` and run `.venv/bin/python make_exercises.py`.

## The weeks

| Week | Topic | Lab pages |
| --- | --- | --- |
| 0 | Orientation and tools: Python, NumPy, pandas | `/ml-course` |
| 1 | Maths I: vectors, matrices, derivatives | `/ml-maths` |
| 2 | Maths II: gradient descent, momentum, Adam | `/ml-maths`, `/deep-learning` |
| 3 | What machine learning is; splits and missing values | `/ml`, `/probability-stats` |
| 4 | Probability: Bayes' rule, distributions, Monte Carlo | `/probability-stats` |
| 5 | Statistics: robust summaries, outliers, likelihood, regression, the bootstrap | `/probability-stats` |
| 6 | Generalisation: three-way splits, bias and variance | `/model-evaluation`, `/deep-learning` |
| 7 | Measuring a classifier: confusion matrix, ROC, AUC, lift | `/model-evaluation` |
| 8 | Evaluating fairly: k-fold, stratification, oversampling, leakage | `/model-evaluation` |
| 9 | Nearest neighbours, and why scale matters | `/ml` |
| 10 | Decision trees: entropy, Gini, depth | `/ml`, `/probability-stats` |
| 11 | Ensembles: bagging, random forests, boosting by hand | `/ml`, `/tabular` |
| 12 | Naive Bayes and logistic regression | `/ml`, `/probability-stats` |
| 13 | Support vector machines and kernels | `/ml` |
| 14 | Bayesian optimisation with a Gaussian process | `/tuning` |
| 15 | Neural networks I: backpropagation by hand, gradient checking, XOR | `/deep-learning` |
| 16 | Neural networks II: overfitting, weight decay, dropout | `/deep-learning`, `/training` |
| 17 | Convolutional networks: convolution, pooling, a CNN on digits | `/deep-learning`, `/vision` |
| 18 | Hyperparameter tuning: grid, random, successive halving | `/tuning` |
| 19 | Language models I: tokens, a bigram model, temperature, causal attention | `/whatisgpt`, `/tokens`, `/transformer` |
| 20 | Language models II: scaling laws, few-shot prompts, LoRA, a tiny trained model | `/training`, `/lora`, `/prompting` |
| 21 | Interpretability, fairness and model cards | `/interpretability` |
| 22 | Unsupervised I: k-means, the elbow, single linkage | `/ml` |
| 23 | Unsupervised II: PCA, compression, similarity search | `/ml`, `/embeddings` |
| 24 | Reinforcement learning: bandits, value iteration, Q-learning | `/reinforcement-learning` |
| 25 | Capstone: optimise a black box on a budget (`capstone/`) | `/capstone`, `/mlops` |

Anything a week writes goes under the repo's gitignored `generated/ml-course/`.
