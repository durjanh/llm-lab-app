import { useMemo, useState, type ReactNode } from 'react';
import type { ChapterDef } from './chapters';
import { fmt, gauss, mean, rng, sigmoid, softmax, sum } from './kit';
import { Chips, Notebook, Readout, Slider } from './Notebook';
import { Plot } from './Plot';

/* ---------- small matrix helpers ---------- */

type M = number[][];
const matmul = (a: M, b: M): M => a.map((r) => b[0].map((_, j) => r.reduce((s, v, k) => s + v * b[k][j], 0)));
const transpose = (a: M): M => a[0].map((_, j) => a.map((r) => r[j]));
const randM = (rand: () => number, rows: number, cols: number, scale = 1): M =>
  Array.from({ length: rows }, () => Array.from({ length: cols }, () => gauss(rand) * scale));
const identity = (n: number): M => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
const relu = (a: M): M => a.map((r) => r.map((v) => Math.max(0, v)));
const argmax = (xs: number[]) => xs.reduce((best, v, i) => (v > xs[best] ? i : best), 0);

function shuffled(n: number, seed: number): number[] {
  const rand = rng(seed);
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return p;
}

/** A cell colour: brand for probabilities and counts, blue/orange for signed values, stronger for larger magnitudes. */
function shade(v: number, max: number, signed: boolean): string {
  if (!Number.isFinite(v) || max <= 0 || v === 0) return 'transparent';
  const t = Math.min(1, Math.abs(v) / max);
  const colour = signed ? (v < 0 ? 'var(--s2)' : 'var(--s1)') : 'var(--brand)';
  return `color-mix(in srgb, ${colour} ${Math.round(t * 65)}%, transparent)`;
}

function cell(v: number, digits: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

interface MatrixProps {
  m: M;
  title: ReactNode;
  rows?: string[];
  cols?: string[];
  signed?: boolean;
  digits?: number;
  highlight?: [number, number] | null;
  onCell?: (i: number, j: number) => void;
}

/** A small matrix as a table, each cell shaded by its value. */
function Matrix({ m, title, rows, cols, signed = true, digits = 2, highlight, onCell }: MatrixProps) {
  const max = Math.max(1e-9, ...m.flat().map(Math.abs));
  return (
    <div className="dl-scroll">
      <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
        {title}
      </div>
      <table className="dl-table">
        {cols && (
          <thead>
            <tr>
              {rows && <th />}
              {cols.map((c, j) => (
                <th key={j}>{c}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {m.map((r, i) => (
            <tr key={i}>
              {rows && <th>{rows[i]}</th>}
              {r.map((v, j) => {
                const on = highlight && highlight[0] === i && highlight[1] === j;
                return (
                  <td
                    key={j}
                    style={{
                      background: shade(v, max, signed),
                      outline: on ? '2px solid var(--brand)' : undefined,
                      outlineOffset: on ? -2 : undefined,
                      cursor: onCell ? 'pointer' : undefined,
                    }}
                    onClick={onCell && (() => onCell(i, j))}
                  >
                    {cell(v, digits)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- 12.1 Self-attention ---------- */

const WORDS = ['the', 'cat', 'sat', 'down'];
const D = 4;
const DIMS = ['d1', 'd2', 'd3', 'd4'];

function SelfAttention() {
  const [seed, setSeed] = useState(3);
  const [scaled, setScaled] = useState(true);
  const [size, setSize] = useState(1);
  const base = useMemo(() => {
    const rand = rng(seed);
    return { X: randM(rand, WORDS.length, D), Wq: randM(rand, D, D, 0.7), Wk: randM(rand, D, D, 0.7), Wv: randM(rand, D, D, 0.7) };
  }, [seed]);
  const X = base.X.map((r) => r.map((v) => v * size));
  const Q = matmul(X, base.Wq);
  const K = matmul(X, base.Wk);
  const V = matmul(X, base.Wv);
  const S = matmul(Q, transpose(K)).map((r) => r.map((v) => (scaled ? v / Math.sqrt(D) : v)));
  const A = S.map(softmax);
  const O = matmul(A, V);
  const peak = mean(A.map((r) => Math.max(...r)));
  const entropy = mean(A.map((r) => -sum(r.map((p) => (p > 1e-12 ? p * Math.log(p) : 0)))));

  return (
    <Notebook
      id="12.1"
      title="Self-attention"
      intro={
        <>
          Each word is a vector. Three learned matrices turn it into a query, a key and a value. Each word's query is
          compared with every key (a dot product), softmax turns those scores into weights that sum to 1, and the word's
          output is the weighted mix of all the values. Every number below is computed live.
        </>
      }
      tryThis={[
        'Turn off the √d scaling and push the embedding size to 3: each row of the attention matrix collapses onto one word.',
        'With scaling on, the same embeddings give softer weights: the average top weight falls and the entropy rises.',
        'Press New embeddings to draw new word vectors and weight matrices.',
      ]}
      takeaway={
        <>
          Attention is a data-dependent weighted average. Dividing the scores by √d keeps softmax from saturating, so
          gradients still flow to the words that were not picked.
        </>
      }
    >
      <div className="dl-controls">
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New embeddings
        </button>
        <label className="small">
          <input type="checkbox" checked={scaled} onChange={(e) => setScaled(e.target.checked)} /> Scale scores by 1/√d
        </label>
        <Slider label="Embedding size" value={size} min={0.25} max={3} step={0.05} onChange={setSize} show={(v) => `×${v.toFixed(2)}`} />
      </div>
      <div className="dl-cols">
        <Matrix m={X} title="X: word embeddings" rows={WORDS} cols={DIMS} />
        <Matrix m={Q} title="Q = X Wq (queries)" rows={WORDS} cols={DIMS} />
        <Matrix m={K} title="K = X Wk (keys)" rows={WORDS} cols={DIMS} />
        <Matrix m={V} title="V = X Wv (values)" rows={WORDS} cols={DIMS} />
      </div>
      <div className="dl-cols">
        <Matrix m={S} title={scaled ? 'Scores Q Kᵀ / √d' : 'Scores Q Kᵀ (unscaled)'} rows={WORDS} cols={WORDS} />
        <Matrix m={A} title="Attention = softmax of each row" rows={WORDS} cols={WORDS} signed={false} />
        <Matrix m={O} title="Output = attention × V" rows={WORDS} cols={DIMS} />
      </div>
      <p className="dl-caption">Rows of the attention matrix are the word asking; columns are the words it looks at. Each row sums to 1.</p>
      <Readout
        items={[
          ['average top weight in a row', fmt(peak)],
          ['average row entropy (max ln 4 = 1.386)', fmt(entropy)],
          ['row sums', A.map((r) => sum(r).toFixed(2)).join(' ')],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 12.2 Multi-head self-attention ---------- */

function MultiHead() {
  const [seed, setSeed] = useState(11);
  const r = useMemo(() => {
    const rand = rng(seed);
    const X = randM(rand, WORDS.length, D);
    const heads = [0, 1].map(() => {
      const Wq = randM(rand, D, 2, 0.8), Wk = randM(rand, D, 2, 0.8), Wv = randM(rand, D, 2, 0.8);
      const Q = matmul(X, Wq), K = matmul(X, Wk), V = matmul(X, Wv);
      const A = matmul(Q, transpose(K)).map((row) => softmax(row.map((v) => v / Math.sqrt(2))));
      return { A, O: matmul(A, V) };
    });
    const concat = X.map((_, i) => [...heads[0].O[i], ...heads[1].O[i]]);
    const Wo = randM(rand, D, D, 0.6);
    return { X, heads, concat, out: matmul(concat, Wo) };
  }, [seed]);
  const diff = mean(r.heads[0].A.flatMap((row, i) => row.map((v, j) => Math.abs(v - r.heads[1].A[i][j]))));

  return (
    <Notebook
      id="12.2"
      title="Multi-head self-attention"
      intro={
        <>
          Several attention heads run side by side, each with its own query, key and value matrices that project the
          4-d words down to 2-d. Each head can learn to look for something different. Their outputs are joined and
          mixed by one more matrix, Wo.
        </>
      }
      tryThis={[
        'Compare the two attention matrices: for the same word, the heads often favour different words.',
        'Press New weights a few times and watch the "where each head looks" table change.',
      ]}
      takeaway={
        <>
          Heads are cheap (each works in a smaller space) and give the layer several ways to relate words at once, such
          as one head for the previous word and another for the subject.
        </>
      }
    >
      <div className="dl-controls">
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New weights
        </button>
      </div>
      <div className="dl-cols">
        <Matrix m={r.heads[0].A} title="Head 1 attention" rows={WORDS} cols={WORDS} signed={false} />
        <Matrix m={r.heads[1].A} title="Head 2 attention" rows={WORDS} cols={WORDS} signed={false} />
        <div className="dl-scroll">
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
            Where each head looks most
          </div>
          <table className="dl-table">
            <thead>
              <tr>
                <th>word</th>
                <th>head 1</th>
                <th>head 2</th>
              </tr>
            </thead>
            <tbody>
              {WORDS.map((w, i) => (
                <tr key={w}>
                  <th>{w}</th>
                  <td>{WORDS[argmax(r.heads[0].A[i])]}</td>
                  <td>{WORDS[argmax(r.heads[1].A[i])]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="dl-cols">
        <Matrix m={r.concat} title="Concatenated head outputs [O1 | O2]" rows={WORDS} cols={['h1·1', 'h1·2', 'h2·1', 'h2·2']} />
        <Matrix m={r.out} title="Output = concat × Wo" rows={WORDS} cols={DIMS} />
      </div>
      <Readout items={[['mean difference between the heads’ attention weights', fmt(diff)]]} />
    </Notebook>
  );
}

/* ---------- 12.3 Tokenization (byte-pair encoding) ---------- */

const DEFAULT_CORPUS = `low lower lowest
new newer newest
wide wider widest
slow slower slowest
the newest tokenizer learns the lowest common pieces
a tokenizer learns tokens from the text`;

interface Merge {
  a: string;
  b: string;
  count: number;
  tokens: number; // tokens in the corpus after this merge
}

function learnBpe(text: string, maxMerges = 60) {
  const freq = new Map<string, number>();
  for (const w of text.toLowerCase().split(/\s+/).filter(Boolean)) freq.set(w, (freq.get(w) ?? 0) + 1);
  const words = [...freq].map(([w, f]) => ({ syms: [...w, '_'], f }));
  const chars = [...new Set(words.flatMap((w) => w.syms))].sort();
  const total = () => words.reduce((s, w) => s + w.syms.length * w.f, 0);
  const start = total();
  const merges: Merge[] = [];
  for (let m = 0; m < maxMerges; m++) {
    const pairs = new Map<string, number>();
    for (const w of words) {
      for (let i = 0; i < w.syms.length - 1; i++) {
        const k = `${w.syms[i]}\u0000${w.syms[i + 1]}`;
        pairs.set(k, (pairs.get(k) ?? 0) + w.f);
      }
    }
    let best = '';
    let bestCount = 1; // a pair must occur at least twice to be worth a token
    for (const [k, c] of pairs) if (c > bestCount || (c === bestCount && best && k < best)) [best, bestCount] = [k, c];
    if (!best) break;
    const [a, b] = best.split('\u0000');
    for (const w of words) w.syms = mergeOnce(w.syms, a, b);
    merges.push({ a, b, count: bestCount, tokens: total() });
  }
  return { merges, chars, start };
}

function mergeOnce(syms: string[], a: string, b: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < syms.length; i++) {
    if (syms[i] === a && syms[i + 1] === b) {
      out.push(a + b);
      i++;
    } else out.push(syms[i]);
  }
  return out;
}

function Tokenization() {
  const [text, setText] = useState(DEFAULT_CORPUS);
  const [k, setK] = useState(8);
  const { merges, chars, start } = useMemo(() => learnBpe(text), [text]);
  const used = Math.min(k, merges.length);
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const split = words.map((w) => merges.slice(0, used).reduce((syms, m) => mergeOnce(syms, m.a, m.b), [...w, '_']));
  const tokenCount = split.reduce((s, t) => s + t.length, 0);
  const vocab = chars.length + used;
  const xs = Array.from({ length: merges.length + 1 }, (_, i) => i);
  const ys = [start, ...merges.map((m) => m.tokens)];

  return (
    <Notebook
      id="12.3"
      title="Tokenization"
      intro={
        <>
          Byte-pair encoding starts with single characters (plus _ for the end of a word), then repeatedly finds the most
          frequent neighbouring pair and makes it a new token. Each merge adds one word to the vocabulary and makes the
          text shorter in tokens.
        </>
      }
      tryThis={[
        'Step through the first merges: common endings such as "est_" and "er_" and stems such as "low" appear early.',
        'Add a line to the corpus with a new word repeated three times and watch it become a single token.',
        'Push the merges to the end: frequent words become one token, rare words stay in pieces.',
      ]}
      takeaway={
        <>
          The vocabulary is learned from data, so text like the training data is short in tokens and unusual text is
          long. That is why token counts, and costs, differ between languages and formats. The Tokens lab shows this with
          a real tokenizer.
        </>
      }
    >
      <textarea
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Corpus"
        style={{ width: '100%', boxSizing: 'border-box', font: 'inherit', fontSize: 13 }}
      />
      <div className="dl-controls">
        <Slider label="Merges" value={used} min={0} max={merges.length} step={1} onChange={setK} show={(v) => String(v)} />
        <button className="btn small" disabled={used >= merges.length} onClick={() => setK(used + 1)}>
          Step
        </button>
        <button className="btn small" onClick={() => setK(0)}>
          Reset
        </button>
      </div>
      <Readout
        items={[
          ['tokens in the corpus', tokenCount],
          ['characters at the start', start],
          ['vocabulary size', vocab],
          ['merges learned (pairs seen twice or more)', merges.length],
        ]}
      />
      <div className="dl-cols">
        <div className="dl-scroll" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table className="dl-table">
            <thead>
              <tr>
                <th>#</th>
                <th style={{ textAlign: 'left' }}>merge</th>
                <th>count</th>
              </tr>
            </thead>
            <tbody>
              {merges.slice(0, used).map((m, i) => (
                <tr key={i} style={{ background: i === used - 1 ? 'color-mix(in srgb, var(--brand) 18%, transparent)' : undefined }}>
                  <td>{i + 1}</td>
                  <td className="mono" style={{ textAlign: 'left' }}>
                    {m.a} + {m.b} → {m.a + m.b}
                  </td>
                  <td>{m.count}</td>
                </tr>
              ))}
              {used === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    No merges yet: every character is a token.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div>
          <Plot
            x={[0, Math.max(1, merges.length)]}
            y={[0, Math.max(1, start) * 1.05]}
            height={200}
            xLabel="merges"
            yLabel="tokens in corpus"
            ariaLabel="Tokens in the corpus against the number of merges"
            draw={(f) => {
              f.line(xs, ys, f.c.brand);
              f.vline(used, f.c.s2);
              f.dots([[used, ys[used]]], f.c.s2, 4);
            }}
          />
        </div>
      </div>
      <div>
        <div className="small" style={{ fontWeight: 600, margin: '4px 0' }}>
          The corpus in tokens
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px' }}>
          {split.slice(0, 80).map((toks, i) => (
            <span key={i} style={{ display: 'inline-flex', gap: 2 }}>
              {toks.map((t, j) => (
                <span
                  key={j}
                  className="mono"
                  style={{
                    fontSize: 12,
                    padding: '1px 4px',
                    borderRadius: 4,
                    border: '1px solid var(--line2)',
                    background: j % 2 ? 'var(--soft)' : 'color-mix(in srgb, var(--brand) 14%, transparent)',
                  }}
                >
                  {t}
                </span>
              ))}
            </span>
          ))}
        </div>
        <p className="dl-caption">
          Vocabulary: {chars.join(' ')}
          {used > 0 && <> + {merges.slice(0, used).map((m) => m.a + m.b).join(' ')}</>}
        </p>
      </div>
    </Notebook>
  );
}

/* ---------- 12.4 Decoding strategies ---------- */

const STORY = `the cat sat on the mat . the dog sat on the rug . the cat chased the dog . the dog chased the ball .
a cat likes the warm mat . the dog likes the big ball . the cat sat by the door . a dog ran to the door .
the big dog ran to the park . the cat ran to the mat . the warm sun sat on the park . a dog likes the park .
the cat likes the sun . the dog ran by the cat . a big cat sat on the rug .`;

function bigramModel(smoothing: number) {
  const tokens = STORY.split(/\s+/).filter(Boolean);
  const vocab = [...new Set(tokens)].sort();
  const index = new Map(vocab.map((w, i) => [w, i]));
  const counts = vocab.map(() => vocab.map(() => 0));
  for (let i = 0; i < tokens.length - 1; i++) counts[index.get(tokens[i])!][index.get(tokens[i + 1])!]++;
  const P = counts.map((row) => {
    const total = sum(row) + smoothing * vocab.length;
    return row.map((c) => (c + smoothing) / total);
  });
  return { vocab, index, P };
}

type Strategy = 'greedy' | 'beam' | 'topk' | 'nucleus' | 'temperature';

function pick(dist: number[], rand: () => number): number {
  let r = rand() * sum(dist);
  for (let i = 0; i < dist.length; i++) if ((r -= dist[i]) <= 0) return i;
  return dist.length - 1;
}

function topKDist(p: number[], k: number): number[] {
  const keep = new Set([...p.keys()].sort((a, b) => p[b] - p[a]).slice(0, k));
  return p.map((v, i) => (keep.has(i) ? v : 0));
}

function nucleusDist(p: number[], top: number): number[] {
  const order = [...p.keys()].sort((a, b) => p[b] - p[a]);
  const keep = new Set<number>();
  let cum = 0;
  for (const i of order) {
    keep.add(i);
    cum += p[i];
    if (cum >= top) break;
  }
  return p.map((v, i) => (keep.has(i) ? v : 0));
}

function temperatureDist(p: number[], t: number): number[] {
  const q = p.map((v) => v ** (1 / t));
  const s = sum(q);
  return q.map((v) => v / s);
}

function Decoding() {
  const [prompt, setPrompt] = useState('the');
  const [length, setLength] = useState(8);
  const [beam, setBeam] = useState(3);
  const [topK, setTopK] = useState(3);
  const [topP, setTopP] = useState(0.7);
  const [temp, setTemp] = useState(1);
  const [smoothing, setSmoothing] = useState(0.1);
  const [seed, setSeed] = useState(1);
  const { vocab, index, P } = useMemo(() => bigramModel(smoothing), [smoothing]);
  const start = index.get(prompt) ?? 0;

  const results = useMemo(() => {
    const lp = (seq: number[]) => seq.slice(1).reduce((s, w, i) => s + Math.log(P[seq[i]][w]), 0);
    const sampled = (offset: number, shape: (p: number[]) => number[]) => {
      const rand = rng(seed * 97 + offset);
      const seq = [start];
      for (let i = 0; i < length; i++) seq.push(pick(shape(P[seq[seq.length - 1]]), rand));
      return seq;
    };
    const greedy = [start];
    for (let i = 0; i < length; i++) greedy.push(argmax(P[greedy[greedy.length - 1]]));
    let beams = [{ seq: [start], lp: 0 }];
    for (let i = 0; i < length; i++) {
      const next = beams.flatMap((b) => P[b.seq[b.seq.length - 1]].map((p, w) => ({ seq: [...b.seq, w], lp: b.lp + Math.log(p) })));
      beams = next.sort((a, b) => b.lp - a.lp).slice(0, beam);
    }
    const out: { id: Strategy; label: string; seq: number[] }[] = [
      { id: 'greedy', label: 'Greedy', seq: greedy },
      { id: 'beam', label: `Beam search (width ${beam})`, seq: beams[0].seq },
      { id: 'topk', label: `Top-k sampling (k = ${topK})`, seq: sampled(1, (p) => topKDist(p, topK)) },
      { id: 'nucleus', label: `Nucleus sampling (p = ${topP.toFixed(2)})`, seq: sampled(2, (p) => nucleusDist(p, topP)) },
      { id: 'temperature', label: `Temperature sampling (T = ${temp.toFixed(2)})`, seq: sampled(3, (p) => temperatureDist(p, temp)) },
    ];
    return out.map((r) => ({ ...r, lp: lp(r.seq) }));
  }, [P, start, length, beam, topK, topP, temp, seed]);

  const first = P[start];
  const order = [...first.keys()].sort((a, b) => first[b] - first[a]).slice(0, 10);
  const inTopK = new Set([...first.keys()].sort((a, b) => first[b] - first[a]).slice(0, topK));
  const nucleus = nucleusDist(first, topP);
  const tempered = temperatureDist(first, temp);
  const maxBar = Math.max(...order.map((i) => Math.max(first[i], tempered[i])));

  return (
    <Notebook
      id="12.4"
      title="Decoding strategies"
      intro={
        <>
          A language model gives a probability for every possible next word. Decoding decides which one to take. Here the
          model is a tiny bigram model counted from {STORY.split(/\s+/).filter(Boolean).length} words of text, so you can
          see every probability. The Sampling lab does the same with GPT-2.
        </>
      }
      tryThis={[
        'Greedy often loops ("the cat sat on the cat sat…"). Beam search finds a higher total log-probability.',
        'Set top-k to 1 or nucleus p near 0: both become greedy. Raise them and the text varies.',
        'Temperature below 1 sharpens the bars, above 1 flattens them; press New samples to draw again.',
        'Raise the smoothing: unseen word pairs get more probability and the samples get stranger.',
      ]}
      takeaway={
        <>
          Searching for the most likely text (greedy, beam) gives safe but repetitive output. Sampling from a trimmed
          distribution (top-k, nucleus) with a moderate temperature gives varied, still sensible text.
        </>
      }
    >
      <div className="dl-controls">
        <label className="small">
          Start word{' '}
          <select value={prompt} onChange={(e) => setPrompt(e.target.value)}>
            {vocab
              .filter((w) => w !== '.')
              .map((w) => (
                <option key={w}>{w}</option>
              ))}
          </select>
        </label>
        <Slider label="Words" value={length} min={3} max={14} step={1} onChange={setLength} show={(v) => String(v)} />
        <Slider label="Beam width" value={beam} min={1} max={6} step={1} onChange={setBeam} show={(v) => String(v)} />
        <Slider label="Top-k" value={topK} min={1} max={10} step={1} onChange={setTopK} show={(v) => String(v)} />
        <Slider label="Nucleus p" value={topP} min={0.05} max={1} step={0.05} onChange={setTopP} show={(v) => v.toFixed(2)} />
        <Slider label="Temperature" value={temp} min={0.2} max={2.5} step={0.05} onChange={setTemp} show={(v) => v.toFixed(2)} />
        <Slider label="Smoothing" value={smoothing} min={0.01} max={1} step={0.01} onChange={setSmoothing} show={(v) => v.toFixed(2)} />
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New samples
        </button>
      </div>
      <div className="dl-scroll">
        <table className="dl-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>strategy</th>
              <th style={{ textAlign: 'left' }}>output</th>
              <th>total log-prob</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id}>
                <td style={{ textAlign: 'left' }}>{r.label}</td>
                <td style={{ textAlign: 'left' }}>
                  <b>{vocab[r.seq[0]]}</b> {r.seq.slice(1).map((i) => vocab[i]).join(' ')}
                </td>
                <td>{r.lp.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <div className="small" style={{ fontWeight: 600, margin: '4px 0' }}>
          Next word after “{prompt}”: the ten most likely
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '3px 10px', alignItems: 'center', maxWidth: 640 }}>
          {order.map((i) => (
            <div key={i} style={{ display: 'contents' }}>
              <span className="mono small">{vocab[i]}</span>
              <div>
                <div style={{ height: 8, width: `${(first[i] / maxBar) * 100}%`, background: 'var(--brand)', borderRadius: 3 }} title="model probability" />
                <div
                  style={{ height: 5, marginTop: 2, width: `${(tempered[i] / maxBar) * 100}%`, background: 'var(--s2)', borderRadius: 3 }}
                  title="after temperature"
                />
              </div>
              <span className="small mono">
                {(first[i] * 100).toFixed(1)}% {inTopK.has(i) ? '· top-k' : ''} {nucleus[i] > 0 ? '· nucleus' : ''}
              </span>
            </div>
          ))}
        </div>
        <div className="dl-legend" style={{ marginTop: 6 }}>
          <span>
            <i style={{ background: 'var(--brand)' }} />
            model probability
          </span>
          <span>
            <i style={{ background: 'var(--s2)' }} />
            after temperature {temp.toFixed(2)}
          </span>
        </div>
      </div>
    </Notebook>
  );
}

/* ---------- graphs: drawing ---------- */

interface GraphSvgProps {
  pos: [number, number][];
  edges: [number, number][];
  labels: string[];
  fill?: (v: number) => string;
  ring?: Set<number>;
}

function GraphSvg({ pos, edges, labels, fill, ring }: GraphSvgProps) {
  return (
    <svg viewBox="0 0 300 200" style={{ width: '100%', maxWidth: 340, display: 'block' }} role="img" aria-label="Graph">
      {edges.map(([a, b], i) => (
        <line key={i} x1={pos[a][0]} y1={pos[a][1]} x2={pos[b][0]} y2={pos[b][1]} style={{ stroke: 'var(--line2)', strokeWidth: 2 }} />
      ))}
      {pos.map(([x, y], v) => (
        <g key={v}>
          <circle
            cx={x}
            cy={y}
            r={15}
            style={{
              fill: fill ? fill(v) : 'var(--surface)',
              stroke: ring?.has(v) ? 'var(--brand)' : 'var(--ink2)',
              strokeWidth: ring?.has(v) ? 4 : 1.5,
            }}
          />
          <text x={x} y={y + 4} textAnchor="middle" style={{ fill: 'var(--ink)', fontSize: 12, fontWeight: 600 }}>
            {labels[v]}
          </text>
        </g>
      ))}
    </svg>
  );
}

const adjacency = (n: number, edges: [number, number][]): M => {
  const A = Array.from({ length: n }, () => Array(n).fill(0) as number[]);
  for (const [a, b] of edges) A[a][b] = A[b][a] = 1;
  return A;
};

const permute = (A: M, p: number[]): M => p.map((i) => p.map((j) => A[i][j]));

/* ---------- 13.1 Encoding graphs ---------- */

const G_POS: [number, number][] = [
  [40, 50],
  [40, 150],
  [110, 100],
  [190, 100],
  [260, 50],
  [260, 150],
];
const G_EDGES: [number, number][] = [
  [0, 1],
  [0, 2],
  [1, 2],
  [2, 3],
  [3, 4],
  [3, 5],
  [4, 5],
];

function EncodingGraphs() {
  const [power, setPower] = useState(1);
  const [shuffles, setShuffles] = useState(0);
  const [picked, setPicked] = useState<[number, number] | null>([0, 5]);
  const n = G_POS.length;
  const A = adjacency(n, G_EDGES);
  const X = useMemo(() => {
    const rand = rng(5);
    return Array.from({ length: n }, () => Array.from({ length: 3 }, () => Math.round(rand() * 10) / 10));
  }, [n]);
  const p = shuffles ? shuffled(n, shuffles) : Array.from({ length: n }, (_, i) => i); // position i holds original node p[i]
  const P = p.map((orig) => Array.from({ length: n }, (_, j) => (j === orig ? 1 : 0)));
  const Ap = matmul(matmul(P, A), transpose(P));
  const Xp = matmul(P, X);
  let An = identity(n);
  for (let i = 0; i < power; i++) An = matmul(An, Ap);
  const label = (orig: number) => String(p.indexOf(orig));
  const ring = picked ? new Set([p[picked[0]], p[picked[1]]]) : undefined;
  const sameGraph = G_EDGES.every(([a, b]) => Ap[p.indexOf(a)][p.indexOf(b)] === 1) && sum(Ap.flat()) === 2 * G_EDGES.length;
  const idx = Array.from({ length: n }, (_, i) => String(i));

  return (
    <Notebook
      id="13.1"
      title="Encoding graphs"
      intro={
        <>
          A graph is stored as an adjacency matrix A (1 where two nodes are joined) and a node feature matrix X (one row
          per node). Powers of A count walks: entry (i, j) of Aⁿ is the number of walks of length n from node i to
          node j.
        </>
      }
      tryThis={[
        'Click a cell of Aⁿ: the two nodes are ringed on the graph. Try node 0 to node 5 with powers 1 to 4.',
        'Press Shuffle node order: the matrices change because the rows and columns are reordered, but the graph is the same.',
      ]}
      takeaway={
        <>
          The same graph has many matrices, one for each node order. A graph network must give the same answer for all
          of them, which is why it uses operations like A × H that respect the reordering.
        </>
      }
    >
      <div className="dl-controls">
        <Slider label="Power n" value={power} min={1} max={5} step={1} onChange={setPower} show={(v) => String(v)} />
        <button className="btn small" onClick={() => setShuffles((s) => s + 1)}>
          Shuffle node order
        </button>
        <button className="btn small" disabled={!shuffles} onClick={() => setShuffles(0)}>
          Original order
        </button>
      </div>
      <div className="dl-cols">
        <div>
          <GraphSvg pos={G_POS} edges={G_EDGES} labels={G_POS.map((_, v) => label(v))} ring={ring} />
          <p className="dl-caption">
            {picked
              ? `${An[picked[0]][picked[1]]} walk${An[picked[0]][picked[1]] === 1 ? '' : 's'} of length ${power} from node ${picked[0]} to node ${picked[1]}.`
              : 'Click a cell of Aⁿ.'}
          </p>
        </div>
        <Matrix
          m={An}
          title={power === 1 ? 'A (adjacency): click a cell' : `A${'⁰¹²³⁴⁵'[power]}: walks of length ${power}`}
          rows={idx}
          cols={idx}
          signed={false}
          highlight={picked}
          onCell={(i, j) => setPicked([i, j])}
        />
        <Matrix m={Xp} title="X: node features" rows={idx} cols={['f1', 'f2', 'f3']} digits={1} signed={false} />
      </div>
      {shuffles > 0 && (
        <div className="dl-cols">
          <Matrix m={P} title="Permutation P (row i picks the old node)" rows={idx} cols={idx} signed={false} />
          <Matrix m={Ap} title="P A Pᵀ: the shuffled adjacency" rows={idx} cols={idx} signed={false} />
        </div>
      )}
      <Readout
        items={[
          ['edges', G_EDGES.length],
          ['node order (old node at each position)', p.join(' ')],
          ['same graph after reordering', sameGraph ? '✓ yes' : '✗ no'],
        ]}
      />
    </Notebook>
  );
}

/* ---------- 13.2 Graph classification ---------- */

type GraphId = 'ring' | 'star' | 'chain' | 'complete' | 'triangles';

function circle(n: number, cx = 150, cy = 100, r = 75): [number, number][] {
  return Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n - Math.PI / 2), cy + r * Math.sin((2 * Math.PI * i) / n - Math.PI / 2)]);
}

const GRAPHS: Record<GraphId, { label: string; pos: [number, number][]; edges: [number, number][] }> = {
  ring: { label: 'Ring', pos: circle(6), edges: Array.from({ length: 6 }, (_, i) => [i, (i + 1) % 6] as [number, number]) },
  star: { label: 'Star', pos: [[150, 100], ...circle(5)], edges: [1, 2, 3, 4, 5].map((i) => [0, i] as [number, number]) },
  chain: { label: 'Chain', pos: Array.from({ length: 6 }, (_, i) => [30 + i * 48, i % 2 ? 120 : 80] as [number, number]), edges: Array.from({ length: 5 }, (_, i) => [i, i + 1] as [number, number]) },
  complete: {
    label: 'Complete',
    pos: circle(5),
    edges: [0, 1, 2, 3, 4].flatMap((i) => [0, 1, 2, 3, 4].filter((j) => j > i).map((j) => [i, j] as [number, number])),
  },
  triangles: {
    label: 'Two triangles',
    pos: [
      [40, 50],
      [40, 150],
      [110, 100],
      [190, 100],
      [260, 50],
      [260, 150],
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 0],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 3],
    ],
  },
};

interface Gcn {
  W1: M;
  b1: number[];
  W2: M;
  b2: number[];
  w: number[];
  b: number;
}

function runGcn(A: M, net: Gcn) {
  const n = A.length;
  const deg = A.map((r) => sum(r));
  const H0 = deg.map((d) => [1, d / 4]); // features: a constant and the node's degree
  const At = A.map((r, i) => r.map((v, j) => v + (i === j ? 1 : 0)));
  const dinv = At.map((r) => 1 / Math.sqrt(sum(r)));
  const Ahat = At.map((r, i) => r.map((v, j) => v * dinv[i] * dinv[j]));
  const layer = (H: M, W: M, b: number[]) => relu(matmul(matmul(Ahat, H), W).map((r) => r.map((v, j) => v + b[j])));
  const H1 = layer(H0, net.W1, net.b1);
  const H2 = layer(H1, net.W2, net.b2);
  const pooled = H2[0].map((_, j) => sum(H2.map((r) => r[j])) / n);
  const y = sigmoid(sum(pooled.map((v, j) => v * net.w[j])) + net.b);
  return { H: [H0, H1, H2], pooled, y };
}

function GraphClassification() {
  const [graph, setGraph] = useState<GraphId>('ring');
  const [seed, setSeed] = useState(7);
  const [shuffles, setShuffles] = useState(0);
  const [layer, setLayer] = useState<'0' | '1' | '2'>('2');
  const [channel, setChannel] = useState(0);
  const net = useMemo<Gcn>(() => {
    const rand = rng(seed);
    return {
      W1: randM(rand, 2, 4, 0.9),
      b1: Array.from({ length: 4 }, () => gauss(rand) * 0.1),
      W2: randM(rand, 4, 4, 0.9),
      b2: Array.from({ length: 4 }, () => gauss(rand) * 0.1),
      w: Array.from({ length: 4 }, () => gauss(rand)),
      b: gauss(rand) * 0.2,
    };
  }, [seed]);
  const g = GRAPHS[graph];
  const n = g.pos.length;
  const A = adjacency(n, g.edges);
  const p = shuffles ? shuffled(n, shuffles + 100) : Array.from({ length: n }, (_, i) => i);
  const plain = runGcn(A, net);
  const reordered = runGcn(permute(A, p), net);
  const H = reordered.H[+layer];
  const cols = H[0].map((_, j) => `c${j + 1}`);
  const ch = Math.min(channel, cols.length - 1);
  const max = Math.max(1e-9, ...H.map((r) => Math.abs(r[ch])));
  const all = (Object.keys(GRAPHS) as GraphId[]).map((id) => {
    const gg = GRAPHS[id];
    return { id, label: gg.label, y: runGcn(adjacency(gg.pos.length, gg.edges), net).y };
  });

  return (
    <Notebook
      id="13.2"
      title="Graph classification"
      intro={
        <>
          A graph convolutional network updates every node from its neighbours: H′ = ReLU(Â H W + b), where Â is the
          adjacency with self-loops, normalised by degree. After two layers the node embeddings are averaged (mean
          pooling) and a sigmoid gives one number for the whole graph. The weights here are random, not trained.
        </>
      }
      tryThis={[
        'Pick each graph and step through the layers: node colours spread information from neighbours.',
        'Press Shuffle node order: the node rows move, but the pooled embedding and the output stay exactly the same.',
        'Press New weights: the outputs change, but they still differ between graphs. Training would set weights that separate the classes you care about.',
      ]}
      takeaway={
        <>
          Because each layer only multiplies by Â (which reorders with the nodes) and pooling is a mean, the network
          gives the same answer for every node order: it is permutation invariant.
        </>
      }
    >
      <div className="dl-controls">
        <Chips options={(Object.keys(GRAPHS) as GraphId[]).map((id) => ({ id, label: GRAPHS[id].label }))} value={graph} onChange={(v) => (setGraph(v), setShuffles(0))} />
        <button className="btn small" onClick={() => setShuffles((s) => s + 1)}>
          Shuffle node order
        </button>
        <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
          New weights
        </button>
      </div>
      <div className="dl-controls">
        <span className="small muted">Layer</span>
        <Chips
          options={[
            { id: '0', label: 'Input' },
            { id: '1', label: 'After layer 1' },
            { id: '2', label: 'After layer 2' },
          ]}
          value={layer}
          onChange={setLayer}
        />
        <span className="small muted">Colour by</span>
        <Chips options={cols.map((c, j) => ({ id: String(j), label: c }))} value={String(ch)} onChange={(v) => setChannel(+v)} />
      </div>
      <div className="dl-cols">
        <div>
          <GraphSvg
            pos={g.pos}
            edges={g.edges}
            labels={g.pos.map((_, v) => String(p.indexOf(v)))}
            fill={(v) => {
              const val = H[p.indexOf(v)][ch];
              return `color-mix(in srgb, var(--brand) ${Math.round((Math.abs(val) / max) * 75)}%, var(--surface))`;
            }}
          />
          <p className="dl-caption">Darker nodes have a larger value in channel {cols[ch]}.</p>
        </div>
        <Matrix
          m={H}
          title={layer === '0' ? 'Input features [1, degree/4]' : `Node embeddings after layer ${layer}`}
          rows={H.map((_, i) => `node ${i}`)}
          cols={layer === '0' ? ['1', 'deg/4'] : cols}
          signed={false}
        />
      </div>
      <Readout
        items={[
          ['output, original order', plain.y.toFixed(6)],
          ['output, this node order', reordered.y.toFixed(6)],
          ['difference', Math.abs(plain.y - reordered.y) < 1e-12 ? '0 ✓ invariant' : fmt(Math.abs(plain.y - reordered.y))],
          ['pooled embedding', reordered.pooled.map((v) => v.toFixed(3)).join(', ')],
        ]}
      />
      <div className="dl-scroll">
        <table className="dl-table">
          <thead>
            <tr>
              {all.map((r) => (
                <th key={r.id}>{r.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {all.map((r) => (
                <td key={r.id} style={{ background: r.id === graph ? 'color-mix(in srgb, var(--brand) 18%, transparent)' : undefined }}>
                  {r.y.toFixed(3)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
        <p className="dl-caption">The same network's output for each graph.</p>
      </div>
    </Notebook>
  );
}

/* ---------- 12.5 Encoders, decoders and encoder–decoders (lab extra) ---------- */

type Arch = 'encoder' | 'decoder' | 'encdec';
type Link = 'self' | 'cross' | 'causal' | null;

const SRC = ['the', 'black', 'cat', 'sat', 'on', 'the', 'mat'];
const TGT = ['le', 'chat', 'noir', "s'est", 'assis', 'sur', 'le', 'tapis'];
const DEC_IN = ['<s>', ...TGT]; // what the decoder reads: the translation so far, after a start token
const DEC_OUT = [...TGT, '</s>']; // what it must predict at each position

const ARCHS: { id: Arch; label: string; example: string }[] = [
  { id: 'encoder', label: 'Encoder-only', example: 'BERT' },
  { id: 'decoder', label: 'Decoder-only', example: 'GPT' },
  { id: 'encdec', label: 'Encoder–decoder', example: 'T5' },
];

const LINK_COLOUR: Record<Exclude<Link, null>, string> = {
  self: 'var(--brand)',
  causal: 'var(--s3)',
  cross: 'var(--s2)',
};

/** The tokens each architecture attends over, and which query (row) may look at which key (column). */
function layoutFor(arch: Arch): { tokens: string[]; split: number; link: (i: number, j: number) => Link } {
  if (arch === 'encoder') return { tokens: SRC, split: SRC.length, link: () => 'self' };
  if (arch === 'decoder') return { tokens: SRC, split: SRC.length, link: (i, j) => (j <= i ? 'causal' : null) };
  const n = SRC.length;
  return {
    tokens: [...SRC, ...DEC_IN],
    split: n,
    link: (i, j) => {
      if (i < n) return j < n ? 'self' : null; // the encoder never sees the translation
      if (j < n) return 'cross'; // every decoder position reads the whole source
      return j <= i ? 'causal' : null; // and only the translation up to itself
    },
  };
}

interface MaskGridProps {
  arch: Arch;
  labels?: string[];
  selected: number | null;
  onSelect?: (i: number) => void;
  compact?: boolean;
}

/** An attention mask as a grid: rows are the position asking, columns the positions it may look at. */
function MaskGrid({ arch, labels, selected, onSelect, compact }: MaskGridProps) {
  const { tokens, split, link } = layoutFor(arch);
  const names = labels ?? tokens;
  const size = compact ? 9 : arch === 'encdec' ? 17 : 22;
  const border = (j: number) => (arch === 'encdec' && j === split ? '2px solid var(--ink2)' : undefined);
  return (
    <div className="dl-scroll">
      <table className="dl-table" style={{ tableLayout: 'fixed' }}>
        {!compact && (
          <thead>
            <tr>
              <th />
              {names.map((t, j) => (
                <th
                  key={j}
                  className="mono"
                  style={{ writingMode: 'vertical-rl', fontSize: 11, padding: '4px 2px', borderLeft: border(j) }}
                >
                  {t}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {names.map((t, i) => (
            <tr key={i} style={{ borderTop: arch === 'encdec' && i === split ? '2px solid var(--ink2)' : undefined }}>
              {!compact && (
                <th
                  className="mono"
                  style={{
                    fontSize: 11,
                    cursor: 'pointer',
                    outline: i === selected ? '2px solid var(--brand)' : undefined,
                    outlineOffset: -2,
                  }}
                  onClick={() => onSelect?.(i)}
                >
                  {t}
                </th>
              )}
              {names.map((_, j) => {
                const kind = link(i, j);
                const on = i === selected;
                return (
                  <td
                    key={j}
                    onClick={() => onSelect?.(i)}
                    style={{
                      width: size,
                      height: size,
                      minWidth: size,
                      padding: 0,
                      cursor: onSelect ? 'pointer' : undefined,
                      borderLeft: border(j),
                      background: kind
                        ? `color-mix(in srgb, ${LINK_COLOUR[kind]} ${selected === null || on ? 70 : 28}%, transparent)`
                        : 'transparent',
                      outline: on && !compact ? '1px solid var(--ink2)' : undefined,
                    }}
                    title={compact ? undefined : `${names[i]} → ${names[j]}: ${kind ? 'may attend' : 'masked'}`}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Which positions of the source and the translation each design may attend to, and what it learns to predict. */
function EncoderDecoder() {
  const [arch, setArch] = useState<Arch>('encoder');
  const [selected, setSelected] = useState<number | null>(3);
  const [rate, setRate] = useState(0.15);
  const [seed, setSeed] = useState(1);
  const { tokens, split, link } = layoutFor(arch);
  const sel = selected !== null && selected < tokens.length ? selected : null;

  // Masked-language-modelling: hide a share of the words, at least one, chosen at random.
  const masked = useMemo(() => {
    const k = Math.max(1, Math.round(rate * SRC.length));
    return new Set(shuffled(SRC.length, seed * 31 + 7).slice(0, k));
  }, [rate, seed]);
  const labels = arch === 'encoder' ? SRC.map((w, i) => (masked.has(i) ? '[MASK]' : w)) : undefined;
  const names = labels ?? tokens;

  const open = sel === null ? [] : tokens.map((_, j) => link(sel, j));
  const pairs = tokens.reduce((s, _, i) => s + tokens.filter((__, j) => link(i, j)).length, 0);
  const choose = (a: Arch) => {
    setArch(a);
    setSelected(a === 'encdec' ? SRC.length + 2 : 3);
  };

  const strip = (from: number, to: number, title: string) => (
    <div>
      <div className="small muted" style={{ marginBottom: 3 }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {names.slice(from, to).map((t, k) => {
          const j = from + k;
          const kind = open[j];
          return (
            <button
              key={j}
              className="mono"
              onClick={() => setSelected(j)}
              style={{
                font: 'inherit',
                fontSize: 13,
                padding: '2px 7px',
                borderRadius: 5,
                cursor: 'pointer',
                color: 'var(--ink)',
                border: j === sel ? '2px solid var(--ink)' : '1px solid var(--line2)',
                background: kind ? `color-mix(in srgb, ${LINK_COLOUR[kind]} 35%, transparent)` : 'var(--surface)',
                opacity: sel !== null && !kind && j !== sel ? 0.45 : 1,
              }}
            >
              {t}
            </button>
          );
        })}
      </div>
    </div>
  );

  const seen = sel === null ? '' : names.filter((_, j) => open[j]).join(' · ');

  return (
    <Notebook
      id="12.5"
      title="Encoders, decoders and encoder–decoders (lab extra)"
      intro={
        <>
          A lab extra: chapter 12 of the book describes these three designs, but its notebooks do not cover them. All
          three are built from the same transformer layers. What differs is the attention mask, which says which
          positions each position may look at, and what the model is trained to predict. Pick a design, then click a
          word to see what it may attend to.
        </>
      }
      tryThis={[
        'Click "sat" in each design. The encoder sees both sides of it; the decoder sees only "the black cat sat".',
        'Raise the mask rate. More words are hidden, so each sentence gives more training targets but less context to guess them from.',
        'In the encoder–decoder, click "chat" in the translation: it can read every source word through cross-attention, but no later French word.',
        'Compare the number of open pairs: the causal mask allows about half as many as the full one.',
      ]}
      takeaway={
        <>
          The mask and the objective decide what a transformer is good at. Seeing both sides makes good representations
          for understanding text; seeing only the past is what lets a model generate text one token at a time; a
          separate encoder suits tasks that turn one sequence into a different one.
        </>
      }
    >
      <div className="dl-cols">
        {ARCHS.map((a) => (
          <div
            key={a.id}
            onClick={() => choose(a.id)}
            style={{
              cursor: 'pointer',
              borderRadius: 8,
              padding: 8,
              border: a.id === arch ? '2px solid var(--brand)' : '1px solid var(--line)',
            }}
          >
            <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
              {a.label} <span className="muted">(like {a.example})</span>
            </div>
            <MaskGrid arch={a.id} selected={null} compact />
          </div>
        ))}
      </div>
      <p className="dl-caption">
        The three masks side by side. Coloured cells may attend; blank cells are masked out (their score is set to −∞
        before the softmax). The encoder–decoder grid has the source in the top-left block and the translation below it.
      </p>
      <div className="dl-controls">
        <Chips
          options={ARCHS.map((a) => ({ id: a.id, label: `${a.label} (${a.example})` }))}
          value={arch}
          onChange={choose}
        />
      </div>
      <div className="dl-cols">
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>
            Attention mask: click a row or a word
          </div>
          <MaskGrid arch={arch} labels={labels} selected={sel} onSelect={setSelected} />
          <div className="dl-legend" style={{ marginTop: 6 }}>
            {arch === 'encoder' && (
              <span>
                <i style={{ background: LINK_COLOUR.self }} />
                bidirectional self-attention
              </span>
            )}
            {arch !== 'encoder' && (
              <span>
                <i style={{ background: LINK_COLOUR.causal }} />
                causal self-attention
              </span>
            )}
            {arch === 'encdec' && (
              <>
                <span>
                  <i style={{ background: LINK_COLOUR.self }} />
                  encoder self-attention
                </span>
                <span>
                  <i style={{ background: LINK_COLOUR.cross }} />
                  cross-attention
                </span>
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {arch === 'encdec' ? (
            <>
              {strip(0, split, 'Source, read by the encoder')}
              {strip(split, tokens.length, 'Translation so far, read by the decoder')}
            </>
          ) : (
            strip(0, tokens.length, 'Sentence')
          )}
          <p className="small" style={{ margin: 0 }}>
            {sel === null ? (
              'Click a word.'
            ) : (
              <>
                <b className="mono">{names[sel]}</b> may attend to: <span className="mono">{seen}</span>
              </>
            )}
          </p>
          <Readout
            items={[
              ['open query–key pairs', `${pairs} of ${tokens.length ** 2}`],
              ['positions', arch === 'encdec' ? `${SRC.length} + ${DEC_IN.length}` : tokens.length],
            ]}
          />
        </div>
      </div>

      <div className="small" style={{ fontWeight: 600, marginTop: 4 }}>
        Training objective on the same sentence
      </div>
      {arch === 'encoder' && (
        <>
          <div className="dl-controls">
            <Slider
              label="Mask rate"
              value={rate}
              min={0.05}
              max={0.6}
              step={0.05}
              onChange={setRate}
              show={(v) => `${Math.round(v * 100)}%`}
            />
            <button className="btn small" onClick={() => setSeed((s) => s + 1)}>
              New mask
            </button>
          </div>
          <div className="dl-scroll">
            <table className="dl-table">
              <tbody>
                <tr>
                  <th>input</th>
                  {SRC.map((w, i) => (
                    <td
                      key={i}
                      className="mono"
                      style={{
                        background: masked.has(i) ? 'color-mix(in srgb, var(--s2) 25%, transparent)' : undefined,
                      }}
                    >
                      {masked.has(i) ? '[MASK]' : w}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th>predict</th>
                  {SRC.map((w, i) => (
                    <td key={i} className="mono">
                      {masked.has(i) ? w : '–'}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="dl-caption">
            Masked-language modelling: the loss counts only the {masked.size} hidden word{masked.size === 1 ? '' : 's'}{' '}
            of {SRC.length}. Each guess can use the words on both sides. BERT hides 15%, and sometimes swaps in a random
            word or leaves the word in place, so the model cannot rely on seeing [MASK].
          </p>
        </>
      )}
      {arch === 'decoder' && (
        <>
          <div className="dl-scroll">
            <table className="dl-table">
              <tbody>
                <tr>
                  <th>input</th>
                  {SRC.map((w, i) => (
                    <td key={i} className="mono">
                      {w}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th>predict</th>
                  {SRC.map((_, i) => (
                    <td key={i} className="mono">
                      {i + 1 < SRC.length ? SRC[i + 1] : '<end>'}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="dl-caption">
            Next-token prediction: every position predicts the word after it, so one sentence gives {SRC.length}{' '}
            training targets in a single pass. The causal mask stops a position from reading the answer. To translate, a
            decoder-only model is given the source as the start of its text ("the black cat sat on the mat → French:")
            and continues it.
          </p>
        </>
      )}
      {arch === 'encdec' && (
        <>
          <div className="dl-scroll">
            <table className="dl-table">
              <tbody>
                <tr>
                  <th>encoder input</th>
                  {SRC.map((w, i) => (
                    <td key={i} className="mono">
                      {w}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
            <table className="dl-table" style={{ marginTop: 6 }}>
              <tbody>
                <tr>
                  <th>decoder input</th>
                  {DEC_IN.map((w, i) => (
                    <td key={i} className="mono">
                      {w}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th>predict</th>
                  {DEC_OUT.map((w, i) => (
                    <td key={i} className="mono">
                      {w}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="dl-caption">
            Sequence-to-sequence: the encoder reads the whole source once. The decoder predicts the translation one word
            at a time, from the source (through cross-attention to the encoder's last layer) and the French words before
            it. The loss counts only the {DEC_OUT.length} target positions. T5 is also pre-trained this way: spans of
            the input are hidden and the decoder writes them out.
          </p>
        </>
      )}

      <div className="dl-scroll">
        <table className="dl-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>design</th>
              <th style={{ textAlign: 'left' }}>mask</th>
              <th style={{ textAlign: 'left' }}>trained to</th>
              <th style={{ textAlign: 'left' }}>suits</th>
            </tr>
          </thead>
          <tbody>
            {[
              [
                'Encoder-only (BERT)',
                'every word sees every word',
                'fill in hidden words',
                'classification, tagging names and places, embeddings for search, picking an answer out of a passage',
              ],
              [
                'Decoder-only (GPT)',
                'each word sees itself and earlier words',
                'predict the next word',
                'writing text, chat and code; most other tasks by putting them in the prompt',
              ],
              [
                'Encoder–decoder (T5)',
                'full in the encoder, causal in the decoder, plus cross-attention',
                'write the target given the source',
                'translation, summarising, speech to text: one sequence in, a different one out',
              ],
            ].map(([d, m, o, s], i) => (
              <tr
                key={i}
                style={{
                  background: ARCHS[i].id === arch ? 'color-mix(in srgb, var(--brand) 12%, transparent)' : undefined,
                }}
              >
                <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>{d}</td>
                <td style={{ textAlign: 'left' }}>{m}</td>
                <td style={{ textAlign: 'left' }}>{o}</td>
                <td style={{ textAlign: 'left' }}>{s}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Notebook>
  );
}

export const CHAPTERS: ChapterDef[] = [
  {
    n: 12,
    title: 'Transformers',
    blurb: 'Attention lets every word look at every other word. Tokenization and decoding are the steps either side of the model.',
    notebooks: [
      { id: '12.1', title: 'Self-attention', Component: SelfAttention },
      { id: '12.2', title: 'Multi-head self-attention', Component: MultiHead },
      { id: '12.3', title: 'Tokenization', Component: Tokenization },
      { id: '12.4', title: 'Decoding strategies', Component: Decoding },
      { id: '12.5', title: 'Encoders, decoders and encoder–decoders (lab extra)', Component: EncoderDecoder },
    ],
  },
  {
    n: 13,
    title: 'Graph neural networks',
    blurb: 'Graphs have no natural order, so networks for them must give the same answer whichever way the nodes are numbered.',
    notebooks: [
      { id: '13.1', title: 'Encoding graphs', Component: EncodingGraphs },
      { id: '13.2', title: 'Graph classification', Component: GraphClassification },
    ],
  },
];
