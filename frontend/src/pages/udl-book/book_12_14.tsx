import { useMemo, useState } from 'react';
import { gauss, rng } from '../deep-learning/kit';
import { Chips, Readout, Slider } from '../deep-learning/Notebook';
import { Plot } from '../deep-learning/Plot';
import type { BookChapter } from './types';

/* ---------- formatting ---------- */

/** A count with a unit suffix: 174.6B, 30.72M. */
function human(n: number): string {
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [v, u] of units) if (Math.abs(n) >= v) return `${+(n / v).toPrecision(4)}${u}`;
  return String(Math.round(n));
}

const SUP: Record<string, string> = {
  '-': '⁻',
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
};

/** A large number in scientific form: 3.14 × 10²³. */
function sci(n: number): string {
  if (n === 0) return '0';
  const e = Math.floor(Math.log10(Math.abs(n)));
  const m = n / 10 ** e;
  return `${m.toFixed(2)} × 10${[...String(e)].map((c) => SUP[c] ?? c).join('')}`;
}

/** Bytes in decimal units, as memory sizes are usually quoted for GPUs. */
function bytes(n: number): string {
  const units: [number, string][] = [
    [1e12, 'TB'],
    [1e9, 'GB'],
    [1e6, 'MB'],
    [1e3, 'kB'],
  ];
  for (const [v, u] of units) if (n >= v) return `${+(n / v).toPrecision(3)} ${u}`;
  return `${Math.round(n)} B`;
}

/* ---------- 12.7d A decoder's size and cost ---------- */

type PresetId = 'bert' | 'gpt2' | 'gpt3' | 'custom';
type HeadSize = '64' | '128' | '256';
type KvMode = 'mha' | 'gqa' | 'mqa';
type PosMode = 'learned' | 'rope';

interface Config {
  layers: number;
  heads: number;
  dHead: HeadSize;
  vocab: number;
  ctx: number;
  kv: KvMode;
  pos: PosMode;
}

const PRESETS: Record<Exclude<PresetId, 'custom'>, { label: string; cfg: Config; quoted: string }> = {
  bert: {
    label: 'BERT-large (12.6)',
    cfg: { layers: 24, heads: 16, dHead: '64', vocab: 30000, ctx: 512, kv: 'mha', pos: 'learned' },
    quoted: 'about 340 million (book)',
  },
  gpt2: {
    label: 'GPT-2 XL',
    cfg: { layers: 48, heads: 25, dHead: '64', vocab: 50257, ctx: 1024, kv: 'mha', pos: 'learned' },
    quoted: '1.5 billion (Radford et al., 2019)',
  },
  gpt3: {
    label: 'GPT-3 (12.7)',
    cfg: { layers: 96, heads: 96, dHead: '128', vocab: 50257, ctx: 2048, kv: 'mha', pos: 'learned' },
    quoted: '175 billion (book)',
  },
};

/** Parameters, compute and cache for a transformer stack with a 4 × d_model MLP and tied input/output embeddings. */
function sizeOf(c: Config) {
  const dh = +c.dHead;
  const d = c.heads * dh;
  const kvHeads = c.kv === 'mha' ? c.heads : c.kv === 'gqa' ? Math.min(8, c.heads) : 1;
  const attn = 2 * d * d + 2 * d * kvHeads * dh; // Ω_q and Ω_o are d × d; Ω_k and Ω_v shrink with fewer KV heads
  const mlp = 8 * d * d; // d → 4d → d
  const small = 11 * d + 2 * kvHeads * dh; // biases and the two LayerNorms
  const tokenEmb = c.vocab * d;
  const posEmb = c.pos === 'learned' ? c.ctx * d : 0;
  const total = c.layers * (attn + mlp + small) + 2 * d + tokenEmb + posEmb;
  const matmul = c.layers * (attn + mlp) + tokenEmb; // the output layer reuses the embedding matrix
  const fwdWeights = 2 * matmul; // one multiply and one add per weight
  const fwdAttn = 4 * c.layers * c.ctx * d; // q·k for every earlier token, then the weighted sum of values
  const kvPerToken = 2 * c.layers * kvHeads * dh * 2; // keys and values, 16-bit
  return {
    d,
    kvHeads,
    total,
    tokenEmb,
    posEmb,
    attnAll: c.layers * attn,
    mlpAll: c.layers * mlp,
    smallAll: c.layers * small + 2 * d,
    fwdWeights,
    fwdAttn,
    kvPerToken,
  };
}

function DecoderCalculator() {
  const [preset, setPreset] = useState<PresetId>('gpt3');
  const [cfg, setCfg] = useState<Config>(PRESETS.gpt3.cfg);
  const [tokens, setTokens] = useState(300e9);
  const s = sizeOf(cfg);
  const set = (patch: Partial<Config>) => {
    setCfg((c) => ({ ...c, ...patch }));
    setPreset('custom');
  };
  const choose = (p: PresetId) => {
    setPreset(p);
    if (p !== 'custom') setCfg(PRESETS[p].cfg);
  };
  const fwd = s.fwdWeights + s.fwdAttn;
  const rows: [string, number][] = [
    ['Token embeddings (also the output layer)', s.tokenEmb],
    ['Position table', s.posEmb],
    ['Attention weights, all layers', s.attnAll],
    ['MLP weights, all layers', s.mlpAll],
    ['Biases and LayerNorms', s.smallAll],
  ];

  return (
    <>
      <div className="dl-controls">
        <Chips
          options={[
            ...(Object.keys(PRESETS) as Exclude<PresetId, 'custom'>[]).map((id) => ({ id, label: PRESETS[id].label })),
            { id: 'custom' as const, label: 'Your own' },
          ]}
          value={preset}
          onChange={choose}
        />
      </div>
      <div className="dl-controls">
        <Slider label="Layers" value={cfg.layers} min={1} max={128} step={1} onChange={(v) => set({ layers: v })} />
        <Slider label="Heads" value={cfg.heads} min={1} max={128} step={1} onChange={(v) => set({ heads: v })} />
        <Slider
          label="Vocabulary"
          value={cfg.vocab}
          min={1000}
          max={262144}
          step={1}
          onChange={(v) => set({ vocab: v })}
          show={human}
        />
        <Slider
          label="Context"
          value={Math.log2(cfg.ctx)}
          min={7}
          max={17}
          step={1}
          onChange={(v) => set({ ctx: 2 ** v })}
          show={(v) => (2 ** v).toLocaleString('en-GB')}
        />
        <Slider
          label="Training tokens"
          value={Math.log10(tokens)}
          min={9}
          max={13}
          step={0.01}
          onChange={(v) => setTokens(10 ** v)}
          show={() => human(tokens)}
        />
      </div>
      <div className="dl-controls">
        <span className="small muted">Head size</span>
        <Chips
          options={[
            { id: '64', label: '64' },
            { id: '128', label: '128' },
            { id: '256', label: '256' },
          ]}
          value={cfg.dHead}
          onChange={(v) => set({ dHead: v })}
        />
        <span className="small muted">Key/value heads</span>
        <Chips
          options={[
            { id: 'mha', label: 'one per head' },
            { id: 'gqa', label: '8 shared (GQA)' },
            { id: 'mqa', label: '1 shared (MQA)' },
          ]}
          value={cfg.kv}
          onChange={(v) => set({ kv: v })}
        />
        <span className="small muted">Positions</span>
        <Chips
          options={[
            { id: 'learned', label: 'learned table' },
            { id: 'rope', label: 'rotary (no parameters)' },
          ]}
          value={cfg.pos}
          onChange={(v) => set({ pos: v })}
        />
      </div>
      <div className="dl-cols">
        <div className="dl-scroll">
          <table className="dl-table">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}>
                  <th style={{ textAlign: 'left' }}>{k}</th>
                  <td>{human(v)}</td>
                  <td>{s.total ? `${((100 * v) / s.total).toFixed(1)}%` : ''}</td>
                </tr>
              ))}
              <tr>
                <th style={{ textAlign: 'left' }}>Total parameters</th>
                <td>
                  <b>{human(s.total)}</b>
                </td>
                <td>{preset !== 'custom' ? PRESETS[preset].quoted : ''}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Readout
          items={[
            ['d_model = heads × head size', s.d.toLocaleString('en-GB')],
            ['FLOPs per token, forward pass', sci(fwd)],
            ['…as a multiple of the parameter count', `${(fwd / s.total).toFixed(2)} ×`],
            ['share spent on attention scores at full context', `${((100 * s.fwdAttn) / fwd).toFixed(1)}%`],
            ['KV cache per token (16-bit)', bytes(s.kvPerToken)],
            ['KV cache for one full context', bytes(s.kvPerToken * cfg.ctx)],
            ['training compute ≈ 6 × parameters × tokens', `${sci(6 * s.total * tokens)} FLOPs`],
          ]}
        />
      </div>
      <p className="dl-caption">
        Each layer holds 4d² attention weights and 8d² MLP weights, so the count is close to 12 × layers × d². Every
        weight costs one multiply and one add per token, which is why a forward pass costs about 2 FLOPs per parameter.
        Attention adds 4 × layers × context × d for the token at the end of a full window; it is a small share at 2,048
        tokens and grows with the context. The book&apos;s figures are rounded, and small parts (BERT&apos;s pooler and
        segment embeddings) are left out here. Gated MLPs in newer models use three matrices; with a hidden size of 8d/3
        they also come to 8d², though many models choose a wider one.
      </p>
    </>
  );
}

/* ---------- 12.9 Sparse attention patterns ---------- */

type Pattern = 'full' | 'causal' | 'window' | 'dilated' | 'selected';
const GRID = 25;
const EVERY = 7; // in the "selected" pattern, every 7th token looks at everything before it

const PATTERNS: { id: Pattern; label: string }[] = [
  { id: 'full', label: 'Encoder: all pairs' },
  { id: 'causal', label: 'Decoder: causal' },
  { id: 'window', label: 'Window' },
  { id: 'dilated', label: 'Dilated window' },
  { id: 'selected', label: 'Window + selected tokens' },
];

/** Whether token i (the one asking) may attend to token j. */
function allowed(p: Pattern, i: number, j: number, w: number, r: number): boolean {
  if (p === 'full') return true;
  if (j > i) return false;
  const gap = i - j;
  if (p === 'causal') return true;
  if (p === 'window') return gap < w;
  if (p === 'dilated') return gap % r === 0 && gap / r < w;
  return gap < w || i % EVERY === 0;
}

/** How many tokens row i scores, without building the row. */
function rowCount(p: Pattern, i: number, n: number, w: number, r: number): number {
  if (p === 'full') return n;
  if (p === 'causal') return i + 1;
  if (p === 'window') return Math.min(i + 1, w);
  if (p === 'dilated') return Math.min(Math.floor(i / r) + 1, w);
  return i % EVERY === 0 ? i + 1 : Math.min(i + 1, w);
}

function pairs(p: Pattern, n: number, w: number, r: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) total += rowCount(p, i, n, w, r);
  return total;
}

/** Layers until the last token has (indirectly) heard from token `start`, or null if it never does. */
function layersToReach(p: Pattern, w: number, r: number, start = 0): number | null {
  let reach = Array.from({ length: GRID }, (_, i) => i === start);
  for (let layer = 1; layer <= GRID; layer++) {
    const prev = reach;
    reach = prev.map((has, i) => has || prev.some((h, j) => h && allowed(p, i, j, w, r)));
    if (reach[GRID - 1]) return layer;
  }
  return null;
}

const LOG_N = Array.from({ length: 13 }, (_, k) => 6 + k); // 64 to 262,144 tokens

function AttentionPatterns() {
  const [pattern, setPattern] = useState<Pattern>('window');
  const [w, setW] = useState(4);
  const [dil, setDil] = useState<'2' | '3'>('2');
  const r = +dil;
  const grid = GRID * GRID;
  const open = useMemo(() => pairs(pattern, GRID, w, r), [pattern, w, r]);
  const layers = useMemo(() => layersToReach(pattern, w, r), [pattern, w, r]);
  const unheard = useMemo(
    () => Array.from({ length: GRID - 1 }, (_, j) => layersToReach(pattern, w, r, j)).filter((l) => l === null).length,
    [pattern, w, r],
  );
  const curve = useMemo(() => LOG_N.map((e) => Math.log10(pairs(pattern, 2 ** e, w, r))), [pattern, w, r]);
  const full = LOG_N.map((e) => Math.log10(2 ** e * 2 ** e));
  const causal = LOG_N.map((e) => Math.log10((2 ** e * (2 ** e + 1)) / 2));
  const cell = 10;

  return (
    <>
      <div className="dl-controls">
        <Chips options={PATTERNS} value={pattern} onChange={setPattern} />
      </div>
      <div className="dl-controls">
        <Slider label="Window (tokens)" value={w} min={2} max={10} step={1} onChange={setW} />
        {pattern === 'dilated' && (
          <>
            <span className="small muted">Dilation</span>
            <Chips
              options={[
                { id: '2', label: 'every 2nd token' },
                { id: '3', label: 'every 3rd token' },
              ]}
              value={dil}
              onChange={setDil}
            />
          </>
        )}
      </div>
      <div className="dl-cols">
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
            Which pairs are scored ({GRID} tokens)
          </div>
          <svg
            viewBox={`0 0 ${GRID * cell} ${GRID * cell}`}
            style={{ width: '100%', maxWidth: 260, display: 'block', background: 'var(--surface)' }}
            role="img"
            aria-label="Attention mask: rows are the token asking, columns the token it looks at"
          >
            {Array.from({ length: GRID }, (_, i) =>
              Array.from({ length: GRID }, (_, j) => (
                <rect
                  key={`${i}-${j}`}
                  x={j * cell + 0.5}
                  y={i * cell + 0.5}
                  width={cell - 1}
                  height={cell - 1}
                  rx={1.5}
                  style={{
                    fill: allowed(pattern, i, j, w, r)
                      ? i === GRID - 1
                        ? 'var(--s2)'
                        : 'var(--brand)'
                      : 'color-mix(in srgb, var(--line) 60%, transparent)',
                  }}
                />
              )),
            )}
          </svg>
          <p className="dl-caption">
            Rows: the token asking. Columns: the tokens it may look at. The last row is the newest token.
          </p>
        </div>
        <div>
          <Plot
            x={[6, 18]}
            y={[1, 11]}
            height={220}
            xLabel="log₂ tokens"
            yLabel="log₁₀ pairs scored"
            ariaLabel="Pairs scored per layer against sequence length"
            draw={(f) => {
              f.line(LOG_N, full, f.c.s1, 1.5, [5, 4]);
              f.line(LOG_N, causal, f.c.s3, 1.5, [2, 3]);
              f.line(LOG_N, curve, f.c.brand, 2.5);
            }}
          />
          <div className="dl-legend">
            <span>
              <i style={{ background: 'var(--s1)' }} />
              all pairs (N²)
            </span>
            <span>
              <i style={{ background: 'var(--s3)' }} />
              causal (about N²/2)
            </span>
            <span>
              <i style={{ background: 'var(--brand)' }} />
              chosen pattern
            </span>
          </div>
        </div>
      </div>
      <Readout
        items={[
          ['pairs scored per layer, 25 tokens', `${open} of ${grid}`],
          ['pairs at 262,144 tokens', human(10 ** curve[curve.length - 1])],
          ['layers before the last token hears from the first', layers === null ? 'never' : String(layers)],
          ['earlier tokens the last token can never hear from', String(unheard)],
        ]}
      />
      <p className="dl-caption">
        A window keeps the cost linear in length, but information then crawls back one window per layer. Dilation
        stretches the reach but skips the tokens in between, however many layers you stack; that is why dilated windows
        are mixed with plain ones. Letting a few tokens see everything shortens the path, but those rows still grow with
        the length, so the cost stays quadratic, only smaller.
      </p>
    </>
  );
}

/* ---------- 14.3d Precision, recall and the Fréchet distance ---------- */

type Pt = [number, number];
const CENTRES: Pt[] = [
  [-1.5, -1.5],
  [1.5, 1.5],
  [-1.5, 1.5],
  [1.5, -1.5],
];
const N_PTS = 150;
const SD = 0.35;
const K_NN = 3;

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Each point's radius: the distance to its kth nearest neighbour in the same set. */
function radii(ps: Pt[]): number[] {
  return ps.map((p, i) => {
    const ds = ps.filter((_, j) => j !== i).map((q) => dist(p, q));
    ds.sort((a, b) => a - b);
    return ds[K_NN - 1];
  });
}

/** The share of `ps` that fall inside at least one ball around the points of `set`. */
function covered(ps: Pt[], set: Pt[], rs: number[]): number {
  return ps.filter((p) => set.some((q, j) => dist(p, q) <= rs[j])).length / ps.length;
}

/** Fréchet distance between Gaussians fitted to two 2D samples (the FID formula, on raw points). */
function frechet(a: Pt[], b: Pt[]): number {
  const fit = (ps: Pt[]) => {
    const n = ps.length;
    const mx = ps.reduce((s, p) => s + p[0], 0) / n;
    const my = ps.reduce((s, p) => s + p[1], 0) / n;
    let xx = 0;
    let yy = 0;
    let xy = 0;
    for (const [x, y] of ps) {
      xx += (x - mx) ** 2;
      yy += (y - my) ** 2;
      xy += (x - mx) * (y - my);
    }
    return { m: [mx, my], c: [xx / n, xy / n, yy / n] };
  };
  const A = fit(a);
  const B = fit(b);
  const [a1, a2, a3] = A.c;
  const [b1, b2, b3] = B.c;
  // M = Σa Σb; for a 2 × 2 matrix with non-negative eigenvalues, tr √M = √(tr M + 2 √det M).
  const tr = a1 * b1 + a2 * b2 + a2 * b2 + a3 * b3;
  const det = (a1 * a3 - a2 * a2) * (b1 * b3 - b2 * b2);
  const trSqrt = Math.sqrt(Math.max(0, tr + 2 * Math.sqrt(Math.max(0, det))));
  const dm = (A.m[0] - B.m[0]) ** 2 + (A.m[1] - B.m[1]) ** 2;
  return dm + a1 + a3 + b1 + b3 - 2 * trSqrt;
}

function GenerativeMetrics() {
  const [modes, setModes] = useState(4);
  const [spread, setSpread] = useState(1);
  const [copy, setCopy] = useState(false);
  const [discs, setDiscs] = useState(true);

  const real = useMemo<Pt[]>(() => {
    const rand = rng(7);
    return Array.from({ length: N_PTS }, (_, i) => {
      const c = CENTRES[i % 4];
      return [c[0] + SD * gauss(rand), c[1] + SD * gauss(rand)];
    });
  }, []);
  const noise = useMemo<Pt[]>(() => {
    const rand = rng(21);
    return Array.from({ length: N_PTS }, () => [gauss(rand), gauss(rand)]);
  }, []);
  const gen = useMemo<Pt[]>(
    () =>
      copy
        ? real
        : noise.map(([u, v], i) => {
            const c = CENTRES[i % modes];
            return [c[0] + SD * spread * u, c[1] + SD * spread * v];
          }),
    [copy, real, noise, modes, spread],
  );
  const rReal = useMemo(() => radii(real), [real]);
  const m = useMemo(() => {
    const rGen = radii(gen);
    return { precision: covered(gen, real, rReal), recall: covered(real, gen, rGen), fd: frechet(real, gen) };
  }, [gen, real, rReal]);

  return (
    <>
      <div className="dl-controls">
        <Slider label="Modes the model covers" value={modes} min={1} max={4} step={1} onChange={setModes} />
        <Slider
          label="Sample spread"
          value={spread}
          min={0.3}
          max={3}
          step={0.05}
          onChange={setSpread}
          show={(v) => `×${v.toFixed(2)}`}
        />
        <label className="small">
          <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} /> Model copies the training
          set
        </label>
        <label className="small">
          <input type="checkbox" checked={discs} onChange={(e) => setDiscs(e.target.checked)} /> Show the real-data
          manifold
        </label>
      </div>
      <Plot
        x={[-3.2, 3.2]}
        y={[-3.2, 3.2]}
        height={300}
        ariaLabel="Real points and generated points in two dimensions"
        draw={(f) => {
          if (discs) {
            f.ctx.save();
            f.ctx.globalAlpha = 0.12;
            f.ctx.fillStyle = f.c.s1;
            real.forEach((p, i) => {
              f.ctx.beginPath();
              f.ctx.arc(f.x(p[0]), f.y(p[1]), Math.abs(f.x(rReal[i]) - f.x(0)), 0, Math.PI * 2);
              f.ctx.fill();
            });
            f.ctx.restore();
          }
          f.dots(real, f.c.s1, 2.5);
          f.dots(gen, f.c.s2, 2.5);
        }}
      />
      <div className="dl-legend">
        <span>
          <i style={{ background: 'var(--s1)' }} />
          real data
        </span>
        <span>
          <i style={{ background: 'var(--s2)' }} />
          generated samples
        </span>
      </div>
      <Readout
        items={[
          ['Fréchet distance (lower is better)', m.fd.toFixed(3)],
          ['precision: samples that look real', `${Math.round(100 * m.precision)}%`],
          ['recall: real data the model can produce', `${Math.round(100 * m.recall)}%`],
        ]}
      />
      <p className="dl-caption">
        Each set&apos;s manifold is the union of balls reaching each point&apos;s 3rd nearest neighbour. Here the
        metrics work on the raw points; FID and the published precision/recall work on a classifier&apos;s features of
        images. Same seed every time.
      </p>
    </>
  );
}

/* ---------- the chapters ---------- */

export const CHAPTERS: BookChapter[] = [
  {
    n: 12,
    title: 'Transformers',
    offers: (
      <>
        <p>
          The chapter at the heart of this lab. It builds dot-product self-attention from first principles, adds the
          three extensions every real model uses (positions, scaling, multiple heads), and wraps them into the
          transformer layer. It then walks through the three families with a named example each: BERT (encoder), GPT-3
          (decoder) and a translation model (encoder–decoder).
        </p>
        <p>
          It ends with the two pressures that still shape research: attention&apos;s cost grows with the square of the
          sequence length, and the same layers turn out to work on image patches as well as words.
        </p>
      </>
    ),
    examples: [
      {
        id: '12.1',
        title: 'Processing text data',
        page: 207,
        shows: (
          <p>
            A three-sentence restaurant review sets out what a text model needs. Its 37 words at 1,024 numbers each are
            already 37,888 inputs, so a fully connected network is out. Passages vary in length, so the weights must be
            shared across positions, as convolution shares them across pixels. And &quot;it&quot; and &quot;their&quot;
            refer back to the restaurant, so words need links to each other whose strength depends on the words
            themselves. Self-attention is designed to meet all three needs.
          </p>
        ),
      },
      {
        id: '12.2',
        title: 'Dot-product self-attention',
        page: 208,
        shows: (
          <>
            <p>
              Each input makes a value with shared weights, and each output is a weighted mix of all the values, with
              weights that are positive and sum to one. The weights come from comparing a query from one token with a
              key from every token, then taking a softmax. In matrix form the whole layer is{' '}
              <i>Sa[X] = V · Softmax[KᵀQ]</i>.
            </p>
            <p>
              The point to take away: the parameters do not depend on the length <i>N</i>, but the number of attention
              weights grows as <i>N²</i>. The book also notes that attention is a hypernetwork: one branch computes the
              weights that the other branch applies.
            </p>
          </>
        ),
        notebooks: ['12.1'],
      },
      {
        id: '12.3a',
        title: 'Positional encoding',
        page: 213,
        shows: (
          <p>
            Attention treats its inputs as a set: shuffle the words and the outputs shuffle with them. So &quot;the
            woman ate the raccoon&quot; and &quot;the raccoon ate the woman&quot; would look alike. Two fixes: add an{' '}
            <b>absolute</b> position vector to each input (fixed sinusoids or learned), or make the attention between
            two tokens depend on their <b>relative</b> offset, through a learned term per offset. Relative positions
            matter more in text, which is why today&apos;s models use a relative scheme.
          </p>
        ),
      },
      {
        id: '12.3b',
        title: 'Scaled dot-product self-attention',
        page: 214,
        shows: (
          <p>
            Dot products of long vectors get large, and a softmax of large numbers puts nearly all its weight on one
            token, where gradients vanish. Dividing the scores by <i>√D_q</i>, the square root of the query and key
            size, keeps the softmax soft enough to train.
          </p>
        ),
        notebooks: ['12.1'],
      },
      {
        id: '12.3c',
        title: 'Multiple heads',
        page: 214,
        shows: (
          <p>
            Several attention mechanisms run side by side, each with its own queries, keys and values of size <i>D/H</i>
            , and a final matrix <i>Ω_c</i> mixes their concatenated outputs. Splitting the width this way keeps the
            cost of <i>H</i> heads equal to one full-width head. The book notes that multiple heads seem necessary in
            practice, perhaps because they make training less sensitive to a bad start.
          </p>
        ),
        notebooks: ['12.2'],
      },
      {
        id: '12.4',
        title: 'The transformer layer',
        page: 215,
        shows: (
          <p>
            One layer is multi-head attention (tokens exchange information) followed by a small MLP applied to each
            token on its own. Both are residual blocks, and each is followed by LayerNorm over the token&apos;s <i>D</i>{' '}
            numbers. A model is a stack of these, and the output has the same shape as the input, so layers can be
            stacked freely.
          </p>
        ),
      },
      {
        id: '12.5a',
        title: 'Tokenisation',
        page: 218,
        shows: (
          <p>
            Whole words fail on names, punctuation and endings (walk, walks, walked); single letters make sequences long
            and leave the network to relearn spelling. Byte pair encoding sits between the two: it starts from
            characters and keeps merging the most frequent neighbouring pair, so common words become one token and rare
            ones are built from pieces.
          </p>
        ),
        notebooks: ['12.3'],
      },
      {
        id: '12.5b',
        title: 'Embeddings',
        page: 218,
        shows: (
          <p>
            Each token picks out one column of a learned matrix <i>Ω_e</i>, written as a product with one-hot vectors:{' '}
            <i>X = Ω_e T</i>. With the book&apos;s typical sizes (<i>D</i> = 1,024, a vocabulary of 30,000) that one
            matrix holds about 30.7 million parameters before the first layer. The same word always gets the same
            starting vector; context only enters through attention.
          </p>
        ),
      },
      {
        id: '12.6a',
        title: 'BERT: an encoder',
        page: 219,
        shows: (
          <p>
            The book&apos;s encoder example, with full numbers: a 30,000-token vocabulary, 1,024-dimensional embeddings,
            24 layers, 16 heads of size 64, an MLP hidden layer of 4,096, and about 340 million parameters in all. Every
            token attends to every other token in both directions. The calculator under 12.7d rebuilds this count from
            the shapes.
          </p>
        ),
        notebooks: ['12.5'],
      },
      {
        id: '12.6b',
        title: 'BERT pre-training: predicting masked words',
        page: 220,
        shows: (
          <>
            <p>
              Self-supervision: hide a small share of the tokens behind a <i>&lt;mask&gt;</i> token and train the model
              to predict them from both sides. No labels are needed, so any text will do. BERT trained on inputs of up
              to 512 tokens, in batches of 256, for a million steps: about 50 passes over a 3.3-billion-word corpus.
            </p>
            <p>
              Filling gaps teaches some grammar (adjectives come before nouns) and shallow facts (a train, not a peanut,
              pulls into a station). The cost: only the masked positions add to the loss, so most of each input teaches
              nothing directly. A second task, guessing whether two sentences were adjacent, helped only a little.
            </p>
          </>
        ),
        notebooks: ['12.5'],
      },
      {
        id: '12.6c',
        title: 'BERT fine-tuning: three task shapes',
        page: 221,
        shows: (
          <p>
            After pre-training, a small head is added and trained on labelled data. <b>Text classification</b>: the
            output at the <i>&lt;cls&gt;</i> token goes through a sigmoid, for example for sentiment.{' '}
            <b>Word classification</b>: each token&apos;s output gets a softmax over entity types (person, place,
            organisation, none). <b>Span prediction</b> (SQuAD 1.1): each token scores how likely the answer starts and
            ends there, and two softmaxes give the most likely span.
          </p>
        ),
      },
      {
        id: '12.7a',
        title: 'GPT-3: language modelling',
        page: 222,
        shows: (
          <p>
            A decoder has one job: predict the next token. The chain rule turns the probability of a whole sentence into
            a product of next-word probabilities: for the book&apos;s nine-word sentence, <i>Pr(It)</i> ×{' '}
            <i>Pr(takes | It)</i> × … × <i>Pr(weak | all eight before)</i>. So getting each next word right is the same
            as giving the whole text a high probability.
          </p>
        ),
      },
      {
        id: '12.7b',
        title: 'GPT-3: masked self-attention',
        page: 223,
        shows: (
          <p>
            To train on every position of a sentence in one pass, each position must not see the words it is meant to
            predict. Setting the scores for later tokens to −∞ before the softmax gives them zero weight. Tokens only
            meet inside attention, so this one change is enough. Unlike BERT, every position now adds a term to the
            loss, which uses the data far better, at the price of seeing only the left context.
          </p>
        ),
        notebooks: ['12.5'],
      },
      {
        id: '12.7c',
        title: 'GPT-3: generating text',
        page: 223,
        shows: (
          <p>
            A decoder is the book&apos;s first generative model. Feed in a start, pick or sample the next token, append
            it, repeat. Because earlier positions never look ahead, their work can be kept and reused as the text grows
            (this is the KV cache). How to pick matters: beam search looks for the most likely whole sequence, while
            top-k sampling draws only from the <i>k</i> most likely tokens to avoid the long tail.
          </p>
        ),
        notebooks: ['12.4'],
      },
      {
        id: '12.7d',
        title: 'GPT-3 and few-shot learning',
        page: 224,
        shows: (
          <>
            <p>
              GPT-3 at full scale: sequences of 2,048 tokens, batches of 3.2 million tokens, 96 layers (some with a
              sparse attention pattern), embeddings of 12,288, 96 heads of size 128, 175 billion parameters, trained on
              300 billion tokens. The book shows it continuing a paragraph about the book itself: fluent, and only
              partly accurate.
            </p>
            <p>
              The surprise at this scale is <b>few-shot learning</b>: give a few input/output pairs, such as clumsy
              sentences and their corrected versions, then a new input, and the model often completes the pattern with
              no retraining. The book is careful: results are erratic, and it is unclear how much is generalisation and
              how much is recall of training text. The calculator rebuilds the 175 billion from the shapes and shows
              what one token costs.
            </p>
          </>
        ),
        Demo: DecoderCalculator,
      },
      {
        id: '12.8',
        title: 'Encoder–decoder: machine translation',
        page: 226,
        shows: (
          <p>
            For English to French, an encoder reads the English sentence and a decoder writes the French one with masked
            self-attention. Between the two in each decoder layer sits <b>cross-attention</b>: queries come from the
            French tokens, keys and values from the encoder&apos;s outputs. Each French word is therefore predicted from
            the French so far and the whole English sentence. The loss is the decoder&apos;s next-token loss.
          </p>
        ),
        notebooks: ['12.5'],
      },
      {
        id: '12.9',
        title: 'Transformers for long sequences',
        page: 227,
        shows: (
          <p>
            Every token scoring every other token makes the cost grow with <i>N²</i>; a decoder halves the pairs but is
            still quadratic. The book&apos;s remedy is to thin out the matrix: a convolution-like window around each
            token, wider reach through dilation, a few chosen tokens that see everything earlier, or extra global tokens
            that link to all. Over several layers the window&apos;s reach grows, as a receptive field does in a CNN. The
            demo shows the trade: fewer pairs, more layers before distant tokens can meet.
          </p>
        ),
        Demo: AttentionPatterns,
      },
      {
        id: '12.10a',
        title: 'ImageGPT',
        page: 229,
        shows: (
          <p>
            A decoder that predicts the next pixel. The quadratic cost bites hard: even with 6.8 billion parameters it
            worked on 64 × 64 images, with colours cut to 9 bits so that each pixel is one of 512 tokens. Each pixel has
            its own learned position, so the model must learn that the pixel above is a neighbour. Used for ImageNet
            classification at 48 × 48, it reached a 27.4% top-1 error, worse than CNNs of the time.
          </p>
        ),
      },
      {
        id: '12.10b',
        title: 'Vision Transformer (ViT)',
        page: 229,
        shows: (
          <p>
            ViT solves the resolution problem by cutting the image into 16 × 16-pixel patches, each mapped to an
            embedding by a learned linear layer, with learned 1D positions and a <i>&lt;cls&gt;</i> token: BERT&apos;s
            design applied to patches. Pre-trained with labels on 303 million images in 18,000 classes, it reached an
            11.45% top-1 error on ImageNet. Without that much data it trailed the best CNNs: attention has to learn the
            locality a convolution gets for free.
          </p>
        ),
      },
      {
        id: '12.10c',
        title: 'Multi-scale vision transformers: SWin and DaViT',
        page: 230,
        shows: (
          <p>
            SWin works like a CNN: attention only within small windows of patches, windows shifted on alternate layers
            so information crosses their edges, and 2 × 2 groups of patches merged as it goes deeper. It averages the
            final features rather than using a <i>&lt;cls&gt;</i> token, and reached a 9.89% top-1 error. DaViT
            alternates attention between patches with attention between channels, reaching 9.60%.
          </p>
        ),
      },
    ],
    inLlms: (
      <>
        <p>
          The large models with published designs (Llama, Mistral, Qwen, DeepSeek, Gemma) are decoder-only transformers
          trained exactly as in 12.7: masked self-attention, next-token loss at every position, sampling at the end.
          What has changed since GPT-3 is mostly the parts. The LayerNorm moved in front of each block (pre-norm) and is
          often RMSNorm. Learned absolute positions gave way to rotary embeddings (RoPE), a relative scheme. The MLP is
          gated (SwiGLU), and many models replace it with a mixture of experts so that each token uses only some of the
          weights.
        </p>
        <p>
          The reuse of earlier work noted in 12.7.3 is the <b>KV cache</b>, and its size (layers × heads × head size ×
          tokens) drives the cost of serving long chats. Grouped-query attention cuts it by sharing keys and values
          between heads. GPT-3 already mixed dense and banded sparse layers; Mistral 7B and Gemma 2 use sliding-window
          layers to cap attention cost. Few-shot learning became <b>in-context learning</b>, the basis of prompting.
        </p>
        <p>
          The other two families survive in supporting roles. BERT-style encoders power many embedding models and
          rerankers in retrieval. Whisper, the speech recogniser, is an encoder–decoder. And multimodal models read
          images through a ViT-style encoder whose patch embeddings are fed to the language model as tokens.
        </p>
      </>
    ),
    next: [
      'FlashAttention (Dao et al., 2022) computes exact attention tile by tile in on-chip memory, so the N × N score matrix of 12.9 is never written to main memory and memory use grows linearly with length.',
      'Multi-query attention (Shazeer, 2019), grouped-query attention (Ainslie et al., 2023) and multi-head latent attention (DeepSeek-AI, 2024) shrink the KV cache by sharing or compressing the keys and values of 12.3.3.',
      "RoPE (Su et al., 2021) and ALiBi (Press et al., 2021) take the book's relative positions further; YaRN (Peng et al., 2023) stretches RoPE to longer contexts than a model was trained on.",
      'The sparse patterns of 12.9 in use: Longformer (Beltagy et al., 2020) and BigBird (Zaheer et al., 2020) combine windows with global tokens, and Mistral 7B (Jiang et al., 2023) uses sliding windows. Ring attention (Liu et al., 2023) instead keeps attention exact and splits a long sequence across many devices.',
      'Replacing attention: Mamba (Gu and Dao, 2023) is a selective state-space model whose cost grows linearly with length, and Jamba (Lieber et al., 2024) interleaves Mamba layers with attention layers.',
    ],
    labs: [
      ['/transformer', 'Transformer explainer'],
      ['/what-is-gpt', 'What is GPT'],
      ['/tokens', 'Tokens'],
      ['/sampling', 'Sampling'],
      ['/transformer-tricks', 'Transformer tricks'],
      ['/building', 'How LLMs are built'],
      ['/vision', 'Images as tokens'],
      ['/hardware', 'Hardware for AI'],
    ],
  },
  {
    n: 13,
    title: 'Graph neural networks',
    offers: (
      <p>
        How to learn from data made of nodes and edges: molecules, road maps, citation networks, social networks. The
        chapter shows how to encode a graph as matrices, why any network on it must ignore the arbitrary order of the
        nodes, and how graph convolutional layers pass messages between neighbours. It also covers the practical problem
        of training on one graph with millions of nodes, and ends by showing that graph attention is close kin to the
        transformer.
      </p>
    ),
    examples: [
      {
        id: '13.1',
        title: 'What is a graph?',
        page: 240,
        shows: (
          <p>
            A tour of graphs in the wild: roads, molecules and circuits are graphs by nature; social networks,
            citations, Wikipedia links, program code, point clouds and protein interactions can be framed as graphs.
            Edges may be undirected (friendship) or directed (citation). A knowledge graph, with several kinds of node
            and of relation, is a directed heterogeneous multigraph. A set is a graph where every node links to every
            other, which is the view that connects graphs to attention.
          </p>
        ),
      },
      {
        id: '13.2a',
        title: 'The adjacency matrix and walks',
        page: 244,
        shows: (
          <p>
            A graph is stored as an adjacency matrix <i>A</i>, a node-feature matrix <i>X</i> and, if needed, an
            edge-feature matrix <i>E</i>. Multiplying a one-hot node vector by <i>A</i> lists its neighbours; by{' '}
            <i>A²</i>, the number of two-step walks to every node. In general <i>A^L</i> counts walks of length <i>L</i>
            , and a non-zero entry means the two nodes are at most <i>L</i> steps apart.
          </p>
        ),
        notebooks: ['13.1'],
      },
      {
        id: '13.2b',
        title: 'Permuting the node indices',
        page: 245,
        shows: (
          <p>
            Numbering the nodes differently changes the matrices (<i>X′ = XP</i>, <i>A′ = PᵀAP</i>) but not the graph.
            Unlike shuffling pixels or words, this changes nothing real, so any processing must give answers that do not
            depend on the numbering.
          </p>
        ),
        notebooks: ['13.1'],
      },
      {
        id: '13.3',
        title: 'Tasks and loss functions',
        page: 246,
        shows: (
          <p>
            Three kinds of question. <b>Graph-level</b>: average the final node embeddings (mean pooling), then a
            sigmoid, for example to say whether a molecule is poisonous. <b>Node-level</b>: the same head applied to
            each node on its own. <b>Edge prediction</b>: the dot product of two node embeddings through a sigmoid gives
            the chance that they should be linked, as in suggesting friends.
          </p>
        ),
      },
      {
        id: '13.4',
        title: 'A simple graph convolutional layer',
        page: 250,
        shows: (
          <p>
            Each node sums its neighbours&apos; embeddings, adds its own, applies one shared linear map, a bias and a
            ReLU:{' '}
            <i>
              H<sub>k+1</sub> = a[β<sub>k</sub>1ᵀ + Ω<sub>k</sub>H<sub>k</sub>(A + I)]
            </i>
            . The same weights serve every node, any number of neighbours works, and reordering the nodes reorders the
            output in the same way (equivariance). Mean pooling at the end makes a graph-level answer fully invariant.
          </p>
        ),
        notebooks: ['13.2'],
      },
      {
        id: '13.5a',
        title: 'Graph classification: is a molecule toxic?',
        page: 251,
        shows: (
          <p>
            The worked example: atoms are nodes, bonds are edges, and each atom starts as a one-hot vector over the 118
            elements. The first weight matrix maps that to any width <i>D</i>, a stack of GCN layers follows, and mean
            pooling plus a sigmoid gives the probability that the molecule is toxic, trained with binary cross-entropy.
          </p>
        ),
        notebooks: ['13.2'],
      },
      {
        id: '13.5b',
        title: 'Batching graphs of different sizes',
        page: 251,
        shows: (
          <p>
            Graphs with different node counts cannot be stacked into one tensor. The fix is to treat a batch as one big
            graph made of disconnected pieces, run the layers once, and pool each piece separately. The same packing
            idea is used to batch variable-length text without padding.
          </p>
        ),
      },
      {
        id: '13.6',
        title: 'Inductive and transductive learning',
        page: 252,
        shows: (
          <p>
            Inductive learning finds a rule from labelled graphs and applies it to new ones (many molecules).
            Transductive learning has one graph, partly labelled, and fills in the rest (one citation network); it can
            use the unlabelled nodes but must be rerun when the graph grows. Graph-level tasks are always inductive;
            node and edge tasks can be either.
          </p>
        ),
      },
      {
        id: '13.7a',
        title: 'Node classification on a huge graph',
        page: 253,
        shows: (
          <p>
            The second worked example: one graph with millions of nodes, some labelled. The body is the same GCN, the
            head gives a sigmoid per node, and the loss counts only labelled nodes. Two problems follow: storing every
            layer&apos;s embeddings for the whole graph is too much memory, and with one graph it is unclear what a
            batch is.
          </p>
        ),
      },
      {
        id: '13.7b',
        title: 'Neighbourhood sampling and graph partitioning',
        page: 254,
        shows: (
          <p>
            A batch of nodes only needs its <i>K</i>-hop neighbourhood, but in a dense graph that can be nearly
            everything (the graph expansion problem). <b>Neighbourhood sampling</b> keeps only a fixed number of
            neighbours per node at each layer, drawn afresh per batch, which also regularises like dropout.{' '}
            <b>Partitioning</b> cuts the graph into well-connected clusters that serve as batches. Inference needs
            neither, since nothing is stored for gradients.
          </p>
        ),
        notebooks: ['13.3'],
      },
      {
        id: '13.8a',
        title: 'Other ways to aggregate and combine',
        page: 256,
        shows: (
          <p>
            Variants of the layer: weight the node itself by a learned <i>1 + ε</i> (diagonal enhancement, the update
            used by GIN (Xu et al., 2019) with an MLP in place of one layer), or give it its own matrix; use residual
            connections; take the mean of the neighbours (<i>AD⁻¹</i>) so the size of a neighbourhood does not swamp its
            content; use Kipf normalisation (<i>D^−½ A D^−½</i>), which down-weights well-connected neighbours; or take
            an element-wise maximum.
          </p>
        ),
      },
      {
        id: '13.8b',
        title: 'Aggregation by attention',
        page: 258,
        shows: (
          <p>
            In a graph attention layer the weights on neighbours depend on their data, as in a transformer. The
            differences are small: one transformed embedding serves as query, key and value; similarity comes from a
            learned vector applied to the pair; and the softmax is masked to each node&apos;s neighbours and itself.
            Take away the mask and you are close to self-attention on a fully connected graph.
          </p>
        ),
        notebooks: ['13.4'],
      },
      {
        id: '13.9',
        title: 'Edge graphs',
        page: 260,
        shows: (
          <p>
            To learn about edges (road lengths, bond types), turn each edge into a node and link two of these when their
            edges share an end. The same layers then update edge embeddings, and a model can alternate between nodes
            updating nodes, nodes updating edges and the reverse.
          </p>
        ),
      },
    ],
    inLlms: (
      <>
        <p>
          A standard LLM contains no graph neural network, but the connection is real. A transformer layer is message
          passing on a complete graph: each token is a node, attention weights are learned edge strengths, and the
          causal mask removes the edges that point to the future, leaving a directed acyclic graph. Graph attention
          (13.8b) differs mainly in having a sparse mask from the data. Both are equivariant to reordering, which is why
          an LLM must add positions (12.3a) while a GNN usually does not want them.
        </p>
        <p>
          Graphs appear more directly around LLMs. Knowledge graphs feed retrieval systems, packing variable-sized
          examples into one batch (13.5b) is how training pipelines avoid padding, and graph-theory tools are now used
          to analyse how information flows through a decoder&apos;s layers.
        </p>
      </>
    ),
    next: [
      'Graph transformers (Dwivedi and Bresson, 2020; Ying et al., 2021, Graphormer) give every node attention over the whole graph and feed the structure in as positional encodings or attention biases: the mirror image of an LLM adding positions to a set of tokens.',
      'Over-squashing (Alon and Yahav, 2021) describes how too much information is squeezed through too few paths in a GNN; Barbero et al. (2024) apply the same analysis to decoder-only transformers to explain failures at counting and copying in long inputs.',
      'GraphRAG (Edge et al., 2024) has an LLM extract a knowledge graph from documents, group it into communities and summarise each, so questions about a whole collection can be answered.',
      'Feeding graphs to LLMs: Fatemi et al. (2023) found that the way a graph is written as text changes accuracy on graph reasoning tasks, and GraphToken (Perozzi et al., 2024) instead learns a GNN encoder whose output is passed to a frozen LLM as soft tokens.',
    ],
    labs: [
      ['/deep-learning', 'Deep learning notebooks'],
      ['/transformer', 'Transformer explainer'],
      ['/embeddings', 'Embeddings and retrieval'],
    ],
  },
  {
    n: 14,
    title: 'Unsupervised learning',
    offers: (
      <p>
        A short bridge chapter into the book&apos;s generative models. It sorts unsupervised models into a family tree
        (latent variable, generative, probabilistic), lists what a good generative model should do, and explains how
        people try to measure that: test likelihood, the inception score, the Fréchet inception distance, and manifold
        precision and recall. The criteria apply directly to judging LLMs.
      </p>
    ),
    examples: [
      {
        id: '14.1',
        title: 'A taxonomy of unsupervised models',
        page: 269,
        shows: (
          <p>
            Without labels, a common move is to link each example <i>x</i> to a hidden, usually smaller, variable{' '}
            <i>z</i>. k-means maps data to a cluster number; generative models go the other way, drawing <i>z</i> from a
            known distribution and mapping it to data. GANs only generate. Normalising flows, VAEs and diffusion models
            are also probabilistic: they assign <i>Pr(x|φ)</i> and train by minimising the negative log-likelihood{' '}
            <i>−Σ log Pr(x_i|φ)</i>. A footnote names the transformer decoder of 12.7 as a probabilistic generative
            model with no latent variable at all.
          </p>
        ),
      },
      {
        id: '14.2',
        title: 'What makes a good generative model',
        page: 270,
        shows: (
          <p>
            Six properties: cheap, parallel sampling; samples that pass for real; coverage of the whole data rather than
            a favourite corner; a smooth latent space where every point gives plausible data; a disentangled one where
            each direction changes one meaningful property; and, if probabilistic, a cheap exact likelihood. A table
            scores GANs, VAEs, flows and diffusion against them, and none ticks every box.
          </p>
        ),
      },
      {
        id: '14.3a',
        title: 'Test likelihood',
        page: 272,
        shows: (
          <p>
            Score a probabilistic model by the probability it gives held-out data. Training likelihood is useless: a
            model could put all its mass on the training points. Test likelihood rewards generalisation and coverage,
            since mass spent on one region is missing elsewhere. It is exact only for normalising flows, a bound for
            VAEs and diffusion, and undefined for GANs.
          </p>
        ),
      },
      {
        id: '14.3b',
        title: 'Inception score',
        page: 272,
        shows: (
          <p>
            For ImageNet-style images: a pre-trained classifier should be confident about each generated image, and the
            classes should be even across the whole set. The score is the exponential of the average KL divergence
            between each image&apos;s class distribution and the overall one. Its weaknesses: it depends on the
            classifier, suits only ImageNet-like data, and is happy with one good image per class.
          </p>
        ),
      },
      {
        id: '14.3c',
        title: 'Fréchet inception distance (FID)',
        page: 273,
        shows: (
          <p>
            Fit a Gaussian to the classifier&apos;s deepest features for the real images and another for the generated
            ones, and measure the Fréchet distance between them. It does notice diversity within a class, but sees only
            what the classifier keeps, and it folds realism and variety into one number.
          </p>
        ),
      },
      {
        id: '14.3d',
        title: 'Manifold precision and recall',
        page: 274,
        shows: (
          <p>
            To separate realism from variety, estimate where each set lives by putting a ball around every point,
            reaching to its <i>k</i>th nearest neighbour. <b>Precision</b> is the share of generated samples inside the
            real data&apos;s balls (do they look real?). <b>Recall</b> is the share of real points inside the generated
            balls (can the model make them?). The demo shows FID rising for two different faults that precision and
            recall tell apart, and all three missing a model that only copies its training data.
          </p>
        ),
        Demo: GenerativeMetrics,
      },
    ],
    inLlms: (
      <>
        <p>
          Pre-training an LLM is unsupervised learning, usually called self-supervised: the text supplies its own
          targets. And an LLM is the book&apos;s footnote case, a probabilistic generative model with no latent
          variable, whose likelihood is exact and cheap: one forward pass scores every token. That is why{' '}
          <b>test likelihood</b> is the main yardstick in pre-training, reported as loss or perplexity (the exponential
          of the average negative log-likelihood per token). Scores are only comparable between models with the same
          tokeniser, and a leaked test set inflates them, which is the memorisation blind spot in the demo.
        </p>
        <p>
          Against the 14.2 list, an LLM scores well on sample quality and likelihood but samples one token at a time,
          which is why speculative decoding exists. The precision/recall trade appears in decoding: a low temperature
          gives typical, safe text, and a high one gives variety and more mistakes. There is no designed latent space,
          but interpretability research looks for disentangled directions in the model&apos;s activations. Images use
          FID; text is judged by perplexity, benchmarks and model-graded evals.
        </p>
      </>
    ),
    next: [
      'Scaling laws (Kaplan et al., 2020; Hoffmann et al., 2022) show that test loss falls as a power law in parameters, data and compute, which is how labs choose model and dataset sizes before training.',
      'MAUVE (Pillutla et al., 2021) brings the precision/recall idea to text: it compares model and human text in an embedding space and summarises both kinds of error in one curve.',
      'Kirk et al. (2023) found that preference tuning (RLHF) improves generalisation but reduces output diversity: a loss of coverage in the 14.2 sense, and an active topic in post-training.',
      'Sparse autoencoders (Bricken et al., 2023; Cunningham et al., 2023) learn, without labels, a dictionary of directions in an LLM’s activations, many of which match interpretable features: a disentangled latent space recovered after training.',
      'Diffusion language models such as LLaDA (Nie et al., 2025) generate text by denoising many masked tokens at once, trading the left-to-right order for more parallel sampling.',
    ],
    labs: [
      ['/training', 'Training'],
      ['/sampling', 'Sampling'],
      ['/evals', 'Evals'],
      ['/benchmarks', 'Benchmarks'],
      ['/deep-learning', 'Deep learning notebooks'],
    ],
  },
];
