(function () {
  const { $, esc, fmtInt } = Site;
  const PRESETS = {
    'English': 'Large language models read text as tokens. A token is often a whole common word, a piece of a rarer word, or a single punctuation mark.',
    'Python': 'def average(numbers):\n    """Return the mean of a list."""\n    if not numbers:\n        return 0.0\n    return sum(numbers) / len(numbers)\n',
    'JSON': '{"user_id": 48213, "name": "Ada Lovelace", "roles": ["admin", "editor"], "active": true}',
    'Numbers & dates': 'Order 1042 shipped on 2026-10-14. Total: £1,234.56. Ref 8f3a9c21. 123456789 + 987654321 = 1111111110',
    'Other languages': 'Bonjour, comment allez-vous ?\nGuten Morgen, wie geht es dir?\nこんにちは、元気ですか？\nمرحبا، كيف حالك؟\nनमस्ते, आप कैसे हैं?',
    'Emoji': 'Great job 🎉🎉 thanks 👍🏽 ❤️ see you at 3pm ☕',
    'Rare words': 'Kubernetes, Databricks, PyTorch and OAuth2 are common in engineering but rare in general text. So is pneumonoultramicroscopicsilicovolcanoconiosis.',
    'Whitespace': 'def f():\n        if True:\n                return 1   \n\n\n\t\tx = 2\n'
  };
  const text = $('#text'), out = $('#out');
  let ready = false;

  // ---------- playground ----------
  function tokenSpan(id, opts) {
    let s = GPT2.decode(id);
    const title = `id ${id} · ${esc(JSON.stringify(s))}`;
    let html = esc(s);
    if (opts.spaces) html = html.replace(/ /g, '<span class="sp">·</span>');
    html = html.replace(/\n/g, '<span class="sp">↵</span>').replace(/\t/g, '<span class="sp">⇥</span>');
    const br = (s.match(/\n/g) || []).length;
    return `<span class="tk" title="${title}">${html}${opts.ids ? `<small>${id}</small>` : ''}</span>${br ? '<br>'.repeat(Math.min(br, 2)) : ''}`;
  }
  function renderPlayground() {
    if (!ready) return;
    const t = text.value, ids = GPT2.encode(t);
    const opts = { ids: $('#showIds').checked, spaces: $('#showSpaces').checked };
    out.innerHTML = ids.slice(0, 1500).map(id => tokenSpan(id, opts)).join('') + (ids.length > 1500 ? '<p class="muted">Showing the first 1,500 tokens.</p>' : '');
    $('#sTokens').textContent = fmtInt(ids.length);
    $('#sChars').textContent = fmtInt(t.length);
    $('#sRatio').textContent = ids.length ? (t.length / ids.length).toFixed(2) : '0';
    $('#sWords').textContent = fmtInt((t.match(/\S+/g) || []).length);
  }
  Object.keys(PRESETS).forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'chip-btn' + (i === 0 ? ' on' : ''); b.textContent = name;
    b.addEventListener('click', () => {
      document.querySelectorAll('#presets .chip-btn').forEach(x => x.classList.toggle('on', x === b));
      text.value = PRESETS[name]; renderPlayground();
    });
    $('#presets').appendChild(b);
  });
  text.value = PRESETS.English;
  text.addEventListener('input', () => { document.querySelectorAll('#presets .chip-btn').forEach(x => x.classList.remove('on')); renderPlayground(); });
  $('#showIds').addEventListener('change', renderPlayground);
  $('#showSpaces').addEventListener('change', renderPlayground);

  // ---------- formats ----------
  const PEOPLE = [
    { id: 1, name: 'Ada Lovelace', role: 'Engineer', city: 'London', start: 2019 },
    { id: 2, name: 'Alan Turing', role: 'Researcher', city: 'Manchester', start: 2020 },
    { id: 3, name: 'Grace Hopper', role: 'Architect', city: 'New York', start: 2018 },
    { id: 4, name: 'Katherine Johnson', role: 'Analyst', city: 'Hampton', start: 2021 },
    { id: 5, name: 'Tim Berners-Lee', role: 'Engineer', city: 'Geneva', start: 2017 },
    { id: 6, name: 'Margaret Hamilton', role: 'Lead', city: 'Boston', start: 2016 }
  ];
  const keys = Object.keys(PEOPLE[0]);
  const FORMATS = [
    ['JSON, pretty-printed', JSON.stringify(PEOPLE, null, 2)],
    ['JSON, minified', JSON.stringify(PEOPLE)],
    ['YAML', PEOPLE.map(p => keys.map((k, i) => `${i ? '  ' : '- '}${k}: ${p[k]}`).join('\n')).join('\n')],
    ['CSV', [keys.join(','), ...PEOPLE.map(p => keys.map(k => p[k]).join(','))].join('\n')],
    ['Markdown table', [`| ${keys.join(' | ')} |`, `|${keys.map(() => '---').join('|')}|`, ...PEOPLE.map(p => `| ${keys.map(k => p[k]).join(' | ')} |`)].join('\n')],
    ['Plain sentences', PEOPLE.map(p => `${p.name} (id ${p.id}) is a ${p.role.toLowerCase()} in ${p.city} who started in ${p.start}.`).join('\n')]
  ];
  function renderFormats() {
    const rows = FORMATS.map(([name, s]) => ({ name, s, n: GPT2.encode(s).length }));
    const min = Math.min(...rows.map(r => r.n)), max = Math.max(...rows.map(r => r.n));
    $('#fmtTable tbody').innerHTML = rows.map((r, i) => `<tr class="fmt-row" data-i="${i}"><td>${r.name}</td><td class="num">${fmtInt(r.s.length)}</td><td class="num"><b>${fmtInt(r.n)}</b></td>
      <td><span class="hbar" style="width:${(85 * r.n / max).toFixed(1)}%"></span> <span class="small muted">${(r.n / min).toFixed(2)}×</span></td></tr>`).join('');
  }
  $('#fmtTable').addEventListener('click', e => {
    const tr = e.target.closest('.fmt-row'); if (!tr) return;
    document.querySelectorAll('.fmt-row').forEach(r => r.classList.toggle('sel', r === tr));
    text.value = FORMATS[+tr.dataset.i][1]; renderPlayground();
    text.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // ---------- quirks ----------
  const QUIRKS = [
    ['Spelling', ['strawberry', ' strawberry', ' Strawberry', 'STRAWBERRY'], 'How many r letters? The model sees chunks, not letters, and each spelling variant is a different set of chunks.'],
    ['Arithmetic', ['1234567', ' 1234567', '1,234,567', ' 9999 + 1 = 10000'], 'Long numbers split into irregular groups, so the digits do not line up the way they do when you add on paper.'],
    ['Case and spaces', ['hello', ' hello', ' Hello', ' HELLO'], 'These look nearly the same to you but are different tokens with different ids. A trailing space in a prompt template can change the answer.']
  ];
  function renderQuirks() {
    const opts = { ids: true, spaces: true };
    $('#quirks').innerHTML = QUIRKS.map(([title, items, note]) => `<h3 style="margin-top:4px">${title}</h3>
      ${items.map(s => { const ids = GPT2.encode(s); return `<div class="mini-row"><span class="src">${esc(JSON.stringify(s))}</span><span class="n">${ids.length} token${ids.length > 1 ? 's' : ''}</span><span class="tok-out" style="border:0;padding:0;min-height:0;line-height:2">${ids.map(id => tokenSpan(id, opts)).join('')}</span></div>`; }).join('')}
      <p class="small muted" style="margin:8px 0 14px">${note}</p>`).join('');
  }

  // ---------- budget ----------
  const PARTS = [
    ['system', 'System prompt', 2000, 'var(--s1)'],
    ['tools', 'Tool definitions', 3000, 'var(--s2)'],
    ['history', 'Conversation history', 20000, 'var(--s3)'],
    ['docs', 'Retrieved documents', 30000, 'var(--s4)'],
    ['output', 'Reserved for output (max_tokens)', 16000, 'var(--s5)']
  ];
  $('#budgetInputs').innerHTML = `<label>Context window<select id="b_window"><option value="128000">128K tokens</option><option value="200000" selected>200K tokens</option><option value="1000000">1M tokens</option></select></label>` +
    PARTS.map(([k, label, v]) => `<label>${label}<input type="number" id="b_${k}" min="0" step="500" value="${v}"></label>`).join('');
  function renderBudget() {
    const win = +$('#b_window').value;
    const vals = PARTS.map(([k]) => Math.max(0, +$('#b_' + k).value || 0));
    const used = vals.reduce((a, b) => a + b, 0), scale = Math.max(win, used);
    $('#budgetBar').innerHTML = PARTS.map(([k, label, , c], i) => `<i style="flex:0 0 ${(100 * vals[i] / scale).toFixed(3)}%;background:${c}" title="${label}: ${fmtInt(vals[i])}"></i>`).join('') +
      (used < win ? `<i style="flex:1 1 auto;background:transparent" title="Free: ${fmtInt(win - used)}"></i>` : '');
    $('#budgetLegend').innerHTML = PARTS.map(([k, label, , c], i) => `<span style="--c:${c}">${label} <b>${fmtInt(vals[i])}</b></span>`).join('') + `<span style="--c:var(--soft)">Free <b>${fmtInt(Math.max(0, win - used))}</b></span>`;
    $('#budgetMsg').innerHTML = used > win
      ? `<b style="color:var(--bad)">Over budget by ${fmtInt(used - win)} tokens.</b> Trim history, retrieve fewer documents, or summarise older turns.`
      : `<b>${(100 * used / win).toFixed(1)}%</b> of the window is used, leaving ${fmtInt(win - used)} tokens free. Remember that history grows every turn, so leave headroom.`;
  }
  $('#budgetInputs').addEventListener('input', renderBudget);
  renderBudget();

  Site.modelGate($('#gate'), {
    title: 'GPT-2 tokenizer', sizeMB: 2, autoKey: 'gpt2-tok-loaded',
    what: 'It is the real byte-pair-encoding tokenizer used by GPT-2.',
    loader: async cb => { await GPT2.loadTokenizer(cb); try { localStorage.setItem('gpt2-tok-loaded', '1'); } catch (e) { /* storage unavailable */ } },
    onReady: () => { ready = true; $('#lab').classList.remove('locked'); renderPlayground(); renderFormats(); renderQuirks(); }
  });
})();
