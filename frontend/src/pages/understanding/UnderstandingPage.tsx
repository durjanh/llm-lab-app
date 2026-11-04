import { useEffect, useRef, useState } from 'react';
import {
  understandingService as svc,
  type Box,
  type CuResult,
  type MediaKind,
  type UnderstandingInfo,
  type VisionResult,
} from '@/services';
import { Panel, Problem, useCall, usd } from '@/pages/ai103/shared';

const TASK_LABEL: Record<string, string> = {
  concise: 'Concise caption',
  detailed: 'Detailed caption',
  alt: 'Alt text (WCAG)',
  extended: 'Extended description',
  compare: 'Compare several images',
  vqa: 'Answer from visual evidence',
  regions: 'Find objects and regions',
  policy: 'Visual policy rules',
};
const COLOURS = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#eab308'];

const show = (v: unknown): string =>
  v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
const time = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 100))}`;

/** An image with polygons drawn over it, in the image's own pixel space (Content Understanding) or 0 to 1000 (the model). */
function Overlay({
  src,
  width,
  height,
  shapes,
  scale,
}: {
  src: string;
  width: number;
  height: number;
  scale: number;
  shapes: { points: number[][]; colour: string; label?: string }[];
}) {
  return (
    <div style={{ position: 'relative' }}>
      <img src={src} alt="" className="az-img" />
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        preserveAspectRatio="none"
      >
        {shapes.map((s, i) => (
          <g key={i}>
            <polygon
              points={s.points.map((p) => `${p[0] * scale},${p[1] * scale}`).join(' ')}
              fill={`${s.colour}22`}
              stroke={s.colour}
              strokeWidth={width / 300}
            />
            {s.label && (
              <text
                x={s.points[0][0] * scale + 4}
                y={s.points[0][1] * scale + width / 45}
                fontSize={width / 50}
                fill={s.colour}
                fontWeight={700}
              >
                {s.label}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

const rect = (b: number[]) => [
  [b[0], b[1]],
  [b[2], b[1]],
  [b[2], b[3]],
  [b[0], b[3]],
];

export default function UnderstandingPage() {
  const [info, setInfo] = useState<UnderstandingInfo | null>(null);
  const [problem, setProblem] = useState('');
  const [sample, setSample] = useState('invoice');
  const [analyzer, setAnalyzer] = useState('labInvoice');
  const [picked, setPicked] = useState<string | null>(null);
  const [showMd, setShowMd] = useState(false);
  const [images, setImages] = useState<string[]>(['ceiling']);
  const [task, setTask] = useState('alt');
  const [question, setQuestion] = useState('How wide is the stain, and is the light fitting affected?');
  const [dims, setDims] = useState<Record<string, [number, number]>>({});
  const video = useRef<HTMLVideoElement>(null);
  const cu = useCall<CuResult>();
  const prep = useCall<UnderstandingInfo & { made: string[]; cost_usd: number }>();
  const vis = useCall<VisionResult>();
  const std = useCall<CuResult>();
  const agentic = useCall<CuResult>();

  useEffect(() => {
    svc
      .info()
      .then(setInfo)
      .catch((e: Error) => setProblem(e.message));
  }, []);
  useEffect(() => {
    if (prep.result) setInfo(prep.result);
  }, [prep.result]);

  // natural sizes of the pictures, for drawing model boxes (0 to 1000) in the right place
  useEffect(() => {
    (info?.samples ?? [])
      .filter((s) => (s.kind === 'image' || s.kind === 'document') && s.ready && !dims[s.id])
      .forEach((s) => {
        const img = new Image();
        img.onload = () => setDims((d) => ({ ...d, [s.id]: [img.naturalWidth, img.naturalHeight] }));
        img.src = svc.mediaUrl(s.id);
      });
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  const kindOf = (id: string): MediaKind | undefined => info?.samples.find((s) => s.id === id)?.kind;
  const analyzers = (info?.analyzers ?? []).filter((a) => a.kind === kindOf(sample) && !a.id.startsWith('labTotals'));
  const notReady = (info?.samples ?? []).filter((s) => !s.ready);
  const r = cu.result;
  const fieldShapes = (): { points: number[][]; colour: string; label?: string }[] => {
    if (!r) return [];
    const chosen = r.fields.filter((f) => !picked || f.name === picked);
    return chosen.flatMap((f, i) => {
      const all: Box[] = [...f.boxes, ...(f.item_boxes ?? []).flat()];
      return all
        .filter((b) => b.page === 1)
        .map((b) => ({
          points: b.points,
          colour: COLOURS[r.fields.indexOf(f) % COLOURS.length],
          label: i === 0 && picked ? f.name : undefined,
        }));
    });
  };

  function pickSample(id: string) {
    setSample(id);
    setPicked(null);
    cu.setResult(null);
    const first = (info?.analyzers ?? []).find((a) => a.kind === kindOf(id) && !a.id.startsWith('labTotals'));
    if (first) setAnalyzer(kindOf(id) === 'document' ? 'labInvoice' : first.id);
    if (id === 'claim') setAnalyzer('labClaim');
    if (kindOf(id) === 'image') setAnalyzer('labDamage');
  }

  const vr = vis.result;
  const visionShapes = (): { points: number[][]; colour: string; label?: string }[] => {
    if (!vr?.data) return [];
    if (vr.data.regions)
      return vr.data.regions.map((g, i) => ({
        points: rect(g.box),
        colour: COLOURS[i % COLOURS.length],
        label: g.label,
      }));
    if (vr.data.evidence)
      return vr.data.evidence.map((e, i) => ({
        points: rect(e.box),
        colour: COLOURS[i % COLOURS.length],
        label: `${i + 1}`,
      }));
    return [];
  };

  return (
    <main className="page-understanding">
      <div className="kicker">Lab 39 · AI-103: vision and information extraction</div>
      <h1>Reading documents, pictures, audio and video</h1>
      <p className="lede">
        Two ways to make sense of a file. <b>Azure Content Understanding</b> turns documents, images, audio and video
        into Markdown for retrieval, and into named fields, each with a confidence score and the box it came from. A
        <b> multimodal model</b> ({info?.model ?? 'gpt-5.4-mini'}) looks at a picture and answers in words: captions,
        alt text, answers with their visual evidence, and regions. The samples are an invented home insurance claim: an
        invoice, a claim form, three photos and a narrated video.
      </p>
      <div className="az-stack small">
        <span>
          <b>Content Understanding</b> GA API 2025-11-01, model {info?.cu_model ?? 'gpt-4.1-mini'}
        </span>
        <span>
          <b>Vision model</b> {info?.model ?? '…'}
        </span>
        {notReady.length > 0 && (
          <span>
            <button className="btn" disabled={prep.busy} onClick={() => void prep.run(() => svc.prepare())}>
              {prep.busy
                ? 'Making the sample media…'
                : `Make the sample media (${notReady.map((s) => s.id).join(', ')})`}
            </button>{' '}
            gpt-image-2 photos, about $0.06 each
          </span>
        )}
      </div>
      <Problem error={problem || prep.error} />

      <Panel title="1. Content Understanding: from a file to Markdown and fields">
        <div className="az-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
          {(info?.samples ?? []).map((s) => (
            <button
              key={s.id}
              type="button"
              className={`az-thumb${sample === s.id ? ' on' : ''}`}
              onClick={() => pickSample(s.id)}
              disabled={!s.ready}
            >
              {(s.kind === 'image' || s.kind === 'document') && s.ready ? (
                <img src={svc.mediaUrl(s.id)} alt="" style={{ height: 80, objectFit: 'cover' }} />
              ) : (
                <span style={{ height: 80, display: 'grid', placeItems: 'center', fontSize: 28 }}>
                  {s.kind === 'video' ? '▶' : '♪'}
                </span>
              )}
              <span className="small">{s.label}</span>
            </button>
          ))}
        </div>
        <div className="az-chips">
          {analyzers.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`az-chip${analyzer === a.id ? ' on' : ''}`}
              onClick={() => setAnalyzer(a.id)}
              title={a.about ?? a.label}
            >
              {a.custom ? a.label : a.id}
            </button>
          ))}
        </div>
        <p className="small muted">
          {analyzers.find((a) => a.id === analyzer)?.about ?? analyzers.find((a) => a.id === analyzer)?.label}
        </p>
        <button
          className="btn primary"
          disabled={cu.busy || !info?.configured}
          onClick={() => void cu.run(() => svc.analyze(sample, analyzer))}
        >
          {cu.busy ? 'Analysing…' : `Analyse with ${analyzer}`}
        </button>
        <Problem error={cu.error} />
        {r && (
          <div className="az-result">
            <p className="small">
              <b>{r.analyzer}</b> · {r.seconds} s · {usd(r.cost_usd)}
              {r.words > 0 && ` · ${r.words} words`}
              {r.tables > 0 && ` · ${r.tables} tables`}
              {r.duration_ms ? ` · ${(r.duration_ms / 1000).toFixed(1)} s of media` : ''} · usage{' '}
              <code>{JSON.stringify(r.usage)}</code>
            </p>
            <div className="az-two">
              <div>
                {(kindOf(r.sample) === 'document' || kindOf(r.sample) === 'image') && (
                  <Overlay
                    src={svc.mediaUrl(r.sample)}
                    width={r.pages[0]?.width ?? dims[r.sample]?.[0] ?? 1000}
                    height={r.pages[0]?.height ?? dims[r.sample]?.[1] ?? 1000}
                    scale={1}
                    shapes={fieldShapes()}
                  />
                )}
                {kindOf(r.sample) === 'video' && (
                  <video ref={video} src={svc.mediaUrl('video')} controls style={{ width: '100%', borderRadius: 8 }} />
                )}
                {kindOf(r.sample) === 'audio' && (
                  <audio src={svc.mediaUrl('audio')} controls style={{ width: '100%' }} />
                )}
              </div>
              <div>
                {r.fields.length > 0 && (
                  <table className="az-table">
                    <thead>
                      <tr>
                        <th>Field</th>
                        <th>Value</th>
                        <th>Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.fields.map((f, i) => {
                        const schema = info?.analyzers.find((a) => a.id === r.analyzer)?.schema?.[f.name];
                        return (
                          <tr
                            key={f.name}
                            onClick={() => setPicked(picked === f.name ? null : f.name)}
                            style={{
                              cursor: 'pointer',
                              background: picked === f.name ? 'var(--brand-soft)' : undefined,
                            }}
                          >
                            <td>
                              <span style={{ color: COLOURS[i % COLOURS.length] }}>■</span> {f.name}
                              {schema?.method && <div className="small muted">{schema.method}</div>}
                            </td>
                            <td className="small">
                              {Array.isArray(f.value)
                                ? `${f.value.length} items: ${show(f.value).slice(0, 160)}…`
                                : show(f.value)}
                            </td>
                            <td className="small">
                              {f.confidence === null ? (
                                <span className="muted">not given</span>
                              ) : (
                                f.confidence.toFixed(2)
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {r.transcript.length > 0 && (
                  <>
                    <b className="small">Transcript (select a line to jump to it)</b>
                    <ul className="az-stages">
                      {r.transcript.map((t) => (
                        <li
                          key={t.start}
                          onClick={() => {
                            if (video.current) {
                              video.current.currentTime = t.start / 1000;
                              void video.current.play();
                            }
                          }}
                          style={{ cursor: 'pointer' }}
                        >
                          <span className="mono small">{time(t.start)}</span> {t.text}{' '}
                          <span className="small muted">
                            {t.speaker} · {Math.round(t.confidence * 100)}%
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {r.keyframes.length > 0 && (
                  <p className="small">
                    {r.keyframes.length} key frames, camera shots at {r.shots.map(time).join(', ') || '—'}.
                  </p>
                )}
              </div>
            </div>
            <p>
              <button className="az-chip" onClick={() => setShowMd(!showMd)}>
                {showMd ? 'Hide' : 'Show'} the Markdown ({r.markdown.length.toLocaleString('en-GB')} characters)
              </button>
            </p>
            {showMd && <pre className="az-code">{r.markdown}</pre>}
          </div>
        )}
      </Panel>

      <Panel title="2. Standard or agentic? Checking the invoice adds up">
        <p className="small muted">
          The invoice&apos;s lines add up to £409.00 but its subtotal says £400.00. Both analyzers get the same four
          generated fields. The standard one is the GA API; the agentic one (<code>workflow: agentic</code>, preview API
          2026-06-01) reasons over the evidence in several steps. It replaces the earlier preview&apos;s &ldquo;pro
          mode&rdquo;.
        </p>
        <button
          className="btn primary"
          disabled={std.busy || agentic.busy}
          onClick={() => {
            void std.run(() => svc.analyze('invoice', 'labTotalsStandard'));
            void agentic.run(() => svc.analyze('invoice', 'labTotalsAgentic'));
          }}
        >
          {std.busy || agentic.busy ? 'Running both…' : 'Run both on the invoice'}
        </button>
        <Problem error={std.error || agentic.error} />
        {(std.result || agentic.result) && (
          <div className="az-table-wrap az-result">
            <table className="az-table">
              <thead>
                <tr>
                  <th />
                  <th>Standard</th>
                  <th>Agentic (preview)</th>
                </tr>
              </thead>
              <tbody>
                {['LineSum', 'PrintedSubtotal', 'TotalsAddUp', 'Explanation'].map((name) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="small">{show(std.result?.fields.find((f) => f.name === name)?.value)}</td>
                    <td className="small">{show(agentic.result?.fields.find((f) => f.name === name)?.value)}</td>
                  </tr>
                ))}
                <tr>
                  <td>Time</td>
                  <td>{std.result ? `${std.result.seconds} s` : '…'}</td>
                  <td>{agentic.result ? `${agentic.result.seconds} s` : '…'}</td>
                </tr>
                <tr>
                  <td>Model tokens</td>
                  <td className="small">
                    {std.result ? JSON.stringify((std.result.usage as { tokens?: unknown }).tokens) : '…'}
                  </td>
                  <td className="small">
                    {agentic.result ? JSON.stringify((agentic.result.usage as { tokens?: unknown }).tokens) : '…'}
                  </td>
                </tr>
                <tr>
                  <td>Cost</td>
                  <td>{std.result ? usd(std.result.cost_usd) : '…'}</td>
                  <td>{agentic.result ? usd(agentic.result.cost_usd) : '…'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="3. A multimodal model on the same pictures">
        <p className="small muted">
          Choose one picture, or several for a comparison, and a task. Boxes come back on a 0 to 1000 scale and are
          drawn over the picture.
        </p>
        <div className="az-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
          {(info?.samples ?? [])
            .filter((s) => s.kind === 'image' || s.kind === 'document')
            .map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={!s.ready}
                className={`az-thumb${images.includes(s.id) ? ' on' : ''}`}
                onClick={() => setImages(images.includes(s.id) ? images.filter((x) => x !== s.id) : [...images, s.id])}
              >
                {s.ready && <img src={svc.mediaUrl(s.id)} alt="" style={{ height: 80, objectFit: 'cover' }} />}
                <span className="small">{s.label}</span>
              </button>
            ))}
        </div>
        <div className="az-chips">
          {(info?.tasks ?? []).map((t) => (
            <button key={t} type="button" className={`az-chip${task === t ? ' on' : ''}`} onClick={() => setTask(t)}>
              {TASK_LABEL[t] ?? t}
            </button>
          ))}
        </div>
        {(task === 'vqa' || task === 'regions') && (
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            style={{ width: '100%' }}
            aria-label="Question about the picture"
          />
        )}
        {task === 'policy' && <p className="small muted">Rules: {info?.policy_rules.join(' · ')}</p>}
        <div className="az-row">
          <button
            className="btn primary"
            disabled={vis.busy || !images.length}
            onClick={() => void vis.run(() => svc.vision(images, task, question))}
          >
            {vis.busy ? 'Looking…' : `Run: ${TASK_LABEL[task] ?? task}`}
          </button>
        </div>
        <Problem error={vis.error} />
        {vr && (
          <div className="az-result">
            <div className="az-two">
              <div>
                {images[0] && dims[images[0]] && (
                  <Overlay
                    src={svc.mediaUrl(images[0])}
                    width={dims[images[0]][0]}
                    height={dims[images[0]][1]}
                    scale={dims[images[0]][0] / 1000}
                    shapes={visionShapes().map((s) => ({
                      ...s,
                      points: s.points.map((p) => [p[0], (p[1] * dims[images[0]][1]) / dims[images[0]][0]]),
                    }))}
                  />
                )}
              </div>
              <div>
                {!vr.data && (
                  <>
                    <div className="az-quote">{vr.text}</div>
                    <p className="small muted">
                      {vr.text.length} characters
                      {vr.task === 'alt' && vr.text.length > 125 ? ' — over the 125 the instructions asked for' : ''}
                    </p>
                  </>
                )}
                {vr.data?.answer !== undefined && (
                  <>
                    <div className="az-quote">{vr.data.answer}</div>
                    <p className="small">
                      {vr.data.answerable ? (
                        <span className="az-tag pass">answerable from the picture</span>
                      ) : (
                        <span className="az-tag review">not answerable from the picture</span>
                      )}
                    </p>
                    <ol className="small">
                      {vr.data.evidence?.map((e) => (
                        <li key={e.what}>{e.what}</li>
                      ))}
                    </ol>
                  </>
                )}
                {vr.data?.regions && (
                  <ol className="small">
                    {vr.data.regions.map((g) => (
                      <li key={g.label}>{g.label}</li>
                    ))}
                  </ol>
                )}
                {vr.data?.checks && (
                  <table className="az-table">
                    <tbody>
                      {vr.data.checks.map((c) => (
                        <tr key={c.rule}>
                          <td>
                            <span className={`az-tag ${c.passed ? 'pass' : 'block'}`}>
                              {c.passed ? 'pass' : 'fail'}
                            </span>
                          </td>
                          <td className="small">
                            <b>{c.rule}</b>
                            <div className="muted">{c.evidence}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <p className="small muted">
                  {vr.seconds} s · {vr.tokens.input.toLocaleString('en-GB')} tokens in (the pictures are most of them),{' '}
                  {vr.tokens.output} out · {usd(vr.cost_usd)}
                </p>
              </div>
            </div>
          </div>
        )}
      </Panel>

      <h2>Which to use</h2>
      <div className="az-table-wrap">
        <table className="az-table">
          <thead>
            <tr>
              <th>You need</th>
              <th>Use</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Clean Markdown of a document for RAG</td>
              <td>Content Understanding: prebuilt-layout or prebuilt-documentSearch</td>
              <td>OCR, reading order, tables as HTML and sections, in one call, at about half a cent a page</td>
            </tr>
            <tr>
              <td>The same fields from thousands of forms</td>
              <td>A custom analyzer with a field schema</td>
              <td>
                Each value has a confidence score and its box, so low-confidence values go to a person (straight-through
                processing for the rest)
              </td>
            </tr>
            <tr>
              <td>A value that needs working out</td>
              <td>A generate field; agentic mode only when standard gets it wrong</td>
              <td>
                Here both got 409 against 400; agentic took about five times as long, used four times the tokens, and
                its preview explanation turned £ into &ldquo;a3&rdquo;
              </td>
            </tr>
            <tr>
              <td>Transcript, key frames and chapters of a video</td>
              <td>prebuilt-videoSearch</td>
              <td>Speech, shots and descriptions with timestamps, ready to index</td>
            </tr>
            <tr>
              <td>A caption, alt text, or a question about one picture</td>
              <td>A multimodal model</td>
              <td>Flexible wording and reasoning, but no confidence scores, and boxes are approximate</td>
            </tr>
            <tr>
              <td>A domain prebuilt such as prebuilt-invoice</td>
              <td>A full-size model deployment</td>
              <td>It refuses gpt-4.1-mini: check an analyzer&apos;s supportedModels before you deploy</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>What this covers in AI-103</h2>
      <ul className="small">
        <li>
          Multimodal understanding: captions concise and detailed, for one or several images; answers grounded in visual
          evidence; alt text and extended descriptions; objects and regions (section 3).
        </li>
        <li>
          Content Understanding: visual characteristics as fields (labDamage), video segments and transcripts, standard
          and agentic pipelines (sections 1 and 2).
        </li>
        <li>
          Information extraction: OCR, layout and field extraction in one multimodal pipeline; Markdown for agents and
          RAG; custom analyzers for structured output (section 1).
        </li>
        <li>
          Visual policy rules, such as no real brands and prices in pounds (section 3). Unsafe images and text hidden in
          pictures are on the guardrails page.
        </li>
      </ul>

      <h2>What to take away</h2>
      <ul>
        <li>
          Extraction you will automate needs confidence scores and sources. A model&apos;s answer has neither; a Content
          Understanding field has both.
        </li>
        <li>
          Extract, classify and generate are different promises. Extracted values had confidences of 0.9 and more here;
          generated notes, such as the claim&apos;s follow-ups, came in under 0.25. Treat them as drafts.
        </li>
        <li>
          Reach for agentic mode when a standard analyzer gets an answer wrong, not by default. It is a preview: on this
          invoice it wrote &ldquo;a3409&rdquo; for &ldquo;£409&rdquo;, so check its text fields before you trust them.
        </li>
        <li>
          Every analyzer names the models it supports. Deploy for the analyzers you use, then set the resource&apos;s
          default model deployments once.
        </li>
        <li>
          A model&apos;s boxes are approximate; Content Understanding&apos;s come from the OCR and match the text
          exactly.
        </li>
      </ul>
    </main>
  );
}
