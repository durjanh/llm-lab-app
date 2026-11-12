import { useEffect, useRef, useState } from 'react';
import {
  videoTranslateService,
  type VideoEvent,
  type VideoInfo,
  type VideoResult,
  type VideoUpload,
} from '@/services/videoTranslateService';
import { SpeechTrack, toVtt } from './speech';
import './video-translate.css';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

type Sound = 'original' | 'translated' | 'both';

const SOUNDS: { id: Sound; label: string }[] = [
  { id: 'original', label: 'Original sound' },
  { id: 'translated', label: 'Translated speech' },
  { id: 'both', label: 'Both (original quieter)' },
];

/** Video translation: upload a video, see subtitles in your language, or hear it spoken in your language. */
export default function VideoTranslatePage() {
  const video = useRef<HTMLVideoElement>(null);
  const track = useRef<SpeechTrack | null>(null);
  const abort = useRef<AbortController | null>(null);
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [upload, setUpload] = useState<VideoUpload | null>(null);
  const [language, setLanguage] = useState('en');
  const [sound, setSound] = useState<Sound>('original');
  const [subtitles, setSubtitles] = useState(true);
  const [showOriginal, setShowOriginal] = useState(false);
  const [result, setResult] = useState<VideoResult | null>(null);
  const [step, setStep] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cost, setCost] = useState(0);
  const [now, setNow] = useState(0);
  const [over, setOver] = useState(false);

  useEffect(() => {
    videoTranslateService
      .info()
      .then(setInfo)
      .catch((err) => setError(errorText(err)));
    return () => {
      abort.current?.abort();
      track.current?.stop();
    };
  }, []);

  // The caption follows the video's clock, a few times a second.
  useEffect(() => {
    let frame = 0;
    const tick = () => {
      if (video.current) setNow(video.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  // The sound: the video's own, the translated speech, or both.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.muted = sound === 'translated';
    v.volume = sound === 'both' ? 0.2 : 1;
    track.current?.setVolume(sound === 'original' ? 0 : 1);
  }, [sound, result]);

  async function choose(file: File | undefined) {
    if (!file || busy) return;
    setError('');
    if (info && file.size > info.max_mb * 2 ** 20) {
      setError(`Videos up to ${info.max_mb} MB, please.`);
      return;
    }
    abort.current?.abort();
    track.current?.stop();
    track.current = null;
    setResult(null);
    setUpload(null);
    setBusy(true);
    setStep('Uploading the video to this computer…');
    try {
      const up = await videoTranslateService.upload(file);
      setUpload(up);
      setStep('');
      await run(up, language, sound !== 'original');
    } catch (err) {
      setError(errorText(err));
      setStep('');
    } finally {
      setBusy(false);
    }
  }

  async function run(up: VideoUpload, code: string, voice: boolean) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    setProgress(null);
    let failed = '';
    let done: VideoResult | null = null;
    try {
      await videoTranslateService.translate(
        up.id,
        code,
        voice,
        (e: VideoEvent) => {
          if (e.type === 'step') {
            setStep(e.text);
            setProgress(e.total ? (e.done ?? 0) / e.total : null);
          } else if (e.type === 'transcript') setStep(`Heard ${e.detected.name}: ${e.segments} phrases`);
          else if (e.type === 'done') done = e;
          else if (e.type === 'error') failed = e.message;
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) failed = errorText(err);
    }
    if (controller.signal.aborted) return;
    if (failed || !done) {
      setError(failed || 'The translation stopped without a result.');
      setStep('');
      setBusy(false);
      return;
    }
    const r: VideoResult = done;
    setCost((c) => c + r.cost_usd);
    track.current?.stop();
    track.current = null;
    if (r.voice && video.current && r.segments.some((s) => s.audio)) {
      setStep('Loading the translated speech…');
      const t = new SpeechTrack(video.current, r.segments);
      await t.load((n, total) => setProgress(n / total));
      t.setVolume(sound === 'original' ? 0 : 1);
      t.start();
      track.current = t;
    }
    setResult(r);
    setStep('');
    setProgress(null);
    setBusy(false);
  }

  // A new language, or speech asked for when only subtitles were made: run again (cached steps are skipped).
  function changeLanguage(code: string) {
    setLanguage(code);
    if (upload) void run(upload, code, sound !== 'original');
  }

  function changeSound(next: Sound) {
    setSound(next);
    if (upload && next !== 'original' && result && !result.voice) void run(upload, language, true);
  }

  function download(original: boolean) {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([toVtt(result.segments, original)], { type: 'text/vtt' }));
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `${upload?.name.replace(/\.[^.]+$/, '') || 'video'}.${original ? result.detected.code : result.language.code}.vtt`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const line = result?.segments.find((s, i) => {
    const next = result.segments[i + 1];
    return now >= s.start && now < Math.min(next ? next.start : Infinity, s.end + 1.5);
  });

  return (
    <main className="page-video-translate">
      <div className="kicker">Building · Video translation</div>
      <h1>Watch any video in your language</h1>
      <p className="lede">
        Upload a video. Azure listens to it, finds which language is spoken and writes down every phrase with its time.
        Choose your language: each phrase is translated, and you can read it as subtitles, hear it spoken by a neural
        voice in your language, or both. Change the language at any time; the video is not listened to again.
      </p>
      {info && !info.ready && (
        <p className="vt-bad small">Not set up on this server: needs {info.missing.join(' and ')}.</p>
      )}
      {error && <p className="vt-bad small">{error}</p>}

      <div className="vt-bar">
        <label>
          Translate into{' '}
          <select value={language} onChange={(e) => changeLanguage(e.target.value)} disabled={busy}>
            {(info?.languages ?? []).map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <div className="vt-seg" role="radiogroup" aria-label="Sound">
          {SOUNDS.map((s) => (
            <button
              key={s.id}
              role="radio"
              aria-checked={sound === s.id}
              className={`btn small${sound === s.id ? ' primary' : ''}`}
              onClick={() => changeSound(s.id)}
              disabled={busy}
            >
              {s.label}
            </button>
          ))}
        </div>
        <label className="small">
          <input type="checkbox" checked={subtitles} onChange={(e) => setSubtitles(e.target.checked)} /> Subtitles
        </label>
        <label className="small">
          <input type="checkbox" checked={showOriginal} onChange={(e) => setShowOriginal(e.target.checked)} /> Also show
          the original words
        </label>
        <span className="small muted">Spent here: {usd(cost)}</span>
      </div>

      <div className="vt-layout">
        <section className="card">
          {!upload ? (
            <label
              className={`vt-drop${over ? ' over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                void choose(e.dataTransfer.files[0]);
              }}
            >
              <input type="file" accept="video/*" onChange={(e) => void choose(e.target.files?.[0])} disabled={busy} />
              <b>Drop a video here, or click to choose one</b>
              <span className="small">
                MP4, MOV, WebM or MKV, up to {info?.max_mb ?? 200} MB and {Math.round((info?.max_seconds ?? 300) / 60)}{' '}
                minutes
              </span>
            </label>
          ) : (
            <div className="vt-player">
              <video ref={video} src={videoTranslateService.sourceUrl(upload.id)} controls playsInline />
              {subtitles && line && (
                <div className="vt-caption" aria-live="polite">
                  <span>{line.text}</span>
                  {showOriginal && line.text !== line.source_text && <small>{line.source_text}</small>}
                </div>
              )}
            </div>
          )}
          {upload && (
            <div className="vt-row small">
              <span className="muted">
                {upload.name} · {clock(upload.duration_s)}
              </span>
              <label className="btn small vt-again">
                Choose another video
                <input
                  type="file"
                  accept="video/*"
                  onChange={(e) => void choose(e.target.files?.[0])}
                  disabled={busy}
                />
              </label>
            </div>
          )}
          {(busy || step) && (
            <div className="vt-progress small">
              <span className="vt-pulse" /> {step || 'Working…'}
              {progress !== null && <progress value={progress} max={1} />}
            </div>
          )}
          <p className="small muted">
            Privacy: the sound of the video goes to Azure (Speech and Translator, through the lab’s AI Services account)
            to be written down and translated. The video and what is made from it stay on this computer, in
            generated/video-translate/; the ten most recent uploads are kept.
          </p>
        </section>

        <section className="card vt-script" aria-label="Transcript">
          {!result ? (
            <p className="small muted">The transcript appears here, phrase by phrase, with its translation.</p>
          ) : (
            <>
              <p className="small">
                Spoken in <b>{result.detected.name}</b> · translated into <b>{result.language.name}</b> ·{' '}
                {result.segments.length} phrases
                {result.voice && ' · with speech'}
              </p>
              {result.note && <p className="small">{result.note}</p>}
              <div className="vt-actions">
                <button className="btn small" onClick={() => download(false)} disabled={!result.segments.length}>
                  Subtitles (.vtt)
                </button>
                <button className="btn small" onClick={() => download(true)} disabled={!result.segments.length}>
                  Original words (.vtt)
                </button>
              </div>
              <ol className="vt-lines">
                {result.segments.map((s, i) => (
                  <li key={i} className={line === s ? 'on' : ''}>
                    <button
                      className="vt-time"
                      onClick={() => {
                        if (video.current) {
                          video.current.currentTime = s.start;
                          void video.current.play();
                        }
                      }}
                    >
                      {clock(s.start)}
                    </button>
                    <div>
                      <div>{s.text}</div>
                      {s.text !== s.source_text && <div className="muted small">{s.source_text}</div>}
                      {s.rate && s.rate > 1 && <div className="muted small">spoken {s.rate}× to fit</div>}
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      </div>

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
              <td>Take the sound out of the video, and check its size and length</td>
              <td>Code: ffmpeg on this computer</td>
              <td>Only the sound needs to leave the machine</td>
            </tr>
            <tr>
              <td>Write down what is said, with times, and identify the language</td>
              <td>
                Azure Speech fast transcription, choosing among the {info?.languages.length ?? 18} languages the lab has
                voices for
              </td>
              <td>A speech model trained for this; each phrase comes back with its start and end</td>
            </tr>
            <tr>
              <td>Translate each phrase</td>
              <td>Azure Translator</td>
              <td>Made for translation, and it keeps each phrase separate so the timing survives</td>
            </tr>
            <tr>
              <td>Speak each phrase in your language</td>
              <td>Azure neural text to speech, in that language’s voice</td>
              <td>A natural voice in each language</td>
            </tr>
            <tr>
              <td>Fit each spoken phrase into its slot, and keep it in step with the video</td>
              <td>
                Code: a phrase too long for its slot is said again up to {info?.max_rate ?? 1.5}× faster; the page
                starts each one when the video reaches it
              </td>
              <td>Timing is arithmetic, so code does it exactly; a seek or a pause re-syncs</td>
            </tr>
            <tr>
              <td>Keep the transcript and each language’s translation</td>
              <td>Code, on this computer</td>
              <td>Changing the language costs one translation, not another transcription</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">
        No language model is used here: the words are Azure’s speech and translation services, which are built and
        tested for exactly these jobs. Translated speech is one voice for everyone in the video; it does not copy the
        speakers’ own voices.
      </p>
    </main>
  );
}
