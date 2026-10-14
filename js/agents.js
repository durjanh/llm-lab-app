(function () {
  const { $, $$, esc, fmtInt } = Site;
  const MODEL = 'claude-opus-5-5';
  const T = {
    get_weather: { name: 'get_weather', description: 'Get the weather forecast for a city on a given day.', input_schema: { type: 'object', properties: { city: { type: 'string', description: 'City name, for example London' }, date: { type: 'string', description: "An ISO date or 'tomorrow'" } }, required: ['city', 'date'] } },
    get_order: { name: 'get_order', description: 'Look up an order by its id. Returns status, customer id and tracking number.', input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } },
    get_customer: { name: 'get_customer', description: 'Look up a customer by id. Returns name and email address.', input_schema: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] } },
    send_email: { name: 'send_email', description: 'Send an email to a customer. Requires human approval before it is sent.', input_schema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } }
  };
  const user = c => ({ role: 'user', content: c });
  const asst = c => ({ role: 'assistant', content: c });
  const txt = t => ({ type: 'text', text: t });
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const res = (id, content, err) => Object.assign({ type: 'tool_result', tool_use_id: id, content }, err ? { is_error: true } : {});

  const SCENARIOS = {
    weather: {
      system: 'You are a helpful travel assistant.', tools: [T.get_weather],
      steps: [
        { edge: ['user', 'code'], title: 'The user asks a question', text: 'Your code wraps the question in a user message. Nothing has reached the model yet.', add: user("I'm in London tomorrow. Do I need an umbrella?") },
        { edge: ['code', 'api'], call: true, title: 'API call 1: send everything', text: 'Your code sends the system prompt, the full tool definitions and the conversation. The tool descriptions are just more input for the model to read.' },
        { edge: ['api', 'code'], stop: 'tool_use', title: 'The model asks for a tool', text: 'The model cannot run anything. It replies with a <code>tool_use</code> block: a tool name and arguments, with an id. The stop reason <code>tool_use</code> tells your loop to keep going.', add: asst([txt('Let me check the forecast.'), use('toolu_01', 'get_weather', { city: 'London', date: 'tomorrow' })]) },
        { edge: ['code', 'tools'], title: 'Your code runs the tool', text: 'Your code checks the arguments and calls your own <code>get_weather</code> function. This is where permissions, validation and logging belong.' },
        { edge: ['tools', 'code'], title: 'The result goes back as a user message', text: 'The output is wrapped in a <code>tool_result</code> whose <code>tool_use_id</code> matches the request, and appended as a user message.', add: user([res('toolu_01', '{"forecast": "rain", "chance_of_rain": 0.8, "temp_c": 14}')]) },
        { edge: ['code', 'api'], call: true, title: 'API call 2: send everything again', text: 'The API keeps no memory between calls, so the whole history goes again, now with the tool request and its result.' },
        { edge: ['api', 'code'], stop: 'end_turn', title: 'The model answers', text: 'With the result in context, the model writes the answer. The stop reason <code>end_turn</code> ends the loop.', add: asst([txt("Yes, take an umbrella. There's an 80% chance of rain in London tomorrow, at around 14°C.")]) },
        { edge: ['code', 'user'], title: 'Your code shows the answer', text: 'Two API calls and one tool run produced one answer. A real agent may loop many more times.' }
      ]
    },
    parallel: {
      system: 'You are a helpful travel assistant.', tools: [T.get_weather],
      steps: [
        { edge: ['user', 'code'], title: 'The user asks about two places', text: 'One question that needs two lookups.', add: user("Compare tomorrow's weather in Paris and Atlantis.") },
        { edge: ['code', 'api'], call: true, title: 'API call 1', text: 'System prompt, tools and the question are sent.' },
        { edge: ['api', 'code'], stop: 'tool_use', title: 'Two tool calls in one reply', text: 'The model can request several independent tools at once. Each <code>tool_use</code> block has its own id.', add: asst([txt("I'll check both cities."), use('toolu_01', 'get_weather', { city: 'Paris', date: 'tomorrow' }), use('toolu_02', 'get_weather', { city: 'Atlantis', date: 'tomorrow' })]) },
        { edge: ['code', 'tools'], title: 'Your code runs both, and one fails', text: 'Run independent calls concurrently. Paris works. Atlantis is not a real city, so your function raises an error.', warn: 'tool error' },
        { edge: ['tools', 'code'], title: 'Both results go back in one message', text: 'The failure is not thrown away. It goes back as a <code>tool_result</code> with <code>is_error</code> set, so the model can explain or retry. Both results travel in a single user message; splitting them up teaches the model to stop making parallel calls.', add: user([res('toolu_01', '{"forecast": "sunny", "temp_c": 19}'), res('toolu_02', "Unknown city 'Atlantis'. Use a real city name.", true)]) },
        { edge: ['code', 'api'], call: true, title: 'API call 2', text: 'Everything is sent again, including the error.' },
        { edge: ['api', 'code'], stop: 'end_turn', title: 'The model recovers gracefully', text: 'The model uses the error message to give a useful answer instead of failing.', add: asst([txt("Paris looks sunny tomorrow at about 19°C. I couldn't find a forecast for Atlantis because it isn't a real place. Did you mean Atlanta?")]) },
        { edge: ['code', 'user'], title: 'Done', text: 'Good error messages in tool results are as important as good tool descriptions.' }
      ]
    },
    order: {
      system: 'You are a customer support agent for Northwind. Use the tools to help staff.', tools: [T.get_order, T.get_customer, T.send_email],
      steps: [
        { edge: ['user', 'code'], title: 'A staff member gives a task', text: 'This needs three lookups in a row, and the last one has a side effect.', add: user('Let the customer for order 1042 know it has shipped.') },
        { edge: ['code', 'api'], call: true, title: 'API call 1', text: 'Three tool definitions are sent. Every definition costs tokens on every call, whether it is used or not.' },
        { edge: ['api', 'code'], stop: 'tool_use', title: 'Step 1: look up the order', text: 'The model cannot know the customer yet, so it starts with the order.', add: asst([use('toolu_01', 'get_order', { order_id: '1042' })]) },
        { edge: ['code', 'tools'], title: 'Run get_order', text: 'A read-only lookup, safe to run automatically.' },
        { edge: ['tools', 'code'], title: 'Order details come back', text: 'The result gives the customer id the model needs next.', add: user([res('toolu_01', '{"order_id": "1042", "status": "shipped", "customer_id": "C-77", "tracking": "ZX93"}')]) },
        { edge: ['code', 'api'], call: true, title: 'API call 2', text: 'The whole history goes again.' },
        { edge: ['api', 'code'], stop: 'tool_use', title: 'Step 2: look up the customer', text: 'Each step depends on the last, so these calls must run in sequence.', add: asst([use('toolu_02', 'get_customer', { customer_id: 'C-77' })]) },
        { edge: ['code', 'tools'], title: 'Run get_customer', text: 'Another read-only lookup.' },
        { edge: ['tools', 'code'], title: 'Customer details come back', text: 'Now the model has an email address.', add: user([res('toolu_02', '{"name": "Sam Patel", "email": "sam@example.com"}')]) },
        { edge: ['code', 'api'], call: true, title: 'API call 3', text: 'The request keeps growing with each turn.' },
        { edge: ['api', 'code'], stop: 'tool_use', title: 'Step 3: the model wants to send an email', text: 'This call changes the world, so your code should not run it blindly.', add: asst([use('toolu_03', 'send_email', { to: 'sam@example.com', subject: 'Your order 1042 has shipped', body: 'Hi Sam, your order 1042 is on its way. Tracking number: ZX93.' })]) },
        { edge: ['code', 'human'], title: 'Your code asks a person first', text: 'An approval gate shows the exact email to a human. The model has no way around it, because only your code can send email.', warn: 'approval required' },
        { edge: ['human', 'code'], title: 'Approved', text: 'The reviewer approves. If they had declined, your code would return a tool result saying so, and the model would adapt.' },
        { edge: ['code', 'tools'], title: 'Run send_email', text: 'Only now does the side effect happen.' },
        { edge: ['tools', 'code'], title: 'Confirmation comes back', text: 'The result is appended like any other.', add: user([res('toolu_03', '{"status": "sent"}')]) },
        { edge: ['code', 'api'], call: true, title: 'API call 4', text: 'Four calls in total. Look at the chart: each one was larger than the last.' },
        { edge: ['api', 'code'], stop: 'end_turn', title: 'The model reports back', text: 'The loop ends on <code>end_turn</code>.', add: asst([txt('Done. I emailed Sam Patel at sam@example.com to say order 1042 has shipped, with tracking number ZX93.')]) },
        { edge: ['code', 'user'], title: 'Done', text: 'Three tool runs, one approval and four API calls for one instruction.' }
      ]
    }
  };

  // ---------- diagram ----------
  const NODES = { user: [70, 60, 'User'], code: [260, 150, 'Your code', 'the loop'], api: [450, 60, 'LLM API'], tools: [450, 245, 'Tools', 'your functions'], human: [70, 245, 'Human', 'approval'] };
  const EDGES = [['user', 'code'], ['code', 'api'], ['code', 'tools'], ['code', 'human']];
  function drawDiagram() {
    let s = EDGES.map(([a, b]) => `<line class="edge" data-e="${a}-${b}" x1="${NODES[a][0]}" y1="${NODES[a][1]}" x2="${NODES[b][0]}" y2="${NODES[b][1]}"></line>`).join('');
    s += Object.entries(NODES).map(([k, [x, y, t1, t2]]) => `<g class="node" data-n="${k}"><rect x="${x - 62}" y="${y - 24}" width="124" height="48" rx="10"></rect><text x="${x}" y="${t2 ? y - 3 : y + 5}" font-weight="600">${t1}</text>${t2 ? `<text x="${x}" y="${y + 13}" style="font-size:11px;fill:var(--muted)">${t2}</text>` : ''}</g>`).join('');
    s += '<circle id="dot" r="7" fill="var(--brand)" opacity="0"></circle>';
    $('#diagram').innerHTML = s;
  }
  let dotRaf = null;
  function animateEdge(a, b) {
    $$('#diagram .edge').forEach(e => e.classList.toggle('on', e.dataset.e === `${a}-${b}` || e.dataset.e === `${b}-${a}`));
    $$('#diagram .node').forEach(n => { n.classList.toggle('on', n.dataset.n === a || n.dataset.n === b); });
    const sc = SCENARIOS[$('#scenario').value];
    $$('#diagram .node').forEach(n => n.classList.toggle('dim', n.dataset.n === 'human' && !sc.steps.some(st => st.edge.includes('human'))));
    const [x1, y1] = NODES[a], [x2, y2] = NODES[b], dot = $('#dot');
    cancelAnimationFrame(dotRaf);
    const t0 = performance.now(), dur = 700;
    const step = now => {
      const f = Math.min(1, (now - t0) / dur), e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
      dot.setAttribute('cx', x1 + (x2 - x1) * e); dot.setAttribute('cy', y1 + (y2 - y1) * e); dot.setAttribute('opacity', f < 1 ? 1 : 0);
      if (f < 1) dotRaf = requestAnimationFrame(step);
    };
    dotRaf = requestAnimationFrame(step);
  }

  // ---------- request view ----------
  function hl(json) {
    return esc(json).replace(/(&quot;(?:\\&quot;|\\[^&]|[^\\&]|&(?!quot;))*?&quot;)(\s*:)?/g, (m, str, colon) => colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`);
  }
  function indent(s, n) { return s.split('\n').map(l => ' '.repeat(n) + l).join('\n'); }
  function requestText(sc, msgs, newIdx) {
    const head = `{\n  <span class="k">&quot;model&quot;</span>: <span class="s">&quot;${MODEL}&quot;</span>,\n  <span class="k">&quot;max_tokens&quot;</span>: 16000,\n  <span class="k">&quot;system&quot;</span>: ${hl(JSON.stringify(sc.system))},\n  <span class="k">&quot;tools&quot;</span>: [${sc.tools.map(t => `<span class="s">${t.name}</span>`).join(', ')}],  <span class="c">// full JSON schemas, sent every call</span>\n  <span class="k">&quot;messages&quot;</span>: [\n`;
    const body = msgs.map((m, i) => {
      const block = hl(indent(JSON.stringify(m, null, 2), 4)) + (i < msgs.length - 1 ? ',' : '');
      return i === newIdx ? `<span class="newmsg">${block}</span>` : block + '\n';
    }).join('');
    return head + body + (msgs.length && newIdx !== msgs.length - 1 ? '' : '') + '  ]\n}';
  }
  const estTokens = (sc, msgs) => Math.round(JSON.stringify({ model: MODEL, system: sc.system, tools: sc.tools, messages: msgs }).length / 4);

  // ---------- state ----------
  let idx = -1, timer = null;
  function state(upto) {
    const sc = SCENARIOS[$('#scenario').value];
    const msgs = [], calls = [];
    let newIdx = -1;
    for (let i = 0; i <= upto; i++) {
      const st = sc.steps[i];
      if (st.add) { msgs.push(st.add); if (i === upto) newIdx = msgs.length - 1; }
      if (st.call) calls.push(estTokens(sc, msgs));
    }
    return { sc, msgs, calls, newIdx };
  }
  function render() {
    const sc = SCENARIOS[$('#scenario').value], n = sc.steps.length;
    $('#back').disabled = idx < 0; $('#next').disabled = idx >= n - 1;
    $('#stepNo').textContent = idx < 0 ? `${n} steps` : `Step ${idx + 1} of ${n}`;
    const { msgs, calls, newIdx } = state(idx);
    $('#req').innerHTML = requestText(sc, msgs, newIdx);
    const nl = $('#req .newmsg'); if (nl) nl.scrollIntoView({ block: 'nearest' }); else $('#req').scrollTop = $('#req').scrollHeight;
    if (idx < 0) {
      $('#explain').innerHTML = `<h3>Ready</h3><p>Press <b>Next</b> to step through the loop, or <b>Play</b> to watch it run. The right panel shows the request your code would send to the API, growing as the loop runs.</p>`;
      $$('#diagram .edge, #diagram .node').forEach(e => e.classList.remove('on'));
      const usesHuman = sc.steps.some(st => st.edge.includes('human'));
      $$('#diagram .node').forEach(nd => nd.classList.toggle('dim', nd.dataset.n === 'human' && !usesHuman));
    } else {
      const st = sc.steps[idx];
      const badges = [st.call ? `<span class="badge2 api">API call ${calls.length}</span>` : '', st.stop ? `<span class="badge2 stop">stop_reason: ${st.stop}</span>` : '', st.warn ? `<span class="badge2 warn">${st.warn}</span>` : ''].join('');
      $('#explain').innerHTML = `<div>${badges}</div><h3>${st.title}</h3><p>${st.text}</p>`;
      animateEdge(st.edge[0], st.edge[1]);
    }
    drawCalls(calls);
  }
  function drawCalls(calls) {
    const W = 520, H = 150, l = 44, b = 22, top = 10, pw = W - l - 10, ph = H - top - b;
    const maxCalls = Math.max(4, ...Object.values(SCENARIOS).map(s => s.steps.filter(x => x.call).length));
    const all = state(SCENARIOS[$('#scenario').value].steps.length - 1).calls;
    const raw = Math.max(...all, 1) * 1.1, p10 = Math.pow(10, Math.floor(Math.log10(raw)));
    const max = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(s => s * p10).find(x => x >= raw);
    const slot = pw / maxCalls, bw = Math.min(56, slot * 0.6);
    let s = '';
    [0, 0.5, 1].forEach(f => { const y = top + ph - ph * f; s += `<line x1="${l}" x2="${W - 10}" y1="${y}" y2="${y}" stroke="var(--line)"></line><text x="${l - 6}" y="${y + 4}" text-anchor="end">${fmtInt(max * f)}</text>`; });
    calls.forEach((t, i) => {
      const h = ph * t / max, x = l + i * slot + (slot - bw) / 2, y = top + ph - h;
      s += `<path d="M${x} ${top + ph} V${y + 4} Q${x} ${y} ${x + 4} ${y} H${x + bw - 4} Q${x + bw} ${y} ${x + bw} ${y + 4} V${top + ph} Z" fill="var(--s1)" class="fade-in"><title>Call ${i + 1}: about ${fmtInt(t)} tokens</title></path><text x="${x + bw / 2}" y="${y - 4}" text-anchor="middle" style="fill:var(--ink2)">${fmtInt(t)}</text>`;
    });
    for (let i = 0; i < maxCalls; i++) s += `<text x="${l + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">call ${i + 1}</text>`;
    $('#tokChart').innerHTML = s;
  }
  function go(d) { const n = SCENARIOS[$('#scenario').value].steps.length; idx = Math.max(-1, Math.min(n - 1, idx + d)); render(); }
  function stopPlay() { clearInterval(timer); timer = null; $('#play').textContent = 'Play'; }
  $('#next').addEventListener('click', () => { stopPlay(); go(1); });
  $('#back').addEventListener('click', () => { stopPlay(); go(-1); });
  $('#reset').addEventListener('click', () => { stopPlay(); idx = -1; render(); });
  $('#scenario').addEventListener('change', () => { stopPlay(); idx = -1; render(); });
  $('#play').addEventListener('click', () => {
    if (timer) return stopPlay();
    const n = SCENARIOS[$('#scenario').value].steps.length;
    if (idx >= n - 1) idx = -1;
    $('#play').textContent = 'Pause'; go(1);
    timer = setInterval(() => { if (idx >= SCENARIOS[$('#scenario').value].steps.length - 1) return stopPlay(); go(1); }, 2600);
  });
  document.addEventListener('keydown', e => { if (e.target.closest('input,select,textarea')) return; if (e.key === 'ArrowRight') { stopPlay(); go(1); } if (e.key === 'ArrowLeft') { stopPlay(); go(-1); } });
  $$('.tabs .chip-btn').forEach(b => b.addEventListener('click', () => {
    $$('.tabs .chip-btn').forEach(x => x.classList.toggle('on', x === b));
    $$('pre[data-panel]').forEach(p => (p.hidden = p.dataset.panel !== b.dataset.tab));
  }));

  drawDiagram(); render();
  const qs = new URLSearchParams(location.search);
  if (qs.get('step')) { idx = +qs.get('step') - 1; if (qs.get('scenario')) { $('#scenario').value = qs.get('scenario'); } render(); }
})();
