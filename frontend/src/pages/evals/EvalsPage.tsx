import { useRef } from 'react';
import { useEngine } from '@/lib/useEngine';
import { mount } from './engine';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './evals.css';

export default function EvalsPage() {
  const root = useRef<HTMLElement>(null);
  useEngine(root, mount);
  return (
    <main ref={root} className="page-evals">
      <div className="kicker">Lab 7 · Evals</div>
      <h1>Did the prompt get better, or did you get lucky?</h1>
      <p className="lede">
        An eval is a set of test cases plus a way to grade the answers. It turns "this prompt feels better" into a
        number you can defend. This lab builds one, grades answers three ways, then asks the question most teams skip:
        is the difference bigger than the noise? GPT-2 does the classifying, using its real next-token probabilities.
      </p>
      <div id="gate" />
      <section id="secData">
        <h2>1. Build a labelled test set</h2>
        <p>
          A test set is a list of inputs, each with the answer a person agrees is correct. The task here is sentiment:
          is each review positive or negative? A third of the cases are deliberately hard. Sarcasm uses nice words to
          mean the opposite. Negation flips a word, as in "not bad at all". Mixed reviews praise one thing and criticise
          another, and the label is the overall verdict.
        </p>
        <p>
          This matters because a prompt change is only as good as the cases you test it on. Leave out the hard cases and
          every prompt looks fine.
        </p>
        <div className="stats">
          <div className="stat">
            <div className="v" id="dN">
              –
            </div>
            <div className="k">cases</div>
          </div>
          <div className="stat">
            <div className="v" id="dPos">
              –
            </div>
            <div className="k">labelled positive</div>
          </div>
          <div className="stat">
            <div className="v" id="dNeg">
              –
            </div>
            <div className="k">labelled negative</div>
          </div>
          <div className="stat">
            <div className="v" id="dHard">
              –
            </div>
            <div className="k">hard cases</div>
          </div>
        </div>
        <div className="scroll">
          <table className="t" id="dataTable">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Review</th>
                <th>Label</th>
                <th>Kind</th>
                <th>
                  <span className="sr">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody />
          </table>
        </div>
        <div className="row add-row">
          <input
            type="text"
            id="newText"
            placeholder="Add your own review, for example: Could have been worse."
            aria-label="New review"
          />{' '}
          <select id="newLabel" aria-label="Label">
            <option>positive</option>
            <option>negative</option>
          </select>{' '}
          <select id="newKind" aria-label="Kind">
            <option>plain</option>
            <option>sarcasm</option>
            <option>negation</option>
            <option>mixed</option>
          </select>{' '}
          <button className="btn" id="addCase">
            Add case
          </button>{' '}
          <button className="btn" id="resetData">
            Reset to the built-in set
          </button>
        </div>
        <p className="small muted" style={{ marginTop: '6px' }}>
          Changes are scored straight away once GPT-2 is loaded. Each case is scored once per prompt and then
          remembered.
        </p>
        <div className="note">
          <b>Good test sets</b> come from real traffic and include the failures users reported. They keep a sensible
          label mix, and they stay frozen while you compare prompts. If you change the cases and the prompt at the same
          time, you cannot tell which change moved the score.
        </div>
      </section>
      <section id="secGraders">
        <h2>2. Decide how each answer is graded</h2>
        <p>
          A grader turns one model output into a score. Use the cheapest grader that measures what you care about. Code
          is free, fast and gives the same answer every time. A model judge can read meaning, but it costs money and
          makes mistakes of its own.
        </p>
        <div className="grid3">
          <div className="card grader-card">
            <h3>Exact match</h3>
            <p>Compare the output with the expected label as a string.</p>
            <p>
              <b>Use it for</b> classification, extraction of IDs and dates, and multiple choice.
            </p>
            <p>
              <b>Watch out for</b> formatting. "Positive." is not "positive". Constrain the output so it can only be a
              valid label.
            </p>
          </div>
          <div className="card grader-card">
            <h3>Code-based rubric</h3>
            <p>A list of checks written in code: required facts, length limits, banned content, valid JSON.</p>
            <p>
              <b>Use it for</b> free text where you can name what must and must not appear.
            </p>
            <p>
              <b>Watch out for</b> wording. Keyword checks miss paraphrases and are fooled by negation.
            </p>
          </div>
          <div className="card grader-card">
            <h3>LLM as judge</h3>
            <p>A second model reads the output and a rubric, then returns a score and a reason.</p>
            <p>
              <b>Use it for</b> qualities code cannot check, such as faithfulness, tone and helpfulness.
            </p>
            <p>
              <b>Watch out for</b> the judge's own biases. Check it against human labels before you trust it.
            </p>
          </div>
        </div>
        <h3>Exact match, strict and normalised</h3>
        <p>
          The expected label is <code>positive</code>. A strict grader fails anything that is not exactly that string.
          Normalising first, by lowering the case and trimming spaces and end punctuation, rescues small formatting
          slips. It cannot rescue a sentence.
        </p>
        <div className="grid2">
          <div className="table-wrap">
            <table className="t" id="emTable">
              <thead>
                <tr>
                  <th>Model output</th>
                  <th>Strict</th>
                  <th>Normalised</th>
                </tr>
              </thead>
              <tbody />
            </table>
          </div>
          <div className="card">
            <label htmlFor="emTry">Try an output</label>{' '}
            <input type="text" id="emTry" defaultValue="  Positive!" style={{ width: '100%', marginTop: '4px' }} />
            <p id="emTryOut" style={{ margin: '8px 0 0' }} />
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              The fix is to constrain the output. The GPT-2 runs below only score the two allowed labels, and Claude's
              structured outputs guarantee a value from your list.
            </p>
          </div>
        </div>
        <h3>A code-based rubric for free text</h3>
        <p>
          Say a model writes one-line summaries of support tickets for an on-call engineer. Here is the ticket. Below it
          are six candidate summaries, graded by six checks written in code. A person has also marked each summary pass
          or fail, so you can see where the code grader is wrong.
        </p>
        <div className="ticket" id="ticket" />
        <div className="table-wrap" style={{ marginTop: '10px' }}>
          <table className="t rubric" id="rubricTable" />
        </div>
        <p className="small" id="rubricAgree" style={{ marginTop: '6px' }} />
        <label htmlFor="mySummary" style={{ display: 'block', marginTop: '6px' }}>
          Write your own summary. It is graded as you type and appears as the last row.
        </label>{' '}
        <textarea
          id="mySummary"
          rows={2}
          spellCheck="false"
          placeholder="For example: Standing desk arrived with a cracked leg. Customer wants a replacement before 24 March."
        />
        <div className="note">
          Summary 5 passes every check but says the opposite of the ticket, because the keywords are all there. Summary
          6 is correct but fails, because it says "the 24th" instead of "24 March". Code graders are exact, cheap and
          repeatable. They are also literal, so test the grader itself on cases like these.
        </div>
        <h3>LLM as judge</h3>
        <p>
          A judge model reads the ticket, the summary and the rubric, then returns a score from 1 to 5 and a
          one-sentence reason. Structured outputs force the reply into that shape, so code can read it. Here a score of
          4 or 5 counts as a pass.
        </p>
        <div className="card">
          <div className="row">
            <span className="live-state off" id="liveState">
              Checking for live Claude…
            </span>
            <span className="spacer" />
            <button className="btn small" id="liveCheck">
              Check again
            </button>
          </div>
          <div className="grid2" style={{ marginTop: '10px' }}>
            <div>
              <label htmlFor="jPick">Summary to judge</label>{' '}
              <select id="jPick" style={{ width: '100%', marginTop: '4px' }} />
              <div className="small muted" style={{ marginTop: '8px' }}>
                The exact request the judge receives:
              </div>
              <div className="flat" id="jPrompt" />
            </div>
            <div className="stack">
              <div className="row">
                <button className="btn primary" id="jOne" disabled>
                  Judge this summary
                </button>
                <button className="btn" id="jAll" disabled>
                  Judge all six
                </button>
              </div>
              <div className="judge-out" id="jOut" />
              <div id="liveHelp" className="small" />
              <h3 style={{ marginTop: '14px' }}>Test the judge for position bias</h3>
              <p className="small" style={{ marginBottom: '6px' }}>
                Show the judge two summaries and ask which is better. Then swap the order. A fair judge picks the same
                summary both times.
              </p>
              <div className="row">
                <select id="pFirst" aria-label="First summary" />
                <select id="pSecond" aria-label="Second summary" />
                <button className="btn" id="pRun" disabled>
                  Compare in both orders
                </button>
              </div>
              <div className="judge-out" id="pOut" />
            </div>
          </div>
        </div>
        <div className="note">
          <b>Judge pitfalls.</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: '20px' }}>
            <li>
              <b>Position bias.</b> When comparing two answers, judges often favour whichever comes first, or second.
              Run both orders and only count a win that survives the swap.
            </li>
            <li>
              <b>Verbosity bias.</b> Longer answers tend to score higher even when they are worse. Put length limits in
              the rubric and check them with code.
            </li>
            <li>
              <b>Self-preference.</b> A judge can favour text written in its own style. Where you can, use a judge that
              did not write the answers.
            </li>
            <li>
              <b>Check the judge against people.</b> Label 50 to 100 outputs yourself and measure how often the judge
              agrees. Only rely on it where it agrees.
            </li>
            <li>
              <b>Keep the scale small and anchored.</b> Pass or fail, or 1 to 5 with each score described, is more
              consistent than "rate from 1 to 10".
            </li>
          </ul>
        </div>
      </section>
      <section className="needs-model locked" id="lab">
        <h2>3. Score two prompts on the same cases</h2>
        <p>
          Each review is put into a prompt template, and GPT-2 gives the probability that the next token is{' '}
          <code>positive</code> or <code>negative</code>. The more likely label is the prediction, graded by exact
          match. Only the two labels are scored, so formatting can never cause a miss. Prompt A is your baseline. Prompt
          B is the change you want to ship.
        </p>
        <div className="grid2">
          <div className="tplbox">
            <div className="slot-head">
              <span className="slot" style={{ background: 'var(--s1)' }} />
              <b>Prompt A</b>
              <span className="muted small" id="nameA" />
            </div>
            <div className="chips" id="presetsA" style={{ marginBottom: '6px' }} />
            <textarea id="tplA" rows={8} spellCheck="false" aria-label="Prompt A template" />
          </div>
          <div className="tplbox">
            <div className="slot-head">
              <span className="slot" style={{ background: 'var(--s2)' }} />
              <b>Prompt B</b>
              <span className="muted small" id="nameB" />
            </div>
            <div className="chips" id="presetsB" style={{ marginBottom: '6px' }} />
            <textarea id="tplB" rows={8} spellCheck="false" aria-label="Prompt B template" />
          </div>
        </div>
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          <code>&#123;review&#125;</code> marks where each review goes. Few-shot examples must never be copied from the
          test set, or the score measures memory instead of skill. GPT-2 is small and leans towards saying positive, so
          examples matter a lot here. Later, try the two hard-case presets against each other: they hold the same
          examples in a different order.
        </p>
        <div className="row run-row">
          <button className="btn primary" id="runAB">
            Run A and B on the test set
          </button>
          <div className="progress" id="prog" hidden>
            <i />
          </div>
          <span className="small muted" id="progTxt" />
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v" id="sA">
              –
            </div>
            <div className="k">Prompt A correct</div>
          </div>
          <div className="stat">
            <div className="v" id="sB">
              –
            </div>
            <div className="k">Prompt B correct</div>
          </div>
          <div className="stat">
            <div className="v" id="sFix">
              –
            </div>
            <div className="k">B fixed: A wrong, B right</div>
          </div>
          <div className="stat">
            <div className="v" id="sBrk">
              –
            </div>
            <div className="k">B broke: A right, B wrong</div>
          </div>
        </div>
        <p className="small" id="predLine" />
        <div className="grid2">
          <div>
            <h3 style={{ marginTop: '4px' }}>Every case</h3>
            <div className="scroll">
              <table className="t" id="resTable">
                <thead>
                  <tr>
                    <th>Review</th>
                    <th>Label</th>
                    <th>Prompt A</th>
                    <th>Prompt B</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td colSpan={4} className="muted">
                      Load GPT-2 to score the prompts.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginTop: '6px' }}>
              Each bar is the probability of <code>positive</code>. Past the middle line, the prediction is positive.
            </p>
          </div>
          <div>
            <h3 style={{ marginTop: '4px' }}>Accuracy by kind of case</h3>
            <div className="table-wrap">
              <table className="t" id="kindTable">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th className="num">Cases</th>
                    <th className="num">Prompt A</th>
                    <th className="num">Prompt B</th>
                  </tr>
                </thead>
                <tbody />
              </table>
            </div>
            <p className="small" style={{ marginTop: '8px' }}>
              One overall number hides where a prompt fails. Slice the results by kind of case. A prompt that gains on
              easy cases and loses on sarcasm may be worse for the users who matter.
            </p>
            <p className="small">
              Counting what B <b>fixed</b> and what it <b>broke</b> is more useful than the net change. A prompt that
              fixes ten cases and breaks eight has changed behaviour a lot, even if the score barely moved.
            </p>
          </div>
        </div>
        <h2>4. Is B really better? Put an interval on it</h2>
        <p>
          Your test set is a sample. Another sample of the same kind would give a slightly different score. A{' '}
          <b>95% confidence interval</b> is a range made by a method that, repeated on many new samples, would contain
          the prompt&apos;s true accuracy 95% of the time. Here the <b>bootstrap</b> approximates it: build a new test
          set of the same size by drawing cases from yours at random, with replacement, so some appear twice and some
          not at all. Score it, repeat 2,000 times, and keep the middle 95% of the scores.
        </p>
        <p>
          The difference B − A is bootstrapped in pairs. Each resample draws the same cases for both prompts, because
          both saw the same reviews. That is fairer and tighter than comparing two separate intervals. Differences are
          in <b>percentage points</b>: going from 70% to 75% is a gain of 5 points.
        </p>
        <div className="row" style={{ margin: '10px 0 4px' }}>
          <span className="small" style={{ color: 'var(--ink2)' }}>
            Cases in the sample
          </span>
          <div className="chips" id="nChips" />
          <button className="btn small" id="redraw">
            Draw a different sample
          </button>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v" id="cA">
              –
            </div>
            <div className="k" id="cAk">
              Prompt A
            </div>
          </div>
          <div className="stat">
            <div className="v" id="cB">
              –
            </div>
            <div className="k" id="cBk">
              Prompt B
            </div>
          </div>
          <div className="stat">
            <div className="v" id="cD">
              –
            </div>
            <div className="k" id="cDk">
              B − A
            </div>
          </div>
          <div className="stat">
            <div className="v" id="cOne">
              –
            </div>
            <div className="k" id="cOnek">
              one case is worth
            </div>
          </div>
        </div>
        <div className="verdict" id="verdict">
          Load GPT-2 to compare the prompts.
        </div>
        <div className="grid2">
          <div>
            <div className="chart-title">Accuracy with 95% intervals, by sample size</div>
            <div className="legend" id="nLegend" />
            <div id="nChart" />
          </div>
          <div>
            <div className="chart-title">Difference B − A with its 95% interval</div>
            <div className="legend" id="dLegend" />
            <div id="dChart" />
          </div>
        </div>
        <div className="note" id="smallNote">
          <b>Try 8 cases.</b> One case is then worth 12.5 points, so going from 6 to 7 correct looks like a big gain.
          The interval for a single prompt is about 50 points wide, so that jump is noise. Press "Draw a different
          sample" a few times and watch the winner change.
        </div>
        <h2>5. Run it again: run-to-run variance</h2>
        <p>
          So far each prompt always takes its most likely label, so a rerun gives the same answer. Real systems sample,
          and hosted models can vary between identical calls. Here each label is drawn at random from GPT-2's own
          probabilities, so a review that is 70% positive comes out positive about 70% of the time. <b>Temperature</b>{' '}
          reshapes those odds. Below 1 it sharpens them, above 1 it flattens them, and 0 means always take the top
          label.
        </p>
        <p>
          This matters because one run of each prompt can pick the wrong winner. On current Claude models you cannot
          turn temperature down, so run each case a few times and average. These runs use the cases selected in section
          4.
        </p>
        <div className="row" style={{ margin: '10px 0 4px' }}>
          <label>
            Temperature <input type="range" id="temp" min="0" max="2" step="0.1" defaultValue="1" />{' '}
            <span className="mono" id="tempV">
              1.0
            </span>
          </label>{' '}
          <label>
            Repeated runs{' '}
            <select id="nRuns" defaultValue="20">
              <option>10</option>
              <option>20</option>
              <option>40</option>
            </select>
          </label>{' '}
          <button className="btn" id="resample">
            Sample again
          </button>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="v" id="vA">
              –
            </div>
            <div className="k" id="vAk">
              Prompt A, mean across runs
            </div>
          </div>
          <div className="stat">
            <div className="v" id="vB">
              –
            </div>
            <div className="k" id="vBk">
              Prompt B, mean across runs
            </div>
          </div>
          <div className="stat">
            <div className="v" id="vW">
              –
            </div>
            <div className="k" id="vWk">
              runs where B beat A
            </div>
          </div>
        </div>
        <div className="chart-title">Accuracy of each repeated run</div>
        <div className="legend" id="sLegend" />
        <div id="sChart" />
        <p className="small" id="sNote" style={{ marginTop: '6px' }} />
        <h2>6. Every run, side by side</h2>
        <p>
          Each row is one evaluation: a prompt, a number of cases and a way of picking labels. Sampled rows report the
          mean over their repeated runs, with an interval over cases. Overlapping intervals are a warning sign, not a
          verdict. For the A against B decision itself, use the paired difference in section 4.
        </p>
        <div className="legend" id="hLegend" />
        <div id="hChart" />
        <div className="table-wrap" style={{ marginTop: '10px' }}>
          <table className="t" id="histTable">
            <thead>
              <tr>
                <th className="num">Run</th>
                <th>Prompt</th>
                <th className="num">Cases</th>
                <th>Labels picked by</th>
                <th className="num">Accuracy</th>
                <th className="num">95% interval</th>
                <th className="num">Run-to-run range</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={7} className="muted">
                  Runs appear here as you go.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="row" style={{ marginTop: '8px' }}>
          <span className="small muted" id="histCount" />
          <span className="spacer" />
          <button className="btn small" id="clearHist">
            Clear history
          </button>
        </div>
      </section>
      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Build the test set before you touch the prompt.</b> Start with 50 to 200 real cases, including the
            failures users reported. Version it like code.
          </li>
          <li>
            <b>Grade with code wherever you can.</b> Exact match and rubric checks are free and repeatable. Use an LLM
            judge only for what code cannot check, and measure its agreement with human labels first.
          </li>
          <li>
            <b>Report an interval, not a single number.</b> "72%, 95% interval 60% to 83%" stops a team from shipping
            noise.
          </li>
          <li>
            <b>Compare prompts on the same cases, in pairs.</b> Look at the interval for B − A, and count what B fixed
            and what it broke.
          </li>
          <li>
            <b>Size the test set for the gap you need to see.</b> At 75% accuracy, a 95% interval spans about ±30 points
            with 8 cases, ±13 with 40 and ±5 with 300. Small gains need hundreds of cases.
          </li>
          <li>
            <b>Run each case more than once.</b> Current Claude models do not accept temperature, and hosted outputs can
            vary. Average a few runs per case before deciding.
          </li>
        </ul>
        <CodeBlock html={S.s1} />
        <p className="small" style={{ margin: '8px 0 0' }}>
          Runnable versions: <code>python/03_classify_reviews.py</code> classifies reviews with structured outputs, and{' '}
          <code>python/08_eval_with_judge.py</code> runs an LLM judge over a set of outputs and checks it against human
          labels.
        </p>
      </div>
    </main>
  );
}
