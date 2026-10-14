/* Browser client for the local Live Claude server (python/server.py).
 * The server holds the API key; the page never sees it. When the page is opened
 * from disk, or the server is not running, Live.status() reports unavailable. */
(function () {
  let cached = null;
  async function status() {
    if (cached) return cached;
    if (location.protocol === 'file:') return (cached = { available: false, reason: 'Open this page through the local server to use live Claude: python python/server.py' });
    try {
      const r = await fetch('/api/status', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const s = await r.json();
      cached = { available: true, has_credentials: !!s.has_credentials, default_model: s.default_model, models: s.models || [], prices: s.prices || {}, spent_usd: s.spent_usd, budget_usd: s.budget_usd };
      if (!cached.has_credentials) cached.reason = 'The server is running but has no API credentials. Set ANTHROPIC_API_KEY and restart it.';
    } catch (e) {
      cached = { available: false, reason: 'The local server is not running. Start it with: python python/server.py' };
    }
    return cached;
  }
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-llm-lab': '1' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error((data.error && data.error.message) || 'HTTP ' + r.status); e.status = r.status; e.type = data.error && data.error.type; throw e; }
    return data;
  }
  /* body: a Messages API request (model optional; server defaults it). Returns
   * { message, timing: { total_ms }, cost_usd } where message is the API's JSON. */
  const messages = body => post('/api/messages', body);
  const countTokens = body => post('/api/count_tokens', body);
  /* Streams one request. onText(chunk) is called as text arrives. Resolves to
   * { message, timing: { ttft_ms, total_ms }, cost_usd }. */
  async function stream(body, onText) {
    const r = await fetch('/api/stream', { method: 'POST', headers: { 'content-type': 'application/json', 'x-llm-lab': '1' }, body: JSON.stringify(body) });
    if (!r.ok || !r.body) { const d = await r.json().catch(() => ({})); throw new Error((d.error && d.error.message) || 'HTTP ' + r.status); }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '', final = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'text') onText && onText(ev.text);
        else if (ev.type === 'done') final = ev;
        else if (ev.type === 'error') throw new Error(ev.message);
      }
    }
    if (!final) throw new Error('The stream ended without a final message.');
    return final;
  }
  const refresh = () => { cached = null; return status(); };
  const text = message => (message && message.content ? message.content.filter(b => b.type === 'text').map(b => b.text).join('') : '');
  window.Live = { status, refresh, messages, countTokens, stream, text };
})();
