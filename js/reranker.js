/* Cross-encoder reranker: ms-marco-MiniLM-L-6-v2 (8-bit, about 24 MB with its tokenizer) via transformers.js.
 * Unlike an embedding model, it reads the query and a passage together and returns one relevance
 * score per pair. Higher means more relevant; the scale is the model's own. */
(function () {
  const MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
  let tok = null, model = null, loading = null;
  const cache = new Map();

  function load(onProgress) {
    if (model) return Promise.resolve();
    if (!loading) loading = (async () => {
      const T = await GPT2.lib();
      const files = {};
      const progress_callback = p => {
        if (p.status !== 'progress' || !p.total) return;
        files[p.file] = { loaded: p.loaded, total: p.total };
        const fs = Object.values(files);
        onProgress && onProgress(fs.reduce((a, f) => a + f.loaded, 0), fs.reduce((a, f) => a + f.total, 0));
      };
      tok = await T.AutoTokenizer.from_pretrained(MODEL, { progress_callback });
      model = await T.AutoModelForSequenceClassification.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm', progress_callback });
      try { localStorage.setItem('reranker-loaded', '1'); } catch (e) { /* storage unavailable */ }
    })().catch(e => { loading = null; tok = null; model = null; throw e; });
    return loading;
  }

  // one inference run at a time: the ONNX session cannot run concurrently
  let queue = Promise.resolve();
  function score(query, texts) {
    const run = queue.then(() => scoreNow(query, texts));
    queue = run.catch(() => {});
    return run;
  }
  let last = { pairs: 0, ms: 0 };
  async function scoreNow(query, texts) {
    if (!model) throw new Error('Reranker is not loaded');
    const key = t => query + '\u0000' + t;
    const todo = [...new Set(texts)].filter(t => !cache.has(key(t)));
    const t0 = performance.now();
    for (let i = 0; i < todo.length; i += 8) {
      const batch = todo.slice(i, i + 8);
      const inputs = tok(new Array(batch.length).fill(query), { text_pair: batch, padding: true, truncation: true });
      const out = await model(inputs);
      batch.forEach((t, j) => cache.set(key(t), out.logits.data[j]));
    }
    last = { pairs: todo.length, ms: todo.length ? performance.now() - t0 : 0 };
    while (cache.size > 400) cache.delete(cache.keys().next().value);
    return texts.map(t => cache.get(key(t)));
  }

  // pairs scored and time taken by the most recent call; ms is 0 when every score came from the cache
  const lastRun = () => last;
  window.Reranker = { load, isReady: () => !!model, score, lastRun, sizeMB: 24 };
})();
