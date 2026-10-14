/* GPT-2 with every internal value exposed, for the Transformer Explainer.
 *
 * Loads a custom ONNX export of GPT-2 small (made by tools/export_gpt2_explainer.py,
 * saved in models/gpt2-explainer/) with onnxruntime-web, and the GPT-2 tokenizer
 * from js/gpt2.js. run() returns the same activations object as js/model.js, so the
 * page can draw it, but every number in it is GPT-2's own.
 *
 * Browsers block fetch() of local files, so this mode needs the folder served over
 * HTTP, for example with `python3 -m http.server` from the project root. */
(function () {
  const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
  const DIR = 'models/gpt2-explainer/';
  const CACHE = 'gpt2-explainer';
  const HOW = 'Run tools/export_gpt2_explainer.py once, then serve this folder over HTTP, for example with python3 -m http.server.';
  let ort = null, session = null, manifest = null, loading = null, availability = null;

  // ---------- availability ----------
  function available() {
    if (!availability) availability = (async () => {
      if (location.protocol === 'file:') {
        return { ok: false, code: 'file', reason: 'Full internals need the page served over HTTP, not opened as a file. ' + HOW };
      }
      try {
        const r = await fetch(DIR + 'manifest.json', { cache: 'no-cache' });
        if (!r.ok) throw new Error('no manifest');
        manifest = await r.json();
        const m = await fetch(DIR + manifest.file, { method: 'HEAD', cache: 'no-cache' });
        if (!m.ok) throw new Error('no model file');
      } catch (e) {
        manifest = null;
        return { ok: false, code: 'missing', reason: 'The full-internals model file is missing. ' + HOW };
      }
      return { ok: true, code: 'ok', reason: '', sizeMB: Math.round(manifest.bytes / 1e6) };
    })();
    return availability;
  }

  // ---------- loading ----------
  async function fetchModel(onProgress) {
    const url = DIR + manifest.file + '?v=' + manifest.sha256.slice(0, 12);
    let cache = null;
    try {
      cache = await caches.open(CACHE);
      const hit = await cache.match(url);
      if (hit) {
        const buf = new Uint8Array(await hit.arrayBuffer());
        if (buf.byteLength === manifest.bytes) { onProgress(buf.byteLength, buf.byteLength, 'download'); return buf; }
      }
    } catch (e) { cache = null; /* Cache API unavailable: fall back to the network */ }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`model download failed (HTTP ${res.status})`);
    const total = +res.headers.get('content-length') || manifest.bytes;
    if (cache) {
      // keep one copy: drop older versions, store this one while it streams
      cache.keys().then(ks => ks.forEach(k => { if (!k.url.endsWith(url.split('/').pop())) cache.delete(k); })).catch(() => {});
      cache.put(url, res.clone()).catch(() => {});
    }
    const reader = res.body.getReader();
    let buf = new Uint8Array(total), loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.length > buf.length) { const b = new Uint8Array(Math.max(buf.length * 1.25, loaded + value.length)); b.set(buf.subarray(0, loaded)); buf = b; }
      buf.set(value, loaded); loaded += value.length;
      onProgress(loaded, total, 'download');
    }
    return loaded === buf.length ? buf : buf.slice(0, loaded);
  }

  function load(onProgress) {
    if (session) return Promise.resolve();
    if (!loading) loading = (async () => {
      const a = await available();
      if (!a.ok) throw new Error(a.reason);
      const parts = { tok: [0, 0], model: [0, manifest.bytes] };
      let phase = 'download';
      const report = () => onProgress && onProgress(parts.tok[0] + parts.model[0], parts.tok[1] + parts.model[1], phase);
      const tokP = GPT2.loadTokenizer((l, t) => { parts.tok = [l, t]; report(); });
      ort = await import(ORT_BASE + 'ort.wasm.min.mjs');
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.logLevel = 'error';
      if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1; // threads need a cross-origin isolated page
      const bytes = await fetchModel((l, t) => { parts.model = [l, t]; report(); });
      phase = 'init'; report();
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      await tokP;
    })().catch(e => { loading = null; session = null; throw e; });
    return loading;
  }

  // ---------- forward pass ----------
  let queue = Promise.resolve();
  function forward(ids) {
    // one run at a time: an onnxruntime session cannot run concurrently
    const run = queue.then(() => session.run({ input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [ids.length]) }));
    queue = run.catch(() => {});
    return run;
  }

  const gelu = x => 0.5 * x * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (x + 0.044715 * x * x * x)));
  function softmax(xs) {
    let m = -Infinity;
    for (const x of xs) if (x > m) m = x;
    const e = xs.map(x => (x === -Infinity ? 0 : Math.exp(x - m)));
    const s = e.reduce((a, b) => a + b, 0);
    return e.map(x => x / s);
  }
  // rows(data, offset, n, width): n plain arrays of `width` numbers starting at `offset`
  const rows = (data, offset, n, width) => Array.from({ length: n }, (_, i) => Array.from(data.subarray(offset + i * width, offset + (i + 1) * width)));

  // How one head spreads its attention, measured on this text. Rows from the third
  // token on are used when there are enough, so "first" and "previous" are different tokens.
  function headStats(A) {
    const n = A.length, from = n >= 3 ? 2 : 1;
    const s = { first: 0, previous: 0, self: 0, other: 0, rows: Math.max(0, n - from), from };
    for (let i = from; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        const w = A[i][j];
        if (j === i) s.self += w;
        else if (j === i - 1 && j > 0) s.previous += w;
        else if (j === 0) s.first += w;
        else s.other += w;
      }
    }
    if (s.rows) ['first', 'previous', 'self', 'other'].forEach(k => (s[k] /= s.rows));
    return s;
  }

  async function run(text, maxTokens) {
    if (!session) throw new Error('GPT-2 full internals are not loaded');
    let ids = GPT2.encode(text);
    if (!ids.length) return null;
    ids = ids.slice(0, maxTokens || 16);
    const o = await forward(ids);
    const n = ids.length, { D, H, DH, DFF, L } = manifest.dims;
    if (o.q.dims[2] !== D || o.attn.dims[1] !== H || o.mlp_pre.dims[2] !== DFF || o.attn.dims[0] !== L) throw new Error('model outputs do not match manifest.json');
    const d = name => o[name].data;
    const sq = Math.sqrt(DH);

    const tokEmb = rows(d('tok_emb'), 0, n, D), posEmb = rows(d('pos_emb'), 0, n, D);
    const hidden = Array.from({ length: L + 1 }, (_, l) => rows(d('hidden'), l * n * D, n, D));
    let worstSoftmax = 0;
    const layers = [];
    for (let l = 0; l < L; l++) {
      const off = l * n * D;
      const Q = d('q'), K = d('k'), V = d('v'), P = d('attn');
      const q = [], k = [], v = [], raw = [], scaled = [], masked = [], attn = [], headOut = [], stats = [];
      for (let h = 0; h < H; h++) {
        const slice = (data, i) => Array.from(data.subarray(off + i * D + h * DH, off + i * D + (h + 1) * DH));
        const qh = [], kh = [], vh = [];
        for (let i = 0; i < n; i++) { qh.push(slice(Q, i)); kh.push(slice(K, i)); vh.push(slice(V, i)); }
        const aH = rows(P, ((l * H + h) * n) * n, n, n); // GPT-2's own attention probabilities
        const rawH = [], scH = [], mH = [], oH = [];
        for (let i = 0; i < n; i++) {
          const r = [], s = [], m = [];
          for (let j = 0; j < n; j++) {
            let dot = 0;
            for (let t = 0; t < DH; t++) dot += qh[i][t] * kh[j][t];
            r.push(dot); s.push(dot / sq); m.push(j > i ? -Infinity : dot / sq);
          }
          // the page recomputes the softmax as a check on its own maths
          softmax(m).forEach((p, j) => { worstSoftmax = Math.max(worstSoftmax, Math.abs(p - aH[i][j])); });
          const out = new Array(DH).fill(0);
          for (let j = 0; j <= i; j++) { const w = aH[i][j]; for (let t = 0; t < DH; t++) out[t] += w * vh[j][t]; }
          rawH.push(r); scH.push(s); mH.push(m); oH.push(out);
        }
        q.push(qh); k.push(kh); v.push(vh); raw.push(rawH); scaled.push(scH); masked.push(mH); attn.push(aH); headOut.push(oH);
        stats.push(headStats(aH));
      }
      const concat = Array.from({ length: n }, (_, i) => [].concat(...headOut.map(hO => hO[i])));
      const hiddenPre = rows(d('mlp_pre'), l * n * DFF, n, DFF);
      layers.push({
        input: hidden[l], ln1: rows(d('ln1'), off, n, D), q, k, v, raw, scaled, masked, attn, headOut, concat,
        attnOut: rows(d('attn_out'), off, n, D), res1: rows(d('resid_mid'), off, n, D), res1n: rows(d('ln2'), off, n, D),
        hiddenPre, hidden: hiddenPre.map(r => r.map(gelu)), mlpOut: rows(d('mlp_out'), off, n, D), out: hidden[l + 1],
        headStats: stats
      });
    }
    if (worstSoftmax > 1e-4) console.warn(`GPT2Full: recomputed softmax differs from the model by ${worstSoftmax}`);

    const last = d('logits'), Vn = last.length;
    const order = Array.from({ length: Vn }, (_, i) => i).sort((a, b) => last[b] - last[a]);
    const tokens = ids.map(id => ({ text: GPT2.show(GPT2.decode(id)), id }));
    return {
      source: 'gpt2-full', tokens, tokEmb, posEmb, emb: hidden[0], layers,
      final: rows(d('ln_f'), (n - 1) * D, 1, D)[0],
      logits: order.map((id, r) => ({ id, logit: last[id], token: r < 200 ? GPT2.decode(id) : null })),
      vocabSize: Vn, dims: { D, H, DH, DFF, L },
      checks: { softmaxMaxAbs: worstSoftmax }
    };
  }

  window.GPT2Full = {
    available, load, run, headStats,
    isReady: () => !!session && GPT2.isTokenizerReady(),
    sizeMB: () => (manifest ? Math.round(manifest.bytes / 1e6) : 134),
    manifest: () => manifest
  };
})();
