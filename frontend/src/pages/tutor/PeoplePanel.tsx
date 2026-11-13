import { useEffect, useRef, useState } from 'react';
import {
  tutorPeopleService as people,
  type PeopleListing,
  type PersonInput,
  type TutorPersonDto,
} from '@/services/tutorPeopleService';
import { Recorder } from './recorder';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const FACES: Record<string, string> = {
  sonia: 'Sonia’s face',
  ava: 'Ava’s face',
  ryan: 'Ryan’s face',
  custom: 'Uploaded GLB',
};
const STATUS: Record<string, string> = {
  consent: 'Azure is checking the consent recording…',
  voice: 'Azure is making the voice…',
  ready: 'Own voice ready',
  failed: 'Failed',
};

type Take = { wav: Blob; seconds: number; url: string };

/** Records one clip: start, stop, a timer, and the clip to play back. */
function RecordButton({
  label,
  take,
  onTake,
  min,
  max,
  disabled,
}: {
  label: string;
  take: Take | null;
  onTake: (t: Take | null) => void;
  min: number;
  max: number;
  disabled?: boolean;
}) {
  const recorder = useRef<Recorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(() => {
      const s = (Date.now() - (recorder.current?.started ?? Date.now())) / 1000;
      setElapsed(s);
      if (s >= max) void stop();
    }, 200);
    return () => window.clearInterval(t);
  }); // re-armed each render while recording, so stop() sees the current recorder

  useEffect(() => () => recorder.current?.cancel(), []);

  async function start() {
    setProblem('');
    onTake(null);
    try {
      recorder.current = new Recorder();
      await recorder.current.start();
      setElapsed(0);
      setRecording(true);
    } catch (err) {
      setProblem(`The microphone could not start: ${errorText(err)}`);
    }
  }

  async function stop() {
    if (!recorder.current) return;
    setRecording(false);
    try {
      const t = await recorder.current.stop();
      recorder.current = null;
      if (t.seconds < min) setProblem(`That was ${t.seconds.toFixed(0)} s; record at least ${min} s.`);
      onTake(t);
    } catch (err) {
      setProblem(errorText(err));
    }
  }

  return (
    <div className="tp-rec">
      {recording ? (
        <button className="btn danger small" onClick={() => void stop()}>
          ■ Stop ({elapsed.toFixed(0)} s)
        </button>
      ) : (
        <button className="btn small" onClick={() => void start()} disabled={disabled}>
          ● {take ? 'Record again' : label}
        </button>
      )}
      {take && !recording && (
        <>
          <audio src={take.url} controls />
          <span className={`small ${take.seconds < min || take.seconds > max ? 'tp-bad' : 'muted'}`}>
            {take.seconds.toFixed(1)} s
          </span>
        </>
      )}
      {problem && <span className="small tp-bad">{problem}</span>}
    </div>
  );
}

/** Making someone's own voice: their consent in their voice, then a sample. Azure checks the two match. */
function OwnVoice({
  person,
  listing,
  onChange,
}: {
  person: TutorPersonDto;
  listing: PeopleListing;
  onChange: () => void;
}) {
  const [company, setCompany] = useState('');
  const [consent, setConsent] = useState<Take | null>(null);
  const [sample, setSample] = useState<Take | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pv = listing.personal_voice;
  const state = person.personal;
  const working = state?.status === 'consent' || state?.status === 'voice';

  // While Azure works, ask every five seconds; each ask also moves it on to the next step.
  useEffect(() => {
    if (!working) return;
    const t = window.setInterval(() => {
      people
        .refreshVoice(person.id)
        .then(onChange)
        .catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(t);
  }, [working, person.id, onChange]);

  const statement = listing.consent.replace('{name}', person.name).replace('{company}', company.trim() || '[company]');

  async function send() {
    if (!consent || !sample) return;
    setBusy(true);
    setError('');
    try {
      await people.startVoice(person.id, company.trim(), consent.wav, sample.wav);
      onChange();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${person.name}'s own voice at Azure? They will speak with their chosen voice again.`))
      return;
    try {
      await people.removeVoice(person.id);
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (state && state.status !== 'failed') {
    return (
      <div className="tp-own">
        <span className={`tp-chip ${state.status}`}>{STATUS[state.status]}</span>
        {state.status === 'ready' && (
          <>
            <span className="small muted">
              Spoken by {state.base_model} with speaker profile {state.speaker_profile_id?.slice(0, 8)}…
            </span>
            <button className="btn small" onClick={() => void remove()}>
              Delete own voice
            </button>
          </>
        )}
        {error && <p className="small tp-bad">{error}</p>}
      </div>
    );
  }

  return (
    <div className="tp-own">
      {state?.status === 'failed' && <p className="small tp-bad">Last try failed: {state.error}</p>}
      {!pv.ready && (
        <p className="small tp-note">
          <b>Not available yet.</b> {pv.detail}
        </p>
      )}
      <p className="small">
        <b>{person.name}</b> must record both clips themselves: Azure checks that the voice reading the consent is the
        voice in the sample, so nobody’s voice can be copied without them.
      </p>
      <label className="small">
        Company or organisation{' '}
        <input
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          maxLength={80}
          placeholder="e.g. Colibri Digital"
        />
      </label>
      <ol className="tp-steps small">
        <li>
          Read this aloud, word for word:
          <blockquote>{statement}</blockquote>
          <RecordButton
            label="Record consent"
            take={consent}
            onTake={setConsent}
            min={3}
            max={40}
            disabled={!company.trim()}
          />
        </li>
        <li>
          Then read this at a normal pace, in a quiet room (30 to 60 seconds is ideal; 5 to 90 is accepted):
          <blockquote>{listing.sample_text}</blockquote>
          <RecordButton label="Record sample" take={sample} onTake={setSample} min={5} max={90} />
        </li>
      </ol>
      <button
        className="btn primary small"
        disabled={!pv.ready || busy || !consent || !sample || consent.seconds < 3 || sample.seconds < 5}
        onClick={() => void send()}
        title={pv.ready ? '' : pv.detail}
      >
        {busy ? 'Sending…' : 'Send to Azure and make the voice'}
      </button>
      {error && <p className="small tp-bad">{error}</p>}
    </div>
  );
}

const BLANK: PersonInput = { name: '', body: 'F', avatar: 'sonia', voice: 'en-GB-SoniaNeural', locale: 'en-GB' };

/** You and your colleagues as tutors: a name, a face (built in or your own GLB) and a voice (Azure's, or their own). */
export function PeoplePanel({
  listing,
  onChange,
  onUse,
  onClose,
}: {
  listing: PeopleListing;
  onChange: () => void;
  onUse: (personId: string) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<PersonInput>(BLANK);
  const [editing, setEditing] = useState<string | null>(null);
  const [glb, setGlb] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  function edit(p: TutorPersonDto) {
    setEditing(p.id);
    setForm({ name: p.name, body: p.body, avatar: p.avatar, voice: p.voice, locale: p.locale });
    setGlb(null);
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      const wantsUpload = form.avatar === 'custom';
      const base = { ...form, avatar: wantsUpload ? (editing ? form.avatar : 'sonia') : form.avatar };
      let saved = editing
        ? await people.update(editing, wantsUpload && glb ? { ...base, avatar: undefined } : base)
        : await people.create(base);
      if (wantsUpload && glb) saved = await people.uploadAvatar(saved.id, glb);
      else if (wantsUpload && !editing) throw new Error('Choose a .glb file for the uploaded face.');
      setEditing(null);
      setForm(BLANK);
      setGlb(null);
      onChange();
      setOpen(saved.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: TutorPersonDto) {
    if (!window.confirm(`Delete ${p.name}? Their uploaded face, and any own voice at Azure, are deleted too.`)) return;
    try {
      await people.remove(p.id);
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <section className="card tp-panel" aria-label="Your people">
      <div className="tp-head">
        <h2>Your people</h2>
        <button className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="small muted">
        Add yourself and colleagues as tutors. A face can be one of the three built-in people or your own 3D model; a
        voice can be one of Azure’s, or the person’s own voice through Azure personal voice.
      </p>

      {listing.people.length > 0 && (
        <ul className="tp-list">
          {listing.people.map((p) => (
            <li key={p.id}>
              <div className="tp-row">
                <b>{p.name}</b>
                <span className="small muted">
                  {FACES[p.avatar] ?? p.avatar} · {listing.standard_voices[p.voice] ?? p.voice}
                </span>
                {p.personal && <span className={`tp-chip ${p.personal.status}`}>{STATUS[p.personal.status]}</span>}
                <span className="tp-actions">
                  <button className="btn small primary" onClick={() => onUse(`person:${p.id}`)}>
                    Talk to {p.name}
                  </button>
                  <button className="btn small" onClick={() => edit(p)}>
                    Edit
                  </button>
                  <button className="btn small" onClick={() => setOpen(open === p.id ? null : p.id)}>
                    Own voice
                  </button>
                  <button className="btn small" onClick={() => void remove(p)}>
                    Delete
                  </button>
                </span>
              </div>
              {open === p.id && <OwnVoice person={p} listing={listing} onChange={onChange} />}
            </li>
          ))}
        </ul>
      )}

      <div className="tp-form">
        <h3>{editing ? 'Edit person' : 'Add a person'}</h3>
        <div className="tp-fields">
          <label>
            Name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={40}
              placeholder="e.g. Durjan"
            />
          </label>
          <label>
            Face
            <select value={form.avatar} onChange={(e) => setForm({ ...form, avatar: e.target.value })}>
              {Object.keys(listing.built_in_avatars).map((a) => (
                <option key={a} value={a}>
                  {FACES[a] ?? a}
                </option>
              ))}
              <option value="custom">Upload my own (.glb)</option>
            </select>
          </label>
          {form.avatar === 'custom' && (
            <label>
              Model file
              <input
                type="file"
                accept=".glb,model/gltf-binary"
                onChange={(e) => setGlb(e.target.files?.[0] ?? null)}
              />
            </label>
          )}
          <label>
            Body
            <select value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value as 'F' | 'M' })}>
              <option value="F">Feminine poses</option>
              <option value="M">Masculine poses</option>
            </select>
          </label>
          <label>
            Voice
            <select value={form.voice} onChange={(e) => setForm({ ...form, voice: e.target.value })}>
              {Object.entries(listing.standard_voices).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {form.avatar === 'custom' && (
          <p className="small muted">
            The model needs a humanoid rig and the ARKit and Oculus mouth shapes, so the face can move and lip-sync.
            Avaturn makes one from a selfie and exports a GLB with both (choose the “T-pose”, ARKit blendshapes export).
            Check the licence of whatever tool you use.
          </p>
        )}
        <div className="tp-row">
          <button className="btn primary" disabled={busy || !form.name.trim()} onClick={() => void save()}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Add person'}
          </button>
          {editing && (
            <button
              className="btn"
              onClick={() => {
                setEditing(null);
                setForm(BLANK);
              }}
            >
              Cancel
            </button>
          )}
          {error && <span className="small tp-bad">{error}</span>}
        </div>
      </div>
    </section>
  );
}
