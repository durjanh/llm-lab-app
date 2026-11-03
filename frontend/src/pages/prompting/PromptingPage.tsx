import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './prompting.css';

export default function PromptingPage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-prompting">
      <div className="kicker">Lab 3 · Prompting</div>
      <h1>A prompt is just the start of a text</h1>
      <p className="lede">
        A language model continues text. Instructions, examples and chat roles all work by changing which continuation
        is most likely. This lab measures that directly, using GPT-2's real next-token probabilities on a small labelled
        test set.
      </p>
      <div id="gate" />
      <section className="needs-model locked" id="lab">
        <h2>Few-shot prompting, measured</h2>
        <p>
          The task is to label eight reviews as positive or negative. For each review the template below is filled in,
          and the model's probabilities for the next token being <code>positive</code> or <code>negative</code> are read
          off. Try each preset, then edit the template yourself. <code>&#123;review&#125;</code> marks where the review
          goes.
        </p>
        <div className="chips" id="tplPresets" style={{ marginBottom: '8px' }} />
        <textarea id="template" rows={9} spellCheck="false" />
        <div className="row" style={{ margin: '8px 0 4px' }}>
          <label>
            <input type="checkbox" id="calib" /> Calibrate against a blank input
          </label>{' '}
          <span className="spacer" />{' '}
          <button className="btn primary" id="runEval">
            Run on the test set
          </button>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v" id="sAcc">
              –
            </div>
            <div className="k">accuracy</div>
          </div>
          <div className="stat">
            <div className="v" id="sMass">
              –
            </div>
            <div className="k">probability on a valid label</div>
          </div>
          <div className="stat">
            <div className="v" id="sPos">
              –
            </div>
            <div className="k">predicted positive (4 are)</div>
          </div>
        </div>
        <div className="table-wrap">
          <table className="t" id="evalTable">
            <thead>
              <tr>
                <th>Review</th>
                <th>True label</th>
                <th>
                  Leaning <span className="muted">negative ← → positive</span>
                </th>
                <th>Predicted</th>
                <th className="num">Valid label</th>
              </tr>
            </thead>
            <tbody />
          </table>
        </div>
        <h3>Your runs</h3>
        <div className="table-wrap">
          <table className="t" id="runsTable">
            <thead>
              <tr>
                <th>Template</th>
                <th>Calibrated</th>
                <th className="num">Accuracy</th>
                <th className="num">Valid label</th>
                <th className="num">Predicted positive</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={5} className="muted">
                  Run a template to start comparing.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="note">
          <b>What to look for.</b> With no examples, almost none of the probability goes to either label, because the
          model has not learned the answer format. Balanced examples teach the format and improve accuracy. Examples
          that are all positive teach the model to say positive. Calibration divides out the model's bias measured on a
          blank input, which can rescue a biased prompt.
        </div>
        <h2>Constrained decoding: only allow valid answers</h2>
        <p>
          Left alone, the model can continue with anything, including text your code cannot parse. Constrained decoding
          scores only the answers you allow. Labels made of several tokens are scored by multiplying the probability of
          each token in turn.
        </p>
        <div className="grid2">
          <div>
            <label>Prompt</label>
            <textarea id="cPrompt" rows={8} spellCheck="false" />{' '}
            <label style={{ display: 'block', marginTop: '8px' }}>
              Allowed answers, comma separated
              <input type="text" id="cLabels" defaultValue="positive, negative, mixed" style={{ width: '100%' }} />
            </label>{' '}
            <button className="btn primary" id="runC" style={{ marginTop: '8px' }}>
              Score
            </button>
          </div>
          <div className="card">
            <h3 style={{ marginTop: '0' }}>Unconstrained: top next tokens</h3>
            <div id="cFree" />
            <p className="small muted" id="cGreedy" style={{ marginTop: '6px' }} />
            <h3>Constrained to your answers</h3>
            <div id="cCon" />
          </div>
        </div>
        <p className="small muted">
          Structured outputs, enums in JSON schemas, and strict tool inputs use the same idea: the decoder is stopped
          from producing anything that breaks the format.
        </p>
      </section>
      <section>
        <h2>Roles are text too, and so is everything you paste in</h2>
        <p>
          A chat API takes separate system, user and assistant messages, but the model receives them as one sequence of
          tokens with role markers in between. The markers below are illustrative; every provider uses its own. The
          important point is that a document you paste in sits in the same stream as your instructions.
        </p>
        <div className="row" style={{ marginBottom: '8px' }}>
          <label>
            <input type="checkbox" id="wrap" /> Wrap the untrusted email in tags and say it is data
          </label>
        </div>
        <div className="flat" id="flat" />
        <p className="small muted" id="flatCount" style={{ marginTop: '6px' }} />
        <div className="note">
          The red sentence is a <b>prompt injection</b>: instructions hidden inside data. Tags and a clear instruction
          help the model tell data from instructions, but they are not a security boundary. Never give a model access,
          tools or secrets that the least trusted text in its context should not control.
        </div>
      </section>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Examples teach format faster than instructions.</b> A few input and output pairs pin down exactly what
            you want back.
          </li>
          <li>
            <b>Balance and vary your examples.</b> The model copies their label mix and their order. Lopsided examples
            produce lopsided answers.
          </li>
          <li>
            <b>Judge a prompt on a test set, never on one example.</b> This page is a tiny evaluation. Real ones need
            dozens to hundreds of labelled cases.
          </li>
          <li>
            <b>Use structured outputs when code reads the answer.</b> It guarantees valid JSON, so you are not parsing
            free text. On recent Claude models, the old trick of prefilling the assistant's reply returns an error, so
            structured outputs are the way.
          </li>
          <li>
            <b>Treat pasted and retrieved text as data.</b> Delimit it, keep your instructions in the system prompt, and
            limit what tools can do.
          </li>
        </ul>
        <CodeBlock html={S.s1} />
        <p className="small" style={{ margin: '10px 0 0' }}>
          Runnable version: <code>python/03_classify_reviews.py</code>. Setup is in <code>python/README.md</code>.
        </p>
      </div>
    </main>
  );
}
