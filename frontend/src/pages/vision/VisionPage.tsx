import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import './vision.css';

/**
 * How a transformer reads an image (the Vision Transformer, ViT): cut it into patches, flatten each patch into numbers,
 * project those into a token embedding, add position, run attention, and join the result with text tokens.
 * Everything is computed here in the browser from the picture's real pixels. The projection and attention are
 * stand-ins (a fixed random matrix, and similarity of colour and texture), because a trained model is far too big
 * for a page; the shapes and the steps are the real ones.
 */

const PATCH = 16;
const DIM = 48; // embedding size shown here; ViT-Base uses 768
const SAMPLES = [
  { id: 'cat', label: 'Cat on grass', emoji: '🐈', sky: ['#7cc4ff', '#d8f0ff'], ground: '#5fae4b' },
  { id: 'fruit', label: 'Fruit bowl', emoji: '🍎🍌', sky: ['#f5e6c8', '#fff6e5'], ground: '#b5835a' },
  { id: 'street', label: 'House and tree', emoji: '🏠🌳', sky: ['#9fd3ff', '#e9f6ff'], ground: '#8a8f99' },
] as const;
type SampleId = (typeof SAMPLES)[number]['id'];

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draws a sample scene: a sky gradient, the ground, and large emoji, at the given size. */
function drawSample(ctx: CanvasRenderingContext2D, size: number, id: SampleId) {
  const s = SAMPLES.find((x) => x.id === id)!;
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, s.sky[0]);
  g.addColorStop(0.62, s.sky[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = s.ground;
  ctx.fillRect(0, size * 0.66, size, size * 0.34);
  if (id === 'cat' || id === 'street') {
    ctx.fillStyle = '#ffd54a';
    ctx.beginPath();
    ctx.arc(size * 0.82, size * 0.17, size * 0.09, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(size * (s.emoji.length > 2 ? 0.34 : 0.5))}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.fillText(s.emoji, size * 0.5, size * 0.6);
}

interface Patches {
  size: number;
  grid: number; // patches per side
  pixels: Uint8ClampedArray; // RGBA, size × size
  vectors: Float32Array[]; // each patch flattened: 16 × 16 × 3 numbers, scaled to 0..1
  features: number[][]; // colour and texture summary per patch, for the attention stand-in
}

function cutPatches(pixels: Uint8ClampedArray, size: number): Patches {
  const grid = size / PATCH;
  const vectors: Float32Array[] = [];
  const features: number[][] = [];
  for (let py = 0; py < grid; py++) {
    for (let px = 0; px < grid; px++) {
      const v = new Float32Array(PATCH * PATCH * 3);
      let k = 0;
      const sums = [0, 0, 0];
      let edge = 0;
      for (let y = 0; y < PATCH; y++) {
        for (let x = 0; x < PATCH; x++) {
          const i = ((py * PATCH + y) * size + (px * PATCH + x)) * 4;
          for (let c = 0; c < 3; c++) {
            v[k++] = pixels[i + c] / 255;
            sums[c] += pixels[i + c] / 255;
          }
          if (x > 0) edge += Math.abs(pixels[i] - pixels[i - 4]) + Math.abs(pixels[i + 1] - pixels[i - 3]) + Math.abs(pixels[i + 2] - pixels[i - 2]);
        }
      }
      vectors.push(v);
      const n = PATCH * PATCH;
      features.push([sums[0] / n, sums[1] / n, sums[2] / n, edge / (n * 255 * 3)]);
    }
  }
  return { size, grid, pixels, vectors, features };
}

/** A fixed random projection, 768 → DIM, standing in for the learned matrix W. */
const W = (() => {
  const r = seeded(42);
  const scale = 1 / Math.sqrt(PATCH * PATCH * 3);
  return Array.from({ length: DIM }, () => Float32Array.from({ length: PATCH * PATCH * 3 }, () => (r() * 2 - 1) * Math.sqrt(3) * scale));
})();
const project = (v: Float32Array) => W.map((row) => row.reduce((s, w, i) => s + w * v[i], 0));

/** 2D sine/cosine position embedding: half the dimensions encode the row, half the column. */
function position(row: number, col: number): number[] {
  const out: number[] = [];
  const half = DIM / 2;
  for (const p of [row, col]) {
    for (let i = 0; i < half / 2; i++) {
      const f = 1 / 10000 ** ((2 * i) / half);
      out.push(Math.sin(p * f), Math.cos(p * f));
    }
  }
  return out;
}
const cosine = (a: number[], b: number[]) => {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0);
  return dot / (Math.hypot(...a) * Math.hypot(...b) || 1);
};

const heat = (t: number, alpha = 0.75) => `rgba(91, 79, 214, ${(Math.max(0, Math.min(1, t)) * alpha).toFixed(3)})`;
const sign = (v: number, max: number) => (v >= 0 ? `rgba(42, 120, 214, ${Math.min(1, v / max).toFixed(3)})` : `rgba(235, 104, 52, ${Math.min(1, -v / max).toFixed(3)})`);

export default function VisionPage() {
  const [sample, setSample] = useState<SampleId>('cat');
  const [upload, setUpload] = useState<HTMLImageElement | null>(null);
  const [size, setSize] = useState(64);
  const [selected, setSelected] = useState(5);
  const [overlay, setOverlay] = useState<'none' | 'attention' | 'cnn' | 'position'>('attention');
  const [sharpness, setSharpness] = useState(6);
  const [patches, setPatches] = useState<Patches | null>(null);
  const source = useRef<HTMLCanvasElement>(null);

  // Draw the picture at the chosen size and cut it into patches.
  useEffect(() => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    if (upload) {
      const side = Math.min(upload.width, upload.height); // centre square crop
      ctx.drawImage(upload, (upload.width - side) / 2, (upload.height - side) / 2, side, side, 0, 0, size, size);
    } else drawSample(ctx, size, sample);
    setPatches(cutPatches(ctx.getImageData(0, 0, size, size).data, size));
    setSelected((s) => Math.min(s, (size / PATCH) ** 2 - 1));
  }, [sample, upload, size]);

  // From the patches themselves, so a render between choosing a new size and cutting it never mixes the two.
  const grid = patches?.grid ?? size / PATCH;
  const count = grid * grid;
  const sel = Math.min(selected, count - 1);
  const embedding = useMemo(() => (patches ? project(patches.vectors[sel]) : []), [patches, sel]);
  const maxEmb = Math.max(...embedding.map(Math.abs), 1e-6);
  const positions = useMemo(() => Array.from({ length: count }, (_, i) => position(Math.floor(i / grid), i % grid)), [count, grid]);

  // The attention stand-in: softmax over patches of how alike their colour and texture are to the chosen patch.
  const attention = useMemo(() => {
    if (!patches) return [];
    const q = patches.features[sel];
    const scores = patches.features.map((f) => -Math.hypot(...f.map((v, i) => (v - q[i]) * (i === 3 ? 2 : 1))) * sharpness);
    const m = Math.max(...scores);
    const e = scores.map((s) => Math.exp(s - m));
    const total = e.reduce((s, v) => s + v, 0);
    return e.map((v) => v / total);
  }, [patches, sel, sharpness]);
  const maxAtt = Math.max(...attention, 1e-9);

  // Paint the picture, large, with the grid, the chosen patch and the overlay.
  const VIEW = 320;
  useEffect(() => {
    const c = source.current;
    if (!c || !patches) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = c.height = VIEW * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const img = new ImageData(new Uint8ClampedArray(patches.pixels), patches.size, patches.size);
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = patches.size;
    tmp.getContext('2d')!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = patches.size > 64;
    ctx.drawImage(tmp, 0, 0, VIEW, VIEW);
    const cell = VIEW / grid;
    for (let i = 0; i < count; i++) {
      const x = (i % grid) * cell;
      const y = Math.floor(i / grid) * cell;
      let t = 0;
      if (overlay === 'attention') t = Math.sqrt(attention[i] / maxAtt); // square root: weaker links stay visible
      if (overlay === 'position') t = (cosine(positions[i], positions[sel]) + 1) / 2;
      if (overlay === 'cnn') t = Math.abs((i % grid) - (sel % grid)) <= 1 && Math.abs(Math.floor(i / grid) - Math.floor(sel / grid)) <= 1 ? 1 : 0;
      if (overlay !== 'none') {
        ctx.fillStyle = heat(1 - (overlay === 'position' ? t ** 3 : t), 0.82); // clear = related to the chosen patch
        ctx.fillRect(x, y, cell, cell);
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    for (let k = 1; k < grid; k++) {
      ctx.beginPath();
      ctx.moveTo(k * cell, 0);
      ctx.lineTo(k * cell, VIEW);
      ctx.moveTo(0, k * cell);
      ctx.lineTo(VIEW, k * cell);
      ctx.stroke();
    }
    ctx.strokeStyle = '#ff8a00';
    ctx.lineWidth = 3;
    ctx.strokeRect((sel % grid) * cell + 1.5, Math.floor(sel / grid) * cell + 1.5, cell - 3, cell - 3);
    if (grid <= 8) {
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 3;
      for (let i = 0; i < count; i++) ctx.fillText(String(i + 1), (i % grid) * cell + 4, Math.floor(i / grid) * cell + 14);
      ctx.shadowBlur = 0;
    }
  }, [patches, overlay, attention, maxAtt, positions, sel, grid, count]);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const col = Math.floor(((e.clientX - r.left) / r.width) * grid);
    const row = Math.floor(((e.clientY - r.top) / r.height) * grid);
    setSelected(Math.max(0, Math.min(count - 1, row * grid + col)));
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const img = new Image();
    img.onload = () => setUpload(img);
    img.src = URL.createObjectURL(file);
  };

  const vector = patches?.vectors[sel];
  const textTokens = ['What', ' is', ' in', ' this', ' picture', '?'];

  return (
    <main className="page-vision">
      <div className="kicker">Lab 27 · Images as tokens</div>
      <h1>How a transformer reads an image</h1>
      <p className="lede">
        A transformer only understands a sequence of tokens, and an image is a grid of pixels. The Vision Transformer (ViT)
        solves this by making the image look like text: cut it into patches, turn each patch into a token, and from then on it
        is the same machine. Follow one picture through every step; everything below is computed from its real pixels.
      </p>

      <div className="row vi-bar">
        <span className="small">Picture</span>
        {SAMPLES.map((s) => (
          <button key={s.id} className={`chip-btn ${!upload && sample === s.id ? 'on' : ''}`} onClick={() => (setUpload(null), setSample(s.id))}>
            {s.label}
          </button>
        ))}
        <label className={`chip-btn ${upload ? 'on' : ''}`}>
          Your own picture
          <input type="file" accept="image/*" hidden onChange={onFile} />
        </label>
        <span className="small">Size</span>
        <button className={`chip-btn ${size === 64 ? 'on' : ''}`} onClick={() => setSize(64)}>
          64 × 64 (16 patches)
        </button>
        <button className={`chip-btn ${size === 224 ? 'on' : ''}`} onClick={() => setSize(224)}>
          224 × 224 (196 patches, as ViT)
        </button>
      </div>

      <section>
        <h2>1. Cut it into patches</h2>
        <p>
          A {size} × {size} image cut into {PATCH} × {PATCH} squares gives {grid} × {grid} = <b>{count} patches</b>. Read left to
          right, top to bottom, they become a sequence, like the words of a sentence. Click any patch to follow it.
        </p>
        <div className="vi-two">
          <div>
            <canvas ref={source} className="vi-image" style={{ width: VIEW, height: VIEW }} onClick={pick} aria-label="The picture cut into patches; click a patch to choose it" />
            <div className="row small vi-overlays">
              Shading:
              {(
                [
                  ['attention', 'attention from the chosen patch'],
                  ['cnn', 'what a CNN layer sees'],
                  ['position', 'position similarity'],
                  ['none', 'none'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} className={`chip-btn ${overlay === id ? 'on' : ''}`} onClick={() => setOverlay(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="vi-seq" aria-label="The patches as a sequence">
            {patches &&
              Array.from({ length: count }, (_, i) => (
                <PatchThumb key={`${size}-${i}`} patches={patches} index={i} selected={i === sel} onPick={() => setSelected(i)} />
              ))}
          </div>
        </div>
      </section>

      <section>
        <h2>2. Flatten the patch into numbers</h2>
        <p>
          Patch {sel + 1} is {PATCH} × {PATCH} pixels × 3 colours = <b>{PATCH * PATCH * 3} numbers</b>, read off row by row: red,
          green, blue, red, green, blue…
        </p>
        <div className="vi-two">
          {patches && <PatchZoom patches={patches} index={sel} />}
          <div className="vi-vector mono small">
            {vector &&
              [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                <div key={i}>
                  <span className={`vi-ch c${i % 3}`}>{'RGB'[i % 3]}</span> {Math.round(vector[i] * 255)}
                </div>
              ))}
            <div className="muted">⋮ {PATCH * PATCH * 3 - 10} more</div>
            {vector && (
              <div>
                <span className="vi-ch c2">B</span> {Math.round(vector[vector.length - 1] * 255)}
              </div>
            )}
          </div>
        </div>
      </section>

      <section>
        <h2>3. Project it into a token</h2>
        <p>
          The {PATCH * PATCH * 3} numbers are multiplied by a weight matrix <b>W</b> ({PATCH * PATCH * 3} × {DIM} here), giving one
          vector of {DIM} numbers: the patch's <b>embedding</b>, in the same space as text tokens' embeddings. A patch is now a
          token. In a real model W is learned in training (ViT-Base uses 768 numbers per token); here it is a fixed random
          matrix, so the numbers are real arithmetic on this patch but not yet meaningful.
        </p>
        <div className="vi-emb" aria-label={`Embedding of patch ${sel + 1}`}>
          {embedding.map((v, i) => (
            <span key={i} style={{ background: sign(v, maxEmb) }} title={v.toFixed(3)} />
          ))}
        </div>
        <p className="small muted">Blue positive, orange negative. Pick other patches: similar-looking patches get similar embeddings.</p>
      </section>

      <section>
        <h2>4. Add its position</h2>
        <p>
          Attention has no sense of order, so without help the model could not tell the top-left patch from the bottom-right. A{' '}
          <b>position embedding</b> is added to each patch's embedding. Choose <i>position similarity</i> above: patches near the
          chosen one stay clear, because their position embeddings are similar. These are fixed sine and cosine waves for the row and the column; ViT
          learns its own in training, and they end up with much the same pattern.
        </p>
      </section>

      <section>
        <h2>5. Attention: every patch looks at every other</h2>
        <p>
          In one step, each patch can draw on every other patch in the image, wherever it is: fur relates to ear, sky to sky.
          Choose <i>attention from the chosen patch</i> above: the stronger the link, the clearer the patch (shaded ones get
          little attention). Then choose <i>what a CNN layer sees</i>: a convolution's first layer looks only at the 3 × 3
          neighbourhood, and builds up wider views layer by layer.
        </p>
        <div className="row small vi-controls">
          <label>
            Attention sharpness{' '}
            <input type="range" min={2} max={40} value={sharpness} onChange={(e) => setSharpness(+e.target.value)} /> {sharpness}
          </label>
        </div>
        <p className="small muted">
          A stand-in for a trained attention head: here a patch attends to patches with similar colour and texture. A trained ViT
          learns what to attend to, with many heads looking for different things.
        </p>
        <div className="card vi-why">
          <b>Why ViT needed so much data.</b> A CNN starts out assuming that nearby pixels belong together, which is usually true,
          so it learns well from fewer pictures. A ViT makes no such assumption: it has to learn from examples that neighbours
          matter. That costs more data at small scale, and wins once there is enough (ViT was trained on hundreds of millions of
          images).
        </div>
      </section>

      <section>
        <h2>6. One sequence with the text</h2>
        <p>
          In a multimodal model the image tokens and the text tokens go into the same sequence. "What is in this picture?" and
          "what comes after this sentence?" become the same operation: predict the next token.
        </p>
        <div className="vi-tokens">
          {Array.from({ length: Math.min(count, 24) }, (_, i) => (
            <span key={i} className="vi-tok img">
              ▣{i + 1}
            </span>
          ))}
          {count > 24 && <span className="vi-tok img">… ▣{count}</span>}
          {textTokens.map((t, i) => (
            <span key={i} className="vi-tok txt">
              {t}
            </span>
          ))}
          <span className="vi-tok next">→ next token</span>
        </div>
        <h3>What a picture costs, measured</h3>
        <p className="small">
          Image tokens are billed like text tokens. Measured on 2 November 2026: Claude with the API's token counter, GPT through
          your Azure deployment's reported usage, each minus the same question without the image.
        </p>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Image</th>
                <th className="num">Claude Opus 5.5 / Haiku 5.5</th>
                <th className="num">GPT-5.4 mini, detail high</th>
                <th className="num">GPT-5.4 mini, detail low</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['224 × 224', 67, 94, 68],
                ['512 × 512', 364, 301, 275],
                ['1000 × 1000', '1,299', 714, 275],
                ['2000 × 1500', '3,891', 903, 211],
              ].map((r) => (
                <tr key={r[0]}>
                  <td>{r[0]}</td>
                  <td className="num">{r[1]}</td>
                  <td className="num">{r[2]}</td>
                  <td className="num">{r[3]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Claude's count is close to width × height ÷ 750: about one token per 27 × 27 pixels. GPT resizes and tiles the image
          (detail high), or uses a small fixed view (detail low), so its count grows more slowly. Either way: resize pictures
          before sending them, to the smallest size that still shows what matters.
        </p>
      </section>
    </main>
  );
}

function PatchThumb({ patches, index, selected, onPick }: { patches: Patches; index: number; selected: boolean; onPick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = c.height = PATCH;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(PATCH, PATCH);
    const v = patches.vectors[index];
    for (let p = 0; p < PATCH * PATCH; p++) {
      img.data[p * 4] = v[p * 3] * 255;
      img.data[p * 4 + 1] = v[p * 3 + 1] * 255;
      img.data[p * 4 + 2] = v[p * 3 + 2] * 255;
      img.data[p * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [patches, index]);
  return (
    <button className={`vi-thumb ${selected ? 'on' : ''}`} onClick={onPick} title={`Patch ${index + 1}`}>
      <canvas ref={ref} />
      <span>{index + 1}</span>
    </button>
  );
}

function PatchZoom({ patches, index }: { patches: Patches; index: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const scale = 12;
    c.width = c.height = PATCH * scale;
    const ctx = c.getContext('2d')!;
    const v = patches.vectors[index];
    for (let y = 0; y < PATCH; y++) {
      for (let x = 0; x < PATCH; x++) {
        const i = (y * PATCH + x) * 3;
        ctx.fillStyle = `rgb(${v[i] * 255},${v[i + 1] * 255},${v[i + 2] * 255})`;
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
    ctx.strokeStyle = 'rgba(128,128,128,0.35)';
    for (let k = 1; k < PATCH; k++) {
      ctx.beginPath();
      ctx.moveTo(k * scale, 0);
      ctx.lineTo(k * scale, PATCH * scale);
      ctx.moveTo(0, k * scale);
      ctx.lineTo(PATCH * scale, k * scale);
      ctx.stroke();
    }
  }, [patches, index]);
  return <canvas ref={ref} className="vi-zoom" aria-label={`Patch ${index + 1}, enlarged`} />;
}
