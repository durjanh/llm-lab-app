import { useState } from 'react';
import { Link } from 'react-router';
import { List, Section, Table } from './parts';

/* The strategy sections of the Delivery page, written for the AB-100 exam map: AI adoption with the Cloud Adoption
   Framework, build, buy or extend, ROI and total cost of ownership, the AI Center of Excellence and a prompt library.
   The adoption, CoE and build-or-buy material follows Microsoft's Cloud Adoption Framework; the ROI method and the
   prompt-library guidelines are the lab's own, because Microsoft Learn gives no template for either. */

const CAF = 'https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/scenarios/ai/';

export function AdoptionSection() {
  return (
    <Section
      id="adoption"
      title="AI adoption with the Cloud Adoption Framework"
      tags="AB-100 · Design overall AI strategy"
    >
      <p>
        Microsoft's{' '}
        <a href={CAF} target="_blank" rel="noreferrer">
          Cloud Adoption Framework for AI
        </a>{' '}
        splits adopting AI into steps an organisation works through, so that the first agent is not also the first time
        anyone thought about data, security or ownership. The steps are not a one-way waterfall: governing, securing and
        managing go on for as long as the solutions run.
      </p>
      <Table
        head={['Step', 'What it settles', 'Produces', 'In this lab']}
        rows={[
          [
            'AI strategy',
            'Which business problems are worth AI, and what technology, data and responsible AI stance the organisation takes.',
            'Prioritised use cases with a measurable outcome each; a technology choice per use case.',
            <a href="#brief">From brief to design</a>,
          ],
          [
            'AI plan',
            'The skills, people and order of work: who builds, who owns, which pilot first.',
            'A skills plan, an AI Center of Excellence, and a first set of pilots with success measures.',
            <a href="#coe">AI Center of Excellence</a>,
          ],
          [
            'AI ready',
            'The landing zone: networking, identity, regions, quotas and where the resources live.',
            'Environments that meet the security and residency rules before any data arrives.',
            <Link to="/foundry-operations">Foundry operations</Link>,
          ],
          [
            'Govern AI',
            'Policies for which models, data and tools are allowed, and how compliance is checked.',
            'AI policies, enforced where possible (Azure Policy, permissions) rather than only written down.',
            <a href="#compliance">Compliance</a>,
          ],
          [
            'Manage AI',
            'Running AI in production: deployments, model versions, cost, monitoring and incident response.',
            'Operating procedures, dashboards, and a process for model retirements and upgrades.',
            <a href="#observability">Observability</a>,
          ],
          [
            'Secure AI',
            'Threats specific to AI (prompt injection, data leakage, model misuse) on top of normal security.',
            'Threat models, guardrails, red-team findings and access reviews.',
            <Link to="/red-team">Adversarial testing</Link>,
          ],
        ]}
      />
      <p>
        For an architect, the useful habit is to ask which step a request skips. A team asking for "an agent on our
        SharePoint" is usually at strategy (is it worth it, and what does success look like?) and ready (who can read
        those sites, and is the index in the right region?) at the same time.
      </p>
    </Section>
  );
}

export function BuildBuySection() {
  return (
    <Section
      id="build-buy"
      title="Build, buy or extend"
      tags="AB-100 · Evaluate the costs and benefits · Design overall AI strategy"
    >
      <p>
        The Cloud Adoption Framework sorts Microsoft's AI offerings by how much the organisation runs itself. Its advice
        is to prefer the option with the least operational responsibility that still meets the requirements: each step
        down the table gives more control and more work.
      </p>
      <Table
        head={['Option', 'Microsoft example', 'You pay for', 'You own', 'Choose it when']}
        rows={[
          [
            'Buy (SaaS)',
            'Microsoft 365 Copilot; the prebuilt agents in Microsoft 365 and Dynamics 365',
            'Licences per user',
            'Adoption, data access permissions, training',
            'The task is general office work on data already in Microsoft 365, and the built-in behaviour is good enough.',
          ],
          [
            'Extend (low code)',
            'Copilot Studio agents, agents in Microsoft 365 Copilot, connectors and actions',
            'Licences and Copilot Studio capacity (credits)',
            'Topics, knowledge sources, connectors, the agent life cycle',
            'You need your own knowledge or actions, a maker team can own it, and the flow fits the platform.',
          ],
          [
            'Build (PaaS)',
            'Microsoft Foundry: models, Foundry Agent Service, Foundry Tools',
            'Model usage (tokens) plus the compute and services around it',
            'Code, prompts, evaluation, security, deployment and monitoring',
            'You need custom logic, rules enforced in code, several models, or an experience the platforms cannot give.',
          ],
          [
            'Build on infrastructure (IaaS)',
            'Your own models on virtual machines or Kubernetes with GPUs',
            'Compute, whether used or not',
            'Everything above, plus the model, scaling, patching and capacity',
            'A model or control that no managed service offers, or strict hosting rules.',
          ],
        ]}
      />
      <h3>Questions that decide it</h3>
      <List
        items={[
          'Does a prebuilt agent already do 80% of this? Then buy, and spend the effort on adoption.',
          'Is the hard part knowledge and simple actions, or rules that must never be broken? Rules in code point to building (see MedAssist).',
          'Who will own it in a year: a maker team in the business, or engineers? Pick what they can maintain.',
          'Where must the data stay, and which models are allowed there?',
          'What does it cost at the expected volume, all in? Licences are predictable; token costs follow usage.',
        ]}
      />
      <h3>When to create a custom model</h3>
      <p>
        Custom models come last. Try a better prompt, then grounding (RAG), then a smaller or cheaper model with
        routing. Train or fine-tune only when those fail on a measured evaluation set, and when you have labelled data
        and someone to retrain the model as things change. Good reasons: a narrow task at high volume where a small
        tuned model is cheaper and fast enough, a fixed output style the base model will not keep, or data the model
        must run next to. The lab shows both sides: <Link to="/lora">fine-tuning with LoRA</Link> and{' '}
        <Link to="/tabular">tabular foundation models</Link>, which often beat training anything for table data.
      </p>
    </Section>
  );
}

type Inputs = {
  tasks: number;
  minutes: number;
  rate: number;
  share: number;
  review: number;
  perTask: number;
  fixed: number;
  people: number;
  build: number;
  months: number;
};

const START: Inputs = {
  tasks: 6000,
  minutes: 4,
  rate: 22,
  share: 60,
  review: 0.5,
  perTask: 0.03,
  fixed: 400,
  people: 1500,
  build: 40000,
  months: 36,
};

const FIELDS: [keyof Inputs, string, string][] = [
  ['tasks', 'Tasks a month', 'bookings, tickets, documents'],
  ['minutes', 'Staff minutes per task today', 'measured, not guessed'],
  ['rate', 'Staff cost per hour (£)', 'salary plus on-costs'],
  ['share', 'Share the AI completes (%)', 'from the evaluation set'],
  ['review', 'Review minutes per AI task', 'sampling and escalations'],
  ['perTask', 'Model and services per task (£)', 'tokens, search, speech'],
  ['fixed', 'Fixed running cost a month (£)', 'hosting, licences, monitoring'],
  ['people', 'Support and improvement a month (£)', 'the people who keep it working'],
  ['build', 'One-off build cost (£)', 'discovery, build, evaluation, rollout'],
  ['months', 'Months to count', 'often 36'],
];

type Draft = Record<keyof Inputs, string>;

/** The typed fields as numbers: blank or invalid counts as 0, and the share is held between 0 and 100. */
function parse(d: Draft): Inputs {
  const out = {} as Inputs;
  for (const k of Object.keys(d) as (keyof Inputs)[]) {
    const n = Number(d[k]);
    out[k] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  out.share = Math.min(100, out.share);
  return out;
}

const signed = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-GB')}`;
const money = (n: number) => signed(Math.round(n)).replace(/^(−?)/, '$1£');

/** Monthly benefit and cost, total cost of ownership and payback, from the inputs. All arithmetic, no model. */
function roi(i: Inputs) {
  const handled = (i.tasks * i.share) / 100;
  const benefit = ((handled * i.minutes) / 60) * i.rate;
  const reviewCost = ((handled * i.review) / 60) * i.rate;
  const running = handled * i.perTask + i.fixed + i.people + reviewCost;
  const net = benefit - running;
  const months = Math.max(1, Math.round(i.months));
  const tco = i.build + running * months;
  const value = benefit * months;
  const perHandled = (i.minutes / 60) * i.rate - (i.review / 60) * i.rate - i.perTask;
  // The share at which the value over the months covers the build and the running costs (an ROI of 0).
  const fixedPerMonth = i.fixed + i.people + i.build / months;
  const breakEven = i.tasks > 0 && perHandled > 0 ? (fixedPerMonth / (i.tasks * perHandled)) * 100 : null;
  return {
    handled,
    benefit,
    reviewCost,
    running,
    net,
    tco,
    value,
    roi: tco > 0 ? (value - tco) / tco : 0,
    payback: net > 0 ? i.build / net : null,
    breakEven,
    months,
  };
}

function RoiCalculator() {
  const start = () => Object.fromEntries(Object.entries(START).map(([k, v]) => [k, String(v)])) as Draft;
  const [draft, setDraft] = useState<Draft>(start);
  const r = roi(parse(draft));
  return (
    <div className="card dl-calc">
      <div className="dl-calc-grid">
        {FIELDS.map(([k, label, hint]) => (
          <label key={k}>
            <span>{label}</span>
            <input
              type="number"
              min={0}
              max={k === 'share' ? 100 : undefined}
              step="any"
              value={draft[k]}
              onChange={(e) => setDraft((p) => ({ ...p, [k]: e.target.value }))}
            />
            <span className="small muted">{hint}</span>
          </label>
        ))}
      </div>
      <div className="dl-calc-out" aria-live="polite">
        <div>
          <span className="small muted">Benefit a month</span>
          <b>{money(r.benefit)}</b>
          <span className="small muted">{Math.round(r.handled).toLocaleString('en-GB')} tasks done by the AI</span>
        </div>
        <div>
          <span className="small muted">Running cost a month</span>
          <b>{money(r.running)}</b>
          <span className="small muted">of which review time {money(r.reviewCost)}</span>
        </div>
        <div>
          <span className="small muted">Net a month</span>
          <b className={r.net < 0 ? 'dl-bad' : undefined}>{money(r.net)}</b>
          <span className="small muted">
            {r.payback === null ? 'never pays back' : `pays back the build in ${r.payback.toFixed(1)} months`}
          </span>
        </div>
        <div>
          <span className="small muted">Total cost of ownership</span>
          <b>{money(r.tco)}</b>
          <span className="small muted">over {r.months} months</span>
        </div>
        <div>
          <span className="small muted">Return on investment</span>
          <b className={r.roi < 0 ? 'dl-bad' : undefined}>{signed(Math.round(r.roi * 100))}%</b>
          <span className="small muted">(value − TCO) ÷ TCO</span>
        </div>
        <div>
          <span className="small muted">Break-even share</span>
          <b>{r.breakEven === null || r.breakEven > 100 ? 'never' : `${Math.ceil(r.breakEven)}%`}</b>
          <span className="small muted">the AI must complete for the build to pay back in {r.months} months</span>
        </div>
      </div>
      <div className="dl-bar">
        <button type="button" className="btn small" onClick={() => setDraft(start())}>
          Reset to the MedAssist example
        </button>
      </div>
    </div>
  );
}

export function RoiSection() {
  return (
    <Section
      id="roi"
      title="ROI and total cost of ownership"
      tags="AB-100 · Evaluate the costs and benefits of an AI-powered business solution"
    >
      <p>
        An ROI analysis compares what a process costs today with what it costs with AI, all in, over the life of the
        solution. The criteria come first: agree with the business which of the <a href="#value">value pillars</a>{' '}
        count, how each is measured, and the baseline, before anyone builds anything.
      </p>
      <h3>What goes into the total cost of ownership</h3>
      <Table
        head={['Cost', 'Examples', 'Often forgotten']}
        rows={[
          [
            'Build',
            'Discovery, design, build, evaluation set, security and compliance review, rollout.',
            'Writing and labelling the evaluation set.',
          ],
          [
            'Licences and capacity',
            'Microsoft 365 Copilot licences, Copilot Studio capacity, Dynamics 365 licences.',
            'Licences bought for people who never use them.',
          ],
          [
            'Usage',
            'Model tokens, search and embedding, speech, document processing, per call or per page.',
            'Retries, long conversations, and the cost of evaluation runs.',
          ],
          [
            'Running',
            'Hosting, storage, networking, monitoring and logs.',
            'Log retention, and environments for test and development.',
          ],
          [
            'People',
            'Support, prompt and knowledge updates, evaluation reruns, model upgrades, review of AI work.',
            'Review time: a person checking AI output is a cost on every task.',
          ],
          [
            'Change',
            'Training, communications, new processes, the dip in productivity while people learn.',
            'Adoption: value only arrives when people use it.',
          ],
        ]}
      />
      <h3>A calculator</h3>
      <p>
        The figures start from an invented MedAssist case: booking calls across a group of practices, handled by the
        agent instead of reception. At these figures it pays back in about 15 months; halve the volume and it takes over
        nine years, and loses money over three, which is the kind of finding to take to the business early. This is the
        lab's own simple method, not a Microsoft template (Microsoft Learn names the cost factors but gives no formula).
        Change any number; everything updates in your browser.
      </p>
      <RoiCalculator />
      <h3>Reading it honestly</h3>
      <List
        items={[
          'Saved staff time is only money if the time is used for something else or a hire is avoided. Say which.',
          'Take the AI share from the evaluation set, not from a demonstration, and expect it to be lower in the first months.',
          'Show a range: rerun with the share, the volume and the token cost at pessimistic values. If the case only works at the optimistic end, say so.',
          'Count benefits that are not time where they matter (24-hour service, fewer errors, shorter waits), but measure them separately rather than turning them into pounds.',
          'Compare with the other options, including a better process with no AI.',
        ]}
      />
      <p>
        For token costs, see <Link to="/context">context and cost</Link> and <Link to="/routing">routing</Link>: a
        router that sends easy requests to a smaller model is often the biggest single saving.
      </p>
    </Section>
  );
}

export function CoeSection() {
  return (
    <Section id="coe" title="An AI Center of Excellence" tags="AB-100 · Design overall AI strategy">
      <p>
        The Cloud Adoption Framework recommends an AI Center of Excellence (CoE): a small, multidisciplinary group that
        helps the rest of the organisation adopt AI well. It sets standards and builds shared foundations. It should not
        become the only team allowed to build anything.
      </p>
      <h3>Setting one up</h3>
      <Table
        head={['Element', 'What to decide']}
        rows={[
          [
            'Executive sponsor',
            'A senior person who owns the AI strategy, funds the CoE and settles disputes between departments.',
          ],
          ['Leader', 'One named person who runs the CoE day to day and answers for its results.'],
          [
            'Team',
            'Several disciplines: business analysis, data, engineering, security, legal and compliance, change management, and people from the business units.',
          ],
          [
            'Placement',
            'Where it sits: in IT, in a business function, or reporting to the executive team. The closer to the business, the easier it is to find the right use cases.',
          ],
          [
            'Operating model',
            'Centralised (the CoE builds), federated (business units build to CoE standards), or a hub with spokes. Most organisations start central and federate as skills grow.',
          ],
        ]}
      />
      <h3>What it is responsible for</h3>
      <List
        items={[
          'The AI strategy and the list of use cases, ranked by value and feasibility.',
          'Skills: training plans for makers, engineers and everyone who will use AI at work.',
          'Pilots: running the first projects so that what is learned can be reused.',
          'Standards: responsible AI, security, data handling, evaluation and the approved models and tools.',
          'Intake: one route for a team to propose a use case and get it assessed.',
          'Reusable assets: templates, connectors, a prompt library, evaluation sets and reference architectures.',
          'Measuring outcomes: whether each solution delivered the value it promised.',
          'Managing shared AI services: platforms, capacity, cost and model upgrades.',
        ]}
      />
      <p>
        In this lab, the parts a CoE would own are spread across pages: <a href="#risks">risks and ethics</a>,{' '}
        <Link to="/evals">evaluation</Link>, <a href="#observability">observability</a> and the{' '}
        <a href="#prompt-library">prompt library</a> below.
      </p>
    </Section>
  );
}

export function PromptLibrarySection() {
  return (
    <Section id="prompt-library" title="A prompt library" tags="AB-100 · Design overall AI strategy">
      <p>
        A prompt library is a shared, maintained set of prompts that work, so that people stop rewriting the same prompt
        and the good ones get better over time. Microsoft Learn has no page on running one; these are the lab's
        guidelines.
      </p>
      <h3>What each entry holds</h3>
      <Table
        head={['Field', 'Why']}
        rows={[
          ['Purpose and task type', 'So people can find it: summarise, draft, extract, classify, analyse.'],
          [
            'The prompt, with marked inputs',
            'Placeholders for what the user fills in, such as {document} or {audience}.',
          ],
          ['One or two examples', 'An input and a good output, so a reader can judge the result.'],
          ['Model and tool it was tested on', 'A prompt tuned for one model may behave differently on another.'],
          ['Owner and last reviewed date', 'Someone answers for it; stale entries are found and retired.'],
          ['Test cases', 'A few inputs with the expected output, rerun when the prompt or model changes.'],
          ['Data classification', 'Which data it may be used with: public, internal, confidential, personal.'],
          ['Known limits', 'What it does badly, in plain words.'],
        ]}
      />
      <h3>Running it</h3>
      <List
        items={[
          'Start with the ten tasks people do most, not with everything.',
          'Version prompts like code: a change has a reason, a reviewer and test results.',
          'Write prompts for the person, not the model: plain words, the goal, the audience and the format.',
          'Keep prompts free of secrets and personal data; inputs bring the data at run time.',
          'Collect feedback on each entry and look at which entries are used; retire the ones that are not.',
          'Make the CoE or a named team the owner, with business units contributing.',
        ]}
      />
      <p>
        <Link to="/claude-at-work#task-types">Claude at work</Link> has prompt templates by task type that could seed a
        library, and <Link to="/prompting">Prompting</Link> covers the techniques behind them.
      </p>
    </Section>
  );
}
