import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { VoiceComposer } from '@/components/voice/VoiceComposer';
import { isLocalModel } from '@/lib/models';
import { scanService, type ScanInfo, type ScanMark, type ScanResult } from '@/services/scanService';
import { statusService } from '@/services/statusService';
import './scans.css';

const usd = (v: number) => `$${v < 0.1 ? v.toFixed(4) : v.toFixed(2)}`;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const MAX_EDGE = 2000; // larger pictures are made smaller in the browser before they are sent
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];

interface Picture {
  /** base64, no data: prefix */
  data: string;
  url: string;
  name: string;
  shrunk: boolean;
}

/** Reads a picture file; shrinks it to at most MAX_EDGE on its long side so it fits the upload limit. */
async function toPicture(file: File, maxBytes: number): Promise<Picture> {
  if (!TYPES.includes(file.type))
    throw new Error('Choose a PNG, JPEG or WebP picture. Export a DICOM file as a picture first.');
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('That file is not a picture the browser can open.'));
    el.src = url;
  });
  const edge = Math.max(img.naturalWidth, img.naturalHeight);
  if (edge <= MAX_EDGE && file.size <= maxBytes)
    return { data: url.split(',')[1], url, name: file.name, shrunk: false };
  const k = Math.min(1, MAX_EDGE / edge);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * k);
  canvas.height = Math.round(img.naturalHeight * k);
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
  const small = canvas.toDataURL('image/jpeg', 0.92);
  return { data: small.split(',')[1], url: small, name: file.name, shrunk: true };
}

/** Boxes over the picture: the findings, numbered as in the table, and the places the latest answer points at. */
function Marks({ boxes, marks, hot }: { boxes: number[][]; marks: ScanMark[]; hot: number | null }) {
  const at = (b: number[]) => ({
    left: `${b[0] * 100}%`,
    top: `${b[1] * 100}%`,
    width: `${b[2] * 100}%`,
    height: `${b[3] * 100}%`,
  });
  return (
    <>
      {boxes.map((b, i) =>
        b.length === 4 ? (
          <span key={`o${i}`} className={`sc-box${hot === i ? ' hot' : ''}`} style={at(b)}>
            <i>{i + 1}</i>
          </span>
        ) : null,
      )}
      {marks.map((m, i) => (
        <span key={`m${i}`} className="sc-box answer" style={at(m.box)}>
          <i>{m.label}</i>
        </span>
      ))}
    </>
  );
}

/** A scan explainer: upload a medical image, and a model says what it can see, how sure it is and what to ask. */
export default function ScanPage() {
  const [info, setInfo] = useState<ScanInfo | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [picture, setPicture] = useState<Picture | null>(null);
  const [note, setNote] = useState('');
  const [asked, setAsked] = useState(''); // the note as it was sent with the reading on show
  const [over, setOver] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState<{ q: string; a: string; marks: ScanMark[] }[]>([]);
  const [hot, setHot] = useState<number | null>(null); // the finding row under the pointer
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cost, setCost] = useState(0);
  const lastAnswer = useRef<HTMLDivElement>(null);

  // A new answer is brought to the top of the view, so it reads from its first line; the question box stays in reach.
  useEffect(() => {
    if (answers.length) lastAnswer.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [answers.length]);

  useEffect(() => {
    Promise.all([scanService.info(), statusService.status()])
      .then(([i, s]) => {
        const offered = s.models || [];
        setInfo(i);
        setModels(offered);
        setModel(offered.includes(i.model) ? i.model : s.claude_model || offered[0] || '');
      })
      .catch((err) => setError(errorText(err)));
  }, []);

  async function choose(file: File | undefined) {
    if (!file) return;
    setError('');
    try {
      setPicture(await toPicture(file, (info?.max_mb ?? 5) * 2 ** 20));
      setResult(null);
      setAnswers([]);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function read(text = note) {
    if (busy) return;
    if (!picture) {
      setError('Choose a picture of the scan first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await scanService.read(picture.data, text, model || undefined);
      setResult(r);
      setAsked(text.trim());
      setAnswers([]);
      setCost((c) => c + r.cost_usd);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function ask(text: string) {
    if (!result || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await scanService.ask(text, result.reading, picture?.data ?? null, model || undefined);
      setAnswers((a) => [...a, { q: text, a: r.answer, marks: r.marks }]);
      setCost((c) => c + r.cost_usd);
      setQuestion('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const r = result?.reading;

  return (
    <main className="page-scans">
      <div className="kicker">Building · Scan explainer</div>
      <h1>Understand a scan before you see the doctor</h1>
      <p className="lede">
        Upload a picture of an X-ray, a CT or MRI slice, an ultrasound or a photograph taken for a doctor. A model that
        reads images describes what it can see, says how sure it is, and suggests questions to ask. It does not
        diagnose: code checks the wording, and decides the notices you see.
      </p>
      {info && <p className="sc-notice small">{info.notice}</p>}
      {error && <p className="sc-bad small">{error}</p>}

      <div className="sc-layout">
        <section className="card" aria-label="Your scan">
          <label
            className={`sc-drop${over ? ' over' : ''}`}
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
            <input type="file" accept={TYPES.join(',')} onChange={(e) => void choose(e.target.files?.[0])} />
            {picture ? (
              <span className="sc-figure">
                <img src={picture.url} alt="The uploaded scan" />
                {result && !result.message && (
                  <Marks
                    boxes={result.reading.observations.map((o) => o.box)}
                    marks={answers[answers.length - 1]?.marks ?? []}
                    hot={hot}
                  />
                )}
              </span>
            ) : (
              <>
                <b>Drop a picture here, or click to choose one</b>
                <span className="small">PNG, JPEG or WebP, up to {info?.max_mb ?? 5} MB</span>
              </>
            )}
          </label>
          {picture && (
            <p className="small muted">
              {picture.name}
              {picture.shrunk && ' · made smaller in your browser before sending'}
            </p>
          )}
          <VoiceComposer
            value={note}
            onChange={setNote}
            onSend={(t) => void read(t)}
            onError={setError}
            busy={busy}
            maxLength={1500}
            placeholder="Ask or say anything useful: your question, what the scan is of, what the report said"
          />
          <div className="sc-row">
            <label className="small">
              Model{' '}
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {m === info?.model ? ' (most capable)' : ''}
                    {m.startsWith('gpt-') ? ' (Azure OpenAI)' : isLocalModel(m) ? ' (local, free)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn primary" disabled={!picture || busy} onClick={() => void read()}>
              {busy ? 'Reading…' : 'Explain this scan'}
            </button>
            <span className="small muted">Spent here: {usd(cost)}</span>
          </div>
          <p className="small muted">
            Privacy: the picture is sent to the model you choose
            {isLocalModel(model) ? ', which runs on this machine' : ' (a cloud service)'} and is not stored by the lab.
            Crop out your name, date of birth and hospital number first.
          </p>
        </section>

        <section className="card sc-result" aria-label="Explanation">
          {!result && (
            <div className="sc-empty small muted">
              <p>The explanation appears here.</p>
              <p>You get what the picture shows, how sure the model is, what it cannot tell, and questions to ask.</p>
            </div>
          )}
          {result?.message && <p>{result.message}</p>}
          {result && r && !result.message && (
            <>
              {result.urgent_message && <div className="sc-urgent">{result.urgent_message}</div>}
              <p className="small muted">
                {[r.modality, r.body_region, r.view].filter(Boolean).join(' · ')} · picture quality: {r.quality}
                {r.quality_limits && ` (${r.quality_limits})`}
                {result.tries.length > 1 && (
                  <> · rewritten once after code found: {result.tries[0].problems.join('; ')}</>
                )}
              </p>
              <p>{r.summary}</p>
              {r.answer && (
                <div className="sc-qa">
                  <p className="small">
                    <b>You asked:</b> {asked}
                  </p>
                  <p>{r.answer}</p>
                </div>
              )}

              <h3>What the model can see</h3>
              {r.observations.length === 0 ? (
                <p className="small">Nothing it could point to.</p>
              ) : (
                <div className="table-wrap">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Feature</th>
                        <th>Where</th>
                        <th>In plain words</th>
                        <th>How sure</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.observations.map((o, i) => (
                        <tr key={i} onPointerEnter={() => setHot(i)} onPointerLeave={() => setHot(null)}>
                          <td>
                            {o.box.length === 4 && <b className="sc-num">{i + 1}</b>} {o.what}
                          </td>
                          <td>{o.where}</td>
                          <td>{o.plain}</td>
                          <td>
                            <span className={`sc-chip ${o.confidence}`}>{o.confidence}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {r.possibilities.length > 0 && (
                <>
                  <h3>What it could be consistent with (to discuss, not a diagnosis)</h3>
                  <ul>
                    {r.possibilities.map((p, i) => (
                      <li key={i}>
                        <b>{p.name}.</b> {p.why} <span className="muted">Also to consider: {p.also_consider}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {r.looks_normal.length > 0 && (
                <>
                  <h3>Looks as expected</h3>
                  <ul>
                    {r.looks_normal.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </>
              )}

              <h3>What this picture cannot tell</h3>
              <ul>
                {r.cannot_tell.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>

              <h3>Questions to ask your doctor</h3>
              <ol>
                {r.questions.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ol>
              <p className="small muted">
                How soon to raise it, in the model’s view: <b>{r.urgency}</b>. {r.urgency_reason}
              </p>

              {answers.map((x, i) => (
                <div key={i} className="sc-qa" ref={i === answers.length - 1 ? lastAnswer : undefined}>
                  <p className="small">
                    <b>You:</b> {x.q}
                  </p>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{x.a}</ReactMarkdown>
                </div>
              ))}
              <div className="sc-ask">
                <VoiceComposer
                  value={question}
                  onChange={setQuestion}
                  onSend={(t) => void ask(t)}
                  onError={setError}
                  busy={busy}
                  placeholder="Ask the AI about this scan: what does that word mean?"
                />
              </div>
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
              <td>Check the file is a real picture of an allowed type and size</td>
              <td>Code, from the file’s first bytes</td>
              <td>A file’s name proves nothing</td>
            </tr>
            <tr>
              <td>Describe the image: features, where, how sure, what it cannot tell</td>
              <td>The model (Opus by default), as JSON in a fixed schema</td>
              <td>The form makes it say how sure it is and what is missing, every time</td>
            </tr>
            <tr>
              <td>Reject wording that states a diagnosis or suggests treatment</td>
              <td>Code; one retry with the problems, then nothing is shown</td>
              <td>The model is told the rule; code checks it was kept</td>
            </tr>
            <tr>
              <td>The notices and the urgent message</td>
              <td>Code, in fixed words</td>
              <td>Safety wording must be the same for everyone</td>
            </tr>
            <tr>
              <td>The diagnosis</td>
              <td>A doctor, with the whole study, the history and the patient</td>
              <td>A general model has not been tested on scans; it misses findings and invents some</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Models made for medical images exist: Microsoft Foundry’s catalogue has MedImageInsight, MedImageParse and
        CXRReportGen, and regulators have cleared many single-purpose tools for radiologists. Those are trained and
        tested on scans and still work under a radiologist, not in place of one. This page uses a general model to show
        the pattern, and its limits.
      </p>
    </main>
  );
}
