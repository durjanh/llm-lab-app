import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { documentsService, tutorService, type Answers, type ProposedAnswer, type TemplateField } from '@/services';
import { Speech, type Spoken } from '@/pages/tutor/speech';

interface Message {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  shown?: string; // while the reply is being read aloud: the words said so far
  spoken?: boolean;
  files?: string[]; // the documents attached to it
  voiced?: boolean; // its audio was made, so it can be played again
}

interface Props {
  templateId: string;
  title: string;
  fields: TemplateField[];
  answers: Answers;
  model: string;
  disabled: boolean;
  sampleNotes: string; // notes to try it with, put in the box by the Sample notes button
  onAnswers: (answers: ProposedAnswer[]) => void;
  onCost: (cost: number) => void;
}

const VOICE = 'en-GB-SoniaNeural';

/**
 * Fill the interview from one box: type, speak, paste notes or attach documents, such as "the client is
 * Brightwater Logistics and we start on 3 November" or a client's email. Send uses whatever is there.
 * Claude fills the fields it gives, says what it filled, and asks for the next missing one.
 * Speaking uses Azure Speech, as in the tutor: speech types into the box, then press Stop and Send.
 */
export function TalkToFill({ templateId, title, fields, answers, model, disabled, sampleNotes, onAnswers, onCost }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState('');
  const [dictated, setDictated] = useState(false); // the box holds speech, so the message is marked as spoken
  const [problem, setProblem] = useState('');
  const [speechReady, setSpeechReady] = useState(false);
  const [readAloud, setReadAloud] = useState(true);
  const speech = useRef(new Speech());
  const player = useRef<HTMLAudioElement | null>(null); // the reply being read aloud
  const voices = useRef(new Map<number, { url: string; spoken: Spoken }>()); // each reply's audio, to play again
  const log = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    tutorService.config().then((c) => setSpeechReady(c.speech)).catch(() => setSpeechReady(false));
    const made = voices.current;
    return () => {
      speech.current.stopListening(false);
      player.current?.pause();
      for (const v of made.values()) URL.revokeObjectURL(v.url);
    };
  }, []);

  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [messages]);

  // Keep the latest words in view while dictating, however long it gets.
  useEffect(() => {
    if (listening && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [listening, heard]);

  // A new template is a new interview, opened with its first question. No AI is needed for that.
  useEffect(() => {
    const first = fields.find((f) => f.required && f.type !== 'boolean') ?? fields[0];
    const opening = `Let's fill in “${title}”. You can tell me several details at once.${first ? ` To start: ${first.question}` : ''}`;
    setMessages([{ id: nextId.current++, role: 'assistant', text: opening }]);
    setFiles([]);
  }, [templateId]); // only when a new template loads

  const update = (id: number, change: Partial<Message>) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...change } : m)));

  /** Shows a reply; read aloud, its words appear in the bubble as they are spoken. */
  async function reply(text: string) {
    const id = nextId.current++;
    const aloud = readAloud && speechReady;
    setMessages((ms) => [...ms, { id, role: 'assistant', text, shown: aloud ? '' : undefined }]);
    if (!aloud) return;
    // Making the audio takes a few seconds for a long reply. If it takes too long, show the reply
    // in full rather than keep the bubble waiting.
    const slow = new Promise<never>((_, fail) => window.setTimeout(() => fail(new Error('slow')), 8000));
    try {
      const spoken = await Promise.race([speech.current.synthesize(text, VOICE, 1), slow]);
      voices.current.set(id, { url: URL.createObjectURL(new Blob([spoken.audio], { type: 'audio/wav' })), spoken });
      update(id, { voiced: true });
      await play(id, text);
    } catch {
      update(id, { shown: undefined }); // no voice: show the whole reply
    }
  }

  /**
   * Plays a reply's audio through an audio element, made new each time, so it follows the computer's
   * current speakers or headphones. The bubble shows the words up to where the audio has reached,
   * so the text keeps pace with what is heard. Sound the browser blocks shows the reply in full.
   */
  async function play(id: number, text: string) {
    const voice = voices.current.get(id);
    if (!voice) return;
    player.current?.pause(); // one voice at a time
    const el = new Audio(voice.url);
    player.current = el;
    // Where each spoken word ends in the text, so the bubble shows everything up to it, punctuation included.
    let cursor = 0;
    const ends = voice.spoken.words.map((word) => {
      const at = text.indexOf(word, cursor);
      cursor = at >= 0 ? at + word.length : cursor;
      return cursor;
    });
    const done = () => update(id, { shown: undefined });
    const follow = () => {
      if (player.current !== el || el.paused || el.ended) return done();
      const ms = el.currentTime * 1000;
      const said = voice.spoken.wtimes.filter((t) => t <= ms).length;
      update(id, { shown: said ? text.slice(0, ends[said - 1]) : '' });
      requestAnimationFrame(follow);
    };
    el.onended = done;
    update(id, { shown: '' });
    try {
      await el.play();
      requestAnimationFrame(follow);
    } catch {
      done();
      setProblem('The browser blocked the sound. Press 🔊 on a reply to hear it.');
    }
  }

  /** Sends what is in the box and any attached documents, together, as one message. */
  async function send(message: string, spoken = false) {
    const clean = message.trim();
    const attached = files;
    if ((!clean && !attached.length) || busy) return;
    // Earlier messages name their documents; their contents have already filled the form.
    const history = messages.map(({ role, text: t, files: f }) => ({ role, text: [t, ...(f ?? []).map((n) => `[attached ${n}]`)].filter(Boolean).join('\n') }));
    setMessages((m) => [...m, { id: nextId.current++, role: 'user', text: clean, spoken, files: attached.map((f) => f.name) }]);
    setText('');
    setFiles([]);
    setDictated(false);
    setBusy(true);
    setProblem('');
    try {
      const r = await documentsService.chat(templateId, clean, attached, answers, history, model);
      onAnswers(r.answers);
      onCost(r.cost);
      void reply(r.reply);
    } catch (err) {
      setProblem((err as Error).message);
      setFiles(attached); // to try again
    } finally {
      setBusy(false);
    }
  }

  async function attachSample() {
    try {
      const sample = await documentsService.sample('intake-email.txt');
      setFiles((cur) => [...cur.filter((f) => f.name !== sample.name), sample].slice(0, 5));
    } catch (err) {
      setProblem((err as Error).message);
    }
  }

  /** Dictation: speech types into the box. Stopping leaves it there to correct, and Send sends it. */
  async function speak() {
    if (listening) {
      speech.current.stopListening(true); // stop: keep what was heard in the box
      return;
    }
    setProblem('');
    setHeard('');
    setListening(true);
    try {
      player.current?.pause(); // don't talk over the person speaking
      const result = await speech.current.listen({ onPartial: setHeard });
      if (result.text) {
        setText((cur) => (cur.trim() ? `${cur.trim()} ` : '') + result.text);
        setDictated(true);
        window.setTimeout(() => box.current?.focus(), 0); // ready to correct, then Send
      } else setProblem('Nothing was heard. Press Speak and try again.');
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setListening(false);
      setHeard('');
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(text, dictated);
    }
  };

  return (
    <div className="dc-talk">
      <b>Fill it in</b>
      <p className="small muted">
        Type, speak, paste notes or attach the client's documents, then Send. For example “the client is Brightwater
        Logistics, we start on 3 November, fixed fee of £4,500”, or an email with the details. Claude fills what it finds,
        with the words each answer came from, and asks for the rest. Speech appears in the box so you can correct it first.
      </p>
      <div ref={log} className="dc-chat">
        {messages.map((m) => (
          <div key={m.id} className={`dc-msg ${m.role} ${m.shown !== undefined ? 'speaking' : ''}`}>
            {m.spoken && '🎤 '}
            {m.shown === undefined ? m.text : m.shown || <span className="muted">🔊 Getting the voice ready…</span>}
            {m.voiced && m.shown === undefined && (
              <button className="dc-replay" title="Hear it again" aria-label="Hear it again" onClick={() => void play(m.id, m.text)}>
                🔊
              </button>
            )}
            {m.files?.map((name) => (
              <div key={name} className="dc-attached">📎 {name}</div>
            ))}
          </div>
        ))}
        {busy && <div className="dc-msg assistant small muted">Filling in…</div>}
      </div>
      <div className="row dc-attach">
        <button className="btn small" disabled={disabled || busy} onClick={() => fileInput.current?.click()} title="PDF, Word, email or text">
          📎 Add documents
        </button>
        <button className="btn small" disabled={disabled || busy} onClick={() => void attachSample()}>
          Sample intake email
        </button>
        <button className="btn small" disabled={disabled || busy || listening} onClick={() => (setText(sampleNotes), setDictated(false))}>
          Sample notes
        </button>
        {files.map((f, i) => (
          <span key={`${f.name}-${i}`} className="dc-chip">
            {f.name}
            <button aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>
              ×
            </button>
          </span>
        ))}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md,.eml"
          hidden
          onChange={(e) => {
            // Copy the chosen files before clearing the picker (so the same file can be picked again):
            // React may run the update later, when the picker's list is already empty.
            const chosen = [...(e.target.files ?? [])];
            e.target.value = '';
            setFiles((cur) => [...cur, ...chosen].slice(0, 5));
          }}
        />
      </div>
      <div className="dc-talk-input">
        {/* Speech types into the box as it is heard, after anything already typed, so it can be corrected before sending. */}
        <textarea
          ref={box}
          rows={2}
          className={listening ? 'dc-dictating' : ''}
          value={listening ? [text.trim(), heard].filter(Boolean).join(' ') : text}
          readOnly={listening}
          aria-live={listening ? 'polite' : undefined}
          placeholder={listening ? 'Listening… start speaking, then press Stop' : 'Type, paste notes or press Speak, then Send'}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        {speechReady && (
          <button
            className={`btn ${listening ? 'dc-on' : ''}`}
            disabled={disabled || busy}
            onClick={() => void speak()}
            title={listening ? 'Stop, and check the text before sending' : 'Speak instead of typing'}
          >
            {listening ? '■ Stop' : '🎤 Speak'}
          </button>
        )}
        <button className="btn primary" disabled={disabled || busy || listening || (!text.trim() && !files.length)} onClick={() => void send(text, dictated)}>
          Send
        </button>
      </div>
      {speechReady && (
        <label className="small dc-aloud">
          <input type="checkbox" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} /> Read replies aloud
        </label>
      )}
      {problem && <div className="small dc-problem">{problem}</div>}
    </div>
  );
}
