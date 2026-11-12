import { useState } from 'react';
import { Link } from 'react-router';
import { CodeBlock } from '@/components/CodeBlock';
import * as S from './snippets';
import './building-agents.css';

interface Loop {
  id: string;
  name: string;
  code: string;
  file: string;
  owns: string;
  stops: string;
  adds: string[];
  tryIt: { label: string; to: string };
}

const LOOPS: Loop[] = [
  {
    id: 'claude',
    name: 'Claude API, by hand',
    code: S.loopClaude,
    file: 'examples/hotel/hotel.py',
    owns: 'A list of messages you keep and resend',
    stops: 'No tool_use in the reply, or max_rounds',
    adds: [
      'Each result names the call it answers with tool_use_id.',
      'A failed tool returns is_error, and the model adapts.',
      'Works unchanged on GPT and the local model, through make_client().',
    ],
    tryIt: { label: 'The hotel agent', to: '/hotel' },
  },
  {
    id: 'harness',
    name: 'A harness',
    code: S.loopHarness,
    file: 'python/11_harness_loop.py',
    owns: 'A list of messages, compacted when it grows',
    stops: 'No tool_use, max_turns, the budget or the stop button',
    adds: [
      'Permissions checked before each tool; risky calls ask the page.',
      'Read-only calls run in parallel; calls with side effects run alone.',
      'Sub-agents are tools that run through the same function.',
      'pause_turn resumes a server tool such as web search.',
      'Every response priced; a refusal or max_tokens stops cleanly.',
    ],
    tryIt: { label: 'Harness engineering', to: '/harness' },
  },
  {
    id: 'framework',
    name: 'Agent Framework',
    code: S.loopFramework,
    file: 'examples/medassist/medassist_af.py',
    owns: 'The framework’s session',
    stops: 'No function call, or max_iterations',
    adds: [
      'No loop code: agent.run() calls the tools it is asked for.',
      'Middleware is the hook: NewTurn tells the clinic a new turn started.',
      'DevUI shows every step without a page of your own.',
      'The tools are the clinic’s own methods, so the rules are the same.',
    ],
    tryIt: { label: 'MedAssist', to: '/medassist' },
  },
  {
    id: 'foundry',
    name: 'Foundry Responses API',
    code: S.loopFoundry,
    file: 'examples/medassist/clinic.py',
    owns: 'A conversation kept in Foundry',
    stops: 'No function_call in the output, or max_rounds',
    adds: [
      'The same loop as the Claude one, in another API’s shapes.',
      'function_call and function_call_output instead of tool_use and tool_result.',
      'File Search and Code Interpreter run inside Foundry; only our functions come back.',
    ],
    tryIt: { label: 'MedAssist', to: '/medassist' },
  },
];

const GLOSSARY: [string, string, string][] = [
  ['Model', 'A remote function: text in, text out', 'gpt-5.4-mini in Microsoft Foundry'],
  ['Token', 'The unit you are billed in: a word or part of one', 'Priced per reply by the spend tracker'],
  ['Prompt, instructions', 'The request, plus configuration', 'MedAssist’s instructions, saved in Foundry'],
  ['Tool, function call', 'A function the model may ask you to run', 'book_appointment'],
  ['Agent', 'A loop around the model', 'clinic.run_turn, about 40 lines'],
  ['Grounding, RAG', 'Search the documents first, then answer from them', 'File Search over three documents'],
  ['Hallucination', 'Confident, wrong output: validate it like user input', 'Slot ids checked against those offered'],
  ['Evals', 'A test suite whose pass rate varies', 'Nine cases; most runs pass 8 or 9'],
];

/** How an agent is built, in the lab's own code: the API call, a tool, three ways to write the loop, rules and tests. */
/** The ten steps of a common "build an agent from scratch" checklist: what each means, and the lab pages that show it. */
const STEPS: [string, string, [string, string][], string?][] = [
  [
    '1. Role and goal',
    'What the agent does, for whom, and what it produces',
    [
      ['/prompting', 'Prompting'],
      ['/medassist', 'MedAssist'],
    ],
  ],
  [
    '2. Structured input and output',
    'A JSON schema for what goes in and comes out, so code can check it',
    [
      ['/whiteboard', 'AI whiteboard'],
      ['/scan-explainer', 'Scan explainer'],
      ['/documents', 'Document automation'],
    ],
    'Section 2 above. The backend validates requests with Pydantic.',
  ],
  [
    '3. Behaviour and protocol',
    'A system prompt for the role; MCP to connect tools and data',
    [
      ['/prompting', 'Prompting'],
      ['/mcp', 'MCP servers'],
      ['/context-engineering', 'Context engineering'],
    ],
    'Prompt tuning and prefix tuning train extra weights, which hosted models such as Claude and GPT do not allow; the lab steers with prompts and, for open models, with the training pages.',
  ],
  [
    '4. Reasoning and tools',
    'The loop: think, call a tool, read the result, repeat',
    [
      ['/agents', 'Agents and tools'],
      ['/reasoning-models', 'Reasoning models'],
      ['/coding-agent', 'Coding agent'],
    ],
    'Section 3 above has the loop written three ways.',
  ],
  [
    '5. More than one agent',
    'Roles such as planner, researcher and reporter, each with its own input and output',
    [
      ['/workflows', 'Agent workflows'],
      ['/agent-types', 'Agent types'],
      ['/harness', 'Harness engineering'],
    ],
  ],
  [
    '6. Memory and retrieval',
    'What the agent remembers between conversations, and what it looks up',
    [
      ['/diet', 'Diet planner (memory files)'],
      ['/embeddings', 'Embeddings and RAG'],
      ['/search-pipeline', 'Search pipeline'],
    ],
  ],
  [
    '7. Voice and vision',
    'Speech in and out; reading images',
    [
      ['/tutor', 'Tutor'],
      ['/translation-speech', 'Translation and speech'],
      ['/vision', 'Images as tokens'],
      ['/content-understanding', 'Content Understanding'],
    ],
    'Every chat page has the microphone bar.',
  ],
  [
    '8. Deliver the output',
    'A file a person can use: PDF, spreadsheet, slides',
    [
      ['/diet', 'Diet planner (PDF and Excel)'],
      ['/decks', 'Deck builder'],
      ['/brain-check', 'Brain health check (PDF)'],
    ],
  ],
  [
    '9. A user interface',
    'A front end over the agent',
    [['/architecture', 'Architecture']],
    'This site: React pages over a FastAPI backend.',
  ],
  [
    '10. Evaluate and monitor',
    'Test cases with pass rates; logs, cost and traces in production',
    [
      ['/evals', 'Evals'],
      ['/confidence', 'Confidence'],
      ['/observability', 'Monitoring and traces'],
      ['/foundry-operations', 'Foundry operations'],
      ['/context', 'Context and cost'],
    ],
    'Evals check the answers; the monitoring page records every model call the lab makes, with its tokens, cost, latency and trace.',
  ],
];

export default function BuildingAgentsPage() {
  const [loopId, setLoopId] = useState('claude');
  const loop = LOOPS.find((l) => l.id === loopId) ?? LOOPS[0];

  return (
    <main className="page-building-agents">
      <div className="kicker">Building · for developers</div>
      <h1>Building agents as ordinary software</h1>
      <p className="lede">
        An agent is an API call, a list of functions the model may ask for, and a loop. This page shows each piece in
        the lab’s own code: how we call the model, what a tool looks like, three ways to write the loop, where the rules
        go, and how to test something that varies. The architecture is on the{' '}
        <Link to="/architecture">architecture page</Link>; running a model on your own machine is on{' '}
        <Link to="/local-model">Running a local model</Link>.
      </p>

      <h2>1. How we call the model</h2>
      <p>
        One HTTPS request. The API keeps no state, so every call sends the instructions, the tool schemas and the whole
        conversation. The reply is a list of content blocks and a <code>stop_reason</code>: <code>end_turn</code> means
        it answered, <code>tool_use</code> means it wants a function run.
      </p>
      <div className="grid2">
        <div>
          <div className="ba-label">Request</div>
          <CodeBlock html={S.request} />
        </div>
        <div>
          <div className="ba-label">Response</div>
          <CodeBlock html={S.response} />
        </div>
      </div>
      <p className="small muted">
        Change the model string to <code>gpt-5.4-mini</code> or the local model and the same code runs: the client
        routes by name (<code>python/local_model.py</code>).
      </p>

      <h2>2. A tool is a JSON schema</h2>
      <p>
        The model chooses a tool from its name and description, and fills in arguments that match its schema. It never
        runs anything: your code does, if it agrees to.
      </p>
      <CodeBlock html={S.toolSchema} />
      <ul className="ba-points">
        <li>
          <b>The description</b> is what the model reads to decide when to call it. Write it like API documentation.
        </li>
        <li>
          <b>No patient_id.</b> The signed-in patient is fixed in our session, so there is nothing the model could pass
          to reach someone else’s record.
        </li>
        <li>
          <b>strict</b> guarantees the shape of the arguments, not their values. Those are checked in the function.
        </li>
      </ul>

      <h2>3. Three ways to write the loop</h2>
      <p>
        Every agent is the same loop: call the model; if it asked for functions, run them and send the results back;
        stop when it answers. What differs is who writes the loop and what it adds.
      </p>
      <div className="ba-tabs" role="tablist" aria-label="Loop">
        {LOOPS.map((l) => (
          <button
            key={l.id}
            role="tab"
            aria-selected={l.id === loopId}
            className={l.id === loopId ? 'on' : ''}
            onClick={() => setLoopId(l.id)}
          >
            {l.name}
          </button>
        ))}
      </div>
      <div className="ba-loop">
        <CodeBlock html={loop.code} />
        <div className="card">
          <dl className="ba-facts">
            <dt>File</dt>
            <dd>
              <code>{loop.file}</code>
            </dd>
            <dt>History</dt>
            <dd>{loop.owns}</dd>
            <dt>Stops when</dt>
            <dd>{loop.stops}</dd>
          </dl>
          <ul className="ba-points">
            {loop.adds.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          <p className="small">
            Try it: <Link to={loop.tryIt.to}>{loop.tryIt.label}</Link>
          </p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Loop</th>
              <th>Who writes it</th>
              <th>History</th>
              <th>Use it when</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Claude API, by hand</td>
              <td>You, about 20 lines</td>
              <td>Your list</td>
              <td>You want to see and control every step</td>
            </tr>
            <tr>
              <td>Harness</td>
              <td>You, with permissions, budget and compaction</td>
              <td>Your list, compacted</td>
              <td>Long, autonomous runs: coding agents, research</td>
            </tr>
            <tr>
              <td>Agent Framework</td>
              <td>The framework</td>
              <td>Its session</td>
              <td>Microsoft’s stack, workflows, hosted agents in Foundry</td>
            </tr>
            <tr>
              <td>Foundry Responses API</td>
              <td>You, on Foundry’s API</td>
              <td>A Foundry conversation</td>
              <td>A prompt agent saved and versioned in Foundry</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>4. The model decides; the code sets the limits</h2>
      <p>
        MedAssist’s instructions told it to book only after the patient chose, and to ask before cancelling. In test
        runs it did both anyway. The fix was not a better prompt: it was ordinary defensive code inside the tools, which
        every loop above has to pass through.
      </p>
      <CodeBlock html={S.rules} />
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Rule</th>
              <th>How</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>The patient is fixed</td>
              <td>Set when the session starts; no tool takes a patient id</td>
            </tr>
            <tr>
              <td>Book only a slot already shown</td>
              <td>
                <code>self.offered[slot_id]</code> must be from an earlier turn
              </td>
            </tr>
            <tr>
              <td>Cancel in two steps</td>
              <td>
                The first call returns <code>confirm_first</code>; the next turn cancels
              </td>
            </tr>
            <tr>
              <td>No double booking</td>
              <td>
                One <code>UPDATE … WHERE patient_id IS NULL</code>, checked by <code>rowcount</code>
              </td>
            </tr>
            <tr>
              <td>Refusals are data</td>
              <td>
                An <code>{'{"error": …}'}</code> result the model reads and recovers from, never an exception
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>5. Testing something that varies</h2>
      <p>
        The same input can give a different reply, so a test checks what changed (the tools called, the rows written)
        before it looks at the wording, and a suite is read as a pass rate over several runs. Single runs of MedAssist’s
        nine cases scored 8, 7, 8, 9, 8 and 9 between changes.
      </p>
      <CodeBlock html={S.testCase} />
      <CodeBlock html={S.testCommands} />

      <h2>6. The ten steps of building an agent, and where each is here</h2>
      <p>
        A common checklist for building an agent from scratch has ten steps. Each one has a page in the lab where you
        can see it working.
      </p>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Step</th>
              <th>What it means</th>
              <th>Where to see it</th>
            </tr>
          </thead>
          <tbody>
            {STEPS.map(([step, meaning, pages, note]) => (
              <tr key={step}>
                <td>
                  <b>{step}</b>
                </td>
                <td>{meaning}</td>
                <td>
                  {pages.map(([to, label], i) => (
                    <span key={to}>
                      {i > 0 && ', '}
                      <Link to={to}>{label}</Link>
                    </span>
                  ))}
                  {note && <div className="muted small">{note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>The words, translated</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>AI term</th>
              <th>In developer terms</th>
              <th>In MedAssist</th>
            </tr>
          </thead>
          <tbody>
            {GLOSSARY.map(([term, dev, here]) => (
              <tr key={term}>
                <td>
                  <b>{term}</b>
                </td>
                <td>{dev}</td>
                <td>{here}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
