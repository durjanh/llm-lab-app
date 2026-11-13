import type { CSSProperties } from 'react';
import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import { SoftmaxSurface } from './SoftmaxSurface';
import './confidence.css';

export default function ConfidencePage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-confidence">
      <div className="kicker">Lab 8 · Confidence</div>
      <h1>When can you trust a model's confidence?</h1>
      <p className="lede">
        Many systems act on a model's confidence. A support bot might answer on its own when it is sure and pass
        everything else to a person. That only works if the confidence is honest: when the model says 80%, it should be
        right about 80% of the time. This lab measures that with GPT-2 on 60 labelled reviews.
      </p>
      <div id="gate" />
      <section className="needs-model locked" id="lab">
        <h2>Sixty reviews, each with a confidence</h2>
        <p>
          Each review goes into a short prompt, and GPT-2's probabilities for the next token being <code>positive</code>{' '}
          or <code>negative</code> are read off. The two are rescaled to add up to 100%. The larger share is the
          prediction, and that share is the model's confidence. Half the reviews are plain. The rest are hard on
          purpose: negation, mixed feelings and sarcasm.
        </p>
        <div className="chips" id="promptChips" />
        <details>
          <summary>Show the prompt</summary>
          <div className="tpl" id="tplText" />
        </details>
        <div className="row run-row">
          <div className="progress" id="runBar" hidden>
            <i />
          </div>
          <span className="small muted" id="runStatus" />
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v" id="sAcc">
              –
            </div>
            <div className="k">accuracy</div>
          </div>
          <div className="stat">
            <div className="v" id="sConf">
              –
            </div>
            <div className="k">average confidence</div>
          </div>
          <div className="stat">
            <div className="v" id="sEce">
              –
            </div>
            <div className="k">calibration error, ECE</div>
          </div>
          <div className="stat">
            <div className="v" id="sPos">
              –
            </div>
            <div className="k">predicted positive, 30 are</div>
          </div>
        </div>
        <div className="chips" id="filterChips" style={{ marginBottom: '8px' }} />
        <div className="scroll">
          <table className="t" id="revTable">
            <thead>
              <tr>
                <th>Review</th>
                <th>Kind</th>
                <th>True label</th>
                <th>Predicted</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody />
          </table>
        </div>
        <h2>Does 70% sure mean 70% right?</h2>
        <p>
          A reliability diagram answers that. It groups the reviews by confidence and shows how often the model was
          right in each group. On a perfectly calibrated model, every bar would reach the dashed diagonal. Bars above
          the line mean the model is right more often than it claims, so it is underconfident. Bars below the line mean
          it is overconfident. With two labels the winner always has at least 50%, so the confidence axis starts at 50%.
        </p>
        <div className="chips" id="binChips" style={{ marginBottom: '6px' }} />
        <div className="legend">
          <span style={{ '--c': 'var(--s1)' } as CSSProperties}>Accuracy of the reviews in each bin</span>
          <span className="dash" style={{ '--c': 'var(--ink2)' } as CSSProperties}>
            Perfect calibration
          </span>
        </div>
        <svg
          className="chart"
          id="relChart"
          viewBox="0 0 560 320"
          role="img"
          aria-label="Reliability diagram: accuracy against confidence"
        />
        <p className="ece-line" id="eceLine" />
        <div className="note" id="verdict" />
        <h2>Calibrate on labelled data</h2>
        <p>
          You can often fix calibration without retraining the model. All you need is a small labelled set. Two simple
          methods work on label probabilities like these.
        </p>
        <p>
          <b>Temperature scaling</b> divides the model's score gap between the two labels by one number, T, chosen to
          fit the labelled set. T below 1 makes the model more decisive. T above 1 makes it more cautious. It never
          changes which label wins, so accuracy stays the same.
        </p>
        <p>
          <b>Contextual calibration</b> shows the model a content-free review, here "N/A", and divides each label's
          probability by the probability the model gave that label for "N/A". This removes a built-in lean towards one
          label. It can change predictions, so accuracy can change too.
        </p>
        <div className="chips" id="fixChips" style={{ marginBottom: '8px' }} />
        <div className="grid2">
          <div>
            <div className="chart-title">Before: raw confidence</div>
            <svg
              className="chart"
              id="relBefore"
              viewBox="0 0 560 320"
              role="img"
              aria-label="Reliability diagram before calibration"
            />
          </div>
          <div>
            <div className="chart-title" id="afterTitle">
              After
            </div>
            <svg
              className="chart"
              id="relAfter"
              viewBox="0 0 560 320"
              role="img"
              aria-label="Reliability diagram after calibration"
            />
          </div>
        </div>
        <div className="legend">
          <span style={{ '--c': 'var(--s1)' } as CSSProperties}>Accuracy of the reviews in each bin</span>
          <span className="dash" style={{ '--c': 'var(--ink2)' } as CSSProperties}>
            Perfect calibration
          </span>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v" id="fEce0">
              –
            </div>
            <div className="k">ECE before</div>
          </div>
          <div className="stat">
            <div className="v" id="fEce1">
              –
            </div>
            <div className="k">ECE after</div>
          </div>
          <div className="stat">
            <div className="v" id="fAcc0">
              –
            </div>
            <div className="k">accuracy before</div>
          </div>
          <div className="stat">
            <div className="v" id="fAcc1">
              –
            </div>
            <div className="k">accuracy after</div>
          </div>
        </div>
        <p className="small muted" id="fitInfo" />
        <h2>Send the unsure cases to a person</h2>
        <p>
          Selective prediction turns confidence into a decision. Above the threshold, the model answers on its own.
          Below it, the case goes to a person. A higher threshold lets fewer errors through but sends more work to
          people. The curve shows the whole trade-off, so you can pick the point that matches the error rate you can
          accept.
        </p>
        <div className="ctl">
          <div>
            <div className="small muted" style={{ marginBottom: '4px' }}>
              Confidence to use
            </div>
            <div className="chips" id="srcChips" />
          </div>
          <label>
            Threshold: answer automatically at or above <span className="mono" id="vTh" />
            <input type="range" id="th" min="0.5" max="1" step="0.01" defaultValue="0.8" />
          </label>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v" id="cCov">
              –
            </div>
            <div className="k">answered automatically</div>
          </div>
          <div className="stat">
            <div className="v" id="cAcc">
              –
            </div>
            <div className="k">accuracy on those</div>
          </div>
          <div className="stat">
            <div className="v" id="cErr">
              –
            </div>
            <div className="k">errors that slip through</div>
          </div>
          <div className="stat">
            <div className="v" id="cHum">
              –
            </div>
            <div className="k">sent to a person</div>
          </div>
        </div>
        <div className="legend">
          <span style={{ '--c': 'var(--s1)' } as CSSProperties}>Accuracy on the answered share</span>
          <span className="dash" style={{ '--c': 'var(--faint)' } as CSSProperties}>
            Accuracy if every review is answered
          </span>
          <span className="dot" style={{ '--c': 'var(--ink)' } as CSSProperties}>
            Your threshold
          </span>
        </div>
        <svg className="chart" id="covChart" viewBox="0 0 560 280" role="img" aria-label="Accuracy against coverage" />
        <p id="covText" />
        <div className="note">
          Calibration makes the threshold mean something. With raw scores, 0.8 is just a number. After calibration,
          answers with 80% confidence are right about 8 times in 10, so the threshold can be agreed in plain terms with
          the people who own the risk. Temperature scaling keeps the reviews in almost the same order, so the curve
          keeps its shape. What changes is the threshold you need to reach a given point on it.
        </div>
        <h2>Temperature changes how sure a model looks, not what it picks</h2>
        <p>
          A wrong prediction can be made to look 99% certain without changing a single weight. The model's scores pass
          through softmax, and dividing them by a temperature T before softmax rescales every confidence at once. Below,
          three classes get scores (x, y, 0). The height of the surface is the confidence, the colour is the class the
          model picks, and the floor shows where each class wins. Lower T and the surface rises towards 1 everywhere:
          every answer looks certain, the wrong ones too. Raise T and it sinks towards ⅓. The coloured regions on the
          floor never move, because dividing all scores by the same number never changes which is largest.
        </p>
        <SoftmaxSurface />
        <div className="note">
          This is why a confidence is only worth what its calibration is worth. A provider, a sampling setting or a
          post-processing step can change T, and with it every probability you see, while accuracy stays exactly the
          same. Temperature scaling, above, uses this on purpose: it picks the one T that makes confidences match how
          often the model is right on labelled data.
        </div>
        <h2>High probability is not the same as being right</h2>
        <p>
          Calibration needs labels. A factual answer comes with a probability but no label, so it is tempting to read
          the probability as truth. Here GPT-2 names the capital of 15 countries. The table shows its top answer, the
          probability of that whole answer, and whether it is right. Several of these capitals are not the country's
          best-known city, such as Ottawa, Canberra and Ankara. That is exactly where a model that learned word patterns
          slips.
        </p>
        <div className="chips" id="fmtChips" />
        <div className="tpl" id="capPrompt" />
        <div className="stats">
          <div className="stat">
            <div className="v" id="kRight">
              –
            </div>
            <div className="k">right answers</div>
          </div>
          <div className="stat">
            <div className="v" id="kPR">
              –
            </div>
            <div className="k">average probability when right</div>
          </div>
          <div className="stat">
            <div className="v" id="kPW">
              –
            </div>
            <div className="k">average probability when wrong</div>
          </div>
          <div className="stat">
            <div className="v" id="kTop">
              –
            </div>
            <div className="k">most confident wrong answer</div>
          </div>
        </div>
        <div className="legend">
          <span className="dot" style={{ '--c': 'var(--s1)' } as CSSProperties}>
            Right answer
          </span>
          <span className="dot" style={{ '--c': 'var(--s2)' } as CSSProperties}>
            Wrong answer
          </span>
        </div>
        <svg
          className="chart"
          id="capChart"
          viewBox="0 0 560 120"
          role="img"
          aria-label="Probability of each answer, right and wrong"
        />
        <div className="table-wrap">
          <table className="t" id="capTable">
            <thead>
              <tr>
                <th>Country</th>
                <th>GPT-2's answer</th>
                <th>Its probability</th>
                <th>Right answer</th>
                <th className="num">Probability of the right answer</th>
              </tr>
            </thead>
            <tbody />
          </table>
        </div>
        <div className="note">
          A next-token probability says how likely those words are to come next. It does not check the fact. Wrong
          answers can score as high as right ones, so a single probability cannot tell you whether one answer is true.
          Measure how often answers at each confidence level are right before you rely on the number.
        </div>
      </section>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Check calibration before you build rules on confidence.</b> Score a labelled set from your own task and
            draw a reliability diagram. On this page, changing only the prompt changes how honest the confidence is, so
            check again after every prompt or model change.
          </li>
          <li>
            <b>Calibrate on held-out data.</b> Temperature scaling fixes overconfidence or underconfidence without
            changing answers. Contextual calibration removes a lean towards one label. Fit either on one labelled set
            and measure on another.
          </li>
          <li>
            <b>Choose the threshold from the coverage curve.</b> Decide what error rate you can accept, then read off
            how much work goes to people. Revisit it when traffic changes.
          </li>
          <li>
            <b>A high probability is not proof.</b> Models can be confidently wrong, especially when a famous answer
            sits next to the right one. Ground factual answers in documents and check them.
          </li>
          <li>
            <b>No token probabilities? Measure agreement.</b> If your API does not return token probabilities, ask the
            same question several times. The share of answers that agree is a practical confidence signal. Calibrate it
            on labelled data like any other score.
          </li>
          <li>
            <b>Check verbal confidence against data.</b> A model that writes "I am 90% sure" is producing more text, not
            reporting a measured probability. Before you trust such statements, check how often they are right on your
            own labelled cases.
          </li>
        </ul>
        <CodeBlock html={S.s1} />
      </div>
    </main>
  );
}
