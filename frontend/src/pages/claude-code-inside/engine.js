/* Inside Claude Code: a step-through, animated walkthrough of what happens behind the scenes.
 * Chapter content lives in claude-code-chapters.js; this file is the player. */
import { CC_CHAPTERS } from './claude-code-chapters';
import { Site } from '@/lib/site';

/** Runs the page's interactive parts. Returns nothing; `life` undoes timers and listeners on unmount. */
export function mount(root, life) {
  const { setTimeout, requestAnimationFrame } = life;  // stopped when you leave the page
  const { $, $$, esc, fmtInt } = Site;
  const CH = CC_CHAPTERS;
  const CAP = 200000;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const KINDS = {
    sys: ['System prompt & tools', '--k-sys'], mem: ['CLAUDE.md & memory', '--k-mem'], skill: ['Skills', '--k-skill'],
    mcp: ['MCP', '--k-mcp'], msg: ['Your prompts & replies', '--k-msg'], tool: ['Tool calls & results', '--k-tool'],
    hook: ['Hook output', '--k-hook'], sum: ['Summary', '--k-sum'], bad: ['Blocked', '--k-bad']
  };
  const PK = { req: '--k-msg', resp: '--k-mem', tool: '--k-tool', file: '--k-sys', hook: '--k-hook', mcp: '--k-mcp', bad: '--k-bad', you: '--k-sum' };

  // ---------- the map ----------
  const NODES = {
    you: [78, 190, 'You', 'in the terminal'],
    cc: [262, 190, 'Claude Code', 'the harness on your machine', 178, 60],
    api: [562, 190, 'Claude', 'the model'],
    hooks: [262, 62, 'Hooks', 'your scripts'],
    sub: [412, 62, 'Subagent', 'its own context'],
    files: [140, 318, 'Files & shell', 'Read, Edit, Bash'],
    mcp: [372, 318, 'MCP servers', 'outside tools'],
    market: [562, 318, 'Marketplace', 'a git repository']
  };
  const EDGES = [['you', 'cc'], ['cc', 'api'], ['cc', 'hooks'], ['cc', 'files'], ['cc', 'mcp'], ['cc', 'sub'], ['sub', 'api'], ['cc', 'market']];
  const ekey = (a, b) => [a, b].sort().join('-');
  function drawMap() {
    let s = `<rect class="zone" x="8" y="8" width="478" height="364" rx="14"></rect><text class="zone-l" x="20" y="27">Your machine</text>
      <rect class="zone" x="494" y="128" width="138" height="124" rx="14"></rect><text class="zone-l" x="506" y="147">Anthropic API</text>
      <rect class="zone" x="494" y="268" width="138" height="104" rx="14" data-zone="market"></rect><text class="zone-l" x="506" y="287" data-zone="market">Internet</text>`;
    s += EDGES.map(([a, b]) => `<line class="edge" data-e="${ekey(a, b)}" x1="${NODES[a][0]}" y1="${NODES[a][1]}" x2="${NODES[b][0]}" y2="${NODES[b][1]}"></line>`).join('');
    s += Object.entries(NODES).map(([k, [x, y, t1, t2, w = 124, h = 48]]) =>
      `<g class="node" data-n="${k}"><rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="10"></rect><text class="t1" x="${x}" y="${y - 3}">${t1}</text><text class="t2" x="${x}" y="${y + 13}">${t2}</text></g>`).join('');
    s += '<g id="pkLayer"></g>';
    $('#map').innerHTML = s;
  }
  function setNodeSubs(ch) {
    Object.keys(NODES).forEach(k => { const t = $(`#map .node[data-n="${k}"] .t2`); t.textContent = (ch.nodeSub && ch.nodeSub[k]) || NODES[k][3]; });
  }

  let runId = 0;
  function playPackets(list, id) {
    const layer = $('#pkLayer'); layer.innerHTML = '';
    if (!list || !list.length) return;
    if (reduced) { list.forEach(p => flashNode(p[1])); return; }
    let i = 0;
    const next = () => {
      if (id !== runId || i >= list.length) return;
      const [a, b, label, kind = 'req'] = list[i++];
      flyOne(a, b, label, kind, id, () => { flashNode(b); setTimeout(next, 90); });
    };
    next();
  }
  function flyOne(a, b, label, kind, id, done) {
    const [x1, y1] = NODES[a], [x2, y2] = NODES[b];
    const text = label.length > 34 ? label.slice(0, 33) + '…' : label;
    const w = Math.max(44, text.length * 6.3 + 18);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'pk');
    g.innerHTML = `<rect x="${-w / 2}" y="-11" width="${w}" height="22" rx="11" style="fill:var(${PK[kind] || PK.req})"></rect><text y="4">${esc(text)}</text>`;
    $('#pkLayer').appendChild(g);
    const t0 = performance.now(), dur = 820;
    const step = now => {
      if (id !== runId) { g.remove(); return; }
      const f = Math.min(1, (now - t0) / dur), e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
      g.setAttribute('transform', `translate(${x1 + (x2 - x1) * e},${y1 + (y2 - y1) * e})`);
      g.style.opacity = f > 0.9 ? (1 - f) * 10 : 1;
      if (f < 1) requestAnimationFrame(step); else { g.remove(); done(); }
    };
    requestAnimationFrame(step);
  }
  function flashNode(n) {
    const el = $(`#map .node[data-n="${n}"]`); if (!el) return;
    el.classList.remove('flash'); void el.getBBox(); el.classList.add('flash');
  }

  // ---------- state ----------
  const blk = b => Object.assign({}, b);
  function replay(ch, upto) {
    let main = (ch.init || []).map(blk), sub = [], term = (ch.term0 || []).slice();
    let calls = 0, last = ch.warm ? main.map(b => b.id + ':' + b.tok) : null;
    const fresh = new Set(), gone = [];
    let termFrom = term.length, info = null;
    for (let i = 0; i <= upto; i++) {
      const st = ch.steps[i], cur = i === upto;
      if (st.termClear) term = [];
      if (cur) termFrom = term.length;
      if (st.term) term = term.concat(st.term);
      (st.del || []).forEach(id => { const b = main.find(x => x.id === id); if (b && cur) gone.push(b); main = main.filter(x => x.id !== id); });
      Object.entries(st.set || {}).forEach(([id, p]) => { const b = main.find(x => x.id === id); if (b) { Object.assign(b, p); if (cur) fresh.add(id); } });
      (st.add || []).forEach(b => { main.push(blk(b)); if (cur) fresh.add(b.id); });
      if (st.call) {
        const n = st.call === true ? 1 : st.call, keys = main.map(b => b.id + ':' + b.tok);
        let k = 0;
        if (last && !st.cacheBreak) while (k < keys.length && k < last.length && keys[k] === last[k]) k++;
        const cached = main.slice(0, k).reduce((s, b) => s + b.tok, 0), total = main.reduce((s, b) => s + b.tok, 0);
        if (cur) info = { from: calls + 1 + (ch.callsBefore || 0), to: calls + n + (ch.callsBefore || 0), total, cached, k, first: !last };
        calls += n; last = keys;
      }
      (st.resp || []).forEach(b => { main.push(blk(b)); if (cur) fresh.add(b.id); });
      if (st.subClear) { if (cur) gone.push(...sub.map(b => Object.assign(blk(b), { sub: true }))); sub = []; }
      (st.subAdd || []).forEach(b => { sub.push(blk(b)); if (cur) fresh.add(b.id); });
    }
    return { main, sub, term, termFrom, fresh, gone, info };
  }

  // ---------- rendering ----------
  let ci = 0, si = 0, timer = null;
  const fmtK = n => n < 1000 ? String(n) : (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';

  function renderAgenda() {
    $('#agenda').innerHTML = CH.map((c, i) => `<button type="button" data-c="${i}" class="${i === ci ? 'on' : i < ci ? 'done' : ''}"${i === ci ? ' aria-current="step"' : ''}><span class="n">${i + 1}</span>${esc(c.short)}</button>`).join('');
    const ag = $('#agenda'), on = $('#agenda .on');  // scroll the bar only, never the page
    if (on && ag.scrollWidth > ag.clientWidth) ag.scrollLeft = Math.max(0, on.offsetLeft - ag.offsetLeft - 40);
  }

  function termHTML(lines, from) {
    return lines.map((l, i) => {
      const [type, text] = l, cls = `l ${type}${i >= from ? ' new' : ''}`;
      if (type === 'ask') { const [h, ...rest] = text.split('\n'); return `<div class="${cls}"><b>${esc(h)}</b>\n${esc(rest.join('\n'))}</div>`; }
      if (type === 'diff') return `<div class="l box${i >= from ? ' new' : ''}">${text.split('\n').map(r => { const m = /^\S+\s+([+-])/.exec(r); return `<span class="${m ? (m[1] === '+' ? 'ok' : 'bad') : ''}">${esc(r)}</span>`; }).join('\n')}</div>`;
      return `<div class="${cls}"${(type === 'p' || type === 'sh') && i >= from ? ` data-type="${esc(text)}"` : ''}>${esc(text)}</div>`;
    }).join('') + '<div class="l"><span class="cursor"></span></div>';
  }
  function typeLines(id) {
    if (reduced) return;
    $$('#term [data-type]').forEach(el => {
      const full = el.dataset.type; let n = 0; el.textContent = '';
      const step = () => { if (id !== runId) { el.textContent = full; return; } n = Math.min(full.length, n + Math.max(1, Math.round(full.length / 28))); el.textContent = full.slice(0, n); if (n < full.length) setTimeout(step, 22); };
      step();
    });
  }

  function gatesHTML(g, names) {
    return '<div class="gates">' + names.map((n, i) => {
      const c = i < g.at ? 'pass' : i === g.at ? (g.verdict === 'deny' ? 'stop' : 'here') : '';
      const label = i === g.at && g.label ? `${n}: ${g.label}` : n;
      return `<span class="g ${c}">${esc(label)}</span>`;
    }).join('<span class="arr">→</span>') + '</div>';
  }

  function render(animate) {
    const ch = CH[ci], st = ch.steps[si], n = ch.steps.length;
    runId++;
    const id = runId;
    $('#chTitle').textContent = `${ci + 1}. ${ch.title}`;
    $('#chSub').textContent = ch.sub;
    $('#stepNo').textContent = `Step ${si + 1} of ${n}`;
    $('#dots').innerHTML = ch.steps.map((_, i) => `<i class="${i < si ? 'past' : i === si ? 'on' : ''}" data-s="${i}" title="Step ${i + 1}"></i>`).join('');
    $('#back').disabled = ci === 0 && si === 0;
    $('#next').disabled = ci === CH.length - 1 && si === n - 1;
    $('#next').textContent = si === n - 1 && ci < CH.length - 1 ? 'Next chapter ›' : 'Next ›';

    const S = replay(ch, si);

    // terminal
    const term = $('#term');
    term.innerHTML = termHTML(S.term, S.termFrom);
    term.scrollTop = term.scrollHeight;
    if (animate) typeLines(id);

    // map
    const visible = new Set(ch.nodes);
    const used = new Set((st.pk || []).map(p => ekey(p[0], p[1])));
    const active = new Set([].concat(...(st.pk || []).map(p => [p[0], p[1]]), st.on || []));
    $$('#map .node').forEach(el => { const k = el.dataset.n; el.classList.toggle('off', !visible.has(k)); el.classList.toggle('on', active.has(k)); });
    $$('#map .edge').forEach(el => { const [a, b] = el.dataset.e.split('-'); el.classList.toggle('off', !(visible.has(a) && visible.has(b))); el.classList.toggle('on', used.has(el.dataset.e)); });
    $$('#map [data-zone="market"]').forEach(el => (el.style.opacity = visible.has('market') ? 1 : 0.25));
    $('#mapNote').textContent = ch.mapNote || '';
    if (animate) playPackets(st.pk, id); else $('#pkLayer').innerHTML = '';

    // narration
    const tags = (st.tags || []).slice();
    if (S.info) tags.unshift(['api', S.info.from === S.info.to ? `API request ${S.info.from}` : `API requests ${S.info.from}–${S.info.to}`]);
    $('#narr').innerHTML = `<div>${tags.map(([c, t]) => `<span class="tag ${c}">${esc(t)}</span>`).join('')}</div>
      <h3>${esc(st.t)}</h3><p>${st.d}</p>${st.why ? `<p class="why">${st.why}</p>` : ''}${st.gates ? gatesHTML(st.gates, ch.gates) : ''}${st.extra || ''}`;
    Site.codeBlocks();

    // context
    $('#ctx').hidden = !!ch.noCtx;
    if (!ch.noCtx) renderCtx(ch, S);
  }

  function renderCtx(ch, S) {
    const total = S.main.reduce((s, b) => s + b.tok, 0);
    $('#ctxSum').textContent = `${fmtInt(total)} of ${fmtInt(CAP)} tokens in use (${(100 * total / CAP).toFixed(total / CAP < 0.1 ? 1 : 0)}%)`;
    const rl = $('#reqline');
    if (S.info) {
      const i = S.info, many = i.from !== i.to;
      const head = many ? `Requests ${i.from} to ${i.to} each resend everything. The last one sent <b>${fmtInt(i.total)}</b> tokens` : `Request ${i.from} sends everything below: <b>${fmtInt(i.total)}</b> tokens`;
      const tail = i.first ? ', all written to the prompt cache for the next request.' : i.cached ? `. <b>${fmtInt(i.cached)}</b> were read from the prompt cache and ${fmtInt(i.total - i.cached)} were new.` : '. None of it came from the prompt cache this time.';
      rl.innerHTML = head + tail; rl.classList.remove('show'); void rl.offsetWidth; rl.classList.add('show');
    } else rl.classList.remove('show');

    const bar = (blocks, label, extra) => `<div class="lane"><div class="lane-h"><span>${label}</span><span>${extra}</span></div><div class="bar">${blocks.map(b => `<i class="${S.fresh.has(b.id) ? 'new' : ''}" style="width:${(100 * b.tok / CAP).toFixed(3)}%;background:var(${KINDS[b.k][1]})" title="${esc(b.label)}: ${fmtInt(b.tok)} tokens"></i>`).join('')}<i class="free"></i></div></div>`;
    let lanes = bar(S.main, ch.sub && S.sub.length ? 'Main conversation' : 'Context window', `${fmtK(total)} / 200k`);
    if (S.sub.length) { const st = S.sub.reduce((s, b) => s + b.tok, 0); lanes += bar(S.sub, "Subagent's own context window", `${fmtK(st)} / 200k`); }
    $('#lanes').innerHTML = lanes;

    const cachedIds = S.info && !S.info.first ? new Set(S.main.slice(0, S.info.k).map(b => b.id)) : new Set();
    const card = (b, extraCls, status) => `<div class="blk ${extraCls}" style="--c:var(${KINDS[b.k][1]})"><div class="bt"><b>${esc(b.label)}${status}</b><span>${fmtK(b.tok)}</span></div>${b.note ? `<small>${esc(b.note)}</small>` : ''}</div>`;
    let html = S.main.map(b => {
      const status = S.info ? (cachedIds.has(b.id) ? '<span class="st cache">from cache</span>' : '<span class="st fresh">new</span>') : '';
      return card(b, S.fresh.has(b.id) ? 'new' : '', status);
    }).join('');
    if (S.sub.length) html += S.sub.map(b => card(Object.assign({}, b, { label: 'Subagent: ' + b.label }), S.fresh.has(b.id) ? 'new' : '', '')).join('');
    html += S.gone.map(b => card(Object.assign({}, b, { label: (b.sub ? 'Subagent: ' : '') + b.label, note: 'removed in this step' }), 'gone', '')).join('');
    $('#blocks').innerHTML = html || '<span class="small muted">Empty: no session is running yet.</span>';
    const box = $('#blocks'), nb = $('#blocks .new') || $('#blocks .gone');  // scroll the list only, never the page
    if (nb && (nb.offsetTop + nb.offsetHeight > box.scrollTop + box.clientHeight || nb.offsetTop < box.scrollTop)) box.scrollTop = nb.offsetTop - 6;

    const kinds = new Set();
    ch.steps.forEach(s => ['add', 'resp', 'subAdd'].forEach(f => (s[f] || []).forEach(b => kinds.add(b.k))));
    (ch.init || []).forEach(b => kinds.add(b.k));
    $('#legend').innerHTML = Object.entries(KINDS).filter(([k]) => kinds.has(k)).map(([, [l, c]]) => `<span style="--c:var(${c})">${l}</span>`).join('');
  }

  function renderAfter() {
    const ch = CH[ci];
    $('#after').innerHTML = ch.after || '';
    Site.codeBlocks();
  }

  function showChapter(i, step, animate = true) {
    const changed = i !== ci;
    ci = i; si = step;
    const ch = CH[ci];
    $('#stageWrap').hidden = !!ch.static;
    if (changed || !$('#after').innerHTML) { renderAfter(); setNodeSubs(ch); }
    renderAgenda();
    if (ch.static) runId++; else render(animate);
    try { history.replaceState(history.state, '', `#${ch.id}${si ? '/' + (si + 1) : ''}`); } catch (e) { /* file: URLs in some browsers */ }
  }

  function go(d) {
    const ch = CH[ci];
    if (ch.static) { if (d < 0 && ci > 0) { showChapter(ci - 1, CH[ci - 1].steps.length - 1); keepInView(); } else if (d > 0 && ci < CH.length - 1) { showChapter(ci + 1, 0); keepInView(); } return; }
    const ns = si + d;
    if (ns >= ch.steps.length) { if (ci < CH.length - 1) { showChapter(ci + 1, 0); keepInView(); } return; }
    if (ns < 0) { if (ci > 0) { const p = CH[ci - 1]; showChapter(ci - 1, p.static ? 0 : p.steps.length - 1); keepInView(); } return; }
    si = ns; render(true);
    try { history.replaceState(history.state, '', `#${ch.id}${si ? '/' + (si + 1) : ''}`); } catch (e) { /* ignore */ }
  }
  function keepInView() {
    const top = $('#agenda').getBoundingClientRect().top;
    if (top < -2 || top > innerHeight * 0.5) $('#agenda').scrollIntoView({ block: 'start' });
  }

  // ---------- controls ----------
  function stopPlay() { clearTimeout(timer); timer = null; $('#play').textContent = 'Play'; }
  function playLoop() {
    const st = CH[ci].steps[si];
    const delay = 2600 + ((st && st.pk) ? st.pk.length * 920 : 0) + Math.min(2500, ((st && st.d) || '').length * 9);
    timer = setTimeout(() => {
      if (CH[ci].static || si >= CH[ci].steps.length - 1) return stopPlay();
      go(1); playLoop();
    }, delay);
  }
  $('#play').addEventListener('click', () => {
    if (timer) return stopPlay();
    if (CH[ci].static) return;
    if (si >= CH[ci].steps.length - 1) showChapter(ci, 0);
    $('#play').textContent = 'Pause';
    playLoop();
  });
  $('#next').addEventListener('click', () => { stopPlay(); go(1); });
  $('#back').addEventListener('click', () => { stopPlay(); go(-1); });
  $('#agenda').addEventListener('click', e => { const b = e.target.closest('[data-c]'); if (!b) return; stopPlay(); showChapter(+b.dataset.c, 0); keepInView(); });
  $('#dots').addEventListener('click', e => { const d = e.target.closest('[data-s]'); if (!d) return; stopPlay(); si = +d.dataset.s; render(true); });
  $('#after').addEventListener('click', e => { const a = e.target.closest('[data-goto]'); if (!a) return; e.preventDefault(); const i = CH.findIndex(c => c.id === a.dataset.goto); if (i >= 0) { stopPlay(); showChapter(i, 0); keepInView(); } });

  function setPresent(on) {
    document.body.classList.toggle('present', on);
    $('#present').textContent = on ? 'Exit presenter' : 'Present';
    try {
      if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
      if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    } catch (e) { /* fullscreen not allowed */ }
    if (on) $('#agenda').scrollIntoView({ block: 'start' });
  }
  $('#present').addEventListener('click', () => setPresent(!document.body.classList.contains('present')));
  life.on(document, 'fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('present')) setPresent(false); });

  life.on(document, 'keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input,select,textarea,summary')) return;
    const onButton = e.target.closest('button');
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || (e.key === ' ' && !onButton)) { e.preventDefault(); stopPlay(); go(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); stopPlay(); go(-1); }
    else if (e.key === 'p' || e.key === 'P') setPresent(!document.body.classList.contains('present'));
    else if (e.key === 'Escape' && document.body.classList.contains('present')) setPresent(false);
  });

  // ---------- start, and links such as #hooks/4 ----------
  function fromHash() {
    const m = /^#([\w-]+)(?:\/(\d+))?$/.exec(location.hash);
    const c = m ? Math.max(0, CH.findIndex(x => x.id === m[1])) : 0;
    const s = m && m[2] && !CH[c].static ? Math.min(CH[c].steps.length - 1, Math.max(0, +m[2] - 1)) : 0;
    return [c, s];
  }
  drawMap();
  ci = -1;
  showChapter(...fromHash(), true);
  life.on(window, 'hashchange', () => { const [c, s] = fromHash(); if (c !== ci || s !== si) { stopPlay(); showChapter(c, s, true); } });
}
