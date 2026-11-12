import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { VoiceComposer } from '@/components/voice/VoiceComposer';
import { isLocalModel } from '@/lib/models';
import { Board, type BoardHandle } from '@/pages/whiteboard/Board';
import '@/pages/whiteboard/whiteboard.css';
import {
  brainService,
  type BrainInfo,
  type BrainResult,
  type ClockScore,
  type RiskAnswer,
} from '@/services/brainService';
import { statusService } from '@/services/statusService';
import './brain-check.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const FLUENCY_SECONDS = 60;

type Step = 'intro' | 'words' | 'date' | 'clock' | 'animals' | 'recall' | 'risks' | 'result';
const ORDER: Step[] = ['words', 'date', 'clock', 'animals', 'recall', 'risks'];
const STEP_NAMES: Record<Step, string> = {
  intro: 'Start',
  words: 'Five words',
  date: 'Day and date',
  clock: 'Draw a clock',
  animals: 'Name animals',
  recall: 'The five words',
  risks: 'Your habits',
  result: 'Results',
};

/** The person's own calendar date, which the backend checks the date answers against. */
function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const OUTCOME_CLASS = { fine: 'ok', repeat: 'warn', gp: 'act', concern: 'act' } as const;

/** A brain health check: short thinking tasks in order, scored by code, compared with the person's earlier checks. */
export default function BrainCheckPage() {
  const board = useRef<BoardHandle>(null);
  const [info, setInfo] = useState<BrainInfo | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [step, setStep] = useState<Step>('intro');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [user, setUser] = useState('');
  const [save, setSave] = useState(false);
  const [concern, setConcern] = useState(false);
  const [checkId, setCheckId] = useState('');
  const [words, setWords] = useState<string[]>([]);
  const [orientation, setOrientation] = useState({ weekday: '', day: '', month: '', year: '' });
  const [clock, setClock] = useState<Promise<ClockScore | null> | null>(null);
  const [animals, setAnimals] = useState('');
  const [left, setLeft] = useState<number | null>(null); // seconds left in the animal minute; null before it starts
  const [recall, setRecall] = useState('');
  const [risks, setRisks] = useState<Record<string, RiskAnswer>>({});
  const [result, setResult] = useState<BrainResult | null>(null);
  const [cost, setCost] = useState(0);

  useEffect(() => {
    brainService
      .info()
      .then(setInfo)
      .catch((err) => setError(errorText(err)));
    statusService
      .status()
      .then((s) => {
        setModels(s.models || []);
        setModel(s.claude_model || s.models?.[0] || '');
      })
      .catch((err) => setError(errorText(err)));
  }, []);

  // The animal minute counts down once started.
  useEffect(() => {
    if (left === null || left <= 0) return;
    const timer = window.setTimeout(() => setLeft((s) => (s === null ? s : s - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [left]);

  const next = () => setStep((s) => ORDER[ORDER.indexOf(s) + 1] ?? 'result');

  async function begin() {
    setError('');
    setBusy(true);
    try {
      const started = await brainService.start();
      setCheckId(started.check_id);
      setWords(started.words);
      setOrientation({ weekday: '', day: '', month: '', year: '' });
      setClock(null);
      setAnimals('');
      setLeft(null);
      setRecall('');
      setRisks({});
      setResult(null);
      setStep('words');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  // The clock is read while the person carries on: the model's answer is only needed at the end.
  function sendClock() {
    const image = board.current?.snapshot() ?? null;
    setClock(
      image
        ? brainService
            .clock(checkId, image, model || undefined)
            .then((r) => {
              setCost((c) => c + r.cost_usd);
              return r.clock;
            })
            .catch((err) => {
              setError(`The clock could not be read: ${errorText(err)}`);
              return null;
            })
        : Promise.resolve(null),
    );
    next();
  }

  async function finish() {
    setBusy(true);
    setError('');
    try {
      await clock; // the clock's score is kept with the check on the server
      const r = await brainService.finish(checkId, {
        model: model || undefined,
        user: user.trim() || 'guest',
        save,
        concern,
        today: localDate(),
        recall: recall.split(/[\s,;]+/).filter(Boolean),
        orientation,
        fluency_text: animals,
        risks,
      });
      setCost((c) => c + r.cost_usd);
      setResult(r);
      setStep('result');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const at = ORDER.indexOf(step);
  const s = result?.scores;

  return (
    <main className="page-brain-check">
      <div className="kicker">Building · Brain health check</div>
      <h1>A ten-minute check you repeat, so change shows early</h1>
      <p className="lede">
        Five short tasks, one after another, then questions about the habits that affect dementia risk. The page records
        your answers and shows how you did. A model reads your clock drawing and picks the animals out of what you said.
        Code scores everything, compares it with your earlier checks, and decides what to suggest.
      </p>
      {info && <p className="bc-notice small">{info.notice}</p>}
      {error && <p className="bc-bad small">{error}</p>}

      {step !== 'intro' && step !== 'result' && (
        <ol className="bc-steps" aria-label="Progress">
          {ORDER.map((o, i) => (
            <li key={o} className={i < at ? 'done' : i === at ? 'on' : ''}>
              {STEP_NAMES[o]}
            </li>
          ))}
        </ol>
      )}

      <section className="card bc-stage" aria-live="polite">
        {step === 'intro' && (
          <>
            <h2>Before you start</h2>
            <p>
              Sit somewhere quiet, with your glasses and hearing aids if you use them. Do it on your own, unhurried.
            </p>
            <div className="bc-form">
              <label>
                Your name{' '}
                <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="e.g. Sam" size={14} />
              </label>
              <label>
                Model{' '}
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                      {m.startsWith('gpt-') ? ' (Azure OpenAI)' : isLocalModel(m) ? ' (local, free)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="bc-tick">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Keep my results on
              this computer, under my name, so the next check can be compared with this one
            </label>
            <label className="bc-tick">
              <input type="checkbox" checked={concern} onChange={(e) => setConcern(e.target.checked)} /> I, or someone
              close to me, have noticed my memory getting worse over the past year
            </label>
            <button className="btn primary" onClick={() => void begin()} disabled={busy || !info}>
              Start the check
            </button>
          </>
        )}

        {step === 'words' && (
          <>
            <h2>1. Remember these five words</h2>
            <p>Read them aloud twice. You will be asked for them again in a few minutes.</p>
            <div className="bc-words">
              {words.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </div>
            <button className="btn primary" onClick={next}>
              I have read them twice
            </button>
          </>
        )}

        {step === 'date' && (
          <>
            <h2>2. What is today?</h2>
            <p>Without looking at a clock, phone or calendar.</p>
            <div className="bc-form">
              <label>
                Day of the week{' '}
                <select
                  value={orientation.weekday}
                  onChange={(e) => setOrientation({ ...orientation, weekday: e.target.value })}
                >
                  <option value="">Choose</option>
                  {WEEKDAYS.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
              <label>
                Date{' '}
                <input
                  inputMode="numeric"
                  size={3}
                  maxLength={2}
                  value={orientation.day}
                  onChange={(e) => setOrientation({ ...orientation, day: e.target.value.replace(/\D/g, '') })}
                />
              </label>
              <label>
                Month{' '}
                <select
                  value={orientation.month}
                  onChange={(e) => setOrientation({ ...orientation, month: e.target.value })}
                >
                  <option value="">Choose</option>
                  {MONTHS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label>
                Year{' '}
                <input
                  inputMode="numeric"
                  size={5}
                  maxLength={4}
                  value={orientation.year}
                  onChange={(e) => setOrientation({ ...orientation, year: e.target.value.replace(/\D/g, '') })}
                />
              </label>
            </div>
            <button className="btn primary" onClick={next}>
              Next
            </button>
          </>
        )}

        {step === 'clock' && (
          <>
            <h2>3. Draw a clock</h2>
            <p>
              Draw a clock face, put in all the numbers, and set the hands to <b>{info?.clock_time}</b>. Use a mouse,
              pen or finger. Your drawing is left exactly as you draw it.
            </p>
            <div className="page-whiteboard bc-board">
              <Board ref={board} tidy={false} hint="Draw the clock here" />
            </div>
            <button className="btn primary" onClick={sendClock}>
              I have finished the clock
            </button>
          </>
        )}

        {step === 'animals' && (
          <>
            <h2>4. Name as many animals as you can in one minute</h2>
            <p>
              Any animals: pets, farm, wild, birds, fish, insects. Press the microphone and say them, or type them. The
              minute starts when you press Start.
            </p>
            {left === null ? (
              <button className="btn primary" onClick={() => setLeft(FLUENCY_SECONDS)}>
                Start the minute
              </button>
            ) : (
              <>
                <div className={`bc-timer${left === 0 ? ' up' : ''}`}>
                  {left > 0 ? `${left} seconds left` : 'Time is up'}
                </div>
                <VoiceComposer
                  value={animals}
                  onChange={(t) => left > 0 && setAnimals(t)}
                  onSend={next}
                  onError={setError}
                  disabled={left === 0}
                  placeholder="cat, dog, …"
                />
                <button className="btn primary" onClick={next} disabled={left > 0 && !animals.trim()}>
                  {left > 0 ? 'I cannot think of any more' : 'Next'}
                </button>
              </>
            )}
          </>
        )}

        {step === 'recall' && (
          <>
            <h2>5. What were the five words?</h2>
            <p>The ones you read at the start, in any order. Leave out any you cannot remember.</p>
            <VoiceComposer
              value={recall}
              onChange={setRecall}
              onSend={next}
              onError={setError}
              placeholder="The words you remember"
            />
            <button className="btn primary" onClick={next}>
              Next
            </button>
          </>
        )}

        {step === 'risks' && info && (
          <>
            <h2>6. Your habits and health</h2>
            <p>
              These are the 14 things the 2024 Lancet Commission found affect dementia risk and can be changed. They do
              not change your scores.
            </p>
            <table className="bc-risks">
              <tbody>
                {info.risks.map((r) => (
                  <tr key={r.id}>
                    <td>{r.question}</td>
                    <td>
                      {(['yes', 'no', 'unsure'] as RiskAnswer[]).map((a) => (
                        <label key={a}>
                          <input
                            type="radio"
                            name={r.id}
                            checked={(risks[r.id] ?? 'no') === a}
                            onChange={() => setRisks({ ...risks, [r.id]: a })}
                          />{' '}
                          {a === 'unsure' ? 'Not sure' : a === 'yes' ? 'Yes' : 'No'}
                        </label>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn primary" onClick={() => void finish()} disabled={busy}>
              {busy ? 'Working out your results…' : 'Show my results'}
            </button>
          </>
        )}

        {step === 'result' && result && s && (
          <>
            <div className={`bc-outcome ${OUTCOME_CLASS[result.outcome.key]}`}>
              <h2>{result.outcome.title}</h2>
              <p>{result.outcome.text}</p>
              {result.outcome.low.length > 0 && (
                <p className="small">Lower than most adults score: {result.outcome.low.join(', ')}.</p>
              )}
              {result.outcome.drops.map((d) => (
                <p key={d} className="small">
                  Compared with your earlier checks: {d}.
                </p>
              ))}
            </div>

            <h3>How you did</h3>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Part</th>
                    <th>Result</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Word recall</td>
                    <td>
                      {s.recall.score} of {s.recall.out_of}
                    </td>
                    <td>
                      {s.recall.remembered.length > 0 && <>Remembered: {s.recall.remembered.join(', ')}. </>}
                      {s.recall.missed.length > 0 && <>Missed: {s.recall.missed.join(', ')}.</>}
                    </td>
                  </tr>
                  <tr>
                    <td>Day and date</td>
                    <td>{s.orientation.score} of 4</td>
                    <td>
                      {Object.entries(s.orientation.right)
                        .map(([k, ok]) => `${k === 'day' ? 'date' : k === 'weekday' ? 'day' : k} ${ok ? '✓' : '✗'}`)
                        .join(' · ')}
                    </td>
                  </tr>
                  <tr>
                    <td>Clock drawing</td>
                    <td>{s.clock ? `${s.clock.score} of 5` : 'Not done'}</td>
                    <td>
                      {s.clock &&
                        Object.entries(s.clock.points)
                          .map(([k, ok]) => `${k} ${ok ? '✓' : '✗'}`)
                          .join(' · ')}
                      {s.clock?.notes && <div className="muted">The model noted: {s.clock.notes}</div>}
                    </td>
                  </tr>
                  <tr>
                    <td>Naming animals</td>
                    <td>{s.fluency.count} in a minute</td>
                    <td>{s.fluency.animals.join(', ')}</td>
                  </tr>
                  <tr>
                    <td>
                      <b>Total</b>
                    </td>
                    <td>
                      <b>
                        {s.total} of {s.total_out_of}
                      </b>
                    </td>
                    <td className="muted">Recall, date and clock. Animals are counted separately.</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {result.earlier.length > 0 && (
              <>
                <h3>Your earlier checks</h3>
                <div className="table-wrap">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Total of 14</th>
                        <th>Words</th>
                        <th>Clock</th>
                        <th>Animals</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...result.earlier.slice(-6)].map((e) => (
                        <tr key={e.date + e.total}>
                          <td>{e.date}</td>
                          <td>{e.total}</td>
                          <td>{e.recall}</td>
                          <td>{e.clock ?? '–'}</td>
                          <td>{e.animals}</td>
                        </tr>
                      ))}
                      <tr>
                        <td>
                          <b>Today</b>
                        </td>
                        <td>
                          <b>{s.total}</b>
                        </td>
                        <td>{s.recall.score}</td>
                        <td>{s.clock?.score ?? '–'}</td>
                        <td>{s.fluency.count}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <h3>Things you can change</h3>
            {result.risks.length === 0 ? (
              <p className="small">None of the 14 risk factors applied from your answers.</p>
            ) : (
              <ul className="bc-advice">
                {result.risks.map((r) => (
                  <li key={r.factor}>
                    <b>{r.factor}.</b> {r.advice} <span className="muted">{r.why}</span>
                  </li>
                ))}
              </ul>
            )}

            <p className="small muted">
              {result.saved
                ? `Saved on this computer. Repeat the check around ${result.next_check}.`
                : 'Not saved. Tick the box at the start next time to compare checks.'}{' '}
              Model calls for this check: ${cost.toFixed(4)}.
            </p>
            <p className="small">
              Have a brain scan from your hospital? The <Link to="/scan-explainer">scan explainer</Link> lets you upload
              a picture of it and ask the AI what it shows, to prepare questions for your doctor.
            </p>
            <div className="bc-actions">
              <button
                className="btn primary"
                onClick={() => void brainService.pdf(checkId).catch((e) => setError(errorText(e)))}
              >
                Download the summary (PDF)
              </button>
              <button className="btn" onClick={() => setStep('intro')}>
                Start again
              </button>
              {(result.saved || result.earlier.length > 0) && (
                <button
                  className="btn"
                  onClick={() =>
                    void brainService
                      .forget(result.user)
                      .then(() => setResult({ ...result, earlier: [], saved: false }))
                      .catch((e) => setError(errorText(e)))
                  }
                >
                  Delete my saved results
                </button>
              )}
            </div>
          </>
        )}
      </section>

      <h2>Who does what</h2>
      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Step</th>
              <th>Done by</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Say what the drawn clock shows: outline, numbers, hands</td>
              <td>The model, as JSON in a fixed schema</td>
              <td>Reading a rough drawing is what image models are good at</td>
            </tr>
            <tr>
              <td>Pick the animals out of what was said</td>
              <td>The model; code keeps only animals found in the person’s own words</td>
              <td>The model knows what an animal is; code stops it adding any</td>
            </tr>
            <tr>
              <td>Score each task</td>
              <td>Code</td>
              <td>The same answer must always get the same score</td>
            </tr>
            <tr>
              <td>Compare with earlier checks and choose the outcome</td>
              <td>Code, from fixed rules; the wording is fixed too</td>
              <td>What a person is told about their memory must not depend on a model’s mood</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">
        The tasks are modelled on the kinds used in memory clinics (word recall, orientation, clock drawing, verbal
        fluency), with this page’s own words and thresholds. The thresholds are illustrative: they have not been
        validated against clinical diagnoses, and software offered to the public for this purpose would need to be
        registered as a medical device.
      </p>
    </main>
  );
}
