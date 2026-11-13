import { Fragment, useState, type ReactNode } from 'react';
import './claude-architect.css';

/* One renderer for the certification exam maps (Anthropic's Claude exams, and Microsoft's AB-100): the format, the
   domain weights, every objective from the official guide with where the lab practises it, and honest statuses. */

export type Status = 'run' | 'part' | 'explained' | 'product' | 'gap';
export type Link = [string, string];
export type Task = {
  id: string;
  title: string;
  tested?: string;
  weight?: number; // the guide's share of the whole exam, where it gives one
  labs: Link[];
  status: Status;
  note?: string;
  group?: string; // the guide's sub-heading, shown once above the first task under it
};
export type Domain = {
  n: number;
  name: string;
  weight: number; // for the bar; the midpoint when the guide gives a range
  weightLabel?: string; // the guide's own figure when it is a range, such as "35–40%"
  tasks: Task[];
};
export type Scenario = { name: string; does: string; domains: string; labs: Link[]; fit: string };
export type Exercise = { name: string; start: Link[]; missing: string };

export type Exam = {
  id: 'associate' | 'developer' | 'architect' | 'professional' | 'ab100';
  name: string;
  code: string;
  fee?: number;
  questions?: number;
  extraFacts?: string[];
  facts?: ReactNode[]; // replaces the Claude exams' fact strip (another vendor's format)
  source?: ReactNode; // replaces the Claude exams' source line
  product?: { label: string; means: string; count: string }; // where "product" skills are practised
  domainWord?: [string, string]; // what the guide calls its domains, such as functional groups
  pageUrl: string;
  item: [string, string]; // what the guide calls each objective, singular and plural
  intro: ReactNode;
  audience: ReactNode;
  domains: Domain[];
  scenarios?: { intro: string; list: Scenario[] };
  exercises?: Exercise[];
  prepare?: ReactNode;
  outOfScope?: { links: Link[]; also: string };
};

export const STATUS: Record<Status, { label: string; tag: string; means: string; count: string }> = {
  run: { label: 'runs here', tag: 'run', means: 'a lab page or script does it', count: 'run here' },
  part: {
    label: 'partly',
    tag: 'explained',
    means: 'runs here, with the missing piece named',
    count: 'partly run (the missing piece is named)',
  },
  explained: {
    label: 'explained',
    tag: 'explained',
    means: 'described with examples, not run',
    count: 'are explained without running',
  },
  product: {
    label: 'in claude.ai',
    tag: 'muted',
    means: 'practise it in the Claude apps; the lab shows the idea',
    count: 'are practised in claude.ai itself',
  },
  gap: { label: 'not yet', tag: 'gap', means: 'nothing here covers it', count: 'are not covered yet' },
};

const FAMILIES: { name: string; maps: [string, string, string][] }[] = [
  {
    name: 'Claude certification exam maps',
    maps: [
      ['associate', 'Associate', '/claude-associate'],
      ['developer', 'Developer', '/claude-developer'],
      ['architect', 'Architect – Foundations', '/claude-architect'],
      ['professional', 'Architect – Professional', '/claude-professional'],
    ],
  },
  {
    name: 'Microsoft certification exam maps',
    maps: [
      ['ai103', 'AI-103', '/ai-103'],
      ['ab100', 'AB-100', '/ab-100'],
    ],
  },
];

export function Links({ links }: { links: Link[] }) {
  return (
    <>
      {links.map(([label, href], i) => (
        <span key={href + label}>
          {i > 0 && ' · '}
          <a href={href}>{label}</a>
        </span>
      ))}
    </>
  );
}

/** The Claude exams' format: the same for all four, apart from the number of questions and the fee. */
function ClaudeFacts({ exam }: { exam: Exam }) {
  return (
    <>
      <span>
        <b>{exam.questions}</b> questions
      </span>
      <span>
        <b>120</b> minutes
      </span>
      {exam.extraFacts?.map((f) => (
        <span key={f}>{f}</span>
      ))}
      <span>
        Pass: <b>720</b> on a 100–1,000 scale
      </span>
      <span>
        <b>${exam.fee}</b>
      </span>
      <span>Valid 12 months</span>
      <span>Multiple choice and multiple response</span>
    </>
  );
}

export function ExamMap({ exam }: { exam: Exam }) {
  const [show, setShow] = useState<Status | 'all'>('all');
  const status = (s: Status) => (s === 'product' && exam.product ? { ...STATUS.product, ...exam.product } : STATUS[s]);
  const family = FAMILIES.find((f) => f.maps.some(([id]) => id === exam.id))!;
  const [domainOne, domainMany] = exam.domainWord ?? ['domain', 'domains'];
  const all = exam.domains.flatMap((d) => d.tasks);
  const count = (s: Status) => all.filter((t) => t.status === s).length;
  const top = Math.max(...exam.domains.map((d) => d.weight));
  // One decimal everywhere when the guide uses decimals, so 11.0% does not read as 11%.
  const decimals = exam.domains.some((d) => !Number.isInteger(d.weight));
  const pct = (n: number) => `${decimals ? n.toFixed(1) : n}%`;
  const weightOf = (d: Domain) => d.weightLabel ?? pct(d.weight);
  const [one, many] = exam.item;
  const parts = (['run', 'part', 'explained', 'product', 'gap'] as const)
    .filter((s) => count(s) > 0)
    .map((s) => `${count(s)} ${status(s).count}`);
  return (
    <>
      <nav className="ca-switch small" aria-label={family.name}>
        {family.name}:{' '}
        {family.maps.map(([id, label, href], i) => (
          <span key={id}>
            {i > 0 && ' · '}
            {id === exam.id ? <b>{label}</b> : <a href={href}>{label}</a>}
          </span>
        ))}
      </nav>
      <div className="kicker">Exam map</div>
      <h1>{exam.name}</h1>
      <p className="lede">
        {exam.intro} {all.length} {many}: {parts.join(', ')}.
      </p>
      <div className="ca-stack small">
        {exam.facts ? exam.facts.map((f, i) => <span key={i}>{f}</span>) : <ClaudeFacts exam={exam} />}
      </div>
      {exam.source ?? (
        <p className="small muted">
          Source: the exam guide, version 1.0, effective July 2026 (exam code {exam.code}), on the{' '}
          <a href={exam.pageUrl}>certification page</a> of the Anthropic Partner Academy, where you register through
          Pearson VUE. The guide has sample questions with their reasoning. Anthropic may change it without notice.
        </p>
      )}
      <div className="ca-audience">{exam.audience}</div>

      <section className="ca-panel">
        <h2>
          The {exam.domains.length} {domainMany}
        </h2>
        <div className="ca-weights">
          {exam.domains.map((d) => (
            <div key={d.n} className="ca-weight">
              <a href={`#domain-${d.n}`}>
                {d.n}. {d.name}
              </a>
              <div className="ca-track">
                <div style={{ width: `${(d.weight / top) * 100}%` }} />
              </div>
              <span className="num">{weightOf(d)}</span>
            </div>
          ))}
        </div>
      </section>

      {exam.scenarios && (
        <>
          <h2>The {exam.scenarios.list.length} scenarios</h2>
          <p>{exam.scenarios.intro}</p>
          <div className="ca-cards">
            {exam.scenarios.list.map((s, i) => (
              <div key={s.name} className="ca-card">
                <h3>
                  {i + 1}. {s.name}
                </h3>
                <p className="small">{s.does}</p>
                <p className="small muted">Mostly domains {s.domains}</p>
                <p className="small">
                  <Links links={s.labs} />
                </p>
                <p className="small">
                  <b>Fit:</b> {s.fit}
                </p>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>
        {many[0].toUpperCase() + many.slice(1)} by {domainOne}
      </h2>
      <div className="ca-filter">
        {(['all', 'run', 'part', 'explained', 'product', 'gap'] as const)
          .filter((s) => s === 'all' || count(s) > 0)
          .map((s) => (
            <button
              key={s}
              type="button"
              className={`ca-chip${show === s ? ' on' : ''}`}
              onClick={() => setShow(s)}
              title={s === 'all' ? undefined : status(s).means}
            >
              {s === 'all' ? `All (${all.length})` : `${status(s).label} (${count(s)})`}
            </button>
          ))}
      </div>
      {exam.domains.map((d) => {
        const tasks = d.tasks.filter((t) => show === 'all' || t.status === show);
        if (!tasks.length) return null;
        return (
          <section key={d.n} className="ca-panel" id={`domain-${d.n}`}>
            <h2>
              {d.n}. {d.name} <span className="ca-tag muted">{weightOf(d)}</span>
            </h2>
            <div className="ca-table-wrap">
              <table className="ca-table">
                <thead>
                  <tr>
                    <th>{one[0].toUpperCase() + one.slice(1)}</th>
                    <th>Practise it in</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t, i) => (
                    <Fragment key={t.id}>
                      {t.group && t.group !== tasks[i - 1]?.group && (
                        <tr className="ca-group">
                          <th colSpan={3}>{t.group}</th>
                        </tr>
                      )}
                      <tr>
                        <td style={{ width: '46%' }}>
                          <span className="ca-id">{t.id}</span> <b>{t.title}</b>
                          {t.weight !== undefined && <span className="ca-id"> · {pct(t.weight)} of the exam</span>}
                          {t.tested && <div className="small muted">{t.tested}</div>}
                        </td>
                        <td>
                          <Links links={t.labs} />
                          {t.note && <div className="small muted">{t.note}</div>}
                        </td>
                        <td style={{ width: 96 }}>
                          <span className={`ca-tag ${status(t.status).tag}`} title={status(t.status).means}>
                            {status(t.status).label}
                          </span>
                        </td>
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {exam.exercises && (
        <>
          <h2>The guide’s {exam.exercises.length} preparation exercises</h2>
          <div className="ca-table-wrap">
            <table className="ca-table">
              <thead>
                <tr>
                  <th>Exercise</th>
                  <th>Start from</th>
                  <th>Still to add</th>
                </tr>
              </thead>
              <tbody>
                {exam.exercises.map((e) => (
                  <tr key={e.name}>
                    <td>
                      <b>{e.name}</b>
                    </td>
                    <td>
                      <Links links={e.start} />
                    </td>
                    <td className="small">{e.missing}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {exam.prepare && (
        <>
          <h2>How to prepare</h2>
          {exam.prepare}
        </>
      )}

      {exam.outOfScope && (
        <>
          <h2>Useful, but not on this exam</h2>
          <p>
            The guide lists topics that will not be tested. The lab covers several of them, so skip these pages when you
            are short of time: <Links links={exam.outOfScope.links} />. {exam.outOfScope.also}
          </p>
        </>
      )}
    </>
  );
}
