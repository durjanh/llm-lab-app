import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { tutorService } from '@/services';
import { voiceAgentService, type LatencyRow, type NormaliseReport, type VoiceInfo } from '@/services/voiceAgentService';
import { base64ToBuffer } from './audio';
import { useVoiceAgent } from './useVoiceAgent';
import './voice-agent.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const ms = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${Math.round(v)} ms`);
const SAMPLE =
  'Your card 4111 1111 1111 1111 expires 03/27. Call 020 7946 0958 or 07700 900123 by 15/03/2025 at 14:30. ' +
  'The balance is £1,234.56, up 12.5%. Order AB12-3456 goes to SW1A 1AA.';

const PHASE: Record<string, string> = {
  off: 'Not listening',
  starting: 'Starting…',
  listening: 'Listening',
  hearing: 'Hearing you',
  thinking: 'Thinking',
  speaking: 'Speaking',
};
const MARKS: { key: keyof LatencyRow; label: string; colour: string }[] = [
  { key: 'final', label: 'transcript final', colour: 'var(--va-c1)' },
  { key: 'end_of_turn', label: 'end of turn', colour: 'var(--va-c2)' },
  { key: 'first_token', label: 'first token', colour: 'var(--va-c3)' },
  { key: 'first_audio_sent', label: 'audio sent', colour: 'var(--va-c4)' },
  { key: 'first_audio_played', label: 'audio played', colour: 'var(--va-c5)' },
];

function Timeline({ row }: { row: LatencyRow }) {
  const max = Math.max(1500, ...MARKS.map((m) => (row[m.key] as number | null) ?? 0)) * 1.05;
  return (
    <div className="va-timeline" title={`Turn ${row.turn}`}>
      <div className="va-axis" />
      {MARKS.map((m) => {
        const v = row[m.key] as number | null;
        return v === null ? null : (
          <span
            key={m.key}
            className="va-mark"
            style={{ left: `${Math.min(99, (v / max) * 100)}%`, background: m.colour }}
            title={`${m.label}: ${ms(v)}`}
          />
        );
      })}
    </div>
  );
}

export default function VoiceAgentPage() {
  const [info, setInfo] = useState<VoiceInfo | null>(null);
  const [speech, setSpeech] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState('');
  const v = useVoiceAgent(info);
  const [text, setText] = useState('');
  const [sample, setSample] = useState(SAMPLE);
  const [report, setReport] = useState<NormaliseReport | null>(null);
  const [reading, setReading] = useState('');
  const [readInfo, setReadInfo] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    voiceAgentService
      .info()
      .then(setInfo)
      .catch((e) => setLoadError(errorText(e)));
    tutorService
      .config()
      .then((c) => setSpeech(c.speech))
      .catch(() => setSpeech(false));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      voiceAgentService
        .normalise(sample)
        .then(setReport)
        .catch(() => setReport(null));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [sample]);

  const s = v.settings;
  const running = v.phase !== 'off';
  const azureOk = info?.tts.azure.available ?? false;
  const localOk = info?.tts.local.installed ?? false;
  const last = v.latency[v.latency.length - 1];
  const wasted = useMemo(() => v.replies.filter((r) => r.status === 'cancelled' && r.speculative).length, [v.replies]);

  const read = async () => {
    if (!s) return;
    setReading('Making the audio…');
    setReadInfo('');
    try {
      const r = await voiceAgentService.speak(
        sample.slice(0, info?.limits.speak ?? 400),
        s.tts,
        s.voice,
        s.local_voice,
        s.expressiveness,
      );
      const url = URL.createObjectURL(new Blob([base64ToBuffer(r.audio)], { type: 'audio/wav' }));
      audio.current?.pause();
      audio.current = new Audio(url);
      await audio.current.play();
      setReadInfo(
        `${r.tts === 'local' ? 'Local voice' : 'Azure neural voice'}: ${r.tts_ms} ms to make ${(r.duration_ms / 1000).toFixed(1)} s of audio.`,
      );
    } catch (e) {
      setReadInfo(errorText(e));
    } finally {
      setReading('');
    }
  };

  return (
    <main className="page-voice-agent">
      <div className="kicker">Agents · Voice</div>
      <h1>Voice agent</h1>
      <p className="lede">
        A voice agent whose parts you can see: it decides when you have finished speaking, starts its reply before you
        have quite stopped, stops the moment you speak over it, remembers what you actually heard, chooses how to sound
        from the conversation and reads numbers the way a person would. Speech comes in through Azure Speech in your
        browser and goes out through an Azure neural voice or a voice running on this machine. Everything between is our
        code. See the <Link to="/tutor">tutor</Link> for the same speech pieces in a language lesson.
      </p>

      {loadError && <p className="va-bad small">{loadError}</p>}

      <section className="card va-bar">
        <div className="va-talk">
          {!running ? (
            <button className="btn primary va-big" onClick={() => void v.start()} disabled={!info || speech === false}>
              Start talking
            </button>
          ) : (
            <button className="btn va-big" onClick={() => void v.stop()}>
              Stop
            </button>
          )}
          {running && v.mode === 'hold' && (
            <button
              className="btn primary va-big"
              onPointerDown={() => v.hold(true)}
              onPointerUp={() => v.hold(false)}
              onPointerLeave={() => v.hold(false)}
            >
              Hold to talk
            </button>
          )}
          <div className="va-state">
            <span className={`va-dot va-${v.phase}`} />
            <b>{PHASE[v.phase]}</b>
            <span className="va-level" aria-hidden>
              <span style={{ width: `${Math.round(v.level * 100)}%` }} />
            </span>
          </div>
          <label className="small">
            <input type="radio" checked={v.mode === 'always'} onChange={() => v.setMode('always')} /> Always listening
          </label>
          <label className="small">
            <input type="radio" checked={v.mode === 'hold'} onChange={() => v.setMode('hold')} /> Hold to talk
          </label>
        </div>
        {speech === false && (
          <p className="small va-bad">
            Azure Speech is not set up for listening (see the tutor page's notes), so you can only type here.
          </p>
        )}
        <p className="small muted">
          Use headphones if you can: the browser cancels echo, but a loud speaker can still make the agent hear itself
          and interrupt itself.
        </p>
        <form
          className="va-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void v.typed(text.trim());
            setText('');
          }}
        >
          <input
            value={text}
            maxLength={info?.limits.text ?? 1000}
            onChange={(e) => setText(e.target.value)}
            placeholder="Or type a turn (no microphone needed)"
          />
          <button className="btn" disabled={!text.trim() || !info}>
            Send
          </button>
        </form>
        {v.error && <p className="va-bad small">{v.error}</p>}
      </section>

      <div className="va-cols">
        <section className="card">
          <h2>Conversation</h2>
          <div className="va-transcript" aria-live="polite">
            {v.lines.length === 0 && !v.partial && <p className="small muted">Nothing said yet.</p>}
            {v.lines.map((l, i) => (
              <p key={i} className={`va-line va-${l.who}`}>
                <b>{l.who === 'you' ? 'You' : 'Agent'}</b> {l.text}
              </p>
            ))}
            {v.partial && (
              <p className="va-line va-you va-partial">
                <b>You</b> {v.partial}…
              </p>
            )}
          </div>
          <h3>Turn events</h3>
          <ul className="va-events">
            {v.turns.slice(-12).map((t) => (
              <li key={t.id} className={`va-ev va-ev-${t.event}`}>
                <span className="mono">{t.event}</span>
                <span className="small muted">
                  turn {t.turn}
                  {t.event !== 'StartOfTurn' && t.event !== 'TurnResumed'
                    ? ` · silence ${Math.round(t.silence_ms)} ms · sounds ${Math.round(t.completeness * 100)}% finished`
                    : ''}
                </span>
              </li>
            ))}
            {v.turns.length === 0 && <li className="small muted">Events appear here as you speak.</li>}
          </ul>
          {wasted > 0 && (
            <p className="small muted">
              {wasted} speculative {wasted === 1 ? 'reply was' : 'replies were'} thrown away because you kept talking.
              Nothing was spoken, but the model and voice were still paid for.
            </p>
          )}
        </section>

        <section className="card">
          <h2>Time to first audio</h2>
          <p className="small">
            Median <b>{ms(v.stats.median_ms)}</b> · p95 <b>{ms(v.stats.p95_ms)}</b> over {v.stats.turns}{' '}
            {v.stats.turns === 1 ? 'turn' : 'turns'}, from the end of your speech.
          </p>
          {last && (
            <>
              <Timeline row={last} />
              <div className="va-legend small">
                {MARKS.map((m) => (
                  <span key={m.key}>
                    <i style={{ background: m.colour }} />
                    {m.label} {ms(last[m.key] as number | null)}
                  </span>
                ))}
              </div>
              <p className="small muted">
                Last turn:{' '}
                {last.speculative_used
                  ? 'the reply started on the eager end and was reused.'
                  : 'the reply started when the turn ended.'}
              </p>
            </>
          )}
          <div className="table-wrap">
            <table className="t small">
              <thead>
                <tr>
                  <th>Turn</th>
                  <th>Final</th>
                  <th>End</th>
                  <th>Token</th>
                  <th>Audio sent</th>
                  <th>Played</th>
                  <th>Early</th>
                </tr>
              </thead>
              <tbody>
                {v.latency.map((r) => (
                  <tr key={r.turn}>
                    <td>{r.turn}</td>
                    <td>{ms(r.final)}</td>
                    <td>{ms(r.end_of_turn)}</td>
                    <td>{ms(r.first_token)}</td>
                    <td>{ms(r.first_audio_sent)}</td>
                    <td>{ms(r.first_audio_played)}</td>
                    <td>{r.speculative_used ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            What these numbers are: milliseconds after your voice detector decided you had stopped, measured on this
            server and in this browser, on this network, with whichever model and voice are chosen. The end of turn
            waits for your silence setting, so a turn that ends on a quiet pause includes that wait; a reply that
            started on an eager end hides most of the model's time behind it. Your own figures will differ.
          </p>
        </section>
      </div>

      <section className="card">
        <h2>Replies and delivery</h2>
        <p className="small">
          Each reply starts with a style tag from the model. Rules read your words too, and win when you sound upset or
          worried. The plan becomes speech markup for the voice.
        </p>
        <ul className="va-replies">
          {v.replies
            .filter((r) => !r.speculative || r.status !== 'cancelled')
            .slice(-6)
            .map((r) => (
              <li key={r.id} className={`va-reply va-${r.status}`}>
                <div className="va-reply-head">
                  <b>Turn {r.turn}</b>
                  <span className="mono small">{r.id}</span>
                  <span className="small muted">
                    {r.speculative ? 'held (speculative)' : r.status}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </span>
                </div>
                {r.plan && (
                  <div className="small">
                    <span className="va-tag">{r.plan.tag}</span> model said{' '}
                    <span className="mono">{r.modelTag ?? 'nothing'}</span>, used by {r.plan.source}. Rate {r.plan.rate}
                    %, pitch {r.plan.pitch}%, pause {r.plan.pause_ms} ms
                    {r.plan.style
                      ? `, style ${r.plan.style} (${r.plan.degree})`
                      : ', no speaking style (this voice has none that fits, or expressiveness is off)'}
                    . <span className="muted">{r.plan.reason}</span>
                  </div>
                )}
                {r.sentences.map((x) => (
                  <div key={x.index} className="small va-sentence">
                    {x.text}
                    {x.spokenAs && x.spokenAs !== x.text && <div className="muted">spoken as: {x.spokenAs}</div>}
                    {x.ttsMs !== undefined && (
                      <span className="muted">
                        {' '}
                        · voice {x.ttsMs} ms for {((x.durationMs ?? 0) / 1000).toFixed(1)} s
                      </span>
                    )}
                  </div>
                ))}
                {r.error && <div className="va-bad small">{r.error}</div>}
              </li>
            ))}
          {v.replies.length === 0 && <li className="small muted">Replies appear here.</li>}
        </ul>
      </section>

      <section className="card">
        <h2>Barge-in log: heard and not heard</h2>
        <p className="small">
          When you speak over the agent, playback stops at once and the page reports how many milliseconds of audio it
          really played. The server maps that back to words and keeps both parts in the history, so the next reply knows
          what you did hear. The voice gives no word timings here, so inside the sentence that was playing the split is
          an estimate by word length.
        </p>
        {v.bargeIns.length === 0 && (
          <p className="small muted">Interrupt the agent while it speaks, and the split appears here.</p>
        )}
        {v.bargeIns.map((b) => (
          <div key={b.id} className="va-barge">
            <div className="small muted">
              {b.reply} · played {b.playedMs === null ? 'unknown' : `${b.playedMs} ms`} · {b.method}
              {b.cut ? ' · the model was still writing' : ''}
            </div>
            <div>
              <span className="va-heard">{b.spoken || '(nothing heard)'}</span>{' '}
              <span className="va-unheard">{b.notSpoken || '(nothing left)'}</span>
            </div>
          </div>
        ))}
        {v.history.length > 0 && (
          <details>
            <summary className="small">What the server remembers ({v.history.length} messages)</summary>
            <ul className="small">
              {v.history.map((h, i) => (
                <li key={i}>
                  <b>{h.role}</b>: {h.text}
                  {h.interrupted && <span className="va-unheard"> [heard only: {h.spoken || 'nothing'}]</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="card">
        <h2>Settings</h2>
        {s && info ? (
          <div className="va-settings">
            <label>
              End-of-turn silence: <b>{s.end_silence_ms} ms</b>
              <input
                type="range"
                min={200}
                max={3000}
                step={50}
                value={s.end_silence_ms}
                onChange={(e) => void v.changeSettings({ end_silence_ms: Number(e.target.value) })}
              />
              <span className="small muted">
                A sentence that sounds finished ends the turn in about half this; one that trails off waits 1.6 times as
                long.
              </span>
            </label>
            <label>
              Eager threshold: <b>{s.eager_threshold.toFixed(2)}</b>
              <input
                type="range"
                min={0.3}
                max={0.95}
                step={0.05}
                value={s.eager_threshold}
                onChange={(e) => void v.changeSettings({ eager_threshold: Number(e.target.value) })}
              />
              <span className="small muted">
                How finished the words must sound before the reply starts early. Lower is faster and throws more away.
              </span>
            </label>
            <label>
              Expressiveness: <b>{['Off', 'Light', 'Medium', 'Strong'][s.expressiveness]}</b>
              <input
                type="range"
                min={0}
                max={3}
                step={1}
                value={s.expressiveness}
                onChange={(e) => void v.changeSettings({ expressiveness: Number(e.target.value) })}
              />
            </label>
            <div>
              Voice engine
              <div className="va-row">
                <label className="small">
                  <input
                    type="radio"
                    checked={s.tts === 'azure'}
                    disabled={!azureOk}
                    onChange={() => void v.changeSettings({ tts: 'azure' })}
                  />{' '}
                  Azure neural voice
                </label>
                <label className="small">
                  <input
                    type="radio"
                    checked={s.tts === 'local'}
                    disabled={!localOk}
                    onChange={() => void v.changeSettings({ tts: 'local' })}
                  />{' '}
                  Local (Kokoro, on this machine)
                </label>
              </div>
              {!azureOk && <span className="small va-bad">{info.tts.azure.reason}</span>}
              {!localOk && <span className="small muted">{info.tts.local.reason}</span>}
            </div>
            <label>
              Voice
              {s.tts === 'azure' ? (
                <select value={s.voice} onChange={(e) => void v.changeSettings({ voice: e.target.value })}>
                  {info.voices.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name} ({x.id.slice(0, 5)}, {x.styles.length} styles)
                    </option>
                  ))}
                </select>
              ) : (
                <select value={s.local_voice} onChange={(e) => void v.changeSettings({ local_voice: e.target.value })}>
                  {info.local_voices.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              )}
            </label>
            <label>
              Model
              <select value={s.model} onChange={(e) => void v.changeSettings({ model: e.target.value })}>
                {info.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <p className="small muted">Loading…</p>
        )}
        <p className="small muted">
          Costs, charged to the server's budget: the model by tokens, Azure voice by characters ($
          {info?.prices.tts_per_1m_chars ?? 15} per million), listening by audio time (${info?.prices.stt_per_hour ?? 1}{' '}
          an hour). The local voice costs nothing.
        </p>
      </section>

      <section className="card">
        <h2>Numbers read correctly</h2>
        <p className="small">
          A voice left alone reads "4111 1111 1111 1111" as a number or guesses. Code rewrites card numbers, phone
          numbers, dates, times, money, postcodes, references and percentages as words first, so every voice says the
          same thing. Edit the text, then play it.
        </p>
        <textarea
          rows={3}
          value={sample}
          maxLength={(info?.limits.speak ?? 400) * 2}
          onChange={(e) => setSample(e.target.value)}
        />
        <div className="va-row">
          <button className="btn primary" onClick={() => void read()} disabled={!!reading || !s || !info}>
            {reading || 'Read this fast'}
          </button>
          <span className="small muted">{readInfo || `Reads the first ${info?.limits.speak ?? 400} characters.`}</span>
        </div>
        {report && (
          <div className="va-norm">
            <div>
              <h3>Before</h3>
              <p>
                {report.segments.map((g, i) =>
                  g.kind === 'text' ? (
                    <span key={i}>{g.before}</span>
                  ) : (
                    <mark key={i} title={g.kind}>
                      {g.before}
                    </mark>
                  ),
                )}
              </p>
            </div>
            <div>
              <h3>After</h3>
              <p>
                {report.segments.map((g, i) =>
                  g.kind === 'text' ? (
                    <span key={i}>{g.after}</span>
                  ) : (
                    <mark key={i} title={g.kind}>
                      {g.after}
                    </mark>
                  ),
                )}
              </p>
            </div>
          </div>
        )}
      </section>

      <section className="card va-explain">
        <h2>How it is built</h2>
        <h3>Turn-taking</h3>
        <p className="small">
          Azure Speech in your browser streams partial and final text. A small state machine on the server (
          <span className="mono">voice_turns.py</span>) watches voice activity, the silence since the last word and a
          text check of whether the sentence sounds finished. It raises <b>StartOfTurn</b>,<b> EagerEndOfTurn</b>{' '}
          (probably done: start the reply now), <b>TurnResumed</b> (they carried on: throw the reply away, nothing was
          spoken) and <b>EndOfTurn</b>. A sentence that ends on "and" or "the" waits longer; "What time do you open?"
          ends quickly. The recogniser's late repeat of words it already gave us is ignored, so it cannot fake a resume.
        </p>
        <h3>Low time to first audio</h3>
        <p className="small">
          On the eager end the model starts at once, but its audio is held back. If the turn ends on the same words, the
          held audio is released with no wait. The reply streams in; the first clause is cut at a comma and sent to the
          voice while the model is still writing, and the page plays pieces as they arrive. Numbers and references are
          rewritten first, so the voice never has to guess.
        </p>
        <h3>Barge-in</h3>
        <p className="small">
          A voice detector on the microphone, behind the browser's echo cancellation, stops playback in the same frame
          it hears you. The player counts the audio it really played. The server cancels the model stream and synthesis
          (both threads stop on one flag, and nothing more is sent), and turns the milliseconds into words. Azure's REST
          voice and the local voice give audio only, so inside the sentence that was playing the split is proportional;
          with word timings it would be exact.
        </p>
        <h3>Delivery</h3>
        <p className="small">
          The model starts each reply with a tag such as [calm], in the same call that writes the words, so there is no
          extra round trip. Rules read your words (upset, worried, pleased, a short factual question) and override a
          cheerful tag for an upset caller. The last mood is kept for the conversation, so calm carries into the next
          turn. A plan is a rate, a pitch, a pause and, where the voice has one, a speaking style, written as speech
          markup. Expressiveness scales all of it; off is the plain voice. The local voice only takes a speed.
        </p>
        <h3>Memory</h3>
        <p className="small">
          The history lives on the server, per conversation, including what you heard after each interruption. The next
          model call sees an interrupted reply as the words you heard, then a marker and the words you did not.
        </p>
        <h3>Compared with a hosted conversation-native voice</h3>
        <p className="small">
          A hosted conversation-native service such as Deepgram Flux TTS does turn-taking and expressive speech inside
          its models. Here they are separate parts you can read and change: a recogniser, a turn rule, a language model,
          a planner and a voice. That costs some latency and loses what a model that listens and speaks in one pass can
          do, such as laughing at the right moment or carrying a mood inside a sentence; in return every decision is
          visible, testable and swappable, and the voice can run on your own machine.
        </p>
      </section>
    </main>
  );
}
