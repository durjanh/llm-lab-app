import Grpo from './Grpo';
import RewardHacking from './RewardHacking';
import TestTime from './TestTime';
import ThinkingBudget from './ThinkingBudget';
import './reasoning.css';

/** Lab 32: how reasoning models think before they answer, how RL with checked answers trains them, and what it costs. */
export default function ReasoningPage() {
  return (
    <main className="page-reasoning">
      <div className="kicker">Lab 32 · Reasoning models</div>
      <h1>Reasoning models: thinking before answering</h1>
      <p className="lede">
        A reasoning model writes out its working before it answers, and is trained with reinforcement learning on problems
        whose answers can be checked. Watch that training loop learn, see how a weak check gets gamed, and work out when
        extra thinking, or extra samples, are worth their cost.
      </p>

      <section className="rm-section">
        <h2>What a reasoning model does differently</h2>
        <div className="rm-two">
          <div className="card">
            <p className="small muted">An illustration of the two styles of answer</p>
            <p className="small">
              <b>Question.</b> A £40 price goes up by 25%, then the new price is cut by 20%. What is the final price?
            </p>
            <div className="rm-answer-box">
              <span className="rm-tag">Answering straight away</span>
              <p>“£42.” <span className="rm-bad">(+25% − 20% looks like +5%: wrong)</span></p>
            </div>
            <div className="rm-answer-box think">
              <span className="rm-tag">Thinking first</span>
              <p className="mono small">
                40 × 1.25 = 50. A 20% cut of 50 is 10, so 50 − 10 = 40.
              </p>
              <p>“£40.” <span className="rm-good">(right)</span></p>
            </div>
          </div>
          <div className="card">
            <ul className="small rm-list">
              <li>
                <b>Thinking tokens.</b> Before the answer, the model writes intermediate steps: working, checks, second
                attempts. It spends more compute at answer time instead of only at training time.
              </li>
              <li>
                <b>Trained to reason.</b> Beyond pre-training and instruction tuning, these models get reinforcement learning on
                problems with checkable answers (maths, code), which rewards reasoning that reaches right answers.
              </li>
              <li>
                <b>A setting in the API.</b> Claude has extended and adaptive thinking with an <code>effort</code> setting;
                OpenAI's reasoning models take a <code>reasoning_effort</code>. More effort means more thinking tokens.
              </li>
              <li>
                <b>Billed and slower.</b> Thinking tokens count as output tokens and take time to generate. Providers may show a
                summary of the thinking rather than all of it.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <Grpo />
      <RewardHacking />
      <TestTime />
      <ThinkingBudget />

      <section className="rm-section">
        <h2>Engineering takeaways</h2>
        <ul className="rm-list">
          <li>
            <b>Use reasoning where steps matter</b>: maths, code, multi-step planning, agents choosing tools. For look-ups,
            extraction and chat, low effort is usually as good and faster.
          </li>
          <li>
            <b>Verify what you can.</b> Tests, schemas, calculators and checkers beat asking the model whether it is sure, and
            make pass@k-style sampling worth paying for.
          </li>
          <li>
            <b>Check the checker.</b> Anything optimised against a check, by training or by a retry loop, finds the check's
            gaps. Hidden tests, property tests and human review of samples catch it.
          </li>
          <li>
            <b>Measure effort per task</b> with an evaluation set at two or three effort levels; pick the cheapest level that
            holds quality. Thinking costs output tokens and latency.
          </li>
        </ul>
      </section>
    </main>
  );
}
