/* Real GPT-2 (124M parameters) in the browser via transformers.js.
 * The tokenizer (~2 MB) and the 8-bit model (~128 MB) download from Hugging Face
 * on first use; the browser caches them afterwards. */
(function () {
  const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js';
  const MODEL = 'Xenova/gpt2';
  let T = null, tok = null, model = null, tokLoading = null, loading = null;

  function progressTracker(onProgress) {
    const files = {};
    return p => {
      if (p.status !== 'progress' || !p.total) return;
      files[p.file] = { loaded: p.loaded, total: p.total };
      const fs = Object.values(files);
      onProgress && onProgress(fs.reduce((a, f) => a + f.loaded, 0), fs.reduce((a, f) => a + f.total, 0));
    };
  }
  async function lib() {
    if (!T) { T = await import(LIB); T.env.allowLocalModels = false; }
    return T;
  }
  function loadTokenizer(onProgress) {
    if (tok) return Promise.resolve();
    if (!tokLoading) tokLoading = (async () => {
      await lib();
      tok = await T.AutoTokenizer.from_pretrained(MODEL, { progress_callback: progressTracker(onProgress) });
      try { localStorage.setItem('gpt2-tok-loaded', '1'); } catch (e) { /* storage unavailable */ }
    })().catch(e => { tokLoading = null; throw e; });
    return tokLoading;
  }
  function load(onProgress) {
    if (model) return Promise.resolve();
    if (!loading) loading = (async () => {
      const cb = progressTracker(onProgress);
      await loadTokenizer(onProgress);
      model = await T.AutoModelForCausalLM.from_pretrained(MODEL, {
        dtype: 'q8', model_file_name: 'decoder_model_merged', device: 'wasm', progress_callback: cb
      });
      try { localStorage.setItem('gpt2-loaded', '1'); } catch (e) { /* storage unavailable */ }
    })().catch(e => { loading = null; throw e; });
    return loading;
  }

  const encode = text => Array.from(tok.encode(text));
  const decode = id => tok.decode([id]);
  const decodeMany = ids => tok.decode(ids);
  const show = s => (s.replace(/\n/g, '↵').replace(/\t/g, '⇥').trim() || '␣');

  // Logits for the token that would follow `ids` (Float32Array of 50,257 scores).
  const cache = new Map();
  let queue = Promise.resolve();
  function nextLogits(ids) {
    // one forward pass at a time: the ONNX session cannot run concurrently
    const run = queue.then(() => forward(ids));
    queue = run.catch(() => {});
    return run;
  }
  async function forward(ids) {
    const key = ids.join(',');
    if (cache.has(key)) return cache.get(key);
    const n = ids.length;
    const input_ids = new T.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, n]);
    const attention_mask = new T.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]);
    const out = await model({ input_ids, attention_mask });
    const V = out.logits.dims[2];
    const last = out.logits.data.slice((n - 1) * V, n * V);
    cache.set(key, last);
    if (cache.size > 48) cache.delete(cache.keys().next().value);
    return last;
  }
  function softmax(logits, T = 1) {
    let m = -Infinity;
    for (let i = 0; i < logits.length; i++) if (logits[i] / T > m) m = logits[i] / T;
    const out = new Float32Array(logits.length); let s = 0;
    for (let i = 0; i < logits.length; i++) { out[i] = Math.exp(logits[i] / T - m); s += out[i]; }
    for (let i = 0; i < out.length; i++) out[i] /= s;
    return out;
  }
  function topIndices(arr, k) {
    const idx = [];
    for (let i = 0; i < arr.length; i++) {
      if (idx.length < k) { idx.push(i); idx.sort((a, b) => arr[b] - arr[a]); }
      else if (arr[i] > arr[idx[k - 1]]) { idx[k - 1] = i; idx.sort((a, b) => arr[b] - arr[a]); }
    }
    return idx;
  }

  // Used by the Transformer Explainer page.
  async function predict(text, maxTokens) {
    let ids = encode(text);
    if (!ids.length) return null;
    ids = ids.slice(0, maxTokens);
    const last = await nextLogits(ids);
    const V = last.length;
    const order = Array.from({ length: V }, (_, i) => i).sort((a, b) => last[b] - last[a]);
    return {
      tokens: ids.map(id => ({ text: show(decode(id)), id })),
      logits: order.map((id, r) => ({ id, logit: last[id], token: r < 200 ? decode(id) : null })),
      vocabSize: V
    };
  }

  window.GPT2 = {
    load, loadTokenizer, predict, encode, decode, decodeMany, show, nextLogits, softmax, topIndices,
    isReady: () => !!model, isTokenizerReady: () => !!tok, lib, sizeMB: 128
  };
})();
