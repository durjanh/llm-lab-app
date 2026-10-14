/* A tiny GPT-style transformer that runs real math in the browser.
 * Weights are deterministic pseudo-random (not trained), so the next-token
 * distribution is blended with an n-gram language model built from a small
 * corpus. Every activation shown in the UI is computed here. */
(function () {
  const D = 48, H = 12, DH = D / H, L = 12, DFF = 4 * D, MAX_TOKENS = 16;

  // ---------- deterministic randomness ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function randn(rng) {
    let u = 0; while (!u) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }
  function randMat(r, c, rng, scale) {
    const m = [];
    for (let i = 0; i < r; i++) { const row = new Array(c); for (let j = 0; j < c; j++) row[j] = randn(rng) * scale; m.push(row); }
    return m;
  }

  // ---------- linear algebra ----------
  function matVec(x, W) { // x[len r] · W[r][c] -> [c]
    const c = W[0].length, out = new Array(c).fill(0);
    for (let i = 0; i < x.length; i++) { const xi = x[i], Wi = W[i]; for (let j = 0; j < c; j++) out[j] += xi * Wi[j]; }
    return out;
  }
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  function layerNorm(x) {
    const m = x.reduce((a, b) => a + b, 0) / x.length;
    const v = x.reduce((a, b) => a + (b - m) * (b - m), 0) / x.length;
    const s = Math.sqrt(v + 1e-5);
    return x.map(t => (t - m) / s);
  }
  function softmax(xs) {
    const m = Math.max(...xs.filter(Number.isFinite));
    const e = xs.map(x => (Number.isFinite(x) ? Math.exp(x - m) : 0));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map(x => x / s);
  }
  const gelu = x => 0.5 * x * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (x + 0.044715 * x * x * x)));

  // ---------- tiny corpus for the n-gram head ----------
  const CORPUS = `
As the spaceship was approaching the planet , the crew prepared for landing .
As the spaceship was approaching the station , the lights began to flicker .
The spaceship was approaching the moon at incredible speed .
As the spaceship was approaching the edge of the galaxy , the captain looked at the stars .
The crew watched the planet grow larger in the window .
Data visualization empowers users to explore complex data and discover hidden patterns .
Data visualization empowers users to understand the story behind the numbers .
Data visualization empowers users to make better decisions .
Artificial intelligence is transforming the world of work .
Artificial intelligence is transforming the way we live and learn .
Artificial intelligence is transforming the healthcare industry .
Once upon a time there was a little girl who lived in a small village .
Once upon a time there was a brave knight who lived in a castle .
Once upon a time there was a dragon who guarded a treasure .
The cat sat on the mat and looked at the dog .
The dog sat on the floor and looked at the cat .
The sun rises in the east and sets in the west .
The transformer uses attention to understand the context of each word .
The model predicts the next word in the sentence .
Attention lets each word look at the words that came before it .
The quick brown fox jumps over the lazy dog .
The weather today is sunny and warm .
I love to read books in the library .
She opened the door and walked into the room .
He looked at the sky and saw the moon .
We are going to the park to play .
The students learned about neural networks in the class .
Neural networks learn patterns from data .
Language models generate text one token at a time .
The future of technology is bright .
`;

  function tokenize(text) {
    const parts = text.match(/[A-Za-z0-9']+|[^\sA-Za-z0-9']/g) || [];
    return parts.slice(0, MAX_TOKENS);
  }

  // n-gram counts
  const uni = new Map(), bi = new Map(), tri = new Map(), display = new Map();
  let uniTotal = 0;
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  CORPUS.trim().split('\n').forEach(line => {
    const toks = tokenize(line.trim()).length ? line.trim().split(/\s+/) : [];
    const low = toks.map(t => t.toLowerCase());
    toks.forEach((t, i) => {
      const w = low[i];
      if (!display.has(w) || (t === w)) display.set(w, i === 0 && display.has(w) ? display.get(w) : t);
      inc(uni, w); uniTotal++;
      if (i > 0) inc(bi, low[i - 1] + ' ' + w);
      if (i > 1) inc(tri, low[i - 2] + ' ' + low[i - 1] + ' ' + w);
    });
  });
  const VOCAB = [...uni.keys()];
  const ctx1 = new Map(), ctx2 = new Map();
  for (const [k, c] of bi) { const a = k.split(' ')[0]; ctx1.set(a, (ctx1.get(a) || 0) + c); }
  for (const [k, c] of tri) { const p = k.split(' '); const a = p[0] + ' ' + p[1]; ctx2.set(a, (ctx2.get(a) || 0) + c); }

  function ngramProb(prev2, prev1, w) {
    const p1 = (uni.get(w) || 0) / uniTotal;
    const c1 = ctx1.get(prev1) || 0;
    const p2 = c1 ? (bi.get(prev1 + ' ' + w) || 0) / c1 : 0;
    const k2 = prev2 + ' ' + prev1, c2 = ctx2.get(k2) || 0;
    const p3 = c2 ? (tri.get(k2 + ' ' + w) || 0) / c2 : 0;
    if (c2) return 0.7 * p3 + 0.22 * p2 + 0.08 * p1;
    if (c1) return 0.85 * p2 + 0.15 * p1;
    return p1;
  }

  // ---------- weights ----------
  const rng = mulberry32(1234);
  const sc = 1 / Math.sqrt(D);
  const layers = [];
  for (let l = 0; l < L; l++) {
    layers.push({
      Wq: randMat(D, D, rng, sc * 1.6), Wk: randMat(D, D, rng, sc * 1.6), Wv: randMat(D, D, rng, sc),
      Wo: randMat(D, D, rng, sc * 0.7), W1: randMat(D, DFF, rng, sc), W2: randMat(DFF, D, rng, sc * 0.5 / Math.sqrt(4)),
      // Each head gets a positional "habit" so heads look different, as in real models
      habit: Array.from({ length: H }, (_, h) => ['previous', 'first', 'self', 'content', 'previous', 'broad'][(h + l) % 6])
    });
  }

  const embCache = new Map();
  function tokenEmbedding(word) {
    const key = word.toLowerCase();
    if (!embCache.has(key)) {
      const r = mulberry32(hashStr(key));
      embCache.set(key, Array.from({ length: D }, () => randn(r) * 0.6));
    }
    return embCache.get(key);
  }
  function tokenId(word) {
    const key = word.toLowerCase();
    const i = VOCAB.indexOf(key);
    return i >= 0 ? i + 100 : 1000 + (hashStr(key) % 49000);
  }
  function positional(pos) {
    return Array.from({ length: D }, (_, i) => {
      const f = pos / Math.pow(10000, (2 * Math.floor(i / 2)) / D);
      return (i % 2 === 0 ? Math.sin(f) : Math.cos(f)) * 0.5;
    });
  }

  // ---------- forward pass ----------
  // `override` lets another tokenizer (GPT-2) supply the tokens: { tokens: [{ text, id }] }
  function run(text, override) {
    const words = override ? override.tokens.map(t => t.text) : tokenize(text);
    if (!words.length) return null;
    const n = words.length;
    const tokens = override ? override.tokens.map(t => ({ text: t.text, id: t.id })) : words.map(w => ({ text: w, id: tokenId(w) }));
    const tokEmb = words.map(tokenEmbedding);
    const posEmb = words.map((_, i) => positional(i));
    const emb = tokEmb.map((t, i) => add(t, posEmb[i]));

    let x = emb;
    const acts = [];
    layers.forEach((W) => {
      const xn = x.map(layerNorm);
      const Q = xn.map(v => matVec(v, W.Wq)), K = xn.map(v => matVec(v, W.Wk)), V = xn.map(v => matVec(v, W.Wv));
      const q = [], k = [], v = [], raw = [], scaled = [], masked = [], attn = [], headOut = [];
      for (let h = 0; h < H; h++) {
        const sl = a => a.map(r => r.slice(h * DH, (h + 1) * DH));
        const qh = sl(Q), kh = sl(K), vh = sl(V);
        const rawH = [], scH = [], mH = [], aH = [], oH = [];
        for (let i = 0; i < n; i++) {
          const r = [], s = [], m = [];
          for (let j = 0; j < n; j++) {
            const d = dot(qh[i], kh[j]);
            let bias = 0;
            const hb = W.habit[h];
            if (hb === 'previous' && j === i - 1) bias = 2.6;
            if (hb === 'first' && j === 0) bias = 2.4;
            if (hb === 'self' && j === i) bias = 2.4;
            if (hb === 'broad') bias = -0.6 * Math.abs(i - j) / Math.max(1, n) ;
            r.push(d);
            s.push(d / Math.sqrt(DH) + bias);
            m.push(j > i ? -Infinity : d / Math.sqrt(DH) + bias);
          }
          const a = softmax(m);
          rawH.push(r); scH.push(s); mH.push(m); aH.push(a);
          const o = new Array(DH).fill(0);
          a.forEach((w, j) => vh[j].forEach((val, d) => (o[d] += w * val)));
          oH.push(o);
        }
        q.push(qh); k.push(kh); v.push(vh); raw.push(rawH); scaled.push(scH); masked.push(mH); attn.push(aH); headOut.push(oH);
      }
      const concat = Array.from({ length: n }, (_, i) => [].concat(...headOut.map(hO => hO[i])));
      const attnOut = concat.map(c => matVec(c, W.Wo));
      const res1 = x.map((xi, i) => add(xi, attnOut[i]));
      const res1n = res1.map(layerNorm);
      const hiddenPre = res1n.map(r => matVec(r, W.W1));
      const hidden = hiddenPre.map(r => r.map(gelu));
      const mlpOut = hidden.map(r => matVec(r, W.W2));
      const out = res1.map((r, i) => add(r, mlpOut[i]));
      acts.push({ input: x, ln1: xn, q, k, v, raw, scaled, masked, attn, headOut, concat, attnOut, res1, res1n, hiddenPre, hidden, mlpOut, out, habit: W.habit });
      x = out;
    });

    const final = layerNorm(x[n - 1]);
    const low = words.map(w => w.toLowerCase());
    const p1 = low[n - 1], p2 = n > 1 ? low[n - 2] : '';
    // transformer logits (tied embeddings), z-normalised
    const tl = VOCAB.map(w => dot(final, tokenEmbedding(w)) / Math.sqrt(D));
    const mu = tl.reduce((a, b) => a + b, 0) / tl.length;
    const sd = Math.sqrt(tl.reduce((a, b) => a + (b - mu) ** 2, 0) / tl.length) || 1;
    const logits = VOCAB.map((w, i) => ({
      token: display.get(w) || w,
      key: w,
      logit: +(Math.log(ngramProb(p2, p1, w) + 1e-5) * 1.6 + 0.35 * (tl[i] - mu) / sd + 6).toFixed(4)
    })).sort((a, b) => b.logit - a.logit);

    return { tokens, tokEmb, posEmb, emb, layers: acts, final, logits };
  }

  function sample(logits, T, mode, k, p, rnd) {
    const scaled = logits.map(l => l.logit / Math.max(T, 1e-3));
    const pAll = softmax(scaled);
    const keep = new Array(logits.length).fill(false);
    if (mode === 'top-k') for (let i = 0; i < Math.min(k, logits.length); i++) keep[i] = true;
    else { let c = 0; for (let i = 0; i < logits.length; i++) { keep[i] = true; c += pAll[i]; if (c >= p) break; } }
    const kept = pAll.map((v, i) => (keep[i] ? v : 0));
    const s = kept.reduce((a, b) => a + b, 0);
    const final = kept.map(v => v / s);
    let r = (rnd ?? Math.random)(), chosen = 0;
    for (let i = 0; i < final.length; i++) { r -= final[i]; if (r <= 0) { chosen = i; break; } }
    return logits.map((l, i) => ({ ...l, scaled: scaled[i], pAll: pAll[i], kept: keep[i], prob: final[i] })).map((o, i) => ({ ...o, chosen: i === chosen }));
  }

  window.TinyGPT = { run, sample, tokenize, softmax, D, H, DH, L, DFF, MAX_TOKENS, vocabSize: VOCAB.length };
})();
