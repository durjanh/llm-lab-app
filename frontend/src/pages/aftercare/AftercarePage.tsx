import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  aftercareService,
  type AftercareInfo,
  type AftercareStep,
  type Board,
  type Engine,
  type AftercareEvalEvent,
  type HospitalRecord,
  type PhoneInfo,
  type PhoneState,
  type StartResult,
  type TurnResult,
  statusService,
  tutorService,
} from '@/services';
import { ReplyPlayer } from '@/lib/replyPlayer';
import { Speech } from '@/pages/tutor/speech';
import './aftercare.css';

const CLAUDE_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
const MAX_AUTO_TURNS = 16;
// Azure neural voices: the agent and the simulated patient sound like two different people.
const VOICES = {
  en: { agent: 'en-GB-SoniaNeural', patient: 'en-GB-RyanNeural', listen: 'en-GB' },
  es: { agent: 'es-ES-ElviraNeural', patient: 'es-ES-AlvaroNeural', listen: 'es-ES' },
} as const;
type Lang = keyof typeof VOICES;

const VOICE_TIMEOUT_MS = 20_000;
const NOTHING_HEARD_MS = 8000;

interface Line {
  from: 'agent' | 'patient';
  text: string;
  steps?: AftercareStep[];
  cost?: number;
  simulated?: boolean;
}

interface EvalPatient {
  id: string;
  name: string;
  wave: number;
  channel: string;
  lines: Line[];
  checks?: { check: string; passed: boolean }[];
  status?: string;
  turns?: number;
  cost?: number;
}

interface EvalSummary {
  engine: Engine;
  model: string;
  passed: number;
  total: number;
  cost: number;
}

const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const tick = (ok: boolean) => (ok ? '✓' : '✗');
const said = (s: string) => s.replace(/_/g, ' ');

/** One step in plain words, as the care team's activity log might put it. Refusals are the rules in code at work. */
function describe(step: AftercareStep): { label: string; tone: '' | 'ok' | 'stop' | 'alert' } {
  const a = step.args;
  const r = step.result;
  if (r.error) return { label: `${step.tool} refused: ${String(r.error)}`, tone: 'stop' };
  const raised = r.raised as { queue: string; urgency: string } | undefined;
  const task = raised ? ` → ${raised.urgency} task for the ${raised.queue}` : '';
  switch (step.tool) {
    case 'verify_identity':
      if (r.verified) return { label: 'Identity confirmed by date of birth', tone: 'ok' };
      return r.locked
        ? { label: 'Identity not confirmed after three tries: call locked', tone: 'stop' }
        : { label: 'Date of birth did not match the record', tone: 'stop' };
    case 'get_discharge_plan':
      return { label: 'Read the discharge plan (the first time the agent learns anything clinical)', tone: '' };
    case 'record_medication':
      return {
        label: `Recorded ${String(a.medication)}: ${said(String(a.status))}${task}`,
        tone: raised ? 'alert' : 'ok',
      };
    case 'record_symptoms': {
      const signs = (a.warning_signs as string[]) ?? [];
      return {
        label: signs.length ? `Warning signs: ${signs.map(said).join(', ')} → escalated by rule` : 'No warning signs',
        tone: signs.length ? 'alert' : 'ok',
      };
    }
    case 'find_follow_up': {
      const n = Array.isArray(r.slots) ? r.slots.length : 0;
      return { label: `Found ${n} free slot${n === 1 ? '' : 's'} at ${String(r.clinic ?? 'the clinic')}`, tone: '' };
    }
    case 'book_follow_up':
      return {
        label: `Booked ${String(r.clinic)}, ${String(r.when)} ${String(r.mode)}, and texted a confirmation`,
        tone: 'ok',
      };
    case 'decline_follow_up':
      return { label: 'Follow-up declined → nurse to call', tone: 'alert' };
    case 'record_barrier':
      return a.kind === 'none'
        ? { label: 'No barriers to recovery', tone: 'ok' }
        : { label: `Barrier: ${said(String(a.kind))}${task}`, tone: 'alert' };
    case 'record_since_discharge':
      return {
        label: `Since discharge: follow-up ${String(a.attended_follow_up)}, ${String(a.emergency_visits)} A&E visit(s), readmitted ${a.readmitted ? 'yes' : 'no'}`,
        tone: Number(a.emergency_visits) || a.readmitted ? 'alert' : 'ok',
      };
    case 'flag_for_nurse':
      return { label: `Flagged for a nurse (${String(a.urgency)}): ${String(a.reason)}`, tone: 'alert' };
    case 'finish_outreach':
      return { label: `Call finished: ${said(String(r.status))}. Note written to the record.`, tone: 'ok' };
    default:
      return { label: step.tool, tone: '' };
  }
}

function Steps({ steps }: { steps: AftercareStep[] }) {
  if (!steps.length) return null;
  return (
    <ul className="ac-steps">
      {steps.map((step, j) => {
        const d = describe(step);
        return (
          <li key={j} className={d.tone}>
            <details>
              <summary>{d.label}</summary>
              <pre>{JSON.stringify({ arguments: step.args, result: step.result }, null, 2)}</pre>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

function Bubbles({ lines, who }: { lines: Line[]; who: string }) {
  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className={`ac-msg ${line.from}`}>
          <div className="ac-from">
            {line.from === 'agent' ? 'Aftercare agent' : who}
            {line.simulated && <span className="ac-sim"> simulated</span>}
          </div>
          {line.steps && <Steps steps={line.steps} />}
          {line.text ? <div className="ac-bubble">{line.text}</div> : <div className="ac-bubble empty">(no reply)</div>}
          {line.cost !== undefined && <div className="ac-cost">{usd(line.cost)}</div>}
        </div>
      ))}
    </>
  );
}

export default function AftercarePage() {
  const [info, setInfo] = useState<AftercareInfo | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [engine, setEngine] = useState<Engine>('claude');
  const [models, setModels] = useState(CLAUDE_MODELS);
  const [model, setModel] = useState(CLAUDE_MODELS[0]);
  const [patientId, setPatientId] = useState('');
  const [call, setCall] = useState<StartResult | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [record, setRecord] = useState<HospitalRecord | null>(null);
  const [items, setItems] = useState<string[]>([]);
  const [left, setLeft] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState('');
  const [spent, setSpent] = useState(0);
  const [evalRun, setEvalRun] = useState<{ running: boolean; patients: EvalPatient[]; error: string }>({
    running: false,
    patients: [],
    error: '',
  });
  const [summaries, setSummaries] = useState<EvalSummary[]>([]);
  const autoRef = useRef(false);
  const callRef = useRef('');
  const scroller = useRef<HTMLDivElement>(null);
  const evalAbort = useRef<AbortController | null>(null);
  const [speechReady, setSpeechReady] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [phoneInfo, setPhoneInfo] = useState<PhoneInfo | null>(null);
  const [phone, setPhone] = useState<PhoneState | null>(null); // a real call to your phone, while it lasts
  const onPhone = phone !== null && (phone.state === 'ringing' || phone.state === 'talking');
  const speech = useRef<Speech | null>(null);
  const player = useRef(new ReplyPlayer());
  const interrupted = useRef(false); // the person started talking, so the rest of this reply is not read out
  const [blocked, setBlocked] = useState<ArrayBuffer | null>(null);
  const voiceRef = useRef(false);
  const langRef = useRef<Lang>('en');
  voiceRef.current = voiceOn;

  useEffect(() => {
    aftercareService
      .info()
      .then((i) => {
        setInfo(i);
        setBoard({ worklist: i.worklist, queue: i.queue });
      })
      .catch((e: Error) => setError(e.message));
    statusService.status().then((s) => {
      if (!s.models?.length) return;
      setModels(s.models); // the local model first, when one is configured
      setModel(s.default_model ?? s.models[0]);
    });
    aftercareService
      .phoneInfo()
      .then(setPhoneInfo)
      .catch(() => setPhoneInfo(null));
    tutorService
      .config()
      .then((c) => setSpeechReady(c.speech))
      .catch(() => setSpeechReady(false));
    return () => {
      autoRef.current = false;
      player.current.stop();
      speech.current?.stopListening(false);
      evalAbort.current?.abort();
      if (callRef.current) void aftercareService.end(callRef.current).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [lines, busy]);

  // A real call is held on your phone: follow its transcript and record here until it ends.
  useEffect(() => {
    if (!onPhone || !call) return;
    const timer = window.setInterval(() => {
      aftercareService
        .phoneStatus(call.call_id)
        .then((s) => {
          setPhone(s.phone);
          setRecord(s.record);
          setLines(s.record.transcript.map((t) => ({ from: t.speaker, text: t.text })));
          if (s.phone.state === 'ended' || s.phone.state === 'failed') void refreshBoard();
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [onPhone, call]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Rings your own phone: the agent holds the follow-up call there, and this page shows it as it goes. */
  async function ringPhone(id: string) {
    setError('');
    setBusy(true);
    setPatientId(id);
    setLines([]);
    setRecord(null);
    try {
      if (callRef.current) await aftercareService.end(callRef.current).catch(() => undefined);
      const started = await aftercareService.phoneCall(id, engine, engine === 'claude' ? model : undefined);
      callRef.current = started.call_id;
      voiceRef.current = false; // your phone speaks, not the page
      setVoiceOn(false);
      setCall(started);
      setPhone(started.phone);
      setItems(started.checklist_left);
      setLines([{ from: 'agent', text: started.reply, steps: started.steps, cost: started.cost_usd }]);
      take(started);
      void refreshBoard();
      document.getElementById('ac-call')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const refreshBoard = () =>
    aftercareService
      .board()
      .then(setBoard)
      .catch(() => undefined);

  /** Reads a line aloud in the call's language and waits until it has been heard. No voice: returns at once. */
  async function say(text: string, who: 'agent' | 'patient') {
    if (!voiceRef.current || !text.trim() || interrupted.current) return;
    setSpeaking(true);
    try {
      speech.current ??= new Speech();
      const spoken = await Promise.race([
        speech.current.synthesize(text, VOICES[langRef.current][who], 1),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Azure Speech took too long to answer.')), VOICE_TIMEOUT_MS),
        ),
      ]);
      if (interrupted.current) return;
      const result = await player.current.play(spoken.audio);
      if (result === 'blocked') setBlocked(spoken.audio);
      if (result === 'failed')
        setError('Voice: the audio did not play to the end. Check your speakers and the volume for this tab.');
    } catch (e) {
      setError(`Voice: ${(e as Error).message}`);
    } finally {
      setSpeaking(false);
    }
  }

  /** Plays a reply the browser refused, from inside this click. */
  function playBlocked() {
    if (!blocked) return;
    const audio = blocked;
    setBlocked(null);
    player.current.unlock();
    void player.current.play(audio).then((result) => {
      if (result === 'blocked')
        setError('Voice: this browser is still refusing sound. Allow audio for this site in its settings.');
    });
  }

  /** The microphone, in the call's language. A pause ends the patient's turn, and what was heard is sent. */
  async function talk() {
    if (listening) {
      speech.current?.stopListening(true);
      return;
    }
    setError('');
    setBlocked(null);
    player.current.unlock();
    interrupted.current = true; // talking over the agent stops it, as on a real call
    player.current.stop();
    setListening(true);
    let heardSomething = false;
    const silent = setTimeout(() => {
      if (!heardSomething)
        setError('Microphone: nothing heard yet. Check the input device and that this site may use the microphone.');
    }, NOTHING_HEARD_MS);
    try {
      speech.current ??= new Speech();
      const heard = await speech.current.listen({
        language: VOICES[langRef.current].listen,
        endOnPause: true,
        onPartial: (text) => {
          if (text.trim()) {
            heardSomething = true;
            setError('');
          }
          setDraft(text);
        },
      });
      setListening(false);
      setDraft('');
      if (heard.text.trim()) await turn(false, heard.text.trim());
      else setError('Microphone: nothing was heard. Check the input device, then press Speak and try again.');
    } catch (e) {
      setError(`Microphone: ${(e as Error).message}`);
    } finally {
      clearTimeout(silent);
      setListening(false);
    }
  }

  function take(r: TurnResult) {
    setRecord(r.record);
    setLeft(r.checklist_left);
    setDone(r.done);
    setSpent(r.spent_usd);
  }

  async function startCall(id: string) {
    player.current.unlock(); // inside the click: the first reply can take many seconds to arrive
    interrupted.current = false;
    setBlocked(null);
    autoRef.current = false;
    setAuto(false);
    setError('');
    setBusy(true);
    setPatientId(id);
    setLines([]);
    setRecord(null);
    try {
      if (callRef.current) await aftercareService.end(callRef.current).catch(() => undefined);
      const started = await aftercareService.start(id, engine, engine === 'claude' ? model : undefined);
      callRef.current = started.call_id;
      langRef.current = started.record.outreach[0]?.language === 'es' ? 'es' : 'en';
      voiceRef.current = speechReady && started.channel === 'voice'; // a phone call is spoken; texts are not
      setVoiceOn(voiceRef.current);
      setCall(started);
      setItems(started.checklist_left);
      setLines([{ from: 'agent', text: started.reply, steps: started.steps, cost: started.cost_usd }]);
      take(started);
      void refreshBoard();
      document.getElementById('ac-call')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      await say(started.reply, 'agent');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function turn(simulate: boolean, text = ''): Promise<boolean> {
    if (!call) return false;
    player.current.unlock();
    interrupted.current = false;
    setBlocked(null);
    setBusy(true);
    setError('');
    if (!simulate) setLines((ls) => [...ls, { from: 'patient', text }]);
    try {
      const r = simulate
        ? await aftercareService.simulate(call.call_id)
        : await aftercareService.send(call.call_id, text);
      setLines((ls) => [
        ...ls,
        ...(simulate ? [{ from: 'patient' as const, text: r.patient ?? '', simulated: true }] : []),
        { from: 'agent', text: r.reply, steps: r.steps, cost: r.cost_usd },
      ]);
      take(r);
      if (r.done) void refreshBoard();
      if (simulate) await say(r.patient ?? '', 'patient');
      await say(r.reply, 'agent');
      return !r.done && !!r.reply.trim();
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function playToEnd() {
    autoRef.current = true;
    setAuto(true);
    for (let i = 0; i < MAX_AUTO_TURNS && autoRef.current; i++) {
      if (!(await turn(true))) break;
    }
    autoRef.current = false;
    setAuto(false);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy || done) return;
    setDraft('');
    void turn(false, text);
  }

  async function hangUp() {
    autoRef.current = false;
    player.current.stop();
    speech.current?.stopListening(false);
    if (callRef.current) await aftercareService.end(callRef.current).catch(() => undefined);
    callRef.current = '';
    setCall(null);
    void refreshBoard();
  }

  async function closeTask(id: number) {
    try {
      setBoard(await aftercareService.closeTask(id, 'Called the patient back'));
      if (patientId) setRecord(await aftercareService.record(patientId));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function reset() {
    await hangUp();
    setLines([]);
    setRecord(null);
    setPatientId('');
    try {
      setBoard(await aftercareService.reset());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function runEvaluation() {
    evalAbort.current?.abort();
    const abort = new AbortController();
    evalAbort.current = abort;
    setEvalRun({ running: true, patients: [], error: '' });
    const patch = (id: string, change: (p: EvalPatient) => EvalPatient) =>
      setEvalRun((s) => ({ ...s, patients: s.patients.map((p) => (p.id === id ? change(p) : p)) }));
    try {
      await aftercareService.evaluate(
        { engine, model: engine === 'claude' ? model : undefined },
        (e: AftercareEvalEvent) => {
          if (e.type === 'patient')
            setEvalRun((s) => ({
              ...s,
              patients: [
                ...s.patients,
                { id: e.patient_id, name: e.name, wave: e.wave, channel: e.channel, lines: [] },
              ],
            }));
          else if (e.type === 'turn')
            patch(e.patient_id, (p) => ({
              ...p,
              lines: [...p.lines, { from: e.speaker, text: e.text, steps: e.steps }],
            }));
          else if (e.type === 'result')
            patch(e.patient_id, (p) => ({
              ...p,
              checks: e.checks,
              status: e.status,
              turns: e.turns,
              cost: e.cost_usd,
            }));
          else if (e.type === 'done') {
            setSpent(e.spent_usd);
            setSummaries((s) => [
              ...s.filter((x) => !(x.engine === e.engine && x.model === e.model)),
              { engine: e.engine, model: e.model, passed: e.passed, total: e.total, cost: e.cost_usd },
            ]);
          } else if (e.type === 'error') setEvalRun((s) => ({ ...s, error: e.message }));
        },
        abort.signal,
      );
    } catch (e) {
      if (!abort.signal.aborted) setEvalRun((s) => ({ ...s, error: (e as Error).message }));
    } finally {
      setEvalRun((s) => ({ ...s, running: false }));
    }
  }

  const af = info?.engines['agent-framework'];
  const engineName = engine === 'claude' ? `Claude (${model})` : `Agent Framework (${af?.model ?? 'not configured'})`;
  const current = record?.outreach[0];
  const callTasks = record && current ? record.tasks.filter((t) => t.outreach_id === current.id) : [];
  const planRead = lines.some((l) => l.steps?.some((s) => s.tool === 'get_discharge_plan' && !s.result.error));
  const who = record?.patient.name.split(' ')[0] ?? 'Patient';
  const hint = patientId ? info?.hints[patientId] : '';

  return (
    <main className="page-aftercare">
      <div className="kicker">Lab 37 · Post-discharge follow-up agent</div>
      <h1>An agent that calls patients after they leave hospital</h1>
      <p className="lede">
        Many readmissions start in the days after discharge: a prescription never collected, a warning sign nobody asked
        about, a follow-up never booked. Here an agent contacts each discharged patient twice, a few days after they go
        home and again near day 30. It checks their medicines, asks about warning signs, books a follow-up, and writes
        every answer back to the hospital record. When something is wrong, a person is brought in. The model holds the
        conversation. Code holds the rules, and the same rules run under both engines: Claude with our own tool loop,
        and Microsoft Agent Framework on a Foundry model.
      </p>

      <div className="ac-stack small">
        <span>
          <b>Hospital</b> {info?.hospital ?? '…'} (invented, with a dummy record)
        </span>
        <span className="ac-engine">
          <b>Engine</b>
          <label>
            <input type="radio" checked={engine === 'claude'} onChange={() => setEngine('claude')} /> Claude
          </label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={engine !== 'claude'}
            aria-label="Model for our own loop"
          >
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <label title={af?.available ? '' : 'Set FOUNDRY_PROJECT_ENDPOINT and FOUNDRY_MODEL in .env, then restart'}>
            <input
              type="radio"
              checked={engine === 'agent-framework'}
              onChange={() => setEngine('agent-framework')}
              disabled={!af?.available}
            />{' '}
            Agent Framework{af?.model ? ` (${af.model})` : ' (not configured)'}
          </label>
        </span>
        <span>
          <b>Spent this session</b> {usd(spent)}
        </span>
      </div>
      {error && !call && <p className="ac-bad small">{error}</p>}

      <h2>The worklist</h2>
      <p className="small muted">
        Everyone discharged recently, highest risk first. Risk is the LACE index, computed from the record. The wave is
        set by days since discharge. Patients aged {info?.voice_from_age ?? 70} or over are called; younger patients get
        texts. Start a call, then type as the patient, or let a simulated patient answer.
      </p>
      <div className="ac-table-wrap">
        <table className="ac-table">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Discharged with</th>
              <th>Risk (LACE)</th>
              <th>Due</th>
              <th>Contact</th>
              <th>Status</th>
              <th>Open tasks</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(board?.worklist ?? []).map((w) => (
              <tr key={w.id} className={w.id === patientId ? 'on' : ''}>
                <td>
                  <b>{w.name}</b>
                  <span className="small muted"> {w.age}</span>
                </td>
                <td className="small">{w.diagnosis}</td>
                <td>
                  <span
                    className={`ac-risk ${w.risk.band}`}
                    title={`L ${w.risk.parts.L} + A ${w.risk.parts.A} + C ${w.risk.parts.C} + E ${w.risk.parts.E}`}
                  >
                    {w.risk.score} {w.risk.band}
                  </span>
                </td>
                <td className="small">
                  Wave {w.wave_due}
                  <span className="muted"> · day {w.days_since}</span>
                </td>
                <td className="small">
                  {w.channel === 'voice' ? 'Phone call' : 'Text'} · {w.language}
                </td>
                <td className="small">{said(w.status)}</td>
                <td>
                  {(['emergency', 'urgent', 'routine'] as const).map((u) =>
                    w.open_tasks[u] ? (
                      <span key={u} className={`ac-tag ${u}`}>
                        {w.open_tasks[u]} {u}
                      </span>
                    ) : null,
                  )}
                </td>
                <td>
                  <button className="btn" onClick={() => void startCall(w.id)} disabled={busy || auto || onPhone}>
                    Start call
                  </button>
                  {w.channel === 'voice' && phoneInfo?.configured && (
                    <button
                      className="btn"
                      onClick={() => void ringPhone(w.id)}
                      disabled={busy || auto || onPhone}
                      title={`The agent rings your phone (${phoneInfo.to}) and holds this call there`}
                    >
                      Ring my phone
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(call || lines.length > 0) && (
        <div className="ac-layout" id="ac-call">
          <section className="ac-phone" aria-label="The follow-up call">
            <header className="ac-bar">
              <div>
                <b>{record?.patient.name ?? '…'}</b>
                <span className="small muted">
                  {' '}
                  · wave {call?.wave ?? current?.wave} ·{' '}
                  {(call?.channel ?? record?.patient.channel) === 'voice' ? 'phone call' : 'text messages'} ·{' '}
                  {record?.patient.language}
                </span>
              </div>
              <span className="ac-bar-right small muted">
                {speechReady && (
                  <label title="Read the replies aloud, and answer with the microphone">
                    <input type="checkbox" checked={voiceOn} onChange={(e) => setVoiceOn(e.target.checked)} /> Voice
                  </label>
                )}
                {call ? engineName.replace(/\(.*\)/, '').trim() : ''}
              </span>
            </header>
            {hint && (
              <p className="ac-hint small">
                <b>If you play the patient:</b> {hint}
              </p>
            )}
            <div className="ac-messages" ref={scroller}>
              {phone && (
                <div className={`ac-typing small${phone.state === 'failed' ? ' ac-error' : ''}`}>
                  On your phone ({phone.to}):{' '}
                  {
                    {
                      ringing: 'ringing…',
                      talking: 'talking. The transcript appears here as you speak.',
                      ended: 'the call has ended.',
                      failed: 'the call failed.',
                    }[phone.state]
                  }
                  {phone.note && ` ${phone.note}`}
                </div>
              )}
              <Bubbles lines={lines} who={who} />
              {busy && !speaking && <div className="ac-typing small muted">The agent is working…</div>}
              {speaking && <div className="ac-typing small muted">Speaking… press Speak to talk over it.</div>}
              {blocked && (
                <div className="ac-typing small">
                  Your browser blocked the sound.{' '}
                  <button type="button" className="btn small" onClick={playBlocked}>
                    Play the reply
                  </button>
                </div>
              )}
              {listening && <div className="ac-typing small">Listening… pause when you have finished.</div>}
              {done && <div className="ac-ended small">The call has finished and the note is in the record.</div>}
            </div>
            {error && <p className="ac-bad small ac-call-error">{error}</p>}
            <form className="ac-input" onSubmit={onSubmit}>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={done ? 'The call has finished' : `Reply as ${who}…`}
                disabled={!call || busy || done || auto || onPhone}
                maxLength={1000}
                aria-label="Your reply as the patient"
              />
              {voiceOn && (
                <button
                  type="button"
                  className={`btn${listening ? ' primary' : ''}`}
                  onClick={() => void talk()}
                  disabled={!call || (busy && !listening && !speaking) || done || auto}
                  aria-pressed={listening}
                >
                  {listening ? 'Done' : 'Speak'}
                </button>
              )}
              <button
                type="submit"
                className="btn primary"
                disabled={!call || busy || done || auto || onPhone || !draft.trim() || listening}
              >
                Send
              </button>
            </form>
            <div className="ac-actions">
              <button
                className="btn"
                onClick={() => void turn(true)}
                disabled={!call || busy || done || auto || onPhone}
              >
                Let the patient answer
              </button>
              {auto ? (
                <button className="btn" onClick={() => (autoRef.current = false)}>
                  Stop
                </button>
              ) : (
                <button className="btn" onClick={() => void playToEnd()} disabled={!call || busy || done || onPhone}>
                  Play to the end
                </button>
              )}
              <button className="btn" onClick={() => void hangUp()} disabled={!call || busy || onPhone}>
                Hang up
              </button>
              {call && (
                <span className="small muted">This call {usd(lines.reduce((s, l) => s + (l.cost ?? 0), 0))}</span>
              )}
            </div>
          </section>

          <aside className="ac-record" aria-label="The hospital record">
            <h2>Written to the record</h2>
            {record && (
              <>
                <div className="ac-card">
                  <h3>What the agent knows</h3>
                  <p className="small">
                    {planRead ? (
                      <>The discharge plan: diagnosis, medicines to check, warning signs and the follow-up needed.</>
                    ) : (
                      <>
                        Only the first name <b>{who}</b>, the wave and the channel. Nothing clinical reaches the model
                        until the date of birth matches.
                      </>
                    )}
                  </p>
                </div>
                <div className="ac-card">
                  <h3>Checklist (kept in code)</h3>
                  <ul className="ac-checklist">
                    {items.map((item) => (
                      <li key={item} className={left.includes(item) ? '' : 'done'}>
                        {left.includes(item) ? '○' : '✓'} {item}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="ac-card">
                  <h3>Tasks raised on this call</h3>
                  {callTasks.length === 0 && <p className="small muted">None yet.</p>}
                  <ul className="ac-tasks">
                    {callTasks.map((t) => (
                      <li key={t.id}>
                        <span className={`ac-tag ${t.urgency}`}>{t.urgency}</span> <b>{t.queue}</b>{' '}
                        <span className="small muted">
                          by{' '}
                          {t.source === 'screen'
                            ? 'the emergency-word screen'
                            : t.source === 'agent'
                              ? 'the agent'
                              : 'a rule'}
                        </span>
                        <div className="small">{t.reason}</div>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="ac-card">
                  <h3>Answers recorded</h3>
                  {record.checks.length === 0 && <p className="small muted">None yet.</p>}
                  <table className="ac-mini">
                    <tbody>
                      {record.checks.map((c, i) => (
                        <tr key={i}>
                          <td>{said(c.item)}</td>
                          <td>{c.subject}</td>
                          <td>
                            <b>{said(c.value)}</b>
                            {c.detail && <div className="small muted">{c.detail}</div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="ac-card">
                  <h3>Appointments and texts</h3>
                  {record.appointments.length === 0 && <p className="small muted">No follow-up booked.</p>}
                  <ul className="ac-list small">
                    {record.appointments.map((a) => (
                      <li key={a.id}>
                        <b>{a.when}</b> · {a.clinic} · {said(a.mode)}
                      </li>
                    ))}
                  </ul>
                  {record.texts.map((t, i) => (
                    <div key={i} className="ac-sms small">
                      {t.body}
                    </div>
                  ))}
                </div>
                {current?.summary && (
                  <div className="ac-card">
                    <h3>Closing note · {said(current.status)}</h3>
                    <p className="small">{current.summary}</p>
                  </div>
                )}
                <details className="ac-card">
                  <summary>
                    <b>Audit log</b> <span className="small muted">({record.audit.length})</span>
                  </summary>
                  <ul className="ac-audit small">
                    {record.audit.map((a, i) => (
                      <li key={i}>
                        <span className="mono">{a.at.slice(11, 19)}</span> {a.actor} <b>{a.action}</b> {a.detail}
                      </li>
                    ))}
                  </ul>
                </details>
              </>
            )}
          </aside>
        </div>
      )}

      <h2>The care team's queue</h2>
      <p className="small muted">
        Every task the calls raised, most urgent first. The agent never closes the loop on its own: a nurse, pharmacist
        or care navigator does.
      </p>
      {board && board.queue.length === 0 && <p className="small muted">Nothing open.</p>}
      <ul className="ac-queue">
        {(board?.queue ?? []).map((t) => (
          <li key={t.id}>
            <span className={`ac-tag ${t.urgency}`}>{t.urgency}</span>
            <div>
              <b>{t.name}</b> · {t.queue}
              <span className="small muted"> · {t.created_at.slice(11, 16)}</span>
              <div className="small">{t.reason}</div>
            </div>
            <button className="btn" onClick={() => void closeTask(t.id)}>
              Done
            </button>
          </li>
        ))}
      </ul>
      <p>
        <button className="btn" onClick={() => void reset()} disabled={busy || auto}>
          Reset the hospital record
        </button>
      </p>

      <h2>Test it on eight scripted patients</h2>
      <p>
        Each scripted patient has a story and a set of checks. A simulated patient (Claude Haiku) plays the story, and
        code checks what the call left in the record. It never asks a model whether the call went well. The stories
        cover the easy case and the ones that matter: a medicine never collected, a stopped medicine still taken, chest
        pain mid-call, a patient who only speaks Spanish, no transport, a day-30 call, a neighbour answering the phone,
        and a patient asking to stop their steroids early.
      </p>
      <div className="ac-run">
        <button className="btn primary" onClick={() => void runEvaluation()} disabled={evalRun.running || busy || auto}>
          {evalRun.running ? 'Running…' : `Run all eight on ${engineName}`}
        </button>
        {evalRun.running && (
          <button className="btn" onClick={() => evalAbort.current?.abort()}>
            Stop
          </button>
        )}
        <span className="small muted">
          About $0.03 on Claude Haiku and $0.10 on gpt-5.4-mini, simulated patient included, and two to four minutes. It
          uses its own copy of the record.
        </span>
      </div>
      {evalRun.error && <p className="ac-bad small">{evalRun.error}</p>}
      {summaries.length > 0 && (
        <table className="ac-table ac-summary">
          <thead>
            <tr>
              <th>Engine</th>
              <th>Model</th>
              <th>Checks passed</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((s) => (
              <tr key={s.engine + s.model}>
                <td>{s.engine === 'claude' ? 'Claude, our tool loop' : 'Agent Framework, its tool loop'}</td>
                <td className="mono small">{s.model}</td>
                <td>
                  <b>
                    {s.passed} of {s.total}
                  </b>
                </td>
                <td>{usd(s.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {evalRun.patients.length > 0 && (
        <div className="ac-evals">
          {evalRun.patients.map((p) => (
            <details
              key={p.id}
              className={`ac-eval ${p.checks ? (p.checks.every((c) => c.passed) ? 'pass' : 'fail') : ''}`}
            >
              <summary>
                <b>{p.name}</b>
                <span className="small muted">
                  {' '}
                  · wave {p.wave} · {p.channel === 'voice' ? 'phone' : 'text'}
                  {p.status && ` · ${said(p.status)}`}
                  {p.turns !== undefined && ` · ${p.turns} replies`}
                  {p.cost !== undefined && ` · ${usd(p.cost)}`}
                </span>
                <span className="ac-checks">
                  {p.checks
                    ? p.checks.map((c) => (
                        <span key={c.check} className={c.passed ? 'ok' : 'bad'}>
                          {tick(c.passed)} {c.check}
                        </span>
                      ))
                    : 'in progress…'}
                </span>
              </summary>
              <div className="ac-messages ac-transcript">
                <Bubbles lines={p.lines} who={p.name.split(' ')[0]} />
              </div>
            </details>
          ))}
        </div>
      )}

      <h2>How it works</h2>
      <div className="grid2">
        <div className="card">
          <h3>The model holds the conversation</h3>
          <p>
            It decides what to ask next, how to phrase it for a text or a call, which language to use, and which tool to
            call. Its instructions describe a good call. But a prompt is a request, and a model does not always follow
            it.
          </p>
        </div>
        <div className="card">
          <h3>Code holds the rules</h3>
          <p>
            Every tool runs in <code>examples/aftercare/ward.py</code>, against the record. The tools decide what the
            agent may see, what counts as an answer, who is told about a warning sign and how fast, and when a call may
            end. The same file serves both engines, so the rules hold whichever loop calls them.
          </p>
        </div>
      </div>
      <table className="ac-table ac-rules">
        <thead>
          <tr>
            <th>Rule, in code</th>
            <th>What it stops</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              Nothing clinical reaches the model until the date of birth matches; three wrong answers lock the call.
            </td>
            <td>
              Telling a neighbour, carer or wrong number about someone's stay. The model cannot leak what it was never
              given.
            </td>
          </tr>
          <tr>
            <td>
              Every patient message is screened for emergency words in English and Spanish before the model sees it. A
              phrase in a negative clause is skipped ("no chest pain"); a new clause is not ("No, I've got chest pain").
            </td>
            <td>
              A missed emergency. A match raises an alert, and every reply after it carries the 999 line, whatever the
              model wrote.
            </td>
          </tr>
          <tr>
            <td>Warning signs map to a level in the record (emergency or urgent); the tool raises the task.</td>
            <td>The model downgrading a warning sign, or reassuring instead of escalating.</td>
          </tr>
          <tr>
            <td>Every recorded answer must quote the patient's latest message, and the quote is checked against it.</td>
            <td>
              Made-up answers. In testing, gpt-5.4-mini recorded "0 A&E visits" without asking, and "unsure" before the
              patient replied.
            </td>
          </tr>
          <tr>
            <td>
              The checklist lives in code; the call cannot finish while an item is missing, unless the patient ended it.
            </td>
            <td>Calls that end before medicines, warning signs, follow-up and barriers are covered.</td>
          </tr>
          <tr>
            <td>The closing note must be in English, whatever language the call was in.</td>
            <td>
              A Spanish note the care team cannot read. In testing, gpt-5.4-mini wrote one despite the instructions.
            </td>
          </tr>
          <tr>
            <td>The clinic comes from the discharge plan; a slot is booked only after the patient has seen it.</td>
            <td>Booking the wrong clinic, or a time the patient never chose.</td>
          </tr>
          <tr>
            <td>Tools run one at a time on each call.</td>
            <td>
              Agent Framework runs parallel tool calls at the same moment. Two writes to the same database connection
              failed until this lock was added; our own Claude loop runs them in order.
            </td>
          </tr>
        </tbody>
      </table>

      <h3>Two engines, one set of tools</h3>
      <div className="grid2">
        <div className="card">
          <h3>Claude, with our own loop</h3>
          <p>
            <code>ward.claude_turn</code> sends a Messages API request with the instructions and eleven tools, runs each{' '}
            <code>tool_use</code> block against the call, sends back the <code>tool_result</code>, and repeats until
            Claude answers in words. The instructions and tools are cached, so each round pays full price only for what
            is new. A whole call costs about $0.003 on Haiku.
          </p>
        </div>
        <div className="card">
          <h3>Microsoft Agent Framework</h3>
          <p>
            An <code>Agent</code> on <code>FoundryChatClient</code> (the Responses API on your Foundry project) gets the
            same instructions and the same tools, as Python functions with the same JSON schemas.{' '}
            <code>agent.run()</code> does the loop. Our code no longer sees each round, so every rule has to live inside
            the tools: that is the point of keeping them there.
          </p>
        </div>
      </div>

      <h3>Risk and routing</h3>
      <p>
        <b>LACE</b> (van Walraven and others, 2010) scores the risk of death or readmission within 30 days from four
        things in the record: <b>L</b>ength of stay (0 to 7), <b>A</b>cute (emergency) admission (3), <b>C</b>omorbidity
        by the Charlson index (0 to 5), and <b>E</b>mergency department visits in the previous six months (0 to 4). Ten
        or more is high risk. The worklist puts high-risk patients first. Routing is a rule too: age{' '}
        {info?.voice_from_age ?? 70} and over gets a call, everyone else a text, and each patient's language comes from
        the record.
      </p>

      <h3>Voice and Spanish</h3>
      <p>
        A phone call is spoken. The page reads each reply aloud with Azure Speech, in a British English or Castilian
        Spanish neural voice, and <b>Speak</b> listens through the microphone until the patient pauses. A simulated
        patient speaks with a second voice, so <b>Play to the end</b> on a phone call sounds like the call. The agent
        writes for the channel: short plain texts for messages, spoken sentences with no lists or symbols for calls.
        Spanish takes no separate agent: the instructions say to use the patient's language, and <i>usted</i> in
        Spanish. Code checks the two places a second language goes wrong. The emergency screen knows Spanish phrases,
        and the note for the care team must be in English. Here the agent and the speech run separately: speech-to-text,
        then the agent, then text-to-speech. That keeps the rules and the record the same for both channels. A real
        phone line would add telephony (such as Azure Communication Services) and a little delay, but it would not
        change the rules.
      </p>

      <h3>Where a real record system plugs in</h3>
      <p>
        Here the record is SQLite. In a hospital the same writes go to the electronic health record through its FHIR
        API, or through an integration layer such as a robotic process automation bot where there is no API. Each write
        here already has the shape of a FHIR resource:
      </p>
      <table className="ac-table">
        <thead>
          <tr>
            <th>Written here</th>
            <th>FHIR R4 resource</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Tasks for the nurse, pharmacist or care navigator</td>
            <td>
              <code>Task</code> (owner, priority: stat, urgent, routine)
            </td>
          </tr>
          <tr>
            <td>Medicine answers</td>
            <td>
              <code>MedicationStatement</code>
            </td>
          </tr>
          <tr>
            <td>Warning signs, barriers, since discharge</td>
            <td>
              <code>QuestionnaireResponse</code> or <code>Observation</code>
            </td>
          </tr>
          <tr>
            <td>Follow-up booking and the confirmation text</td>
            <td>
              <code>Appointment</code> and <code>Communication</code>
            </td>
          </tr>
          <tr>
            <td>The closing note and transcript</td>
            <td>
              <code>DocumentReference</code> or <code>Communication</code>
            </td>
          </tr>
          <tr>
            <td>The audit log</td>
            <td>
              <code>AuditEvent</code>
            </td>
          </tr>
        </tbody>
      </table>

      <h2>What to take away</h2>
      <ul>
        <li>
          The checklist, the escalation levels and the identity gate are the product. The conversation is the easy part,
          and either engine does it well.
        </li>
        <li>
          Test what the call left in the record, not what the agent said. A call that sounds kind but leaves no task for
          an unpicked-up prescription has failed.
        </li>
        <li>
          Different models fail differently. Haiku and gpt-5.4-mini both passed every check once the rules were in code;
          before that, gpt-5.4-mini made up answers and wrote a Spanish note, and Haiku recorded a medicine before
          asking. Read the transcripts, not only the score. In this run gpt-5.4-mini also cost about four times as much.
        </li>
        <li>
          A framework that runs the loop for you moves the rules into the tools, and runs tools in parallel. Plan for
          both.
        </li>
        <li>No marketing number applies here: this measures whether the calls are done right, not readmissions.</li>
      </ul>

      <h2>Run it yourself</h2>
      <pre className="ac-code">
        {`cd examples/aftercare
python aftercare.py chat --patient P103      # Claude, our loop, in Spanish
python aftercare.py test                     # the eight scripted patients
python aftercare_af.py test                  # the same, on Microsoft Agent Framework (az login)
python aftercare.py queue                    # the care team's open tasks`}
      </pre>
    </main>
  );
}
