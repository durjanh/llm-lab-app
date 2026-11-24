import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import { highlight } from '@/components/highlight';
import {
  Bootstrap,
  Distributions,
  Impurity,
  Likelihood,
  MissingData,
  MonteCarlo,
  NaiveBayes,
  Outliers,
  Regression,
  ScreeningTest,
} from './parts';
import './probability-stats.css';

/*
  Probability and statistics for machine learning: weeks 3, 4, 5, 10 and 12 of the lab's 25-week course. Each idea is
  something to move, on invented data, with the maths in probstats.ts.
*/

const SECTIONS: [string, string][] = [
  ['rules', 'Probability rules'],
  ['bayes', "Bayes' rule"],
  ['distributions', 'Distributions'],
  ['monte-carlo', 'Monte Carlo'],
  ['summaries', 'Summaries and outliers'],
  ['likelihood', 'Likelihood'],
  ['regression', 'Regression'],
  ['bootstrap', 'The bootstrap'],
  ['missing', 'Missing data'],
  ['entropy', 'Entropy and Gini'],
  ['naive-bayes', 'Naive Bayes'],
  ['code', 'In code'],
  ['used', 'Where it is used'],
];

const Week = ({ n }: { n: number }) => <span className="ps-week">Week {n}</span>;

const CODE = `import numpy as np

rng = np.random.default_rng(7)
days = np.array([6, 9, 4, 12, 7, 31, 8, 5, 10, 6, 44, 9, 7, 11, 8, 26, 6])

# The bootstrap: a 95% interval for the median, with no formula.
medians = [np.median(rng.choice(days, size=days.size, replace=True)) for _ in range(5000)]
print(np.median(days), np.percentile(medians, [2.5, 97.5]))

# Entropy in bits of a node holding 9 of one class and 7 of the other.
p = np.array([9, 7]) / 16
print(-(p * np.log2(p)).sum())`;

export default function ProbabilityStatsPage() {
  return (
    <main className="page-probability-stats">
      <p className="kicker">Course · Weeks 3, 4, 5, 10 and 12</p>
      <h1>Probability and statistics for machine learning</h1>
      <p className="lede">
        A model&apos;s output is a guess under uncertainty, and its training data is a sample with gaps and oddities.
        Probability is the language for the first; statistics is how you reason about the second. Every example here
        uses invented data and runs in your browser, so you can move things and see the numbers respond.
      </p>
      <nav className="ps-nav" aria-label="Sections">
        {SECTIONS.map(([id, name]) => (
          <a key={id} href={`#${id}`}>
            {name}
          </a>
        ))}
      </nav>

      <section id="rules" className="ps-section">
        <h2>
          Probability rules <Week n={4} />
        </h2>
        <p>Four rules carry most of the weight.</p>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Formula</th>
                <th>In words</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Complement</td>
                <td className="mono">P(not A) = 1 − P(A)</td>
                <td>Something either happens or it does not.</td>
              </tr>
              <tr>
                <td>Addition</td>
                <td className="mono">P(A or B) = P(A) + P(B) − P(A and B)</td>
                <td>Take away the overlap so it is not counted twice.</td>
              </tr>
              <tr>
                <td>Conditional</td>
                <td className="mono">P(A | B) = P(A and B) ÷ P(B)</td>
                <td>Shrink the world to the cases where B happened, then ask how often A did.</td>
              </tr>
              <tr>
                <td>Independence</td>
                <td className="mono">P(A and B) = P(A) × P(B)</td>
                <td>Only when knowing B tells you nothing about A. Often assumed, rarely checked.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Conditional probability is not symmetric. P(positive test | ill) is a property of the test; P(ill | positive
          test) is what the patient wants to know. Bayes&apos; rule converts one into the other.
        </p>
      </section>

      <section id="bayes" className="ps-section">
        <h2>
          Bayes&apos; rule, with 1,000 people <Week n={4} />
        </h2>
        <p>
          An invented screening test for an invented condition. Counting people instead of multiplying probabilities
          makes the result easy to check: of everyone who tests positive, how many actually have it? Lower the
          prevalence and watch the answer collapse, even with an accurate test.
        </p>
        <ScreeningTest />
        <p className="note">
          The same arithmetic applies to any classifier hunting for something rare, such as fraud, faults or a rare
          disease. Precision depends on the base rate, not only on the model. See{' '}
          <Link to="/model-evaluation">model evaluation</Link>.
        </p>
      </section>

      <section id="distributions" className="ps-section">
        <h2>
          Distributions <Week n={4} />
        </h2>
        <p>
          A distribution says how likely each value is. Discrete ones give a probability to each count; continuous ones
          give a density, and probabilities are areas under it. Choosing one is choosing a story about how the data came
          about, and the story decides the loss: squared error assumes normal noise, cross-entropy assumes a Bernoulli
          outcome.
        </p>
        <Distributions />
      </section>

      <section id="monte-carlo" className="ps-section">
        <h2>
          Monte Carlo: answers by simulation <Week n={4} />
        </h2>
        <p>
          When a probability is hard to work out, simulate the process many times and count. Throw random darts at a
          square and the share inside the quarter circle approaches π ÷ 4. Roll three virtual dice and the share
          totalling over 12 approaches the exact 56 ÷ 216. The catch is the rate: to halve the error you need four times
          as many samples.
        </p>
        <MonteCarlo />
      </section>

      <section id="summaries" className="ps-section">
        <h2>
          Summaries and outliers <Week n={5} />
        </h2>
        <p>
          The mean and standard deviation use every value, so one extreme value moves them a lot. The median and the
          interquartile range (IQR) use the middle of the sorted data, so they are robust. Fifteen invented van stops,
          plus one more you control.
        </p>
        <Outliers />
        <p className="note">
          Finding an outlier is not a reason to delete it. A long stop might be a data-entry slip or a real breakdown.
          Check the source first; if it is real, it may be the most important row you have.
        </p>
      </section>

      <section id="likelihood" className="ps-section">
        <h2>
          Maximum likelihood <Week n={5} />
        </h2>
        <p>
          Likelihood turns the question around: given the data, how plausible is each parameter value? Maximum
          likelihood picks the value that makes the data you saw most probable. Logs turn the product over data points
          into a sum, which is easier to work with and does not underflow. Most training losses are negative
          log-likelihoods in disguise.
        </p>
        <Likelihood />
      </section>

      <section id="regression" className="ps-section">
        <h2>
          Linear regression <Week n={5} />
        </h2>
        <p>
          Fourteen invented mornings at a kiosk: colder mornings sell more hot drinks. Place the line yourself, then let
          least squares do it.
        </p>
        <Regression />
      </section>

      <section id="bootstrap" className="ps-section">
        <h2>
          The bootstrap <Week n={5} />
        </h2>
        <p>
          How sure are you of a statistic computed from one small sample? For a mean there is a formula. For a median, a
          ratio or a model&apos;s accuracy there usually is not, but you can resample.
        </p>
        <Bootstrap />
      </section>

      <section id="missing" className="ps-section">
        <h2>
          Missing data <Week n={3} />
        </h2>
        <p>
          Real tables have gaps, and why a value is missing matters more than how many are missing. The same invented
          survey loses incomes in three different ways. Compare the three common fixes against the truth, which the page
          knows because it made the data up.
        </p>
        <MissingData />
        <p>
          For a predictive model there is a fourth option: impute, and also add a column saying the value was missing.
          When missingness carries information (high earners declining, a test not ordered because the doctor was not
          worried), that indicator lets the model use it. Fit any imputation on the training split only, or it leaks the
          test set into training.
        </p>
      </section>

      <section id="entropy" className="ps-section">
        <h2>
          Entropy, Gini and how a tree chooses a split <Week n={10} />
        </h2>
        <p>
          A decision tree grows by asking, at each node, which question best separates the classes. It needs a number
          for how mixed a node is. Entropy and Gini impurity are the two common choices. The best split is the one that
          lowers that number the most, weighted by branch size. The <Link to="/ml">machine learning toolbox</Link> grows
          whole trees on the same principle.
        </p>
        <Impurity />
      </section>

      <section id="naive-bayes" className="ps-section">
        <h2>
          Naive Bayes <Week n={12} />
        </h2>
        <p>
          Naive Bayes is Bayes&apos; rule used as a classifier. It is fast, needs little data and is a sensible first
          baseline for text, and its weakness comes from one assumption you can see below.
        </p>
        <NaiveBayes />
      </section>

      <section id="code" className="ps-section">
        <h2>The same ideas in code</h2>
        <p>
          The bootstrap interval and a node&apos;s entropy, in a few lines of NumPy, on the page&apos;s claim times.
        </p>
        <CodeBlock html={highlight(CODE)} />
      </section>

      <section id="used" className="ps-section">
        <h2>Where this is used in the lab</h2>
        <ul>
          <li>
            <Link to="/ml">Machine learning toolbox</Link>: decision trees, naive Bayes and logistic regression running
            live.
          </li>
          <li>
            <Link to="/model-evaluation">Model evaluation</Link>: precision, base rates and resampling to judge a model.
          </li>
          <li>
            <Link to="/sampling">Sampling lab</Link>: a language model&apos;s next token drawn from a distribution, with
            temperature.
          </li>
          <li>
            <Link to="/confidence">Confidence and calibration</Link>: whether a model&apos;s stated probabilities match
            how often it is right.
          </li>
          <li>
            <Link to="/llmops">LLMOps</Link>: significance tests and sample sizes for A/B tests.
          </li>
          <li>
            <Link to="/mlops">MLOps</Link>: drift measured by how far a feature&apos;s distribution has moved.
          </li>
          <li>
            <Link to="/ml-maths">Maths for ML</Link>: vectors, derivatives and gradient descent, weeks 1 and 2.
          </li>
        </ul>
      </section>
    </main>
  );
}
