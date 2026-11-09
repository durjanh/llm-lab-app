import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { imagegenService as svc, type GenerateResult, type ImageGenInfo, type PolicyCheck } from '@/services';
import { Chips, Panel, Problem, useCall, usd } from '@/pages/ai103/shared';

type Stroke = { x: number; y: number; r: number }[];

/** Paint over the area that may change. The mask sent is the image's own size: opaque everywhere, transparent where painted. */
function MaskPainter({ src, onMask }: { src: string; onMask: (dataUrl: string) => void }) {
  const img = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [brush, setBrush] = useState(28);
  const drawing = useRef(false);
  const [finished, setFinished] = useState(0); // strokes completed: the mask is exported once they have rendered

  useEffect(() => {
    if (finished) exportMask();
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(239, 68, 68, 0.45)';
    for (const s of strokes)
      for (const p of s) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
  }, [strokes]);

  function at(e: PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const k = e.currentTarget.width / rect.width;
    return { x: (e.clientX - rect.left) * k, y: (e.clientY - rect.top) * k, r: brush };
  }
  function exportMask() {
    const i = img.current;
    const c = canvas.current;
    if (!i || !c) return;
    const out = document.createElement('canvas');
    out.width = i.naturalWidth;
    out.height = i.naturalHeight;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.globalCompositeOperation = 'destination-out';
    const k = out.width / c.width;
    for (const s of strokes)
      for (const p of s) {
        ctx.beginPath();
        ctx.arc(p.x * k, p.y * k, p.r * k, 0, Math.PI * 2);
        ctx.fill();
      }
    onMask(out.toDataURL('image/png'));
  }

  return (
    <div>
      <div style={{ position: 'relative', maxWidth: 560 }}>
        <img
          ref={img}
          src={src}
          alt="Image to edit"
          className="az-img"
          onLoad={(e) => {
            const c = canvas.current;
            if (c) {
              c.width = 560;
              c.height = Math.round((560 * e.currentTarget.naturalHeight) / e.currentTarget.naturalWidth);
            }
          }}
        />
        <canvas
          ref={canvas}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            cursor: 'crosshair',
            touchAction: 'none',
          }}
          onPointerDown={(e) => {
            drawing.current = true;
            const p = at(e); // read the event now: React runs the updater after the event has finished
            setStrokes((s) => [...s, [p]]);
          }}
          onPointerMove={(e) => {
            if (drawing.current) {
              const p = at(e);
              setStrokes((s) => [...s.slice(0, -1), [...s[s.length - 1], p]]);
            }
          }}
          onPointerUp={() => {
            drawing.current = false;
            setFinished((f) => f + 1);
          }}
          onPointerLeave={() => {
            if (drawing.current) {
              drawing.current = false;
              setFinished((f) => f + 1);
            }
          }}
        />
      </div>
      <div className="az-row small">
        <label>
          Brush <input type="range" min={8} max={70} value={brush} onChange={(e) => setBrush(+e.target.value)} />
        </label>
        <button
          className="az-chip"
          onClick={() => {
            setStrokes([]);
            onMask('');
          }}
        >
          Clear the mask
        </button>
        <span className="muted">
          {strokes.length ? 'Red marks what may change.' : 'Paint over what should change.'}
        </span>
      </div>
    </div>
  );
}

export default function ImageGenPage() {
  const [info, setInfo] = useState<ImageGenInfo | null>(null);
  const [problem, setProblem] = useState('');
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [quality, setQuality] = useState('low');
  const [background, setBackground] = useState('auto');
  const [n, setN] = useState(1);
  const [refs, setRefs] = useState<string[]>([]);
  const [editPrompt, setEditPrompt] = useState(
    'Repair the ceiling: replace the brown water stain and peeling paint with clean, smooth white paint. Keep everything else the same.',
  );
  const [masking, setMasking] = useState(true);
  const [mask, setMask] = useState('');
  const [selected, setSelected] = useState('');
  const gen = useCall<GenerateResult>();
  const ed = useCall<GenerateResult>();
  const wm = useCall<{ note: string }>();
  const chk = useCall<PolicyCheck>();

  const load = () =>
    svc
      .info()
      .then((i) => {
        setInfo(i);
        setPrompt((p) => p || i.prompts[0].prompt);
      })
      .catch((e: Error) => setProblem(e.message));
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (gen.result || ed.result || wm.result) void load();
  }, [gen.result, ed.result, wm.result]); // eslint-disable-line react-hooks/exhaustive-deps

  const pool = [...(info?.samples ?? []).map((s) => `sample:${s}`), ...(info?.gallery ?? []).map((g) => g.id)];
  const last = ed.result ?? gen.result;
  const toggle = (id: string) => {
    setRefs((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]));
    setMask('');
  };

  return (
    <main className="page-imagegen">
      <div className="kicker">Lab 40 · AI-103: image and video generation</div>
      <h1>Making and editing images with gpt-image-2</h1>
      <p className="lede">
        Generate from a prompt, from reference images, or with a mask that says which part may change (inpainting).
        Every control the API offers is on the page: size, quality, background, number of images. Each image comes back
        with Content Credentials, a signed record that says an AI made it. Then add a visible watermark, and check the
        image against brand rules before anyone uses it.
      </p>
      <div className="az-stack small">
        <span>
          <b>Model</b> gpt-image-2 (Global Standard, Sweden Central)
        </span>
        <span>
          <b>Price used here</b> ${info?.prices.text_input_per_m}/M text in, ${info?.prices.image_input_per_m}/M image
          in, ${info?.prices.output_per_m}/M image out (gpt-image-1&apos;s rates: gpt-image-2 is not in the retail price
          list yet)
        </span>
        <span>
          <b>Rate limit</b> capacity 1: a second request within the minute is a 429, which this page waits out
        </span>
      </div>
      <Problem error={problem} />

      <Panel title="1. From a prompt">
        <Chips
          items={info?.prompts ?? []}
          label={(p) => p.label}
          onPick={(p) => {
            setPrompt(p.prompt);
            setBackground(p.background ?? 'auto');
          }}
        />
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Prompt" />
        <div className="az-row small">
          <label>
            Size{' '}
            <select value={size} onChange={(e) => setSize(e.target.value)}>
              {info?.sizes.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Quality{' '}
            <select value={quality} onChange={(e) => setQuality(e.target.value)}>
              {info?.qualities.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Background{' '}
            <select value={background} onChange={(e) => setBackground(e.target.value)}>
              {info?.backgrounds.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            Images{' '}
            <select value={n} onChange={(e) => setN(+e.target.value)}>
              <option>1</option>
              <option>2</option>
            </select>
          </label>
          <button
            className="btn primary"
            disabled={gen.busy || !prompt.trim() || !info?.configured}
            onClick={() => void gen.run(() => svc.generate({ prompt, size, quality, background, n }))}
          >
            {gen.busy ? 'Generating…' : 'Generate'}
          </button>
        </div>
        <p className="small muted">
          Low quality is about a cent and 10 to 20 seconds at 1024×1024; high quality costs several times more and takes
          longer.
        </p>
        <Problem error={gen.error} />
      </Panel>

      <Panel title="2. From reference images, and with a mask (inpainting)">
        <p className="small muted">
          Choose one or more references: the claim photos from the Content Understanding lab, or anything made here.
          With a mask, the painted area is what should change and the rest should stay; without one, the references
          guide a new image.
        </p>
        <div className="az-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
          {pool.map((id) => (
            <button
              key={id}
              type="button"
              className={`az-thumb${refs.includes(id) ? ' on' : ''}`}
              onClick={() => toggle(id)}
            >
              <img src={svc.imageUrl(id)} alt="" style={{ height: 70, objectFit: 'cover' }} />
              <span className="small">
                {id.startsWith('sample:') ? id.slice(7) : info?.gallery.find((g) => g.id === id)?.kind}
              </span>
            </button>
          ))}
        </div>
        {refs.length > 0 && (
          <>
            <label className="small">
              <input
                type="checkbox"
                checked={masking}
                onChange={(e) => {
                  setMasking(e.target.checked);
                  setMask('');
                }}
              />{' '}
              Paint a mask on the first reference
            </label>
            {masking && <MaskPainter key={refs[0]} src={svc.imageUrl(refs[0])} onMask={setMask} />}
            <textarea
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              aria-label="Edit instruction"
            />
            <div className="az-row">
              <button
                className="btn primary"
                disabled={ed.busy || (masking && !mask)}
                onClick={() =>
                  void ed.run(() =>
                    svc.edit({
                      prompt: editPrompt,
                      images: refs,
                      mask: masking ? mask : '',
                      size: refs[0].startsWith('sample:') ? '1536x1024' : size,
                      quality,
                    }),
                  )
                }
              >
                {ed.busy
                  ? 'Editing…'
                  : masking
                    ? 'Inpaint the painted area'
                    : `Make a new image from ${refs.length} reference${refs.length > 1 ? 's' : ''}`}
              </button>
              {masking && !mask && <span className="small muted">Paint the area first.</span>}
            </div>
          </>
        )}
        <Problem error={ed.error} />
      </Panel>

      {last && (
        <Panel title="The result">
          <p className="small">
            {last.seconds} s{last.waited_s ? ` (after waiting ${last.waited_s} s for the rate limit)` : ''} ·{' '}
            {last.usage.input_tokens_details?.text_tokens ?? last.usage.input_tokens} text tokens in
            {last.usage.input_tokens_details?.image_tokens
              ? `, ${last.usage.input_tokens_details.image_tokens} image tokens in`
              : ''}
            , {last.usage.output_tokens} image tokens out · {usd(last.cost_usd)}
          </p>
          <div className="az-grid">
            {last.items.map((it) => (
              <div key={it.id}>
                <img
                  src={svc.imageUrl(it.id)}
                  alt={it.prompt}
                  className="az-img"
                  style={{ background: 'repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0 / 20px 20px' }}
                />
                <p className="small">
                  <span className={`az-tag ${it.c2pa ? 'pass' : 'review'}`}>
                    {it.c2pa ? 'Content Credentials (C2PA) present' : 'no Content Credentials'}
                  </span>{' '}
                  <button className="az-chip" onClick={() => setSelected(it.id)}>
                    Use for the checks below
                  </button>
                </p>
                {ed.result === last && refs[0] && (
                  <p className="small muted">
                    Before:{' '}
                    <img
                      src={svc.imageUrl(refs[0])}
                      alt=""
                      style={{ height: 60, verticalAlign: 'middle', borderRadius: 4 }}
                    />
                  </p>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title="3. After generation: provenance, watermark and policy">
        <p className="small muted">
          Choose an image above (&ldquo;Use for the checks below&rdquo;) or from the gallery. Content Credentials are
          metadata: they prove where an image came from, but disappear when it is re-saved or screenshotted. A visible
          watermark survives that. A multimodal model checks the brand rules, because a content filter does not know
          them.
        </p>
        <div className="az-chips">
          {(info?.gallery ?? []).slice(0, 12).map((g) => (
            <button key={g.id} className={`az-chip${selected === g.id ? ' on' : ''}`} onClick={() => setSelected(g.id)}>
              {g.kind} {g.made_at}
            </button>
          ))}
        </div>
        {selected && (
          <div className="az-two">
            <img src={svc.imageUrl(selected)} alt="" className="az-img" />
            <div>
              <div className="az-row">
                <button
                  className="btn"
                  disabled={wm.busy}
                  onClick={() => void wm.run(() => svc.watermark(selected, 'AI-generated'))}
                >
                  Add a visible watermark
                </button>
                <button
                  className="btn primary"
                  disabled={chk.busy}
                  onClick={() => void chk.run(() => svc.check(selected))}
                >
                  {chk.busy ? 'Checking…' : 'Check the brand rules'}
                </button>
              </div>
              {wm.result && <p className="small">{wm.result.note} The watermarked copy is first in the gallery.</p>}
              {chk.result && (
                <table className="az-table">
                  <tbody>
                    {chk.result.checks.map((c) => (
                      <tr key={c.rule}>
                        <td>
                          <span className={`az-tag ${c.passed ? 'pass' : 'block'}`}>{c.passed ? 'pass' : 'fail'}</span>
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
              <Problem error={wm.error || chk.error} />
            </div>
          </div>
        )}
      </Panel>

      <Panel title="4. Video generation: explained, not run">
        <p>
          <span className="az-tag review">not available</span> {info?.video.status}
        </p>
        <ul className="small">
          {info?.video.facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <pre className="az-code">{info?.video.code}</pre>
        <p className="small muted">
          This is the exam&apos;s &ldquo;generate videos from text prompts and reference media&rdquo; and &ldquo;edit
          generated videos&rdquo; (remix). The lab tried to deploy sora-2 in Sweden Central and East US 2: both refused
          it as deprecated. Check a model&apos;s lifecycle before you design around it; previews can go with little
          notice.
        </p>
      </Panel>

      <h2>What this covers in AI-103</h2>
      <ul className="small">
        <li>
          Generate images from text prompts and reference media; edit with inpainting, masks and prompt-driven changes
          (sections 1 and 2).
        </li>
        <li>Select and apply generation controls: size, quality, background, number of images (section 1).</li>
        <li>
          Enforce visual policy rules: watermarks and brand rules (section 3); provenance with Content Credentials.
        </li>
        <li>Generate and edit videos (section 4, explained with code because the model is no longer deployable).</li>
      </ul>
      <h2>What to take away</h2>
      <ul>
        <li>
          Image generation is billed in tokens: an image at higher quality or larger size is more output tokens. Read
          the usage on every response.
        </li>
        <li>
          Capacity is per minute and small by default. Plan for 429s: wait out <code>retry-after</code>, queue, or raise
          the deployment&apos;s capacity.
        </li>
        <li>
          A mask&apos;s transparent pixels mark where to edit. The service does not promise the rest stays pixel for
          pixel the same, so paste the original back over it if you need that. Without a mask, a reference image is a
          guide, and the whole picture can change.
        </li>
        <li>
          Content Credentials prove provenance only while the file is untouched. Keep the original, and add a visible
          label where people need to see it.
        </li>
      </ul>
    </main>
  );
}
