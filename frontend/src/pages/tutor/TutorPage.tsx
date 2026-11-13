import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react';
import { useNavHeight } from '@/lib/useNavHeight';
import { statusService, tutorService, type LiveStatus, type TutorConfig, type TutorFeedback } from '@/services';
import { Avatar } from './avatar';
import { captureScreen, prepareImage, type SharedImage } from './images';
import { LineView } from './LineView';
import { tutorPeopleService, type PeopleListing } from '@/services/tutorPeopleService';
import { PeoplePanel } from './PeoplePanel';
import { builtInPeople, madePeople, setPeople, tutorFor } from './people';
import { useTutor, type TutorSettings } from './useTutor';
import './tutor.css';

const DEFAULTS: TutorSettings = {
  subject: 'english',
  subjectName: '',
  level: 'auto',
  scenario: 'chat',
  stage: 'secondary',
  style: 'explain',
  native: '',
  voice: 'en-GB-SoniaNeural',
  rate: 0.95,
  model: '',
  handsFree: false,
  coaching: true,
  interviewBrief: '',
};
const MAX_MESSAGE = 12000; // characters, as the backend accepts
const STAGE_NAMES = { primary: 'Primary (7–11)', secondary: 'Secondary (11–16)', sixth_form: 'Sixth form (16–18)', university: 'University', adult: 'Adult learner' } as const;
const SCENARIO_NAMES = { chat: 'Free chat', interview: 'Job interview', restaurant: 'Restaurant', travel: 'Travel', ielts: 'IELTS speaking', school: 'School life' } as const;
type SavedWord = TutorFeedback['vocabulary'][number];

// Settings and saved words are this browser's own conveniences, so they live in localStorage.
function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function keep(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: nothing is remembered */
  }
}

export default function TutorPage() {
  const navHeight = useNavHeight();
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [config, setConfig] = useState<TutorConfig | null>(null);
  const [settings, setSettings] = useState<TutorSettings>(() => load('tutor.settings', DEFAULTS));
  const [words, setWords] = useState<SavedWord[]>(() => load<{ list: SavedWord[] }>('tutor.words', { list: [] }).list);
  const [loading, setLoading] = useState<number | null>(0); // share of the avatar downloaded; null when ready
  const [avatarProblem, setAvatarProblem] = useState('');
  const [listing, setListing] = useState<PeopleListing | null>(null);
  const [showPeople, setShowPeople] = useState(false);
  const [started, setStarted] = useState(false);
  const [text, setText] = useState('');
  const [images, setImages] = useState<SharedImage[]>([]);
  const [shareProblem, setShareProblem] = useState('');
  const stage = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  const speechReady = !!config?.speech;
  const tutor = useTutor(settings, speechReady);
  const ready = !!(status?.available && status.has_credentials);
  const english = settings.subject === 'english';
  const subjectName = english ? 'English' : settings.subject === 'other' ? settings.subjectName || 'any subject' : (config?.subjects[settings.subject] ?? settings.subject);
  const busy = tutor.status !== 'idle';

  const set = <K extends keyof TutorSettings>(key: K, value: TutorSettings[K]) =>
    setSettings((s) => {
      const next = { ...s, [key]: value };
      keep('tutor.settings', next);
      return next;
    });

  useEffect(() => {
    statusService.status().then((s) => {
      setStatus(s);
      if (!s.available) return;
      setSettings((cur) => (cur.model && s.models?.includes(cur.model) ? cur : { ...cur, model: s.default_model ?? '' }));
      tutorService.config().then(setConfig).catch(() => undefined);
    });
  }, []);

  // Your people (you, colleagues): loaded with the page, and again after each change on the people panel.
  const loadPeople = useCallback(() => {
    tutorPeopleService
      .list()
      .then((l) => {
        setPeople(l.people);
        setListing(l);
      })
      .catch(() => undefined);
  }, []);
  useEffect(loadPeople, [loadPeople]);

  // The avatar loads once, when the page opens, as the person who goes with the chosen voice.
  const person = tutorFor(settings.voice); // the tutor: their name, face and voice
  const who = person.avatar;
  const firstWho = useRef(who);
  useEffect(() => {
    let alive = true;
    let made: Avatar | null = null;
    if (!stage.current) return;
    Avatar.create(stage.current, firstWho.current, (share) => alive && setLoading(share))
      .then((a) => {
        made = a;
        if (!alive) return a.dispose();
        tutor.avatar.current = a;
        setLoading(null);
      })
      .catch((err: Error) =>
        alive && setAvatarProblem(`The avatar could not load: ${err.message}. Is frontend/public/avatars/mpfb.glb there? See README.md.`),
      );
    return () => {
      alive = false;
      made?.dispose();
      tutor.avatar.current = null;
    };
  }, [tutor.avatar]);

  // A voice of the other gender brings the other person, once the first one has loaded.
  useEffect(() => {
    const avatar = tutor.avatar.current;
    if (loading !== null || !avatar || avatar.who === who) return;
    setLoading(0);
    avatar
      .show(who, (share) => setLoading(share))
      .then(() => setLoading(null))
      .catch((err: Error) => setAvatarProblem(`The avatar could not load: ${err.message}. See README.md for the model files.`));
  }, [who, loading, tutor.avatar]);

  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [tutor.lines]);

  async function start() {
    await tutor.avatar.current?.unlockAudio();
    setStarted(true);
    tutor.avatar.current?.gesture('handup');
    if (!speechReady) return;
    tutor.listen();
  }

  /** Speak instead of typing. The first time, this also starts the lesson. Pressed again, it sends what you said. */
  async function speak() {
    if (tutor.status === 'listening') return tutor.finishSpeaking();
    if (!started) {
      await tutor.avatar.current?.unlockAudio();
      setStarted(true);
    }
    void tutor.listen();
  }

  async function send() {
    if (!ready || busy || (!text.trim() && !images.length) || text.length > MAX_MESSAGE) return;
    if (!started) {
      await tutor.avatar.current?.unlockAudio();
      setStarted(true);
    }
    const message = text.trim();
    const shared = images;
    setText('');
    setImages([]);
    await tutor.send(message, { images: shared });
  }

  async function addImages(blobs: Blob[]) {
    setShareProblem('');
    const room = 3 - images.length;
    if (blobs.length > room) setShareProblem('At most three pictures in one message.');
    try {
      const prepared = await Promise.all(blobs.slice(0, room).map(prepareImage));
      setImages((cur) => [...cur, ...prepared].slice(0, 3));
    } catch (err) {
      setShareProblem((err as Error).message);
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = [...e.clipboardData.items].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean) as File[];
    if (pasted.length) {
      e.preventDefault();
      void addImages(pasted);
    }
  }

  function onDrop(e: DragEvent) {
    const dropped = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    if (dropped.length) {
      e.preventDefault();
      void addImages(dropped);
    }
  }

  async function capture() {
    try {
      const shot = await captureScreen();
      setImages((cur) => [...cur, shot].slice(0, 3));
    } catch (err) {
      if ((err as Error).name !== 'NotAllowedError') setShareProblem((err as Error).message);
    }
  }

  function save(word: SavedWord) {
    setWords((cur) => {
      const next = [word, ...cur.filter((w) => w.term !== word.term)].slice(0, 200);
      keep('tutor.words', { list: next });
      return next;
    });
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
  };

  const statusLabel = { idle: started ? 'Your turn' : 'Ready', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking' }[tutor.status];

  return (
    <main className="page-tutor" style={{ '--nav-h': `${navHeight}px` } as CSSProperties}>
      <section className="tu-left">
        <div className="kicker">Lab 21 · Tutor</div>
        <h1>
          {person.name}, your {subjectName} tutor
        </h1>
        <details className="tu-settings" open={!started}>
          <summary className="small">Settings</summary>
          <div className="tu-grid">
            <label>
              Subject
              <select
                value={settings.subject}
                onChange={(e) => {
                  set('subject', e.target.value);
                  tutor.clear(); // a different subject is a different tutor: start a new conversation
                }}
                disabled={busy}
              >
                {Object.entries(config?.subjects ?? { english: 'English' }).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
                <option value="other">Other…</option>
              </select>
            </label>
            {settings.subject === 'other' && (
              <label>
                Which subject?
                <input value={settings.subjectName} maxLength={40} placeholder="Music theory, Spanish, Accounting…" onChange={(e) => set('subjectName', e.target.value.replace(/[^\w ,&()'+.-]/g, ''))} />
              </label>
            )}
            {english ? (
              <>
                <label>
                  Level
                  <select value={settings.level} onChange={(e) => set('level', e.target.value as TutorSettings['level'])}>
                    <option value="auto">Let the tutor judge</option>
                    {(['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const).map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Practise
                  <select value={settings.scenario} onChange={(e) => set('scenario', e.target.value as TutorSettings['scenario'])}>
                    {Object.entries(SCENARIO_NAMES).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                {settings.scenario === 'interview' && (
                  <label className="tu-brief">
                    The job you are interviewing for
                    <textarea
                      rows={3}
                      maxLength={8000}
                      value={settings.interviewBrief}
                      placeholder="Paste the job advert, or describe the role and company, e.g. Principal AI Engineer at a legal software company, document automation for law firms"
                      onChange={(e) => set('interviewBrief', e.target.value)}
                    />
                  </label>
                )}
                <label>
                  Your first language
                  <input value={settings.native} maxLength={40} placeholder="Polish, Urdu, Arabic…" onChange={(e) => set('native', e.target.value.replace(/[^\w ()'-]/g, ''))} />
                </label>
              </>
            ) : (
              <>
                <label>
                  Level
                  <select value={settings.stage} onChange={(e) => set('stage', e.target.value as TutorSettings['stage'])}>
                    {Object.entries(STAGE_NAMES).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Teaching
                  <select value={settings.style} onChange={(e) => set('style', e.target.value as TutorSettings['style'])}>
                    <option value="explain">Explain it fully</option>
                    <option value="hints">Hints first, let me try</option>
                  </select>
                </label>
              </>
            )}
            <label>
              Tutor
              <select value={person.id} onChange={(e) => set('voice', e.target.value)} disabled={busy || loading !== null}>
                <optgroup label="Built in">
                  {builtInPeople().map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </optgroup>
                {madePeople().length > 0 && (
                  <optgroup label="Your people">
                    {madePeople().map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <button className="btn small tu-people-btn" onClick={() => setShowPeople((v) => !v)} disabled={!listing}>
              Your people…
            </button>
            <label>
              Speed {Math.round(settings.rate * 100)}%
              <input type="range" min={0.7} max={1.2} step={0.05} value={settings.rate} onChange={(e) => set('rate', Number(e.target.value))} disabled={!speechReady} />
            </label>
            <label>
              Model
              <select value={settings.model} onChange={(e) => set('model', e.target.value)}>
                {(status?.models ?? []).map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="tu-check">
              <input type="checkbox" checked={settings.handsFree} onChange={(e) => set('handsFree', e.target.checked)} disabled={!speechReady} />
              Hands-free: listen again after each reply
            </label>
            {english && (
              <label className="tu-check">
                <input type="checkbox" checked={settings.coaching} onChange={(e) => set('coaching', e.target.checked)} />
                Coach me after each answer: the tutor says how to make it stronger
              </label>
            )}
          </div>
        </details>
        {showPeople && listing && (
          <PeoplePanel
            listing={listing}
            onChange={loadPeople}
            onUse={(id) => {
              set('voice', id);
              setShowPeople(false);
            }}
            onClose={() => setShowPeople(false)}
          />
        )}

        <div className="tu-stage" ref={stage}>
          {loading !== null && !avatarProblem && <div className="tu-overlay">Loading your tutor… {Math.round(loading * 100)}%</div>}
          {avatarProblem && <div className="tu-overlay tu-problem">{avatarProblem}</div>}
          <span className={`tu-status s-${tutor.status}`}>{statusLabel}</span>
          {(tutor.caption || tutor.heard) && <div className={`tu-caption ${tutor.heard ? 'heard' : ''}`}>{tutor.heard || tutor.caption}</div>}
        </div>

        <div className="row tu-controls">
          {!started ? (
            <button className="btn primary" disabled={!ready || loading !== null} onClick={start}>
              {speechReady ? 'Start the lesson' : 'Start (text only)'}
            </button>
          ) : tutor.status === 'listening' ? (
            <>
              <button className="btn tu-mic on" onClick={tutor.finishSpeaking} title="Send what you have said">
                ✓ Done
              </button>
              <button className="btn" onClick={tutor.stop} title="Stop listening without sending">
                Cancel
              </button>
            </>
          ) : (
            <button className="btn tu-mic" disabled={!speechReady || !ready} onClick={tutor.listen} title="Speak to your tutor">
              🎤 Speak
            </button>
          )}
          {busy && tutor.status !== 'listening' && (
            <button className="btn" onClick={tutor.stop}>
              Stop
            </button>
          )}
          <span className="spacer" />
          <button className="btn small" disabled={busy || !tutor.lines.length} onClick={tutor.clear}>
            New conversation
          </button>
        </div>
        <p className="small muted tu-note">
          {!ready
            ? (status?.reason ?? 'Checking the lab backend…')
            : !speechReady
              ? 'Azure Speech is not set up, so the tutor writes instead of speaking. Add AZURE_SPEECH_KEY and AZURE_SPEECH_REGION to .env and restart the backend.'
              : 'Your voice goes to Azure Speech to be transcribed and scored; the tutor’s words are spoken by Azure.'}
          {tutor.notice && <span> {tutor.notice}</span>}
          {tutor.problem && <span className="tu-problem"> {tutor.problem}</span>}
        </p>
      </section>

      <section className="tu-right card" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <div ref={log} className="tu-log">
          {tutor.lines.length === 0 && (
            <div className="tu-intro small">
              {english ? (
                <p>
                  Talk to your tutor in English about anything. After each thing you say you get corrections, useful words and
                  pronunciation scores, and you can practise any corrected sentence aloud.
                </p>
              ) : (
                <p>
                  Ask about {subjectName}, or paste a screenshot, upload a photo of your homework or capture your screen. Your tutor
                  explains it line by line: a short summary aloud, and the working written out here.
                </p>
              )}
            </div>
          )}
          {tutor.lines.map((line) => (
            <LineView key={line.id} line={line} practise={tutor.practise} hear={tutor.hear} canPractise={speechReady && !busy} onSave={save} />
          ))}
        </div>

        {words.length > 0 && (
          <details className="tu-saved">
            <summary className="small">My words ({words.length})</summary>
            <ul>
              {words.map((w) => (
                <li key={w.term} className="small">
                  <b>{w.term}</b>: {w.meaning}
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="tu-composer">
          {images.length > 0 && (
            <div className="tu-thumbs">
              {images.map((img, i) => (
                <span key={img.url}>
                  <img src={img.url} alt="To send" />
                  <button aria-label="Remove picture" onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {tutor.status === 'listening' && (
            <div className="tu-listening small">
              <span className="tu-dot" aria-hidden="true" /> {tutor.heard || 'Listening… start speaking'}
              <span className="tu-hint">{settings.handsFree ? ' · pause when you have finished' : ' · press ✓ Done when you have finished'}</span>
            </div>
          )}
          <textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
            disabled={!ready}
            placeholder={english ? 'Type to your tutor, or press 🎤 Speak' : 'Ask a question, paste a screenshot (⌘/Ctrl + V), or press 🎤 Speak'}
          />
          <div className="row">
            <button className="btn small" disabled={images.length >= 3} onClick={() => files.current?.click()} title="Upload a picture">
              Add picture
            </button>
            <button className="btn small" disabled={images.length >= 3} onClick={() => camera.current?.click()} title="Take a photo (on a phone or tablet)">
              Photo
            </button>
            {'getDisplayMedia' in (navigator.mediaDevices ?? {}) && (
              <button className="btn small" disabled={images.length >= 3} onClick={capture} title="Capture a window or your screen">
                Capture screen
              </button>
            )}
            <span className="spacer" />
            {text.length > MAX_MESSAGE * 0.8 && (
              <span className={`tu-count ${text.length > MAX_MESSAGE ? 'over' : ''}`}>
                {text.length.toLocaleString('en-GB')} / {MAX_MESSAGE.toLocaleString('en-GB')}
                {text.length > MAX_MESSAGE && ' · too long: shorten it, or send it in parts'}
              </span>
            )}
            {speechReady && (
              <button
                className={`btn tu-speak ${tutor.status === 'listening' ? 'on' : ''}`}
                disabled={!ready || loading !== null || (busy && tutor.status !== 'listening')}
                onClick={() => void speak()}
                title={tutor.status === 'listening' ? 'Send what you have said so far' : 'Speak to your tutor instead of typing'}
              >
                {tutor.status === 'listening' ? '✓ Done' : '🎤 Speak'}
              </button>
            )}
            <button className="btn primary" disabled={!ready || busy || (!text.trim() && !images.length) || text.length > MAX_MESSAGE} onClick={() => void send()}>
              Send
            </button>
          </div>
          {shareProblem && <div className="small tu-problem">{shareProblem}</div>}
          <input ref={files} type="file" accept="image/*" multiple hidden onChange={(e) => (void addImages([...(e.target.files ?? [])]), (e.target.value = ''))} />
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (void addImages([...(e.target.files ?? [])]), (e.target.value = ''))} />
        </div>
      </section>
    </main>
  );
}
