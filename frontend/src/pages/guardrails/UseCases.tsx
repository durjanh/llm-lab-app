import { useState } from 'react';
import { Panel } from '@/pages/ai103/shared';

type Verdict = 'supported' | 'avoid';
type Scenario = {
  text: string;
  verdict: Verdict;
  why: string;
  /** The consideration it falls under, for the ones to avoid; how it stays safe, for the supported ones. */
  rule: string;
  safe?: [string, string];
};

const NOTE =
  'https://learn.microsoft.com/azure/foundry/responsible-ai/agents/transparency-note#considerations-when-choosing-a-use-case';

/** Scenarios to sort, in the lab's own words. The first five follow a practice exam question. */
const SCENARIOS: Scenario[] = [
  {
    text: 'A city clerk uses an agent to sort incoming service requests, route each to the right department and draft short status updates.',
    verdict: 'supported',
    why: 'Routine triage and drafting. Officials read the updates before they go out, and nobody loses a right or a service because of a routing choice.',
    rule: 'Low stakes, and a person reviews what the public sees.',
    safe: ['Case handling: the caseworker approves', '/casework'],
  },
  {
    text: 'A hospital administrator uses an agent to turn procedures, staff directories and shift policies into short orientation packs for new nurses.',
    verdict: 'supported',
    why: 'It summarises internal documents for staff. It makes no decision about a patient, and the pack is checked before it is used.',
    rule: 'Information for staff, not decisions about patients; reviewed before use.',
    safe: ['MedAssist: answers from the practice documents only', '/medassist'],
  },
  {
    text: "A lawyer uses an agent to review a client's legal documents and decide the risks of a new business venture.",
    verdict: 'avoid',
    why: "The output is legal advice that a client relies on, which affects their legal position. A wrong or missed risk is costly, and the model's output can be inaccurate.",
    rule: 'Could affect legal status or rights; a consequential decision in a legal domain.',
  },
  {
    text: "A boutique owner's agent recommends gifts from a shopper's stated needs and past purchases, and guides them through a large catalogue.",
    verdict: 'supported',
    why: 'Low-stakes guidance. The shopper decides. The agent should not push products unfairly or mislead.',
    rule: 'The person chooses; keep recommendations honest and free of manipulation.',
  },
  {
    text: 'A nurse uses an agent to diagnose a patient and prescribe medication.',
    verdict: 'avoid',
    why: 'A wrong diagnosis or dose can physically harm the patient. This is the clearest case of a use to avoid.',
    rule: 'Could cause physical injury; health advice and medicines are a high-stakes domain.',
    safe: ['Aftercare: warning signs go to a nurse, by rules in code', '/aftercare'],
  },
  {
    text: 'A bank lets an agent approve or decline loan applications on its own.',
    verdict: 'avoid',
    why: 'Access to credit is a life opportunity. A biased or unreliable decision hurts real people, and nobody checks it.',
    rule: 'Affects access to credit; bias causes high-stakes harm.',
  },
  {
    text: 'An agent screens job applications and rejects candidates without a recruiter seeing them.',
    verdict: 'avoid',
    why: 'Employment is a life opportunity, and screening is where training-data bias does the most damage.',
    rule: 'Affects access to employment; consequential and unreviewed.',
  },
  {
    text: 'A teacher uses an agent to gather age-appropriate sources for next week’s lesson.',
    verdict: 'supported',
    why: 'Research help. The teacher checks each source for accuracy and fit before using it.',
    rule: 'The teacher reviews before anything reaches pupils.',
  },
  {
    text: 'An agent watches stock levels, drafts restocking orders and proposes shift rotas; a manager approves them.',
    verdict: 'supported',
    why: 'It proposes, a manager decides. Mistakes are caught before they cost anything.',
    rule: 'Management keeps the final decision.',
    safe: ['Harness: approval before any action', '/harness'],
  },
  {
    text: 'An agent with browser automation logs in to the bank and pays supplier invoices without asking anyone.',
    verdict: 'avoid',
    why: "Payments cannot be undone, and a web page can carry instructions that turn the agent against the user. Microsoft puts browser automation's risk on the customer.",
    rule: 'An irreversible financial action, with a tool open to prompt injection.',
    safe: ['Coding agent: auto mode denies some actions outright', '/coding-agent'],
  },
];

const CONSIDERATIONS: [string, string][] = [
  [
    'Physical or psychological injury',
    'Could the output hurt someone? Diagnosis and prescribing are the standard example.',
  ],
  [
    'Legal status and life opportunities',
    'Could it affect legal rights, or access to credit, education, employment, healthcare, housing, insurance or welfare?',
  ],
  ['High-stakes harm from bias', 'Where unfair or unreliable output is costly, bias in the model matters most.'],
  [
    'Irreversible or consequential actions',
    'Payments, health advice, publishing sensitive information, granting access to systems: take extra care in finance, health and law.',
  ],
  [
    'Your own legal duties',
    'The organisation that deploys the agent checks its compliance, monitors its actions with people, and holds any licence a domain needs.',
  ],
  [
    'Tools outside Microsoft',
    'Third-party tools and other agents are outside Microsoft’s testing; data sent to them leaves your boundary.',
  ],
];

export default function UseCases() {
  const [answers, setAnswers] = useState<Record<number, Verdict>>({});
  const answered = Object.keys(answers).length;
  const right = SCENARIOS.filter((s, i) => answers[i] === s.verdict).length;
  return (
    <Panel title="9. Before any guardrail: is this a supported use?" id="use-cases">
      <p className="small">
        Guardrails reduce harm inside a use case. They cannot make an unsuitable one safe. The Foundry Agent Service is
        use-case agnostic, so choosing the use is your job. Microsoft&apos;s{' '}
        <a href={NOTE}>Transparency Note for the Agent Service</a> lists what to weigh. Its examples of intended uses
        share one pattern: the agent gathers, sorts, drafts or recommends, and a person decides. All five run as Foundry
        agents in <code>examples/agents/</code>, each with a review queue that only a person can clear.
      </p>
      <p className="small muted">
        Sort each scenario, then see why. {answered > 0 && `${right} of ${answered} as the note would.`}{' '}
        {answered > 0 && (
          <button className="az-chip" onClick={() => setAnswers({})}>
            Start again
          </button>
        )}
      </p>
      <ol className="small" style={{ paddingLeft: 20 }}>
        {SCENARIOS.map((s, i) => {
          const pick = answers[i];
          return (
            <li key={s.text} style={{ marginBottom: 12 }}>
              <div>{s.text}</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                {(['supported', 'avoid'] as Verdict[]).map((v) => (
                  <button
                    key={v}
                    className={`az-chip ${pick === v ? 'on' : ''}`}
                    onClick={() => setAnswers({ ...answers, [i]: v })}
                  >
                    {v === 'supported' ? 'Supported use' : 'Avoid'}
                  </button>
                ))}
                {pick && (
                  <span className={`az-tag ${s.verdict === 'supported' ? 'pass' : 'block'}`}>
                    {pick === s.verdict ? 'Right: ' : 'Not quite: '}
                    {s.verdict === 'supported' ? 'supported use' : 'avoid'}
                  </span>
                )}
              </div>
              {pick && (
                <div className="az-quote" style={{ marginTop: 6 }}>
                  {s.why} <b>{s.rule}</b>
                  {s.safe && (
                    <>
                      {' '}
                      In this lab: <a href={s.safe[1]}>{s.safe[0]}</a>.
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <h4 style={{ marginBottom: 6 }}>What the note asks you to weigh</h4>
      <div className="az-table-wrap">
        <table className="az-table">
          <tbody>
            {CONSIDERATIONS.map(([name, text]) => (
              <tr key={name}>
                <td style={{ width: '30%' }}>
                  <b>{name}</b>
                </td>
                <td>{text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        When a use passes, the same note&apos;s practices keep it there: a person approves critical or high-stakes
        actions, users can limit the agent&apos;s tools and domains, tool calls are traced, and allowed and forbidden
        actions are written down before launch. Paraphrased from the note as read on 5 November 2026.
      </p>
    </Panel>
  );
}
