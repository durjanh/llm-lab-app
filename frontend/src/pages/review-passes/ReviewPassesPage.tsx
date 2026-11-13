import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { modelName } from '@/lib/models';
import {
  reviewPassesService,
  type ConfidenceResult,
  type CiResult,
  type ReviewFinding,
  type ReviewInfo,
  type ReviewVariant,
} from '@/services/reviewPassesService';
import { statusService } from '@/services/statusService';
import './review-passes.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (v: number) => `$${v.toFixed(4)}`;
const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);

function Verdict({ f }: { f: ReviewFinding }) {
  const label =
    f.verdict === 'found'
      ? `real: ${f.matches}`
      : f.verdict === 'duplicate'
        ? `repeat of ${f.matches}`
        : f.verdict === 'noise'
          ? `false positive: ${f.matches}`
          : 'false positive: not in the key';
  return <span className={`rp-verdict ${f.verdict.replace(' ', '-')}`}>{label}</span>;
}

function Findings({
  rows,
  status = false,
  confidence = false,
}: {
  rows: ReviewFinding[];
  status?: boolean;
  confidence?: boolean;
}) {
  if (!rows.length) return <p className="small muted">No findings.</p>;
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Where</th>
            <th>Severity</th>
            {status && <th>Status</th>}
            {confidence && <th>Confidence</th>}
            <th>Finding</th>
            <th>Pattern</th>
            <th>Against the key</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((f, i) => (
            <tr key={i}>
              <td className="rp-where">
                {f.file}:{f.line}
              </td>
              <td>{f.severity}</td>
              {status && (
                <td>
                  {f.status}
                  {f.status_ok === false && <span className="rp-bad"> (wrong)</span>}
                </td>
              )}
              {confidence && <td>{f.confidence?.toFixed(2)}</td>}
              <td>{f.issue}</td>
              <td className="small muted">{f.detected_pattern}</td>
              <td>
                <Verdict f={f} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Scorecard({ v, ids }: { v: ReviewVariant; ids: Record<string, string> }) {
  return (
    <div className="card rp-variant">
      <h3>{v.name}</h3>
      <p className="small muted">{v.about}</p>
      <div className="rp-stats">
        <div>
          <b>
            {v.found.length} of {Object.keys(ids).length}
          </b>
          <span>problems found</span>
        </div>
        <div>
          <b>{v.false_positives}</b>
          <span>false positives</span>
        </div>
        <div>
          <b>{pct(v.precision)}</b>
          <span>precision</span>
        </div>
        <div>
          <b>{v.calls}</b>
          <span>
            {v.calls === 1 ? 'call' : 'calls'}, {(v.tokens_in + v.tokens_out).toLocaleString()} tokens
          </span>
        </div>
        <div>
          <b>{usd(v.cost_usd)}</b>
          <span>cost</span>
        </div>
      </div>
      <p className="small">
        <b>Found:</b> {v.found.map((i) => ids[i]).join(', ') || 'none'}
        <br />
        <b>Missed:</b> {v.missed.map((i) => ids[i]).join(', ') || 'none'}
        {v.duplicates > 0 && (
          <>
            <br />
            <span className="muted">{v.duplicates} finding(s) repeated a problem already counted.</span>
          </>
        )}
      </p>
      {v.steps && <p className="small muted">{v.steps.map((s) => `${s.step}: ${s.findings}`).join(' · ')}</p>}
      {v.contradictions && (
        <div className="small">
          <b>Conflicting findings: {v.contradictions.length}</b>
          {v.contradictions.map((c, i) => (
            <p key={i} className="rp-conflict">
              {c.file}
              <br />
              {c.a}
              <br />
              {c.b}
            </p>
          ))}
        </div>
      )}
      {v.explanation && (
        <details className="small">
          <summary>What the conversation said before it reviewed</summary>
          <p>{v.explanation}</p>
        </details>
      )}
      <Findings rows={v.findings} />
    </div>
  );
}

export function ReviewPassesPage() {
  const [info, setInfo] = useState<ReviewInfo | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [cost, setCost] = useState(0);
  const [variants, setVariants] = useState<Record<string, ReviewVariant[]>>({});
  const [conf, setConf] = useState<ConfidenceResult | null>(null);
  const [ci, setCi] = useState<CiResult | null>(null);

  useEffect(() => {
    reviewPassesService
      .info()
      .then(setInfo)
      .catch((e) => setError(errorText(e)));
    statusService
      .status()
      .then((s) => {
        setModels(s.models || []);
        setModel(s.default_model || s.models?.[0] || '');
      })
      .catch(() => undefined);
  }, []);

  const ids: Record<string, string> = Object.fromEntries((info?.key ?? []).map((k) => [k.id, k.id.replace('_', ' ')]));

  async function run(name: string, work: () => Promise<void>) {
    setBusy(name);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }
  const addCost = (vs: ReviewVariant[]) => setCost((c) => c + vs.reduce((a, v) => a + v.cost_usd, 0));
  const runVariants = (name: 'criteria' | 'passes' | 'independent') =>
    run(name, async () => {
      const r = await reviewPassesService[name](model);
      setVariants((v) => ({ ...v, [name]: r.variants }));
      addCost(r.variants);
    });

  const RunBar = ({ name, label }: { name: string; label: string }) => (
    <div className="rp-bar">
      <button
        className="btn primary"
        disabled={!!busy || !model || !info}
        onClick={() => {
          if (name === 'confidence')
            void run(name, async () => {
              const r = await reviewPassesService.confidence(model);
              setConf(r);
              addCost([r.variant]);
            });
          else if (name === 'ci')
            void run(name, async () => {
              const r = await reviewPassesService.ci(model);
              setCi(r);
              addCost([r.first, r.second]);
            });
          else void runVariants(name as 'criteria' | 'passes' | 'independent');
        }}
      >
        {busy === name ? 'Reviewing…' : label}
      </button>
      <span className="small muted">{model && modelName(model)}</span>
    </div>
  );

  const shown = (name: string) => (variants[name] ?? []).map((v) => <Scorecard key={v.name} v={v} ids={ids} />);

  return (
    <main className="page-review-passes">
      <div className="kicker">Building · Code review passes</div>
      <h1>Code review passes</h1>
      <p className="lede">
        A model can review code well or badly depending on how you ask. This page reviews one invented change set in
        different ways and scores each review against an answer key: which of the six real problems it found, which it
        missed, and what it reported that it should not have.
      </p>

      <section className="card">
        <div className="rp-model">
          <label>
            Model{' '}
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!!busy}>
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <span className="small muted">Model calls on this page: {usd(cost)}. Every review is a paid call.</span>
        </div>
        {error && <p className="rp-bad">{error}</p>}
      </section>

      <h2>The change set</h2>
      <p className="small">
        A refunds feature for an invented shop: five new Python files,{' '}
        {info ? info.files.reduce((a, f) => a + f.lines, 0) : '…'} lines. It has six real problems and some things that
        look wrong but are not worth a comment. The model sees the code with line numbers. The key is below if you want
        to read the code first.
      </p>
      {info && (
        <>
          {info.files.map((f) => (
            <details key={f.name} className="rp-file">
              <summary>
                {f.name} <span className="muted small">({f.lines} lines)</span>
              </summary>
              <pre>
                {f.code
                  .split('\n')
                  .map((l, i) => `${String(i + 1).padStart(3)} | ${l}`)
                  .join('\n')}
              </pre>
            </details>
          ))}
          <details className="rp-file">
            <summary>The answer key</summary>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Problem</th>
                    <th>Kind</th>
                    <th>What is wrong</th>
                    <th>Where</th>
                  </tr>
                </thead>
                <tbody>
                  {info.key.map((k) => (
                    <tr key={k.id}>
                      <td>
                        {ids[k.id]}
                        {k.cross_file && <span className="small muted"> (across files)</span>}
                      </td>
                      <td>{k.severity}</td>
                      <td>{k.what}</td>
                      <td className="rp-where">{k.where.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small">
              <b>Not worth reporting:</b>
            </p>
            <ul className="small">
              {info.noise.map((n) => (
                <li key={n.id}>
                  {n.kind}: {n.what}
                </li>
              ))}
            </ul>
            <p className="small muted">
              A finding counts when it points at one of the key’s places, give or take a line. A finding outside the key
              is shown as a false positive, but read it: it may be a real problem the key does not list.
            </p>
          </details>
        </>
      )}

      <h2 id="criteria">1. Vague criteria or explicit ones</h2>
      <p className="small">
        “Be conservative, only high-confidence findings” sounds careful, but it gives the model nothing to decide with.
        Explicit criteria say what to report (bugs, security, data loss), what to skip (style, and patterns that are
        fine in this codebase) and what each severity means, with a code example each. Explicit criteria are what cut
        false positives.
      </p>
      {info && (
        <div className="rp-prompts">
          <div className="card">
            <h3>Vague</h3>
            <pre className="rp-prompt">{info.prompts.vague}</pre>
          </div>
          <div className="card">
            <h3>Explicit</h3>
            <pre className="rp-prompt">{info.prompts.explicit}</pre>
          </div>
        </div>
      )}
      <RunBar name="criteria" label="Run both reviews" />
      <div className="rp-pair">{shown('criteria')}</div>
      <p className="small muted">
        Precision is real findings divided by real findings plus false positives. Read the two false-positive counts
        side by side. A model sometimes ignores a vague instruction and still reports little, so run it more than once.
      </p>

      <h2 id="passes">2. One pass, or per-file passes plus an integration pass</h2>
      <p className="small">
        One pass over every file at once spreads the model’s attention thin and it tends to skim. Reviewing each file on
        its own gives focused local findings, but a bug that lives between two files is invisible to a reviewer who sees
        one. A separate integration pass reads all the files for values that cross a boundary. Here the cross-file bug
        is a refund in pounds that one file hands to another as pence.
      </p>
      <RunBar name="passes" label="Run both strategies (7 calls)" />
      <div className="rp-pair">{shown('passes')}</div>
      <p className="small muted">
        Conflicting findings are two findings about the same place that disagree on severity. Passes that cannot see
        each other’s work produce them; the one-pass review has one voice, so it cannot contradict itself this way. The
        integration pass is told the per-file passes exist, so it should not repeat them, but it does not see their
        output.
      </p>

      <h2 id="independent">3. Self-review or an independent reviewer</h2>
      <p className="small">
        The conversation that explained the change has already argued it is right. Asking the same conversation to
        review it means the review starts from that argument. An independent reviewer is a new call with no history: it
        sees the code and the criteria, so it has no reasoning to defend.
      </p>
      <RunBar name="independent" label="Run both reviews (3 calls)" />
      <div className="rp-pair">{shown('independent')}</div>

      <h2 id="confidence">4. Confidence and the pattern that triggered it</h2>
      <p className="small">
        Each finding carries the model’s own confidence and a <code>detected_pattern</code>: the code construct that
        made it report. Confidence routes the finding: at or above {info?.thresholds.comment ?? 0.8} it is posted on the
        pull request, at or above {info?.thresholds.triage ?? 0.5} it goes to a person, and below that it is only
        logged. The pattern is for later: when people dismiss findings, grouping the dismissed ones by pattern shows
        which rule to tighten. Here, “dismissed” means the key does not support it.
      </p>
      <RunBar name="confidence" label="Run the review with confidence" />
      {conf && (
        <>
          <Scorecard v={conf.variant} ids={ids} />
          <div className="rp-pair">
            {conf.routing.map((r) => (
              <div className="card" key={r.lane}>
                <h3>
                  {r.lane === 'comment'
                    ? 'Post as a PR comment'
                    : r.lane === 'triage'
                      ? 'Send to a person'
                      : 'Log only'}
                </h3>
                <p className="small">
                  {r.count} finding(s): {r.real} real, {r.dismissed} dismissed.
                </p>
                <Findings rows={r.findings} confidence />
              </div>
            ))}
          </div>
          <div className="card">
            <h3>Dismissed findings by detected pattern</h3>
            {conf.dismissed_patterns.length ? (
              <ul className="small">
                {conf.dismissed_patterns.map((p) => (
                  <li key={p.pattern}>
                    <code>{p.pattern}</code>: {p.count}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">Nothing was dismissed on this run.</p>
            )}
            <p className="small muted">
              If confidence is well calibrated, the top lane holds the real findings and the bottom lane the dismissed
              ones. Check whether it did here; a model’s confidence is a signal, not a measurement.
            </p>
          </div>
        </>
      )}

      <h2 id="ci">5. In CI: the same schema, and re-runs that only report what changed</h2>
      <p className="small">
        A CI job reads findings as JSON, so they use one schema: <code>examples/claude-code/ci/review-schema.json</code>{' '}
        (file, line, severity, issue, suggested_fix, detected_pattern, status). On a re-run after a new commit the job
        passes the last findings to the model, with the updated files, and asks it to report only what is{' '}
        <code>new</code> or <code>still_open</code>. Fixed findings drop out, so a developer is not shown the same
        comment twice. This button runs the review, fixes the SQL problem in <code>refunds/store.py</code>, and runs it
        again with the first findings.
      </p>
      <RunBar name="ci" label="Run, fix one file, run again" />
      {ci && (
        <>
          <p className="small">
            Fixed after the change to {ci.changed_file}: <b>{ci.fixed.map((i) => ids[i]).join(', ') || 'nothing'}</b>.
            Still open: <b>{ci.still_open.map((i) => ids[i]).join(', ') || 'nothing'}</b>. A status is marked wrong when
            it calls a problem new that the first run already reported.
          </p>
          <div className="rp-pair">
            <div className="card">
              <h3>Run 1</h3>
              <p className="small">
                {ci.first.found.length} of 6 found, {ci.first.false_positives} false positives, {usd(ci.first.cost_usd)}
                .
              </p>
              <Findings rows={ci.first.findings} status />
            </div>
            <div className="card">
              <h3>Run 2</h3>
              <p className="small">
                {ci.second.found.length} of 6 still reported, {ci.second.false_positives} false positives,{' '}
                {usd(ci.second.cost_usd)}.
              </p>
              <Findings rows={ci.second.findings} status />
            </div>
          </div>
        </>
      )}

      <h2 id="sessions">Sessions: resume and fork</h2>
      <p className="small">
        A review is a conversation, and a conversation can be kept. With the Claude Agent SDK every run has a{' '}
        <code>session_id</code>, which arrives on the result message. Pass it back as <code>resume</code> to carry on
        where the run stopped, with everything it had read still in context. Pass <code>fork_session=True</code> as well
        and the SDK starts a new session from that point, leaving the original untouched. That is how you try two fixes
        from the same baseline, such as the SQL problem fixed with a parameterised query in one fork and an ORM in
        another, and keep whichever works. <code>continue_conversation=True</code> resumes the most recent session in
        the folder without needing its id.
      </p>
      <p className="small">
        The script is <code>examples/claude-agent-sdk/sessions_sdk.py</code>. Resuming is not the same as rewinding
        files: <Link to="/claude-code-inside#rewind">/clear, rewind and resume</Link> shows what each one restores. A
        resumed review should still be an independent one if you want a fresh opinion: resuming brings back the earlier
        reasoning, which is what mode 3 shows you may not want.
      </p>

      <div className="takeaways">
        <h3>Engineering takeaways</h3>
        <ul>
          <li>
            <b>Say what to report and what to skip.</b> “Be conservative” does not change what the model decides to
            report; explicit categories, examples and exclusions do.
          </li>
          <li>
            <b>Review in passes.</b> Per-file passes catch local problems; a separate pass over data flow catches what
            crosses files. Merge their findings and settle conflicts in code.
          </li>
          <li>
            <b>Review with fresh eyes.</b> The author’s conversation is anchored to its own work. Use a new instance for
            the review.
          </li>
          <li>
            <b>Ask for confidence and a pattern.</b> Route by confidence, and track dismissals by pattern so you know
            which criteria to tighten.
          </li>
          <li>
            <b>Make re-runs quiet.</b> One schema, and a status on each finding, so a developer sees only what is new or
            still open.
          </li>
        </ul>
      </div>
    </main>
  );
}

export default ReviewPassesPage;
