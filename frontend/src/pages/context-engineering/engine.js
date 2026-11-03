import { Site } from '@/lib/site';

/** Runs the page's interactive parts. Returns nothing; `life` undoes timers and listeners on unmount. */
export function mount(root, life) {
  const { $, $$, esc, fmtInt } = Site;
  const PRICE_IN = 4 / 1e6, CACHE_READ = 0.2 / 1e6, CACHE_WRITE = 4 * 1.25 / 1e6; // Claude Opus 5.5 list prices, October 2026

  // ---------- 1. context builder ----------
  const FACTS = [
    ['F1', 'Order 1042: what it was, and that it was delivered'],
    ['F2', 'Damaged items are replaced free within 30 days'],
    ['F3', 'Express delivery arrives next working day'],
    ['F4', 'Damaged returns get a prepaid postage label']
  ];
  const GROUPS = [
    { key: 'tools', name: 'Tool definitions', color: 'var(--s1)', options: [
      ['all', 'All 40 tools the platform has', 6000, [], 'Includes refunds, marketing and admin tools this request never needs.'],
      ['needed', 'The 5 tools this task needs', 700, []],
      ['none', 'No tools', 0, [], 'The agent cannot look anything up or act.']] },
    { key: 'policy', name: 'Policies', color: 'var(--s2)', options: [
      ['full', 'The whole policy handbook', 18000, ['F2', 'F4']],
      ['retrieved', 'Three retrieved policy sections', 900, ['F2', 'F4']],
      ['none', 'No policies', 0, []]] },
    { key: 'orders', name: 'Order data', color: 'var(--s3)', options: [
      ['all', 'Export of all 37 of the customer\'s orders', 9500, ['F1']],
      ['lookup', 'Order 1042, looked up by a tool', 250, ['F1']],
      ['none', 'No order data', 0, []]] },
    { key: 'history', name: 'Conversation history', color: 'var(--s4)', options: [
      ['full', 'All 60 earlier turns, verbatim', 14000, []],
      ['summary', 'Summary of earlier turns, plus the last 4', 1100, []],
      ['none', 'Only the latest message', 0, []]] }
  ];
  const EXTRAS = [
    ['shipping', 'Shipping options page', 1200, ['F3'], true],
    ['memory', 'Customer notes: premium member, prefers email', 120, [], true],
    ['marketing', 'Current promotions and marketing copy', 2500, [], false],
    ['logs', 'Debug logs from earlier tool calls', 4000, [], false]
  ];
  const PRESETS = {
    stuff: { tools: 'all', policy: 'full', orders: 'all', history: 'full', shipping: true, memory: true, marketing: true, logs: true },
    engineered: { tools: 'needed', policy: 'retrieved', orders: 'lookup', history: 'summary', shipping: true, memory: true, marketing: false, logs: false },
    lean: { tools: 'needed', policy: 'none', orders: 'lookup', history: 'none', shipping: false, memory: false, marketing: false, logs: false }
  };
  const S = { ...PRESETS.engineered };
  function renderGroups() {
    $('#groups').innerHTML = `<div class="item-group"><h4><i style="--c:var(--muted)"></i>System prompt</h4><div class="opt"><input type="checkbox" checked disabled><span>Role, tone and rules for the support agent</span><span class="tok">400</span></div></div>` +
      GROUPS.map(g => `<div class="item-group"><h4><i style="--c:${g.color}"></i>${g.name}</h4>${g.options.map(([v, label, tok, f, note]) =>
        `<label class="opt"><input type="radio" name="${g.key}" value="${v}" ${S[g.key] === v ? 'checked' : ''}><span>${esc(label)}${f.length ? `<br><span class="facts">Provides ${f.join(', ')}</span>` : ''}${note ? `<br><span class="facts">${esc(note)}</span>` : ''}</span><span class="tok">${fmtInt(tok)}</span></label>`).join('')}</div>`).join('') +
      `<div class="item-group"><h4><i style="--c:var(--s5)"></i>Other material</h4>${EXTRAS.map(([k, label, tok, f, useful]) =>
        `<label class="opt"><input type="checkbox" name="${k}" ${S[k] ? 'checked' : ''}><span>${esc(label)}${f.length ? `<br><span class="facts">Provides ${f.join(', ')}</span>` : useful ? '<br><span class="facts">Useful context, no required fact</span>' : '<br><span class="facts">Irrelevant to this request</span>'}</span><span class="tok">${fmtInt(tok)}</span></label>`).join('')}</div>`;
  }
  $('#groups').addEventListener('change', e => { const t = e.target; if (t.type === 'radio') S[t.name] = t.value; else S[t.name] = t.checked; computeCtx(); });
  $$('[data-preset]').forEach(b => b.addEventListener('click', () => { Object.assign(S, PRESETS[b.dataset.preset]); renderGroups(); computeCtx(); }));
  function totalFor(st) {
    let t = 400 + 120;
    GROUPS.forEach(g => { t += g.options.find(x => x[0] === st[g.key])[2]; });
    EXTRAS.forEach(([k, , tok]) => { if (st[k]) t += tok; });
    return t;
  }
  function computeCtx() {
    const parts = [['System prompt', 400, 'var(--muted)', true]], facts = new Set();
    let noise = 0;
    GROUPS.forEach(g => { const o = g.options.find(x => x[0] === S[g.key]); if (o[2]) parts.push([g.name, o[2], g.color, true]); o[3].forEach(f => facts.add(f)); if ((g.key === 'tools' && o[0] === 'all')) noise += o[2] - 700; if (g.key === 'policy' && o[0] === 'full') noise += o[2] - 900; if (g.key === 'orders' && o[0] === 'all') noise += o[2] - 250; if (g.key === 'history' && o[0] === 'full') noise += o[2] - 1100; });
    EXTRAS.forEach(([k, label, tok, f, useful]) => { if (S[k]) { parts.push([label, tok, useful ? 'var(--s5)' : 'var(--faint)', useful]); f.forEach(x => facts.add(x)); if (!useful) noise += tok; } });
    const total = parts.reduce((a, p) => a + p[1], 0) + 120; // the question itself
    const covered = FACTS.filter(([k]) => facts.has(k)).length;
    $('#ctxStats').innerHTML = [[fmtInt(total), 'input tokens'], ['$' + (total * PRICE_IN).toFixed(4), 'per call, Claude Opus 5.5 input price'], ['$' + fmtInt(total * PRICE_IN * 10000), 'per day at 10,000 calls'], [`${covered} / 4`, 'needed facts present'], [Math.round(100 * noise / total) + '%', 'of the tokens are irrelevant or redundant']]
      .map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
    $('#ctxStack').innerHTML = parts.map(([n, t, c]) => `<i style="flex:0 0 ${(100 * t / total).toFixed(2)}%;background:${c}" title="${esc(n)}: ${fmtInt(t)} tokens"></i>`).join('');
    $('#ctxLegend').innerHTML = parts.map(([n, t, c]) => `<span style="--c:${c}">${esc(n)} ${fmtInt(t)}</span>`).join('');
    $('#facts').innerHTML = FACTS.map(([k, label]) => `<div class="fact"><b class="${facts.has(k) ? 'ok' : 'no'}">${facts.has(k) ? '✓' : '✗'}</b><span><b>${k}</b> ${esc(label)}</span></div>`).join('');
    const v = $('#ctxVerdict');
    if (covered < 4) { v.className = 'verdict bad'; v.innerHTML = `<b>Missing ${4 - covered} fact${4 - covered > 1 ? 's' : ''}.</b> The model will have to guess, ask the customer, or call tools it may not have. Guessing a policy is how confident wrong answers happen.`; }
    else if (total > 12000) { v.className = 'verdict bad'; v.innerHTML = `<b>Everything is there, buried in ${fmtInt(total)} tokens.</b> This costs ${(total / totalFor(PRESETS.engineered)).toFixed(1)} times as much as the engineered version and is slower to process. With so much irrelevant text, the model is more likely to miss or confuse a detail, such as quoting a promotion as policy.`; }
    else { v.className = 'verdict good'; v.innerHTML = '<b>Well engineered.</b> Every needed fact is present, with little else around it. That gives a cheaper, faster and more reliable answer.'; }
  }
  renderGroups(); computeCtx();

  // ---------- 2. ordering for caching ----------
  const LAYOUTS = {
    bad: { name: 'Timestamp at the top', blocks: [['System prompt with "Current time: 14:32:07"', 400, 'v'], ['Tool definitions', 700, 's'], ['Role and rules', 300, 's'], ['Retrieved policies', 900, 'q'], ['Conversation summary and recent turns', 1100, 'q'], ['Customer question', 120, 'q']] },
    shuffled: { name: 'Tool order changes each call', blocks: [['Tool definitions, built from an unordered set', 700, 'v'], ['System prompt and rules', 700, 's'], ['Retrieved policies', 900, 'q'], ['Conversation summary and recent turns', 1100, 'q'], ['Customer question', 120, 'q']] },
    good: { name: 'Stable first, volatile last', blocks: [['Tool definitions, fixed order', 700, 's'], ['System prompt and rules, no timestamp', 700, 's'], ['Conversation summary and recent turns', 1100, 'h'], ['Retrieved policies', 900, 'q'], ['Customer question, with the current time', 120, 'q']] }
  };
  let layout = 'good';
  $('#layoutPick').innerHTML = Object.entries(LAYOUTS).map(([k, l]) => `<button class="chip-btn${k === layout ? ' on' : ''}" data-l="${k}">${l.name}</button>`).join('');
  $('#layoutPick').addEventListener('click', e => { const b = e.target.closest('[data-l]'); if (!b) return; layout = b.dataset.l; $$('#layoutPick .chip-btn').forEach(x => x.classList.toggle('on', x === b)); renderLayout(); });
  function renderLayout() {
    const L = LAYOUTS[layout];
    // cached prefix: blocks from the start until the first block that changes between calls
    let cached = 0, broken = false;
    // 'h' (the conversation so far) matches the previous call's prefix, so it is cached too
    L.blocks.forEach(([, t, kind]) => { if (broken || kind === 'v' || kind === 'q') broken = true; else cached += t; });
    const total = L.blocks.reduce((a, b) => a + b[1], 0);
    let acc = 0, brk = false;
    $('#layout').innerHTML = L.blocks.map(([label, t, kind]) => {
      const isCached = !brk && (kind === 's' || (layout === 'good' && kind === 'h')); if (!isCached) brk = true;
      acc += t; return `<div class="blk ${isCached ? 'cached' : kind === 'v' ? 'volatile' : ''}"><span>${esc(label)}</span><span>${fmtInt(t)} tokens${isCached ? ' · from cache' : kind === 'v' ? ' · changes every call' : ''}</span></div>`;
    }).join('');
    const full = total * PRICE_IN, withCache = cached * CACHE_READ + (total - cached) * PRICE_IN * 1.25;
    $('#layoutStats').innerHTML = [[fmtInt(cached), 'tokens read from cache'], [pctTxt(cached / total), 'of the request'], ['$' + (withCache * 10000).toFixed(2), 'input cost per 10,000 calls, caching on'], ['$' + (full * 10000).toFixed(2), 'with caching off']]
      .map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
    $('#layoutNote').innerHTML = layout === 'bad' ? 'The timestamp changes every second, so the very first block differs on every call and nothing after it can be read from the cache. With caching switched on you even pay the 25% cache-write premium on every call, for nothing.'
      : layout === 'shuffled' ? 'Building the tool list from an unordered set gives a different byte order on different calls. The model does not care, but the cache does, and the write premium is wasted on every call.'
      : 'Tools and instructions never change, and the conversation so far matches the previous call, so all of it is read from the cache. Only the new material at the end is processed at full price.';
  }
  const pctTxt = v => Math.round(v * 100) + '%';
  renderLayout();

  // ---------- 3. long conversations ----------
  const LIMIT = 20000, TURNS = 50, BASE = 1800;
  const turnTokens = t => 380 + (t % 4 === 0 ? 700 : 0); // every fourth turn includes a tool result
  const STRATS = [
    ['all', 'Keep everything', 'var(--s1)'], ['window', 'Sliding window, last 8 turns', 'var(--s2)'],
    ['summary', 'Summarise when 70% full', 'var(--s3)'], ['notes', 'Notes file plus last 6 turns', 'var(--s4)']
  ];
  function simulate(kind) {
    const out = []; let hist = 0, summary = 0, failedAt = null;
    for (let t = 1; t <= TURNS; t++) {
      const add = turnTokens(t);
      let tokens;
      if (kind === 'all') { hist += add; tokens = BASE + hist; if (tokens > LIMIT && !failedAt) failedAt = t; }
      else if (kind === 'window') { let s = 0; for (let k = Math.max(1, t - 7); k <= t; k++) s += turnTokens(k); tokens = BASE + s; }
      else if (kind === 'summary') { hist += add; tokens = BASE + summary + hist; if (tokens > 0.7 * LIMIT) { summary = 1500; hist = add; tokens = BASE + summary + hist; } }
      else { let s = 0; for (let k = Math.max(1, t - 5); k <= t; k++) s += turnTokens(k); tokens = BASE + 600 + s; }
      out.push(failedAt && kind === 'all' ? null : tokens);
    }
    return { out, failedAt };
  }
  function renderConv() {
    const W = 720, H = 280, l = 52, r = 14, t = 12, b = 34, pw = W - l - r, ph = H - t - b, maxY = 24000;
    const sx = x => l + (x - 1) / (TURNS - 1) * pw, sy = y => t + (1 - y / maxY) * ph;
    let s = '';
    [0, 5000, 10000, 15000, 20000].forEach(y => { s += `<line x1="${l}" x2="${W - r}" y1="${sy(y)}" y2="${sy(y)}" stroke="var(--line)"></line><text x="${l - 6}" y="${sy(y) + 4}" text-anchor="end">${y / 1000}K</text>`; });
    [1, 10, 20, 30, 40, 50].forEach(x => { s += `<text x="${sx(x)}" y="${H - 16}" text-anchor="middle">${x}</text>`; });
    s += `<text x="${l + pw / 2}" y="${H - 2}" text-anchor="middle">turn</text>`;
    s += `<line x1="${l}" x2="${W - r}" y1="${sy(LIMIT)}" y2="${sy(LIMIT)}" stroke="var(--bad)" stroke-dasharray="5 4"></line><text x="${W - r}" y="${sy(LIMIT) - 5}" text-anchor="end" style="fill:var(--bad)">context window</text>`;
    const results = STRATS.map(([k, name, col]) => {
      const sim = simulate(k); const pts = sim.out.map((v, i) => (v == null ? null : `${sx(i + 1).toFixed(1)},${sy(v).toFixed(1)}`)).filter(Boolean);
      s += `<polyline fill="none" stroke="${col}" stroke-width="2" points="${pts.join(' ')}"></polyline>`;
      if (sim.failedAt) s += `<text x="${sx(sim.failedAt)}" y="${sy(LIMIT) - 18}" text-anchor="middle" style="fill:var(--bad);font-weight:600">fails at turn ${sim.failedAt}</text>`;
      const total = sim.out.reduce((a, v) => a + (v || 0), 0);
      return { k, name, col, sim, total };
    });
    $('#convChart').innerHTML = s;
    $('#convLegend').innerHTML = STRATS.map(([, n, c]) => `<span style="--c:${c}">${n}</span>`).join('') + '<span style="--c:var(--bad)">Context window</span>';
    const remembers = { all: 'Yes, until it fails', window: 'No: turn 2 fell out of the window', summary: 'Yes, if the summary kept it', notes: 'Yes: saved to the notes file' };
    $('#convTable').innerHTML = `<thead><tr><th>Strategy</th><th>Finishes 50 turns?</th><th>Still knows the account number?</th><th class="num">Tokens sent, over the turns it completed</th></tr></thead><tbody>${results.map(r => `<tr><td><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${r.col};margin-right:6px"></span>${r.name}</td><td>${r.sim.failedAt ? `No, the window fills at turn ${r.sim.failedAt}` : 'Yes'}</td><td>${remembers[r.k]}</td><td class="num">${fmtInt(r.total)}</td></tr>`).join('')}</tbody>`;
  }
  renderConv();

  // ---------- 4. tool results ----------
  const RAW = { data: { order: { id: '1042', uuid: '7f3c2a9e-4b1d-4e8a-9c2f-1a6b8d0e5f73', created_at: '2026-10-02T09:14:22.318Z', updated_at: '2026-10-09T16:40:05.002Z', status: 'DELIVERED', status_history: [{ status: 'PLACED', at: '2026-10-02T09:14:22Z', actor: 'web-checkout-svc' }, { status: 'PAID', at: '2026-10-02T09:14:31Z', actor: 'payments-svc', psp_ref: 'pi_3Q8x2LkT9' }, { status: 'PICKED', at: '2026-10-03T07:02:10Z', actor: 'wms-node-14' }, { status: 'SHIPPED', at: '2026-10-03T15:48:44Z', actor: 'carrier-sync', carrier: 'DPD', tracking: 'DPD1520447831' }, { status: 'DELIVERED', at: '2026-10-09T16:40:05Z', actor: 'carrier-sync' }], customer: { id: 'C-77', segment: 'premium', marketing_opt_in: false, lifetime_value_gbp: 1840.5, risk_score: 0.03 }, items: [{ sku: 'DSK-STD-OAK-140', name: 'Standing desk, oak, 140 cm', qty: 1, unit_price_gbp: 449, tax_code: 'GB-STD', warehouse: 'MAN-2', weight_kg: 38.2, dimensions_cm: [140, 70, 12] }], totals: { subtotal: 449, shipping: 0, tax: 74.83, total: 449 }, flags: { gift: false, fragile: true, signature_required: true }, _links: { self: '/v2/orders/1042', customer: '/v2/customers/C-77', invoice: '/v2/invoices/INV-55120' } } }, meta: { request_id: 'req_91d2c4', api_version: '2026-07-01', latency_ms: 84 } };
  const SLIM = { order_id: '1042', item: 'Standing desk, oak, 140 cm', status: 'delivered', delivered_on: '2026-10-09', fragile: true, customer: { id: 'C-77', premium: true } };
  const raw = JSON.stringify(RAW, null, 2), slim = JSON.stringify(SLIM, null, 2);
  $('#rawJson').textContent = raw; $('#slimJson').textContent = slim;
  $('#rawTok').textContent = `about ${fmtInt(raw.length / 4)} tokens`; $('#slimTok').textContent = `about ${fmtInt(slim.length / 4)} tokens`;
}
