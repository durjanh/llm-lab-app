import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './ml.css';

export default function MlPage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-ml">
      <div className="kicker">Lab 14 · Machine learning algorithms</div>
      <h1>The machine learning toolbox, live</h1>
      <p className="lede">
        Large language models are one tool in a much bigger box. Seventeen classic and modern algorithms are below, each
        running for real in your browser on data you can see and change. Each one comes with when to use it, when not
        to, and where it turns up inside today's AI systems.
      </p>
      <h2>Which algorithm should I try?</h2>
      <p>
        Answer four questions for a shortlist. It is a starting point, not a rule: on real problems, try two or three
        and compare them on held-out data.
      </p>
      <div className="card">
        <div className="helper">
          <label>
            Do you have labelled examples?
            <select id="hLabels">
              <option value="yes">Yes, each example has the right answer</option>
              <option value="no">No, just raw data</option>
            </select>
          </label>{' '}
          <label>
            What do you want?
            <select id="hGoal" />
          </label>{' '}
          <label>
            What does the data look like?
            <select id="hData">
              <option value="table">Rows and columns, like a spreadsheet</option>
              <option value="text">Text</option>
              <option value="image">Images</option>
              <option value="seq">Sequences or time series</option>
            </select>
          </label>{' '}
          <label>
            What matters most?
            <select id="hPri">
              <option value="accuracy">Accuracy</option>
              <option value="explain">Explaining each decision</option>
              <option value="small">Working with little data</option>
              <option value="speed">Speed and simplicity</option>
            </select>
          </label>
        </div>
        <ol className="recs" id="recs" />
      </div>
      <h2>Pick an algorithm</h2>
      <div className="algo-groups" id="algoGroups" />
      <div className="demo">
        <div>
          <div className="plot-wrap" id="plotArea" />
          <div className="ctrl" id="controls" />
          <div className="readout" id="readout" />
          <div id="extra" />
        </div>
        <div className="info" id="info" />
      </div>
      <h2>All seventeen at a glance</h2>
      <p>Filter by family. Click a name to open its demo above.</p>
      <div className="chips" id="cmpFilter" style={{ marginBottom: '8px' }} />
      <div className="table-wrap">
        <table className="t cmp" id="cmpTable" />
      </div>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Start simple and keep it as a baseline.</b> A logistic regression or a gradient-boosted model trained in
            minutes tells you whether a fancier model is earning its cost.
          </li>
          <li>
            <b>Match the model to the data's shape.</b> Gradient-boosted trees usually win on spreadsheet-style data.
            Convolutional networks and transformers win on images, audio and text, where the structure matters.
          </li>
          <li>
            <b>Always judge on data the model has not seen.</b> Every demo above shows training and held-out accuracy. A
            big gap means memorising, the same failure the Training lab shows for language models.
          </li>
          <li>
            <b>Many LLM systems are classic ML underneath.</b> Retrieval is nearest-neighbour search, IVF and
            product-quantisation vector indexes use k-means (HNSW, the most common index, is a graph instead), routers
            and guardrails are often small classifiers, and an LLM's last layer is a giant logistic regression over its
            vocabulary.
          </li>
          <li>
            <b>You do not always need an LLM.</b> For a fixed label set with plenty of examples, a small classifier is
            cheaper, faster and easier to test. Use an LLM when the task is open-ended, or when you have too few
            examples to train on.
          </li>
        </ul>
        <CodeBlock html={S.s1} />
      </div>
    </main>
  );
}
