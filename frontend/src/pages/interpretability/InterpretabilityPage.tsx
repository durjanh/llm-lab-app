import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { highlight } from '@/components/highlight';
import { Coefficients, DocForm, Explainer, Fairness, Importance, PartialDependence, Proxy } from './interactive';
import './interpretability.css';

/*
  Interpretability, fairness and documentation (course week 21). A static page: one invented loan model in
  model.ts, small enough that every explanation on the page is computed exactly rather than estimated.
*/

const SECTIONS: [string, string][] = [
  ['kinds', 'Kinds of explanation'],
  ['importance', 'Permutation importance'],
  ['dependence', 'Partial dependence and ICE'],
  ['shapley', 'Shapley values and counterfactuals'],
  ['mislead', 'When explanations mislead'],
  ['fairness', 'Fairness metrics'],
  ['bias', 'Where bias comes from'],
  ['docs', 'Model cards and datasheets'],
  ['llms', 'Language models'],
  ['code', 'In Python'],
  ['used', 'Used in the lab'],
];

const CODE = `# Model-agnostic explanations with scikit-learn, on any fitted estimator.
from sklearn.inspection import PartialDependenceDisplay, permutation_importance

# Permutation importance on held-out data: shuffle one column at a time and record the fall in score.
result = permutation_importance(model, X_test, y_test, scoring="roc_auc", n_repeats=10, random_state=0)
for name, drop, spread in sorted(zip(X_test.columns, result.importances_mean, result.importances_std),
                                 key=lambda r: -r[1]):
    print(f"{name:<18} {drop:.3f} ± {spread:.3f}")

# Partial dependence (the average) with ICE curves (one line per row) for two features.
PartialDependenceDisplay.from_estimator(model, X_test, ["income", "debt"], kind="both", subsample=50)

# Shapley values for a few features can be computed exactly; for more, the shap package estimates them,
# for example shap.Explainer(model.predict_proba, background_rows)(X_test.iloc[:1]).`;

function Tags({ text }: { text: string }) {
  return <p className="small muted in-tags">Week 21 · {text}</p>;
}

export default function InterpretabilityPage() {
  return (
    <main className="page-interpretability">
      <p className="kicker">Course week 21</p>
      <h1>Interpretability, fairness and documentation</h1>
      <p className="lede">
        A model that decides who gets a loan has to answer three questions: why did it decide this, is it fair to
        different groups, and what is it for. This page answers them for one invented model that scores 600 invented
        applicants. The model is small enough that every explanation here is exact, so you can see what the usual tools
        estimate on larger models.
      </p>
      <nav className="in-nav" aria-label="Sections">
        {SECTIONS.map(([id, name]) => (
          <a key={id} href={`#${id}`}>
            {name}
          </a>
        ))}
      </nav>

      <section id="kinds" className="in-section">
        <h2>Global and local, built-in and after the fact</h2>
        <Tags text="what an explanation is for" />
        <p>
          A <b>global</b> explanation describes the model as a whole: which inputs it relies on and how. A <b>local</b>{' '}
          explanation describes one decision: why this applicant was declined. Both are needed. A regulator asks the
          first; the applicant asks the second.
        </p>
        <p>
          Some models are <b>interpretable by design</b>: a short linear model or a shallow tree can be read directly.
          Others, such as boosted trees or neural networks, need <b>post-hoc</b> methods that probe the model from the
          outside. Post-hoc methods work on any model but describe its behaviour, not its reasoning, and they can be
          wrong in ways a reader cannot see.
        </p>
        <p>
          The model on this page is a logistic regression with four inputs. Its weights are the whole model: each one
          multiplies the odds of repaying by a fixed amount, whoever the applicant is. The branch area each applicant
          lives in, North or South, is <i>not</i> an input. It matters later.
        </p>
        <Coefficients />
        <p className="small muted">
          The <Link to="/ml">algorithms page</Link> shows logistic regression and decision trees fitting live.
        </p>
      </section>

      <section id="importance" className="in-section">
        <h2>Permutation importance: what the model leans on</h2>
        <Tags text="global, model-agnostic" />
        <p>
          Shuffle one column so it no longer lines up with the rest of each row, score the model again, and see how far
          the score falls. A large fall means the model depends on that input. It needs no access to the model’s
          insides, so it works the same on a neural network.
        </p>
        <Importance />
        <p>
          Two cautions. It measures dependence, not truth: a model can lean hard on a feature that is a poor reason. And
          when two features carry the same information, shuffling either one alone barely hurts, so both look
          unimportant. Compute it on held-out data, or it rewards what the model memorised.
        </p>
      </section>

      <section id="dependence" className="in-section">
        <h2>Partial dependence and ICE curves: how an input moves the score</h2>
        <Tags text="global and local together" />
        <p>
          Partial dependence sets one input to each value in turn for every applicant and averages the predictions. ICE
          curves draw the same sweep for each applicant separately. When the ICE curves run parallel, the average is a
          fair summary. When they fan out or cross, the input interacts with others and the average hides it.
        </p>
        <PartialDependence />
      </section>

      <section id="shapley" className="in-section">
        <h2>Shapley values and counterfactuals: one decision</h2>
        <Tags text="local" />
        <p>
          Shapley values split one prediction among the inputs. Start from the average prediction. For each input, ask
          how much the prediction moves when that input’s real value joins a group of others, average over every group,
          and you have its share. The shares always add up to the gap between this prediction and the average, so
          nothing is left unexplained.
        </p>
        <p>
          With four inputs there are only 16 groups, so the page computes the exact values. SHAP and similar tools
          estimate the same quantity by sampling when there are too many inputs to enumerate. The estimate inherits two
          choices that change the answer: which background rows stand in for the missing inputs, and whether the output
          is a probability or log-odds.
        </p>
        <p>
          A counterfactual answers the question the applicant actually has: what would have to change for a different
          decision? Some answers are useless or harmful. Telling someone to have lived at their address for longer is
          not advice, and a model that hinges on it is suspect.
        </p>
        <Explainer />
      </section>

      <section id="mislead" className="in-section">
        <h2>When explanations mislead</h2>
        <Tags text="proxies and correlated inputs" />
        <p>
          Leaving a sensitive attribute out of the inputs does not keep it out of the decisions. Here, the branch area
          is never an input, yet South is approved far less often. Years at address and income both track the area, so
          the model picks it up through them.
        </p>
        <Proxy />
        <p>
          Correlated inputs also distort the explanations themselves. Shapley values and partial dependence create
          combinations of inputs that never occur together, such as one applicant’s income with another’s years at
          address, and report how the model behaves on those. Permutation importance splits credit between correlated
          inputs unpredictably. Treat any single explanation as a lead to check, not a finding.
        </p>
      </section>

      <section id="fairness" className="in-section">
        <h2>Fairness metrics, and why they conflict</h2>
        <Tags text="group fairness" />
        <p>
          Each group fairness metric compares a different rate between groups. Demographic parity compares approval
          rates. Equal opportunity compares how many of those who would repay get approved. Equalised odds also compares
          how many of those who would default get approved. Predictive parity compares how many of those approved go on
          to repay. Calibration asks that a score of 30% means 30% in every group.
        </p>
        <p>
          When groups repay at different rates and the model is imperfect, these cannot all hold at once. That is
          arithmetic, not a flaw in this model. Choosing which to satisfy is a decision about harm: wrongly declining a
          good applicant and wrongly approving one who then struggles to repay hurt different people in different ways.
          Separate thresholds by group can close one gap, but treating groups differently on purpose has legal limits
          that vary by country and sector, so it is a decision for the business and its lawyers, written down.
        </p>
        <Fairness />
      </section>

      <section id="bias" className="in-section">
        <h2>Where bias comes from</h2>
        <Tags text="before the model is trained" />
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Source</th>
                <th>What happens</th>
                <th>In the loan data</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Sampling</td>
                <td>Some people are missing or rare in the training data.</td>
                <td>Only approved loans have outcomes, so people the old process declined are never learned from.</td>
              </tr>
              <tr>
                <td>Label</td>
                <td>The label measures something other than what you care about.</td>
                <td>“Repaid” counts early refinancing as success, which can hide people who struggled.</td>
              </tr>
              <tr>
                <td>Measurement</td>
                <td>An input is recorded differently or less accurately for some groups.</td>
                <td>Income from irregular work is often under-recorded, and such work is more common in some areas.</td>
              </tr>
              <tr>
                <td>Historical</td>
                <td>The data faithfully records an unfair past.</td>
                <td>Fewer years at one address reflects renting, which reflects wealth more than reliability.</td>
              </tr>
              <tr>
                <td>Deployment</td>
                <td>The model is used for a decision or a population it was not built for.</td>
                <td>Reusing the score to set interest rates, which it was never tested for.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section id="docs" className="in-section">
        <h2>Model cards and datasheets</h2>
        <Tags text="documentation that travels with the work" />
        <p>
          A <b>datasheet</b> records what a dataset is: why it was collected, what a row means, how it was labelled, and
          who is missing. A <b>model card</b> records what a model is for: its intended use and the uses it is not fit
          for, how it performs overall and by group, and its known limits. Writing them is how the findings above reach
          the people who will deploy the model later. Fill in either form, or load the worked example, and keep the
          Markdown next to the code.
        </p>
        <DocForm />
      </section>

      <section id="llms" className="in-section">
        <h2>Language models: explanations that are not explanations</h2>
        <Tags text="the same questions for LLMs" />
        <p>
          The methods above assume a handful of meaningful inputs. A language model’s inputs are thousands of tokens,
          and attribution scores per token (from attention weights or gradients) are unstable: small rewording moves
          them, and attention weights in particular show where information was routed, not why an answer was chosen.
        </p>
        <p>
          A model’s written reasoning, its chain of thought, is also not a faithful account of how it reached an answer.
          It is more text, produced by the same process. Studies have found models giving reasons that leave out the
          hint they actually used. Treat reasoning as useful for checking and debugging, never as an audit trail.
        </p>
        <p>
          What works for LLM systems is behavioural: test sets broken down by group and by case type, checks on what the
          system says and refuses, and records of what it was given. See{' '}
          <Link to="/confidence">confidence and calibration</Link>, <Link to="/guardrails">guardrails</Link>,{' '}
          <Link to="/red-team">adversarial testing</Link> and the ethics and oversight sections of{' '}
          <Link to="/delivery">delivery and governance</Link>.
        </p>
      </section>

      <section id="code" className="in-section">
        <h2>In Python</h2>
        <Tags text="the same tools on a real model" />
        <CodeBlock html={highlight(CODE)} />
      </section>

      <section id="used" className="in-section">
        <h2>Where this is used in the lab</h2>
        <ul>
          <li>
            <Link to="/ml">Machine learning algorithms</Link>: the models these methods explain.
          </li>
          <li>
            <Link to="/mlops">MLOps</Link>: the promotion gate that checks the recall gap between segments before a
            model ships.
          </li>
          <li>
            <Link to="/confidence">Confidence and calibration</Link>: calibration for language models.
          </li>
          <li>
            <Link to="/guardrails">Guardrails</Link> and <Link to="/red-team">adversarial testing</Link>: behavioural
            checks for LLM systems.
          </li>
          <li>
            <Link to="/delivery">Delivery and governance</Link>: human oversight, ethics and compliance in a real
            design.
          </li>
        </ul>
        <div className="takeaways">
          <h3>What to take away</h3>
          <ul>
            <li>Ask for a global and a local explanation; they answer different people.</li>
            <li>Post-hoc explanations describe behaviour and can mislead when inputs are correlated.</li>
            <li>Leaving out a sensitive attribute does not remove it; check outcomes by group.</li>
            <li>Fairness metrics conflict when base rates differ, so choose one and record why.</li>
            <li>Write the model card and datasheet while the findings are fresh.</li>
          </ul>
        </div>
      </section>
    </main>
  );
}
