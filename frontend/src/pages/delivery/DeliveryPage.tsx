import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { modelName } from '@/lib/models';
import { deliveryService, type Design, type DesignResult } from '@/services/deliveryService';
import { statusService } from '@/services/statusService';
import { BRIEFS } from './briefs';
import './delivery.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const SECTIONS: [string, string][] = [
  ['brief', 'From brief to design'],
  ['discovery', 'Discovery'],
  ['patterns', 'Choosing a pattern'],
  ['value', 'Business value'],
  ['integration', 'Integration'],
  ['observability', 'Observability'],
  ['compliance', 'Compliance'],
  ['risks', 'Risks and ethics'],
  ['lifecycle', 'Lifecycle'],
];

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ id, title, tags, children }: { id: string; title: string; tags: string; children: ReactNode }) {
  return (
    <section id={id} className="dl-section">
      <h2>{title}</h2>
      <p className="small muted dl-tags">{tags}</p>
      {children}
    </section>
  );
}

/** The MedAssist system as input, processing, output and a feedback loop. Colours come from the page's variables. */
function MedAssistFlow() {
  const box = (x: number, y: number, w: number, h: number, title: string, lines: string[], cls = '') => (
    <g className={`dl-node ${cls}`}>
      <rect x={x} y={y} width={w} height={h} rx={8} />
      <text x={x + w / 2} y={y + 20} textAnchor="middle" className="dl-t">
        {title}
      </text>
      {lines.map((l, i) => (
        <text key={l} x={x + w / 2} y={y + 38 + i * 15} textAnchor="middle" className="dl-s">
          {l}
        </text>
      ))}
    </g>
  );
  return (
    <svg viewBox="0 0 760 330" role="img" className="dl-flow" aria-labelledby="dl-flow-t dl-flow-d">
      <title id="dl-flow-t">MedAssist end to end</title>
      <desc id="dl-flow-d">
        A patient message goes through sign-in and checks, then the model with tools and the practice documents, then a
        reply and a booking. Audit logs, evaluations and staff feedback return to the design.
      </desc>
      <defs>
        <marker id="dl-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" className="dl-head" />
        </marker>
      </defs>
      <text x="10" y="18" className="dl-h">
        INPUT
      </text>
      <text x="270" y="18" className="dl-h">
        PROCESSING
      </text>
      <text x="570" y="18" className="dl-h">
        OUTPUT
      </text>
      {box(10, 30, 200, 70, 'Patient message', ['Signed-in portal chat', 'Identity fixed at sign-in'])}
      {box(10, 120, 200, 70, 'Practice documents', ['Opening hours, preparation,', 'policies (vector store)'])}
      {box(
        250,
        30,
        270,
        70,
        'Input checks',
        ['Emergency wording goes to a person', 'Prompt-injection and PII filters'],
        'check',
      )}
      {box(
        250,
        120,
        270,
        100,
        'Model and tools',
        [
          'Claude decides which tool to call',
          'get record, find slots, book, cancel',
          'Code enforces what each tool may do',
        ],
        'core',
      )}
      {box(560, 30, 190, 70, 'Reply', ['Slots, reference number', 'Text confirmation'])}
      {box(
        560,
        120,
        190,
        100,
        'Writes',
        ['Booking, cancellation', 'Cancel needs a second turn', 'Every action audited'],
        'check',
      )}
      <g className="dl-arrow">
        <path d="M210 65H250" />
        <path d="M385 100V120" />
        <path d="M210 155H250" />
        <path d="M520 170H560" />
        <path d="M520 60H560" />
        <path d="M655 100V120" />
      </g>
      {box(
        10,
        255,
        740,
        62,
        'Feedback loop',
        [
          'Audit log and traces, offline evaluations on nine cases, staff and patient feedback: all change the',
          'instructions, tools, rules or documents, and then the evaluations run again',
        ],
        'loop',
      )}
      <g className="dl-arrow">
        <path d="M385 220V255" />
        <path d="M655 220V255" />
        <path d="M110 255V190" />
      </g>
    </svg>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul>
      {items.map((i) => (
        <li key={i}>{i}</li>
      ))}
    </ul>
  );
}

const PATTERN_LABEL = { augmented_llm: 'Augmented LLM', workflow: 'Workflow', agent: 'Agent' };

function DesignView({ r }: { r: DesignResult }) {
  const d: Design = r.design;
  return (
    <div className="dl-result">
      <p>
        <b>{PATTERN_LABEL[d.pattern.choice]}</b> — {d.summary}
      </p>
      <p className="small muted">
        {modelName(r.model)} ({r.model}), {r.tries.length === 1 ? 'valid on the first try' : 'fixed on the second try'},
        about ${r.cost_usd.toFixed(4)}.
      </p>
      <div className="dl-grid">
        <div className="card">
          <h3>Functional requirements</h3>
          <List items={d.requirements.functional} />
          <h3>Infrastructure requirements</h3>
          <List items={d.requirements.infrastructure} />
          <h3>Success measures</h3>
          <List items={d.requirements.success_measures} />
        </div>
        <div className="card">
          <h3>Pattern: why</h3>
          <List items={d.pattern.reasons} />
          <h3>What would change the decision</h3>
          <List items={d.pattern.would_change_if} />
        </div>
      </div>
      <div className="card">
        <h3>Components</h3>
        <p>
          <b>Model:</b> {d.components.model.choice}
        </p>
        <List items={d.components.model.reasons} />
        <p>
          <b>Retrieval:</b> {d.components.retrieval}
        </p>
        <Table
          head={['Tool', 'Purpose', 'Mechanism', 'Why']}
          rows={d.components.tools.map((t) => [t.name, t.purpose, t.mechanism, t.why])}
        />
        <p>
          <b>Guardrails</b>
        </p>
        <List items={d.components.guardrails} />
      </div>
      <div className="card">
        <h3>Value pillars</h3>
        <Table head={['Pillar', 'Claim', 'Measure']} rows={d.value.map((v) => [v.pillar, v.claim, v.measure])} />
      </div>
      <div className="card">
        <h3>Risks</h3>
        <Table
          head={['Risk', 'Mitigation', 'Human in the loop']}
          rows={d.risks.map((x) => [x.risk, x.mitigation, x.human_in_the_loop])}
        />
        <h3>Compliance flags</h3>
        <Table
          head={['Regulation', 'Why it may apply', 'What to check']}
          rows={d.compliance.map((c) => [c.regulation, c.why_it_may_apply, c.what_to_check])}
        />
        <h3>Authentication and authorisation</h3>
        <List items={d.authn_authz} />
      </div>
      <div className="card">
        <h3>Evaluation plan</h3>
        <Table
          head={['Metric', 'Plan']}
          rows={[
            ['Accuracy', d.evaluation.metrics.accuracy],
            ['Latency', d.evaluation.metrics.latency],
            ['Cost', d.evaluation.metrics.cost],
            ['Safety', d.evaluation.metrics.safety],
            ['Dataset', d.evaluation.dataset],
            ['A/B test', d.evaluation.ab_test],
          ]}
        />
        <h3>Proposed SLAs</h3>
        <Table head={['SLA', 'Target', 'Measured by']} rows={d.slas.map((s) => [s.name, s.target, s.how_measured])} />
        <h3>Open questions for stakeholders</h3>
        <List items={d.open_questions} />
      </div>
      <div className="card">
        <h3>ADR draft: {d.adr.title}</h3>
        <p className="small muted">Status: {d.adr.status}</p>
        <p>
          <b>Context.</b> {d.adr.context}
        </p>
        <p>
          <b>Decision.</b> {d.adr.decision}
        </p>
        <p>
          <b>Alternatives.</b>
        </p>
        <List items={d.adr.alternatives} />
        <p>
          <b>Consequences.</b>
        </p>
        <List items={d.adr.consequences} />
      </div>
    </div>
  );
}

function BriefTool() {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [brief, setBrief] = useState(BRIEFS[0].text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<DesignResult | null>(null);

  useEffect(() => {
    statusService
      .status()
      .then((s) => {
        setModels(s.models || []);
        setModel(s.default_model || s.models?.[0] || '');
      })
      .catch(() => undefined);
  }, []);

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      setResult(await deliveryService.design(brief, model));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="dl-chips">
        {BRIEFS.map((b) => (
          <button key={b.label} className="btn small" onClick={() => setBrief(b.text)}>
            {b.label}
          </button>
        ))}
      </div>
      <textarea
        className="dl-brief"
        rows={7}
        value={brief}
        maxLength={4000}
        onChange={(e) => setBrief(e.target.value)}
        aria-label="Business brief"
      />
      <div className="dl-bar">
        <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button
          className="btn primary"
          disabled={busy || brief.trim().length < 20 || !model}
          onClick={() => void run()}
        >
          {busy ? 'Designing…' : 'Design it'}
        </button>
        <span className="small muted">
          One call, about 30 seconds. The design is a starting point for a conversation.
        </span>
      </div>
      {error && <p className="dl-bad">{error}</p>}
      {result && <DesignView r={result} />}
    </div>
  );
}

/** The architect's work around the code: from a business problem to a delivered, governed Claude solution. */
export default function DeliveryPage() {
  return (
    <main className="page-delivery">
      <p className="kicker">Delivery and governance</p>
      <h1>From business problem to a governed Claude solution</h1>
      <p className="lede">
        Most of an architect's work happens before and after the code: finding out what the business needs, choosing the
        simplest design that meets it, proving the value, keeping it compliant and handing it over. This page follows
        that work using MedAssist, the lab's invented GP practice assistant (<Link to="/medassist">the agent</Link>,{' '}
        <Link to="/medassist/architecture">its architecture</Link>), as the worked example. Paste your own brief below
        to get a first-pass design.
      </p>
      <nav className="dl-nav" aria-label="Sections">
        {SECTIONS.map(([id, name]) => (
          <a key={id} href={`#${id}`}>
            {name}
          </a>
        ))}
      </nav>

      <Section
        id="brief"
        title="From brief to design"
        tags="Professional P1.1, P1.2, P1.3, P1.6, P3.2, P6.1, P6.2 · Developer D2.1 · Associate S4.1"
      >
        <p>
          Paste a short brief, or use one of three invented ones. One call returns requirements, a pattern, components,
          value measures, risks, compliance flags, an evaluation plan, SLAs, open questions and an ADR draft. Code
          checks that every section is there and that the pattern is one of the three, and asks the model once to fix
          problems. Treat the result as the first page of a discovery conversation, not the answer.
        </p>
        <BriefTool />
      </Section>

      <Section
        id="discovery"
        title="Structured discovery and requirements"
        tags="Professional P6.1, P1.1 · Developer D2.1 · Associate S4.1"
      >
        <p>
          Discovery turns a wish ("a chatbot for the practice") into things a team can build and test. Ask in a fixed
          order so nothing is skipped, and write down the answers with who gave them.
        </p>
        <Table
          head={['Ask about', 'Questions', 'MedAssist example']}
          rows={[
            [
              'The problem',
              'What happens today? Who does it? What does it cost in time or errors? What would better look like?',
              'Receptionists spend the morning on booking calls; patients wait on hold.',
            ],
            [
              'Users',
              'Who will use it, on what device, with what confidence? Who is affected but never sees it?',
              'Patients on the portal; reception staff who handle what it cannot.',
            ],
            [
              'Data',
              'Where does the knowledge live? How current is it? Who owns it? Is any of it personal or special category?',
              'Appointments and records in the practice system; policy documents in a folder.',
            ],
            [
              'Actions',
              'What may it read? What may it change? What can never be undone?',
              'Read own record; book and cancel; never see another patient.',
            ],
            [
              'Constraints',
              'Volume, peak load, latency, availability, languages, budget, where data may be processed.',
              'Monday morning peak; UK data only; under 5 seconds to a first reply.',
            ],
            [
              'Risk and rules',
              'Which regulations and internal policies apply? What is the worst realistic failure?',
              'Health data (UK GDPR); a wrong slot is annoying, a missed emergency is not.',
            ],
            [
              'Success',
              'What number moves, by how much, measured how, against what baseline?',
              'Calls to reception down by a third; no rise in missed appointments.',
            ],
          ]}
        />
        <h3>Functional and infrastructure requirements</h3>
        <p>
          <b>Functional</b> requirements say what the system does: find free slots, book one the patient chose, answer
          from the practice documents. <b>Infrastructure</b> requirements say what it must run on and within: identity
          through the portal sign-in, data stored in the UK, 99.5% availability in surgery hours, an audit log kept for
          the retention period. Both need a test. If you cannot say how you would check a requirement, it is a wish.
        </p>
        <p>
          <b>Success measures</b> come in two kinds. Outcome measures belong to the business (calls avoided, time to
          appointment). Quality measures belong to the system (right slot offered, emergency routed to a person). You
          need both: a system can be accurate and unused, or popular and wrong. See <Link to="/evals">evals</Link> for
          how to score the quality side.
        </p>
      </Section>

      <Section
        id="patterns"
        title="Choosing the pattern"
        tags="Professional P1.2, P1.3 · Developer D2.1 · Associate S4.1"
      >
        <p>Start with the simplest thing that works, and move right only when the work needs it.</p>
        <Table
          head={['', 'Augmented LLM', 'Workflow', 'Agent']}
          rows={[
            [
              'What it is',
              'One model call with retrieval and/or a few tools.',
              'Fixed steps in code; the model does the work inside each step.',
              'The model chooses the steps and tools in a loop until done.',
            ],
            [
              'Choose it when',
              'One question, one answer; knowledge or one lookup is the gap.',
              'The steps are known and repeatable; you need predictable cost and audit.',
              'The path cannot be known in advance and the task is worth the extra cost and variance.',
            ],
            ['Latency and cost', 'Lowest.', 'Predictable; several calls.', 'Highest and least predictable.'],
            [
              'Control',
              'High.',
              'Highest: code decides the order.',
              'Lowest: needs hard limits in tools and human checkpoints.',
            ],
            [
              'Example',
              'Answer "what time do you open?" from the documents.',
              'Triage an incoming letter: classify, extract, route.',
              'Book an appointment: read record, search diary, rebook, confirm.',
            ],
          ]}
        />
        <p>
          Decision criteria: Is the sequence of steps known? Does a wrong step cause harm that code can prevent? Is the
          extra latency acceptable? Can you test every path? If most answers are yes, use a workflow. MedAssist is an
          agent because the route to a booking varies (a patient's own GP, a time of day, a clash), but the risky parts
          (who the patient is, booking only a slot they saw, cancelling in two steps) are code, not instructions. Go
          deeper in <Link to="/agent-types">agent types</Link>, <Link to="/workflows">workflows</Link> and{' '}
          <Link to="/architecture">architecture</Link>.
        </p>
        <h3>End to end: input, processing, output, feedback</h3>
        <div className="dl-diagram-scroll">
          <MedAssistFlow />
        </div>
        <p className="small muted">
          Every design needs the fourth part. Without a feedback loop you cannot tell whether the system is still right
          in three months. See the <Link to="/medassist/architecture">MedAssist architecture page</Link> for the build.
        </p>
      </Section>

      <Section id="value" title="Business value pillars" tags="Professional P1.6 · Associate S4.5">
        <p>
          Value is a claim you can check. Name the pillar, the claim, the measure and the baseline you need before
          launch. Without a baseline, you cannot show improvement.
        </p>
        <Table
          head={['Pillar', 'Means', 'How to measure', 'MedAssist']}
          rows={[
            [
              'Efficiency',
              'The same work in less time or with fewer steps.',
              'Handling time per task, contacts per resolution, before and after.',
              'Minutes of reception time per booking.',
            ],
            [
              'Transformation',
              'Something that was not possible before.',
              'New service or reach: hours covered, languages, volume handled.',
              'Booking at 2 a.m. in plain language.',
            ],
            [
              'Productivity',
              'People do more of the work that needs them.',
              'Output per person; share of time on complex cases.',
              'Staff time moved to patients who need a person.',
            ],
            [
              'Cost',
              'Lower cost per outcome, all in.',
              'Cost per resolved task including model, hosting, review time and support; compare with the old cost.',
              'Cost per booking, tracked on the cost dashboard.',
            ],
            [
              'Performance and SLAs',
              'Meets agreed speed, quality and availability.',
              'Latency percentiles, accuracy on a fixed set, uptime, escalation rate.',
              'p95 first reply, correct-slot rate.',
            ],
          ]}
        />
        <p>
          Be honest about limits when you present: say what the numbers are based on, what is estimated, and what you do
          not yet know. A cost model that ignores human review time overstates savings. See{' '}
          <Link to="/routing">routing</Link> for cutting cost without cutting quality.
        </p>
      </Section>

      <Section
        id="integration"
        title="Integration, tools and trade-offs"
        tags="Professional P3.1, P3.2, P3.3, P3.7, P3.8"
      >
        <h3>Which integration mechanism</h3>
        <Table
          head={['Mechanism', 'Fits when', 'Watch for']}
          rows={[
            [
              'MCP server',
              'Many clients or models need the same tools; the tool is shared across teams; you want a standard way to list and describe capabilities.',
              'Another process to run and secure; every tool description costs context.',
            ],
            [
              'Direct API call (a function tool you write)',
              'One application, one internal service, tight control of arguments and results.',
              'You own the schema and the glue; reuse is manual.',
            ],
            [
              'CLI call',
              'A mature command-line tool already does the job, in a sandbox, for a developer or batch task.',
              'Shell access is broad; confine it (see the coding agent) and never run it beside secrets.',
            ],
            [
              'Agent-to-agent (A2A)',
              'Separate agents owned by different teams or vendors must hand work to each other across a boundary.',
              'Trust between agents, identity passing, and debugging a chain of agents. A single agent with tools is simpler.',
            ],
          ]}
        />
        <p>
          MedAssist uses four function tools in code because one application owns the data and the rules. Had the
          practice wanted its booking tools used by a second system, an <Link to="/mcp">MCP server</Link> would earn its
          place.
        </p>
        <h3>Capability bloat and least privilege</h3>
        <p>
          Every tool you add costs context, and makes wrong choices more likely. Give each agent only the tools its job
          needs, and make each tool narrow: <code>find_appointments</code>, not <code>run_sql</code>. No MedAssist tool
          takes a patient id, so the model cannot reach another record. Review the tool list like a permissions list.
        </p>
        <h3>Progressive discovery</h3>
        <p>
          A monolithic context loads everything on every call: slow, costly and noisy. Progressive discovery loads on
          demand: a tool search finds the right tool among many, and Skills load their full instructions only when the
          task needs them. Use it when you have many tools or many procedures that rarely apply together. Keep one
          context when the set is small and always needed. See{' '}
          <Link to="/context-engineering">context engineering</Link>, <Link to="/context">context</Link> and{' '}
          <Link to="/claude-code-inside#skills">Skills</Link>.
        </p>
        <h3>Accuracy against latency, and justifying a configuration</h3>
        <p>
          A larger model, more reasoning effort, retrieval and a checking step each raise accuracy and add time and
          cost. Do not pick by feel. Run the same evaluation set on each candidate configuration, then show a table of
          accuracy, p95 latency and cost per task, and choose the cheapest one that meets the success measures. Record
          the choice in an ADR (see below) with what would make you revisit it. Routing a simple question to a small
          model and a hard one to a larger model is often the best compromise; see <Link to="/routing">routing</Link>.
        </p>
        <h3>Authentication and authorisation gaps</h3>
        <List
          items={[
            'Per-user identity: does the tool act as the signed-in person, or as a powerful service account that sees everything? Prefer the person, or a fixed identity the code sets and the model cannot change.',
            'Scoped tokens: short-lived, limited to the one resource and action. Watch for tokens that can read and write everywhere.',
            'Service accounts: one per system, with owners and rotation. Shared accounts hide who did what.',
            'Keys in code or prompts: secrets belong in a vault or in keyless sign-in, never in a prompt, a tool result or the repository.',
            'Authorisation in the tool, not the prompt: "only book for the signed-in patient" is enforced in code. The model is not a security boundary.',
            'Audit: every read and write recorded with who, what and when.',
          ]}
        />
        <p>
          See <Link to="/guardrails">guardrails</Link> for checks on input and output and{' '}
          <Link to="/red-team">red team</Link> for trying to break them.
        </p>
      </Section>

      <Section id="observability" title="Observability at scale" tags="Professional P3.4, P4.6">
        <p>
          You cannot run what you cannot see. At volume you cannot read every conversation, so decide up front what to
          record and what to sample.
        </p>
        <Table
          head={['Topic', 'What to do']}
          rows={[
            [
              'Log',
              'Request id, model and version, prompt version, tool calls with arguments and outcomes, token counts, latency, cost, stop reason, and the user and session id (not the message text unless you need it).',
            ],
            [
              'Trace',
              'One trace per conversation with a span for each model call and tool call, so a slow or wrong answer can be followed step by step.',
            ],
            [
              'Sampling',
              'Keep every error, every escalation and every low-score answer; sample the rest (for example 1 in 50) for review and for the evaluation set. Redact personal data before storing.',
            ],
            [
              'Cost',
              'Dashboards by model, feature and customer: cost per task, cache hit rate, retries, tokens per call. Budget caps as a safety net.',
            ],
            [
              'Quality',
              'A running score on sampled answers (human or model-graded), refusal and escalation rates, and thumbs-down feedback.',
            ],
            [
              'Alerting',
              'Error rate, p95 latency, cost per hour, a spike in refusals, a fall in the quality score. Alert on what needs a person, and name who.',
            ],
          ]}
        />
        <p>
          The lab shows this for its own calls on <Link to="/observability">observability</Link>. For Microsoft Foundry
          deployments see <Link to="/foundry-operations">Foundry operations</Link>.
        </p>
      </Section>

      <Section id="compliance" title="Compliance" tags="Professional P5.4 · Associate S6.2, S6.3">
        <p>
          This is a guide to what to ask, not legal advice. Rules depend on the data, the sector and the country.
          Involve your legal and privacy teams early, and keep a record of what you decided.
        </p>
        <Table
          head={['Regime', 'What it asks of an LLM system']}
          rows={[
            [
              'GDPR (and UK GDPR)',
              'A lawful basis for each use of personal data; tell people what you do; use only the data you need (minimisation); limit how long you keep it (retention); control transfers outside the UK or EEA (residency); a data processing agreement with each processor; support for access and erasure requests; a data protection impact assessment for high-risk use; and a person who can review automated decisions that significantly affect someone.',
            ],
            [
              'HIPAA (US health data)',
              'Protect identifiable health information (PHI) with access controls, encryption and audit logs; use the minimum necessary; sign a business associate agreement (BAA) with any vendor that handles PHI for you, and use only the vendor features that agreement covers.',
            ],
            [
              'FedRAMP (US federal)',
              'Use cloud services that have been authorised at the impact level your agency needs, in the authorised environment and regions, with continuous monitoring. Check that the exact service and model you want is inside the authorisation boundary, not only the cloud provider.',
            ],
          ]}
        />
        <h3>What is verified about Anthropic and cloud providers</h3>
        <p className="small muted">
          Checked against the pages below on 13 November 2026. These change; check again before you rely on them.
        </p>
        <List
          items={[
            'Zero data retention: Anthropic describes it as an arrangement for certain Claude API and Claude Code for Enterprise customers, subject to Anthropic approval, applied per organisation. Anthropic still keeps safety classifier results to enforce its usage policy. Some models ("Covered Models") require limited retention and are not available with zero data retention unless Anthropic authorises it.',
            'HIPAA: Anthropic offers a business associate agreement for its "HIPAA-ready" services. For the first-party API it lists the Messages API as covered and Batch, Files, Skills, code execution and web fetch as not covered. The agreement covers only the single organisation that accepted it, and the Primary Owner signs it and contacts Anthropic to enable use with PHI. Claude in Microsoft Foundry is listed as eligible with some features unavailable.',
            'Data residency on the Claude API: a per-request inference_geo of "us" or "global" (supported on Claude 4.6 and later); US-only inference is priced at 1.1 times the standard rate. The only workspace geo (where data is stored at rest) available is "us". On Amazon Bedrock and Google-managed Claude, the region follows the endpoint or inference profile.',
            'Amazon Bedrock: AWS says model providers have no access to the deployment accounts, so they do not have access to Bedrock logs or customer prompts and completions. AWS lists Amazon Bedrock as in scope for FedRAMP at the East/West and GovCloud levels on its services-in-scope page. Which Claude models are available in a given government region is not something this page confirms: check with AWS.',
            'Claude in Microsoft Foundry: deployments can be hosted on Azure or on Anthropic infrastructure; all support Global Standard deployment, and some Azure-hosted versions also offer a US Data Zone Standard deployment that keeps inference in the United States. Microsoft notes that Anthropic manages data retention settings for Claude on Azure.',
          ]}
        />
        <p>
          Anything not on that list, such as availability of Claude in a FedRAMP High government region, EU-only
          inference, or a particular certification for a particular model:{' '}
          <b>check with Anthropic's sales and legal teams</b> and with your cloud provider, and get the answer in
          writing.
        </p>
        <p className="small muted">Sources (all read on 13 November 2026):</p>
        <ul className="small">
          <li>
            <a href="https://privacy.claude.com/en/articles/8956058-i-have-a-zero-data-retention-agreement-with-anthropic-what-products-does-it-apply-to">
              Anthropic privacy centre: zero data retention
            </a>
          </li>
          <li>
            <a href="https://privacy.claude.com/en/articles/8114513-business-associate-agreements-baa-for-commercial-customers">
              Anthropic privacy centre: business associate agreements
            </a>
          </li>
          <li>
            <a href="https://platform.claude.com/docs/en/build-with-claude/data-residency">
              Anthropic API docs: data residency
            </a>
          </li>
          <li>
            <a href="https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html">
              AWS: Amazon Bedrock data protection
            </a>
          </li>
          <li>
            <a href="https://aws.amazon.com/compliance/services-in-scope/FedRAMP/">
              AWS: services in scope for FedRAMP
            </a>
          </li>
          <li>
            <a href="https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/use-foundry-models-claude">
              Microsoft Learn: Claude models in Microsoft Foundry
            </a>
          </li>
        </ul>
        <p>
          How MedAssist applies this: health data means UK GDPR special category rules, so a data protection impact
          assessment first; minimum record fields in the model's context; UK residency chosen at deployment; audit rows
          kept for the retention period; and no use with real patient data until the vendor agreements are in place.
        </p>
      </Section>

      <Section
        id="risks"
        title="Risks, human oversight and ethics"
        tags="Professional P5.2, P5.3, P5.5 · Associate S6.4"
      >
        <Table
          head={['Failure mode', 'What it looks like', 'What to do']}
          rows={[
            [
              'Hallucination',
              'A confident answer with no source: a clinic hour that does not exist.',
              'Answer from retrieved text, require a citation, say "I do not know" when nothing is found.',
            ],
            [
              'Prompt injection',
              'Text in a document or message tries to change the instructions.',
              'Treat retrieved text as data, limit tools, filter, and run the red team.',
            ],
            [
              'Over-reach',
              'The agent does more than asked: booked before the patient chose.',
              'Enforce limits in tool code; two-step confirmation for anything hard to undo.',
            ],
            [
              'Drift',
              'Quality falls as documents, models or users change.',
              'Pin model versions, rerun evaluations on a schedule, watch quality scores.',
            ],
            [
              'Data leakage',
              'Another person’s data appears in a reply or a log.',
              'Fix identity in code, redact logs, test with probing prompts.',
            ],
            [
              'Cost runaway',
              'A loop or a long context multiplies the bill.',
              'Step limits, budgets, per-user caps, alerts.',
            ],
            [
              'Automation bias',
              'Reviewers approve what the model says without checking.',
              'Show evidence beside the answer, sample-check approvals, rotate reviewers.',
            ],
          ]}
        />
        <h3>Human-in-the-loop strategies</h3>
        <List
          items={[
            'Approve before acting: a person confirms anything irreversible or costly (MedAssist asks twice before cancelling).',
            'Review by exception: the system acts alone when confident and routes uncertain or high-risk cases to a person.',
            'Sample review: a person checks a fixed share of automatic decisions, and the findings go back into the evaluation set.',
            'Escalation: a clear route to a human at any point, and certain triggers (emergency words, a complaint) always go there.',
            'Override and appeal: people affected by an outcome can ask for a person to look again.',
          ]}
        />
        <h3>Ethics: bias, fairness and transparency</h3>
        <List
          items={[
            'Bias: test answers across groups (language, age, accent, name) and look for different quality or tone. Fix with data, instructions and review, and keep testing.',
            'Fairness: do not let the model make decisions about entitlement or treatment on its own where a person should decide. Check who is excluded (people who cannot use a chat window).',
            'Transparency: tell people they are talking to an AI, what it can and cannot do, and how to reach a person. Publish how the system works where the setting calls for it, such as the public sector.',
            'Accountability: a named owner for outcomes, and a record of the decisions made when building it.',
          ]}
        />
      </Section>

      <Section
        id="lifecycle"
        title="Lifecycle, decisions and handoff"
        tags="Professional P6.2, P6.3, P6.4, P6.5 · Developer D2.2 · Associate S6.3"
      >
        <div className="dl-steps">
          {['Discovery', 'Design', 'Build', 'Handoff', 'Monitoring', 'Iteration'].map((s, i) => (
            <div key={s} className="dl-step">
              <span className="small muted">{i + 1}</span> {s}
            </div>
          ))}
        </div>
        <p className="small muted">Iteration feeds back into discovery: new questions, new data, new limits.</p>
        <Table
          head={['Stage', 'Produces', 'Done when']}
          rows={[
            [
              'Discovery',
              'Requirements, success measures, baseline, constraints.',
              'Stakeholders agree what "good" is and how it is measured.',
            ],
            [
              'Design',
              'Pattern, components, ADRs, risk and compliance review, evaluation plan.',
              'The riskiest assumption has been tested on a small prototype.',
            ],
            ['Build', 'Working system, tests, evaluation set, dashboards.', 'Evaluations meet the agreed thresholds.'],
            [
              'Handoff',
              'Documentation, runbook, training, access, named owners.',
              'The receiving team has run it and fixed something without you.',
            ],
            [
              'Monitoring',
              'Traces, quality scores, cost, alerts, SLA reports.',
              'Someone is watching and knows what to do on an alert.',
            ],
            [
              'Iteration',
              'Changes driven by evidence; reruns of the evaluations.',
              'Each change shows its effect before it ships.',
            ],
          ]}
        />
        <h3>An architecture decision record (ADR)</h3>
        <p>
          An ADR is a short note on one decision: what you chose, why and what it costs. It saves the next team from
          re-arguing it. Example for MedAssist:
        </p>
        <div className="card dl-adr">
          <p>
            <b>ADR 004: Enforce booking rules in tool code, not in the prompt</b> · Status: accepted
          </p>
          <p>
            <b>Context.</b> In testing, the agent booked a slot in the same turn it found it and cancelled without
            asking. Stronger instructions reduced this but did not remove it.
          </p>
          <p>
            <b>Decision.</b> The signed-in patient is fixed at session start. Booking accepts only a slot shown in an
            earlier turn. Cancelling needs a confirming call in the next turn. Every action is written to an audit
            table.
          </p>
          <p>
            <b>Alternatives.</b> A stricter prompt only (cheaper, not reliable); a fixed workflow with no agent (safer
            but cannot handle varied requests); human approval on every booking (safe, removes the saving).
          </p>
          <p>
            <b>Consequences.</b> More code to maintain and test; behaviour is predictable and auditable. Revisit if a
            future model passes the rule tests without the code limits, and the evaluation set shows it.
          </p>
        </div>
        <h3>Documentation and guidance for the team taking over</h3>
        <List
          items={[
            'A one-page overview: purpose, users, pattern, a diagram, and who owns what.',
            'The ADRs, the evaluation set and how to run it, and the thresholds that must hold.',
            'A runbook: how to deploy, roll back, change a prompt, rotate a secret, and what each alert means.',
            'Known limits and failure modes, in plain words, and the escalation route.',
            'Access: who can change prompts, tools and documents, and who approves.',
            'A trial week: the new team handles changes with you watching.',
          ]}
        />
        <h3>Stakeholder feedback, expectations and SLAs</h3>
        <p>
          Set expectations early and often. Say what the system will not do. Share the evaluation results, not only
          demonstrations. Agree a review rhythm: a short monthly report of usage, quality, cost, incidents and what is
          next. Collect feedback from the people affected (patients, reception, clinicians) and put it in the same
          backlog as the metrics.
        </p>
        <Table
          head={['SLA', 'Example target', 'Notes']}
          rows={[
            [
              'Availability',
              '99.5% in surgery hours',
              'Say what happens when the model provider is down: a fallback message and a phone number.',
            ],
            ['Latency', 'p95 first reply under 5 seconds', 'Measured at the page, not the model.'],
            [
              'Quality',
              'Correct slot offered in 95% of evaluation cases',
              'Against a fixed set, rerun on every change.',
            ],
            ['Safety', 'Every emergency phrase in the test set goes to a person', 'Any miss is an incident.'],
            ['Support', 'Critical issues acknowledged in 1 hour', 'A person, a channel and hours.'],
          ]}
        />
      </Section>

      <div className="takeaways">
        <h3>Takeaways</h3>
        <ul>
          <li>Ask before you build: the problem, users, data, actions, constraints, risks and a measurable success.</li>
          <li>Choose the simplest pattern that works, and put rules that matter in code.</li>
          <li>Claim value you can measure, with a baseline.</li>
          <li>Give each tool the least privilege, and justify each configuration with evaluation results.</li>
          <li>Log, trace and sample so you can see the system at scale.</li>
          <li>For compliance, state what is verified and send the rest to the vendor and your legal team.</li>
          <li>Hand over with ADRs, a runbook, an evaluation set and agreed SLAs.</li>
        </ul>
      </div>
    </main>
  );
}
