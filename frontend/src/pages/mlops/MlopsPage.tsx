import { useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { highlight } from '@/components/highlight';
import { Drift, PointInTime, Rollout, RunsAndRegistry } from './interactive';
import './mlops.css';

/*
  MLOps: the classic machine learning life cycle from a notebook to a monitored production model. A static page:
  every simulation runs in the browser on invented data (mlops.ts), and examples/mlops runs the same steps for real
  with MLflow.
*/

const SECTIONS: [string, string][] = [
  ['lifecycle', 'The life cycle'],
  ['tracking', 'Tracking and registry'],
  ['features', 'Feature store'],
  ['deploy', 'Deployment'],
  ['monitor', 'Monitoring'],
  ['maturity', 'Maturity'],
  ['tools', 'Tools'],
  ['code', 'MLflow code'],
];

interface Stage {
  id: string;
  name: string;
  produces: string;
  owner: string;
  without: string;
}

const STAGES: Stage[] = [
  {
    id: 'data',
    name: 'Data',
    produces: 'A versioned, validated training table with a known snapshot date, schema checks and an owner.',
    owner: 'Data engineers, with the data owner in the business.',
    without: 'Nobody can say which rows trained the model in production, so a bad result cannot be traced or repeated.',
  },
  {
    id: 'features',
    name: 'Features',
    produces:
      'Feature definitions computed once, stored offline for training and online for scoring, joined as of each label time.',
    owner: 'Data scientists define them; data engineers run the pipelines.',
    without:
      'Training and serving compute the same feature two ways and drift apart, and future values leak into training.',
  },
  {
    id: 'train',
    name: 'Train',
    produces:
      'Runs with their parameters, metrics, code commit, data version and the model file, recorded by a tracking server.',
    owner: 'Data scientists, through a pipeline rather than a notebook once it matters.',
    without: 'The best model lives on one laptop. Nobody can rebuild it or explain how it was chosen.',
  },
  {
    id: 'evaluate',
    name: 'Evaluate',
    produces: 'Scores on a held-out, time-split set, broken down by segment, against the current champion.',
    owner: 'Data scientists, with the business owner agreeing the thresholds.',
    without: 'A model that is better on average but much worse for one group of customers goes live unnoticed.',
  },
  {
    id: 'register',
    name: 'Register',
    produces:
      'A numbered version in the model registry with its lineage, and an alias such as champion that deployments load.',
    owner: 'The model owner approves; the pipeline does the registering.',
    without: 'Deployment copies a file by hand. Rolling back means finding the old file.',
  },
  {
    id: 'deploy',
    name: 'Deploy',
    produces:
      'A batch scoring job or an online endpoint, released by shadow, canary or blue-green with automatic rollback.',
    owner: 'ML or platform engineers, through CI/CD.',
    without: 'A new version reaches every user at once, and a fault is found by complaints.',
  },
  {
    id: 'monitor',
    name: 'Monitor',
    produces: 'Service health, input drift, prediction drift and, once labels arrive, real performance, with alerts.',
    owner: 'The team that owns the model, on call like any other service.',
    without: 'The model decays quietly as customers and prices change. Nobody notices for months.',
  },
  {
    id: 'retrain',
    name: 'Retrain',
    produces:
      'A new run through the same pipeline when the evidence says so, which goes back through evaluation and the gate.',
    owner: 'Triggered by monitoring or a schedule; approved by the model owner.',
    without: 'Either the model never improves, or it is retrained blindly on broken data and gets worse.',
  },
];

/** The eight stages as a loop. Each stage is a button; the details show below. */
function Lifecycle() {
  const [sel, setSel] = useState('features');
  const stage = STAGES.find((s) => s.id === sel)!;
  const W = 720;
  const H = 330;
  const cx = W / 2;
  const cy = H / 2;
  const rx = 270;
  const ry = 120;
  const pos = STAGES.map((_, i) => {
    const a = -Math.PI / 2 + (i / STAGES.length) * 2 * Math.PI;
    return { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
  });
  const key = (id: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSel(id);
    }
  };
  return (
    <div className="grid2 ml-life">
      <div className="ml-diagram-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} className="ml-loop" role="group" aria-label="The machine learning life cycle">
          <defs>
            <marker id="ml-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 0L10 5L0 10z" className="ml-head" />
            </marker>
          </defs>
          {pos.map((p, i) => {
            const q = pos[(i + 1) % pos.length];
            const a = { x: p.x + (q.x - p.x) * 0.3, y: p.y + (q.y - p.y) * 0.3 };
            const b = { x: p.x + (q.x - p.x) * 0.7, y: p.y + (q.y - p.y) * 0.7 };
            return (
              <path
                key={i}
                d={`M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`}
                className={`ml-edge${i === STAGES.length - 1 ? ' back' : ''}`}
              />
            );
          })}
          <text x={cx} y={cy - 6} textAnchor="middle" className="ml-centre">
            One pipeline,
          </text>
          <text x={cx} y={cy + 14} textAnchor="middle" className="ml-centre">
            run again and again
          </text>
          {STAGES.map((s, i) => (
            <g
              key={s.id}
              role="button"
              tabIndex={0}
              aria-pressed={s.id === sel}
              aria-label={s.name}
              className={`ml-node${s.id === sel ? ' on' : ''}`}
              onClick={() => setSel(s.id)}
              onKeyDown={key(s.id)}
            >
              <rect x={pos[i].x - 62} y={pos[i].y - 20} width={124} height={40} rx={20} />
              <text x={pos[i].x} y={pos[i].y + 5} textAnchor="middle">
                {i + 1}. {s.name}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="card ml-stage" aria-live="polite">
        <h3 className="ml-flush">{stage.name}</h3>
        <p>
          <b>Produces.</b> {stage.produces}
        </p>
        <p>
          <b>Owned by.</b> {stage.owner}
        </p>
        <p className="ml-without">
          <b>Without it.</b> {stage.without}
        </p>
      </div>
    </div>
  );
}

const MATURITY = [
  {
    level: 'Level 0: manual',
    looks:
      'Notebooks, a model file handed to engineers, deployed by hand a few times a year. Training and serving code are separate.',
    risk: 'Nothing is repeatable. Training/serving skew is likely, and nobody monitors the model after release.',
    next: 'Track every run, register models with lineage, and write the training steps as a script that runs without a person.',
  },
  {
    level: 'Level 1: the pipeline is automated',
    looks:
      'Training is a pipeline (data checks, features, train, evaluate, register) that runs on a schedule or a trigger. A feature store and a registry exist. Models are released through a gate.',
    risk: 'The pipeline itself changes by hand. A bad change to the pipeline code is found in production.',
    next: 'Put the pipeline code under CI/CD: tests on every change, build it as a versioned artefact, deploy it to test, then production.',
  },
  {
    level: 'Level 2: CI/CD of the pipeline',
    looks:
      'Changes to the pipeline are tested and released like any service. Monitoring triggers retraining, and new versions roll out by canary with automatic rollback.',
    risk: 'Cost and complexity. Worth it for many models or models that change often, not for one model updated once a year.',
    next: 'Shared templates and a platform team so each new model starts at level 2 instead of level 0.',
  },
];

const TOOLS: [string, string[]][] = [
  [
    'Experiment tracking',
    [
      'Tracking server: runs, parameters, metrics, artefacts',
      'Jobs log through MLflow-compatible tracking',
      'Vertex AI Experiments',
      'SageMaker Experiments; managed MLflow',
      'Managed MLflow',
      'Pipeline run metadata',
      'None; tasks call a tracker',
    ],
  ],
  [
    'Model registry',
    [
      'Model Registry with versions and aliases',
      'Model registry; registries share across workspaces',
      'Vertex AI Model Registry',
      'Model Registry (model package groups, approval status)',
      'Models in Unity Catalog, with aliases',
      'Kubeflow Model Registry',
      'None',
    ],
  ],
  [
    'Feature store',
    [
      'None (often paired with Feast)',
      'Managed feature store',
      'Vertex AI Feature Store',
      'SageMaker Feature Store (offline and online)',
      'Feature tables in Unity Catalog, online serving',
      'None (Feast is common)',
      'None; schedules feature jobs',
    ],
  ],
  [
    'Pipelines',
    [
      'Not an orchestrator',
      'Azure Machine Learning pipelines',
      'Vertex AI Pipelines (Kubeflow Pipelines or TFX SDK)',
      'SageMaker Pipelines',
      'Jobs (workflows of notebooks and tasks)',
      'Kubeflow Pipelines on Kubernetes',
      'DAGs of tasks on a schedule',
    ],
  ],
  [
    'Serving',
    [
      'mlflow models serve; builds a container',
      'Managed online and batch endpoints',
      'Endpoints and batch prediction',
      'Real-time, serverless and async endpoints; batch transform',
      'Model Serving endpoints',
      'KServe',
      'Triggers batch scoring',
    ],
  ],
  [
    'Monitoring',
    [
      'None built in; log metrics to it',
      'Model monitoring (drift, data quality)',
      'Vertex AI Model Monitoring',
      'SageMaker Model Monitor',
      'Lakehouse Monitoring on tables',
      'None; add Prometheus or Evidently',
      'Schedules monitoring jobs',
    ],
  ],
];

const TOOL_HEAD = [
  '',
  'MLflow',
  'Azure Machine Learning',
  'Vertex AI',
  'SageMaker',
  'Databricks',
  'Kubeflow',
  'Airflow',
];

const MLFLOW = `import mlflow
import pandas as pd
from mlflow import MlflowClient

mlflow.set_tracking_uri("sqlite:///generated/mlops/mlflow.db")  # or a shared server, Azure ML, Databricks
mlflow.set_experiment("churn")

# Features joined as of each label date, never the latest value
table = pd.merge_asof(labels, snapshots, left_on="label_date", right_on="snapshot_date",
                      by="customer_id", direction="backward")

with mlflow.start_run(run_name="gradient-boosting") as run:
    model.fit(train[FEATURES], train["churned"])
    mlflow.log_params({"n_estimators": 300, "learning_rate": 0.05, "max_depth": 3})
    mlflow.log_metrics({"train_auc": ..., "val_auc": ..., "test_auc": ...})
    mlflow.set_tags({"data_hash": fingerprint})            # lineage: which rows trained it
    info = mlflow.sklearn.log_model(model, name="model", input_example=train[FEATURES].head(3))

# Register the best by validation AUC, then point the alias at it
version = mlflow.register_model(info.model_uri, "churn-model")
MlflowClient().set_registered_model_alias("churn-model", "champion", version.version)

# Scoring code names the alias, never a version: promotion and rollback are one alias change
champion = mlflow.sklearn.load_model("models:/churn-model@champion")
risk = champion.predict_proba(batch[FEATURES])[:, 1]`;

export default function MlopsPage() {
  return (
    <main className="page-mlops">
      <p className="kicker">MLOps</p>
      <h1>MLOps: from a notebook to a model in production</h1>
      <p className="lede">
        A model that scores well in a notebook is about a tenth of the work. The rest is making it repeatable, putting
        it in front of users safely, noticing when it stops working, and improving it without breaking it. This page
        walks that life cycle on an invented churn model, with something to try at each step. The{' '}
        <Link to="/ml">algorithms page</Link> covers the models themselves; <Link to="/llmops">LLMOps</Link> covers the
        same ideas for prompts and language models.
      </p>
      <nav className="ml-nav" aria-label="Sections">
        {SECTIONS.map(([id, name]) => (
          <a key={id} href={`#${id}`}>
            {name}
          </a>
        ))}
      </nav>

      <section id="lifecycle" className="ml-section">
        <h2>The life cycle</h2>
        <p>
          Eight stages in a loop. The loop is the point: monitoring feeds retraining, and every new version goes back
          through the same evaluation and release steps. Choose a stage to see what it produces, who owns it and what
          goes wrong when it is skipped.
        </p>
        <Lifecycle />
      </section>

      <section id="tracking" className="ml-section">
        <h2>Experiment tracking and the model registry</h2>
        <p>
          A tracking server records every training run: its parameters, metrics on each split, the code commit, the data
          version and the model file. A registry holds the versions you might deploy, with their lineage, and aliases
          such as <code>champion</code> and <code>challenger</code>. Deployments load an alias, so promoting or rolling
          back is one change in the registry, not a redeploy.
        </p>
        <p>
          Three rules keep the choice honest. Choose on the validation set and read the test set once, afterwards.
          Compare only runs on the same data version. Split by time when the model will predict the future.
        </p>
        <RunsAndRegistry />
      </section>

      <section id="features" className="ml-section">
        <h2>The feature store</h2>
        <p>
          A feature store computes each feature once and serves it two ways: an <b>offline store</b> (a table of
          history, for training and batch scoring) and an <b>online store</b> (a fast key-value lookup of the latest
          value, for an endpoint answering in milliseconds). It exists to stop two failures.
        </p>
        <div className="grid2">
          <div className="card">
            <h3 className="ml-flush">Leakage through the join</h3>
            <p className="small">
              Training rows need each feature as it was <i>when the label was decided</i>. A point-in-time join takes
              the latest value on or before the label time. Joining the newest value instead lets the future leak in.
            </p>
          </div>
          <div className="card">
            <h3 className="ml-flush">Training/serving skew</h3>
            <p className="small">
              The training pipeline computes "logins in 30 days" in SQL; the endpoint computes it in application code
              that counts calendar days instead of rolling ones, or skips the time zone. The model sees inputs in
              production it never saw in training. One definition, used by both paths, prevents it.
            </p>
          </div>
        </div>
        <h3>Try the join</h3>
        <PointInTime />
        <p className="small muted">
          The <Link to="/data-integration">data and integration page</Link> covers the lakehouse tables these features
          are built from.
        </p>
      </section>

      <section id="deploy" className="ml-section">
        <h2>Deployment</h2>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th />
                <th>Batch scoring</th>
                <th>Online endpoint</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>When</td>
                <td>Predictions are needed on a schedule: tonight's churn list, a weekly risk score.</td>
                <td>A decision is made while someone waits: a fraud check at checkout, a price quote.</td>
              </tr>
              <tr>
                <td>Features</td>
                <td>Read from the offline store.</td>
                <td>Read from the online store, or sent with the request.</td>
              </tr>
              <tr>
                <td>What can go wrong</td>
                <td>A job fails quietly and yesterday's scores are used. Monitor the job and the row counts.</td>
                <td>Latency, timeouts and scaling. Monitor like any service, plus the model's inputs and outputs.</td>
              </tr>
              <tr>
                <td>Cost</td>
                <td>Cheap: compute only while the job runs.</td>
                <td>Paid all day, even when idle, unless it scales to zero.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          A new version should never reach every user at once without evidence. Choose a release strategy, set how bad
          the new model really is, and see how many users it hurts before it is stopped. 600 requests a minute for 30
          minutes; the old model fails 1% of the time.
        </p>
        <Rollout />
        <p className="small muted">
          The same releases apply to prompts and model versions behind an LLM feature; see{' '}
          <Link to="/llmops">LLMOps</Link>. For a language model, "error" is usually a failed evaluation, not an HTTP
          error, which is why <Link to="/evals">evals</Link> run on the canary's traffic.
        </p>
      </section>

      <section id="monitor" className="ml-section">
        <h2>Monitoring and retraining</h2>
        <p>Four things drift, and they are caught in different ways:</p>
        <ul>
          <li>
            <b>Data drift</b>: the inputs change (prices rise, a new product launches). Measured at once by comparing
            this month's distribution with the training one.
          </li>
          <li>
            <b>Prediction drift</b>: the share of customers scored "will leave" moves. Also visible at once.
          </li>
          <li>
            <b>Concept drift</b>: the link between inputs and outcome changes (a competitor's offer makes loyal
            customers leave). Inputs can look the same; only labels show it.
          </li>
          <li>
            <b>Delayed labels</b>: whether someone churned is known 30 days later, a loan default months later. Until
            then, drift is a proxy.
          </li>
        </ul>
        <p>
          <b>PSI</b> (population stability index) bins the training sample by its deciles and adds up (current share −
          training share) × ln(current ÷ training) over the bins. <b>KS</b> is the largest gap between the two
          cumulative distributions. Move the slider and watch both.
        </p>
        <Drift />
        <p>
          A retraining policy is either <b>scheduled</b> (every month, simple and predictable, wasteful when nothing has
          changed and slow when something has) or <b>triggered</b> (by a measured performance drop or a large shift,
          faster but needs good monitoring). Either way the new version goes through the same evaluation and gate. The{' '}
          <Link to="/observability">monitoring page</Link> shows the service side: logs, metrics and traces.
        </p>
      </section>

      <section id="maturity" className="ml-section">
        <h2>MLOps maturity</h2>
        <p>
          A common way to describe how far a team has got, in three levels. Most teams do not need level 2 for every
          model; the useful question is what to build next.
        </p>
        <div className="grid3">
          {MATURITY.map((m) => (
            <div key={m.level} className="card">
              <h3 className="ml-flush">{m.level}</h3>
              <p className="small">
                <b>Looks like.</b> {m.looks}
              </p>
              <p className="small">
                <b>Risk.</b> {m.risk}
              </p>
              <p className="small">
                <b>Build next.</b> {m.next}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section id="tools" className="ml-section">
        <h2>The tools across platforms</h2>
        <p>
          The same six jobs appear on every platform under different names. MLflow and Kubeflow are open source and run
          anywhere; Azure Machine Learning, Vertex AI and SageMaker are each cloud's managed service; Databricks runs on
          all three; Airflow schedules work but holds no models. Product names change often, so check the current
          documentation before relying on a detail.
        </p>
        <div className="table-wrap">
          <table className="t ml-tools">
            <thead>
              <tr>
                {TOOL_HEAD.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {TOOLS.map(([job, cells]) => (
                <tr key={job}>
                  <td>
                    <b>{job}</b>
                  </td>
                  {cells.map((c, i) => (
                    <td key={i}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Fine-tuned language models use the same registry and release steps; the <Link to="/lora">LoRA page</Link>{' '}
          trains adapters you would version this way, and the <Link to="/tabular">tabular page</Link> compares models
          you would track as runs.
        </p>
      </section>

      <section id="code" className="ml-section">
        <h2>The same steps in MLflow</h2>
        <p>
          <code>examples/mlops/run_mlops.py</code> runs all of this for real on invented churn data, in its own
          environment: a point-in-time join (and the leaky one, which scores a validation AUC of 1.0), three tracked
          runs, the best by validation AUC registered with the alias <code>champion</code>, a batch scored through that
          alias, and a PSI check. Setup and the command to browse the runs are in its README. The core of it:
        </p>
        <CodeBlock html={highlight(MLFLOW)} />
        <div className="takeaways">
          <h3>What to take away</h3>
          <ul>
            <li>Track every run with its data version and commit, choose on validation, report the test score once.</li>
            <li>Load models by alias, so promotion and rollback are one registry change.</li>
            <li>Join features as of the label time, and compute each feature one way for training and serving.</li>
            <li>Release by shadow or canary with an automatic rollback threshold, not all at once.</li>
            <li>Drift is a reason to look, not to retrain. Retrain on a measured drop, through the same gate.</li>
          </ul>
        </div>
      </section>
    </main>
  );
}
