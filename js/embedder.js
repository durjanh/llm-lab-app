/* Sentence embeddings with all-MiniLM-L6-v2 (384 dimensions, ~23 MB, 8-bit) via transformers.js. */
(function () {
  const MODEL = 'Xenova/all-MiniLM-L6-v2';
  let extractor = null, loading = null;
  const cache = new Map();
  function load(onProgress) {
    if (extractor) return Promise.resolve();
    if (!loading) loading = (async () => {
      const T = await GPT2.lib();
      const files = {};
      extractor = await T.pipeline('feature-extraction', MODEL, {
        dtype: 'q8', device: 'wasm',
        progress_callback: p => {
          if (p.status !== 'progress' || !p.total) return;
          files[p.file] = { loaded: p.loaded, total: p.total };
          const fs = Object.values(files);
          onProgress && onProgress(fs.reduce((a, f) => a + f.loaded, 0), fs.reduce((a, f) => a + f.total, 0));
        }
      });
      try { localStorage.setItem('minilm-loaded', '1'); } catch (e) { /* storage unavailable */ }
    })().catch(e => { loading = null; throw e; });
    return loading;
  }
  let queue = Promise.resolve();
  function embed(texts) {
    const run = queue.then(() => embedNow(texts));
    queue = run.catch(() => {});
    return run;
  }
  async function embedNow(texts) {
    const todo = texts.filter(t => !cache.has(t));
    for (let i = 0; i < todo.length; i += 16) {
      const batch = todo.slice(i, i + 16);
      const out = await extractor(batch, { pooling: 'mean', normalize: true });
      out.tolist().forEach((v, j) => cache.set(batch[j], v));
    }
    return texts.map(t => cache.get(t));
  }
  const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  window.Embedder = { load, embed, cosine, isReady: () => !!extractor, dims: 384, sizeMB: 23 };
})();
