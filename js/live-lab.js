(function () {
  const { $, $$, esc, fmtInt } = Site;
  const money = v => (v == null ? 'n/a' : v < 0.01 ? '$' + v.toFixed(4) : v < 1 ? '$' + v.toFixed(3) : '$' + v.toFixed(2));
  const secs = ms => (ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(2) + ' s');
  let status = null;

  const QUESTIONS = [
    { q: 'If today is Wednesday, what day of the week will it be 100 days from now?', a: 'Friday' },
    { q: 'How many times does the digit 7 appear when you write out every whole number from 1 to 100?', a: '20' },
    { q: 'Pens come in packs of 3 and packs of 5. What is the largest number of pens you cannot buy exactly?', a: '7' },
    { q: 'A train leaves at 09:47 and the journey takes 2 hours 38 minutes. At what time does it arrive? Give the time as HH:MM.', a: '12:25' }
  ];

  // ---------- status ----------
  async function showStatus() {
    status = await Live.refresh();
    const card = $('#status');
    if (!status.available || !status.has_credentials) {
      card.className = 'status-card off';
      card.innerHTML = `<b>Live calls are off.</b> ${esc(status.reason || '')}
        <pre>pip install -r python/requirements.txt
export ANTHROPIC_API_KEY=your-key-here
python python/server.py
# then open http://localhost:8000/live.html</pre>
        <p class="small muted" style="margin:8px 0 0">The server keeps the key, listens only on your machine, and stops at a spending cap you set with --budget. Each call on this page costs real money, usually a fraction of a cent to a few cents.</p>`;
      return;
    }
    card.className = 'status-card ok';
    card.innerHTML = `<span class="ok-dot"></span><b>Connected.</b> Default model ${esc(status.default_model)}. This session has spent about <b id="spent">${money(status.spent_usd)}</b> of its <b>${money(status.budget_usd)}</b> cap.`;
    $('#lab').classList.remove('locked');
    ['m1', 'm2', 'm3', 'm4'].forEach(id => { $('#' + id).innerHTML = status.models.map(m => `<option ${m === status.default_model ? 'selected' : ''}>${esc(m)}</option>`).join(''); });
  }
  const updateSpent = v => { const el = $('#spent'); if (el && v != null) el.textContent = money(v); };
  const usage = m => m.usage || {};

  // ---------- 1. run and measure ----------
  const hist = [];
  $('#run1').addEventListener('click', async () => {
    const btn = $('#run1'), out = $('#out1');
    btn.disabled = true; $('#err1').textContent = ''; out.textContent = ''; out.classList.add('streaming'); $('#stats1').innerHTML = '';
    const body = {
      model: $('#m1').value, max_tokens: +$('#mt1').value,
      output_config: { effort: $('#e1').value },
      messages: [{ role: 'user', content: $('#p1').value }]
    };
    if ($('#sys1').value.trim()) body.system = $('#sys1').value;
    try {
      const r = await Live.stream(body, t => { out.textContent += t; });
      const u = usage(r.message);
      if (r.message.stop_reason === 'refusal') out.textContent += '\n[The model declined this request.]';
      $('#stats1').innerHTML = [
        [secs(r.timing.ttft_ms), 'time to first text'], [secs(r.timing.total_ms), 'total time'],
        [fmtInt(u.input_tokens || 0), 'input tokens'], [fmtInt(u.output_tokens || 0), 'output tokens, including thinking'],
        [money(r.cost_usd), 'estimated cost'], [r.message.stop_reason, 'stop reason']
      ].map(([v, k]) => `<div class="stat"><div class="v">${esc(v)}</div><div class="k">${k}</div></div>`).join('');
      hist.unshift({ model: body.model, effort: body.output_config.effort, ttft: r.timing.ttft_ms, total: r.timing.total_ms, inp: u.input_tokens, out: u.output_tokens, cost: r.cost_usd });
      $('#hist tbody').innerHTML = hist.slice(0, 15).map(h => `<tr><td>${esc(h.model)}</td><td>${h.effort}</td><td class="num">${secs(h.ttft)}</td><td class="num">${secs(h.total)}</td><td class="num">${fmtInt(h.inp || 0)}</td><td class="num">${fmtInt(h.out || 0)}</td><td class="num">${money(h.cost)}</td></tr>`).join('');
      updateSpent(r.spent_usd);
    } catch (e) { $('#err1').textContent = e.message; }
    out.classList.remove('streaming'); btn.disabled = false;
  });

  // ---------- 2. effort ----------
  $('#q2').innerHTML = QUESTIONS.map((x, i) => `<option value="${i}">${esc(x.q)}</option>`).join('') + '<option value="custom">Your own question…</option>';
  $('#q2').addEventListener('change', e => { const c = e.target.value === 'custom'; $('#customWrap').hidden = $('#customAns').hidden = !c; });
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9:]/g, '');
  $('#run2').addEventListener('click', async () => {
    const efforts = $$('#efforts2 input:checked').map(i => i.value);
    if (!efforts.length) { $('#err2').textContent = 'Pick at least one effort level.'; return; }
    const sel = $('#q2').value, item = sel === 'custom' ? { q: $('#cq2').value.trim(), a: $('#ca2').value.trim() } : QUESTIONS[+sel];
    if (!item.q) { $('#err2').textContent = 'Type a question first.'; return; }
    $('#run2').disabled = true; $('#err2').textContent = '';
    $('#effTable').innerHTML = '<tbody><tr><td class="muted">Running…</td></tr></tbody>';
    const model = $('#m2').value;
    const results = await Promise.all(efforts.map(async effort => {
      try {
        const r = await Live.messages({ model, max_tokens: 16000, output_config: { effort },
          messages: [{ role: 'user', content: item.q + "\n\nFinish with a final line of the form 'Answer: <answer>'." }] });
        const txt = Live.text(r.message), m = txt.match(/Answer:\s*(.+)/g);
        const ans = m ? m[m.length - 1].replace(/Answer:\s*/, '').trim() : '(no answer line)';
        updateSpent(r.spent_usd);
        return { effort, ans, ok: item.a ? norm(ans).includes(norm(item.a)) : null, out: usage(r.message).output_tokens || 0, ms: r.timing.total_ms, cost: r.cost_usd };
      } catch (e) { return { effort, error: e.message }; }
    }));
    $('#effTable').innerHTML = `<thead><tr><th>Effort</th><th>Answer</th><th>Correct</th><th class="num">Output tokens</th><th class="num">Time</th><th class="num">Cost</th></tr></thead><tbody>${results.map(r => r.error
      ? `<tr><td>${r.effort}</td><td colspan="5" class="err">${esc(r.error)}</td></tr>`
      : `<tr><td>${r.effort}</td><td>${esc(r.ans)}</td><td>${r.ok == null ? '–' : r.ok ? '<span class="ok">✓</span>' : '<span class="no">✗</span>'}</td><td class="num">${fmtInt(r.out)}</td><td class="num">${secs(r.ms)}</td><td class="num">${money(r.cost)}</td></tr>`).join('')}</tbody>`;
    drawEffort(results.filter(r => !r.error));
    $('#run2').disabled = false;
  });
  function drawEffort(rs) {
    const W = 640, H = 200, l = 54, b = 26, top = 18, pw = W - l - 10, ph = H - top - b;
    if (!rs.length) { $('#effChart').innerHTML = ''; return; }
    const max = Math.max(...rs.map(r => r.out), 1) * 1.15, slot = pw / rs.length, bw = Math.min(70, slot * 0.55);
    let s = '';
    [0, 0.5, 1].forEach(f => { const y = top + ph - ph * f; s += `<line x1="${l}" x2="${W - 10}" y1="${y}" y2="${y}" stroke="var(--line)"></line><text x="${l - 6}" y="${y + 4}" text-anchor="end">${fmtInt(max * f)}</text>`; });
    rs.forEach((r, i) => {
      const h = Math.max(2, ph * r.out / max), x = l + i * slot + (slot - bw) / 2, y = top + ph - h;
      s += `<path d="M${x} ${top + ph} V${y + 4} Q${x} ${y} ${x + 4} ${y} H${x + bw - 4} Q${x + bw} ${y} ${x + bw} ${y + 4} V${top + ph} Z" fill="var(--s1)"><title>${r.effort}: ${fmtInt(r.out)} output tokens, ${money(r.cost)}</title></path>
        <text x="${x + bw / 2}" y="${y - 5}" text-anchor="middle" style="fill:var(--ink2)">${fmtInt(r.out)}${r.ok == null ? '' : r.ok ? ' ✓' : ' ✗'}</text>
        <text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${r.effort}</text>`;
    });
    $('#effChart').innerHTML = s;
  }

  // ---------- 3. caching ----------
  const CACHE_QS = ['How many days of annual leave do I get?', 'What is the hotel limit in Manchester?', 'Who do I call if I lose my laptop?'];
  let handbook = null;
  $('#run3').addEventListener('click', async () => {
    $('#run3').disabled = true; $('#err3').textContent = '';
    try {
      if (!handbook) handbook = (await (await fetch('/api/sample/handbook')).json()).text;
      const mode = document.querySelector('input[name=cm]:checked').value, model = $('#m3').value;
      const text = 'Answer employee questions from this handbook in one or two sentences.\n\n' + handbook;
      const rows = [];
      $('#cacheTable').innerHTML = '<tbody><tr><td class="muted">Running…</td></tr></tbody>';
      for (const q of CACHE_QS) { // sequential: a cache entry is readable only after the previous call starts
        const body = { model, max_tokens: 4096, output_config: { effort: 'low' }, messages: [{ role: 'user', content: q }] };
        if (mode === 'explicit') body.system = [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
        else body.system = text;
        if (mode === 'auto') body.cache_control = { type: 'ephemeral' };
        const r = await Live.messages(body), u = usage(r.message);
        rows.push({ q, inp: u.input_tokens || 0, w: u.cache_creation_input_tokens || 0, rd: u.cache_read_input_tokens || 0, out: u.output_tokens || 0, cost: r.cost_usd });
        updateSpent(r.spent_usd);
      }
      const total = rows.reduce((a, r) => a + (r.cost || 0), 0);
      $('#cacheTable').innerHTML = `<thead><tr><th>Question</th><th class="num">Full-price input</th><th class="num">Cache write</th><th class="num">Cache read</th><th class="num">Output</th><th class="num">Cost</th></tr></thead><tbody>${rows.map(r =>
        `<tr><td>${esc(r.q)}</td><td class="num">${fmtInt(r.inp)}</td><td class="num">${fmtInt(r.w)}</td><td class="num">${fmtInt(r.rd)}</td><td class="num">${fmtInt(r.out)}</td><td class="num">${money(r.cost)}</td></tr>`).join('')}
        <tr><td><b>Total</b></td><td colspan="4"></td><td class="num"><b>${money(total)}</b></td></tr></tbody>`;
    } catch (e) { $('#err3').textContent = e.message; }
    $('#run3').disabled = false;
  });

  // ---------- 4. count ----------
  $('#run4').addEventListener('click', async () => {
    $('#err4').textContent = '';
    try {
      const t = $('#t4').value, r = await Live.countTokens({ model: $('#m4').value, messages: [{ role: 'user', content: t }] });
      $('#stats4').innerHTML = `<div class="stat"><div class="v">${fmtInt(r.input_tokens)}</div><div class="k">tokens, including a few for message framing</div></div><div class="stat"><div class="v">${fmtInt(t.length)}</div><div class="k">characters</div></div><div class="stat"><div class="v">${(t.length / Math.max(1, r.input_tokens)).toFixed(2)}</div><div class="k">characters per token</div></div>`;
    } catch (e) { $('#err4').textContent = e.message; }
  });

  showStatus();
})();
