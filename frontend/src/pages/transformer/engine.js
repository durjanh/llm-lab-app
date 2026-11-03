import { GPT2 } from '@/lib/gpt2';
import { GPT2Full } from './gpt2-full';
import { TinyGPT } from './model';

/** Runs the page's interactive parts. Returns nothing; `life` undoes timers and listeners on unmount. */
export function mount(root, life) {
  const { setTimeout, requestAnimationFrame } = life;  // stopped when you leave the page
  const M = TinyGPT;
  const NS = 'http://www.w3.org/2000/svg';
  const $ = s => document.querySelector(s);
  const svg = $('#stage'), tip = $('#tooltip');
  const COLORS = { emb: '#6b7280', q: '#3b82f6', k: '#ef4444', v: '#10b981', a: '#7c3aed', m: '#f59e0b', o: '#6366f1' };

  const state = {
    text: $('#prompt').value, result: null, probs: null,
    layer: 0, head: 0, T: 0.8, mode: 'top-k', k: 5, p: 0.9,
    flowing: true, busy: false, newIndex: -1,
    engine: 'tiny', wantEngine: 'tiny'
  };
  // 'gpt2' = real GPT-2 tokens and probabilities, tiny model in the middle; 'gpt2-full' = every value from GPT-2
  const isGPT2 = () => !!state.result && (state.result.source === 'gpt2' || state.result.source === 'gpt2-full');
  const isFull = () => !!state.result && state.result.source === 'gpt2-full';
  const disp = t => (isGPT2() ? GPT2.show(t || '') : t);
  const TINY_DIMS = { D: M.D, H: M.H, DH: M.DH, DFF: M.DFF, L: M.L };
  const dims = () => (state.result && state.result.dims) || TINY_DIMS;
  let timers = [];
  const tips = new WeakMap();

  // ---------- helpers ----------
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function text(parent, x, y, s, cls, extra) {
    const t = el('text', Object.assign({ x, y, class: cls }, extra), parent);
    t.textContent = s; return t;
  }
  function pool(vec, n) {
    if (vec.length <= n) return vec.slice();
    const size = vec.length / n, out = [];
    for (let i = 0; i < n; i++) {
      const s = vec.slice(Math.floor(i * size), Math.floor((i + 1) * size));
      out.push(s.reduce((a, b) => a + b, 0) / s.length);
    }
    return out;
  }
  function maxAbs(arr) { // largest |value| in a nested array, without spreading big arrays into arguments
    let m = 1e-6;
    const walk = a => { for (const v of a) { if (typeof v === 'number') { if (Number.isFinite(v) && Math.abs(v) > m) m = Math.abs(v); } else if (v && v.length != null) walk(v); } };
    walk(arr);
    return m;
  }
  const fmt = v => (Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : '−∞');
  // a vector as text: short ones in full, long ones as the first few numbers
  const nums = v => (v.length <= 12 ? `[${v.map(fmt).join(', ')}]` : `[${v.slice(0, 8).map(fmt).join(', ')}, … ${v.length - 8} more]`);
  // Long vectors are averaged into fewer cells so the zoom panels fit. fit() returns the rows to draw.
  const fit = (Mx, cells) => Mx.map(r => (r.length > cells ? pool(r, cells) : r));
  const poolNote = (len, cells) => (len > cells ? `averaged from ${len.toLocaleString('en-GB')} numbers for display` : '');
  const pct = v => (v * 100).toFixed(0) + '%';
  const num = v => v.toLocaleString('en-GB'); // 3072 -> 3,072
  function divColor(v, mx) {
    if (!Number.isFinite(v)) return 'var(--line2)';
    const a = Math.min(1, Math.abs(v) / mx);
    return v >= 0 ? `rgba(59,130,246,${0.08 + 0.92 * a})` : `rgba(249,115,22,${0.08 + 0.92 * a})`;
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function vecHTML(vec, color) {
    const mx = maxAbs(vec);
    return '<div class="vec">' + pool(vec, 32).map(v => `<i style="background:${color ? hexA(color, 0.12 + 0.88 * Math.abs(v) / mx) : divColor(v, mx)}"></i>`).join('') + '</div>';
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function strip(parent, x, y, w, h, vec, color, cells, attrs) {
    const g = el('g', Object.assign({ class: 'strip appear hot' }, attrs), parent);
    el('rect', { class: 'bg', x, y, width: w, height: h, rx: 3 }, g);
    const vals = pool(vec, cells), mx = maxAbs(vals), cw = (w - 4) / vals.length;
    vals.forEach((v, i) => el('rect', {
      class: 'cell', x: x + 2 + i * cw, y: y + 2, width: Math.max(0.5, cw - 0.6), height: h - 4, rx: 1,
      fill: color, 'fill-opacity': (0.12 + 0.88 * Math.abs(v) / mx).toFixed(3)
    }, g));
    return g;
  }
  function link(parent, d, cls, stage, attrs) {
    return el('path', Object.assign({ d, class: `link drawn ${cls}`, 'data-stage': stage }, attrs), parent);
  }
  function setTip(node, fn) { tips.set(node, fn); }
  function navButton(parent, x, y, dir, onClick, disabled) {
    const g = el('g', { class: 'nav', transform: `translate(${x},${y})`, opacity: disabled ? 0.35 : 1 }, parent);
    el('rect', { width: 16, height: 16, rx: 3 }, g);
    text(g, 8, 12, dir < 0 ? '‹' : '›', '', { 'text-anchor': 'middle' });
    if (!disabled) g.addEventListener('click', e => { e.stopPropagation(); onClick(); });
    return g;
  }
  function zoomLabel(parent, x, y, label, kind, anchor) {
    const g = el('g', { class: 'zoom' }, parent);
    const t = text(g, x, y, label + ' ⊕', 'lbl-muted', { 'text-anchor': anchor || 'middle' });
    g.addEventListener('click', () => openModal(kind));
    setTip(g, () => `Click to see <b>${label}</b> step by step`);
    return t;
  }

  // What a head does. The tiny model has a scripted habit per head; for GPT-2 it is measured on this text.
  function headHabit(L, h, short) {
    if (L.habit) return short ? `This head's habit: <b>${L.habit[h]}</b>.` : `This head's habit: attends mostly by <b>${L.habit[h]}</b> position/content.<br>Each head learns a different pattern.`;
    const s = L.headStats[h];
    if (!s.rows) return 'Measured on this text: with one token, each head can only attend to itself.';
    const parts = [['the first token', s.first], ['the previous token', s.previous], ['itself', s.self], ['other tokens', s.other]];
    const top = parts.slice().sort((a, b) => b[1] - a[1])[0];
    const span = s.from === 2 ? 'tokens 3 onwards' : 'token 2';
    const line = `Measured on this text, averaged over ${span}: <b>${pct(s.first)}</b> of attention goes to the first token, <b>${pct(s.previous)}</b> to the previous token, <b>${pct(s.self)}</b> to itself and ${pct(s.other)} elsewhere.`;
    if (short) return line;
    const sink = top[0] === 'the first token' ? '<br>Many GPT-2 heads park spare attention on the first token when nothing else is relevant.' : '';
    return `${line}<br>Mostly <b>${top[0]}</b>.${sink}`;
  }

  // ---------- main render ----------
  function resample() {
    if (!state.result) return;
    state.probs = M.sample(state.result.logits, state.T, state.mode, state.k, state.p);
  }

  function render(animate) {
    timers.forEach(clearTimeout); timers = [];
    svg.innerHTML = '';
    const R = state.result;
    if (!R) { text(svg, 640, 200, 'Type some text above to begin.', 'lbl-muted', { 'text-anchor': 'middle' }); return; }
    const Dm = dims();
    state.layer = Math.min(state.layer, Dm.L - 1); state.head = Math.min(state.head, Dm.H - 1);
    const n = R.tokens.length, L = R.layers[state.layer], h = state.head;
    const rowH = Math.min(36, 330 / n), yTop = 160, rowY = i => yTop + i * rowH + rowH / 2;
    const sH = Math.max(6, Math.min(rowH - 8, 18));
    const X = { emb: 158, q: 292, k: 334, v: 376, mat: 440, ao: 800, m1: 868, mh: 904, mo: 966 };
    const matW = n * rowH, matBottom = yTop + matW;
    const frameBottom = Math.max(matBottom + 100, 480);
    svg.setAttribute('viewBox', `0 0 1280 ${frameBottom + 24}`);

    const gLinks = el('g', {}, svg), gMain = el('g', {}, svg);

    // titles
    zoomLabel(gMain, 118, 120, 'Embedding', 'embedding');
    const blockT = zoomLabel(gMain, 262, 52, `Transformer Block ${state.layer + 1}`, 'block', 'start');
    const navX = Math.max(410, 272 + blockT.getComputedTextLength());
    navButton(gMain, navX, 40, -1, () => setLayer(state.layer - 1), state.layer === 0);
    navButton(gMain, navX + 20, 40, 1, () => setLayer(state.layer + 1), state.layer === Dm.L - 1);
    text(gMain, 268, 82, 'Multi-head Self Attention', 'lbl');
    const mlpT = zoomLabel(gMain, 935, 82, 'MLP', 'mlp');
    text(gMain, 270, 113, 'Residual', 'lbl-small');
    el('rect', { class: 'frame', x: 255, y: 96, width: 755, height: frameBottom - 96, rx: 8 }, gMain);
    ['Q', 'K', 'V'].forEach((s, i) => text(gMain, [X.q, X.k, X.v][i] + 17, yTop - 12, s, 'lbl-small', { 'text-anchor': 'middle', fill: COLORS[s.toLowerCase()] }));
    zoomLabel(gMain, X.mat + Math.max(matW, 120) / 2, 130, 'Attention', 'attention');
    text(gMain, 1045, 52, `${Dm.L - 1} more identical`, 'lbl-small', { 'text-anchor': 'middle' });
    text(gMain, 1045, 66, 'Transformer Blocks', 'lbl-small', { 'text-anchor': 'middle' });
    zoomLabel(gMain, 1196, 120, 'Probabilities', 'probabilities');
    if (R.source === 'gpt2') {
      const b1 = text(gMain, 1196, 140, 'REAL GPT-2', 'badge badge-real', { 'text-anchor': 'middle' });
      setTip(b1, () => 'Tokens and next-token probabilities come from the real GPT-2 (124M parameters), running in your browser.');
      const b2 = text(gMain, 1006, 113, 'ILLUSTRATIVE: TINY MODEL ON GPT-2 TOKENS', 'badge badge-ill', { 'text-anchor': 'end' });
      setTip(b2, () => 'The browser build of GPT-2 does not expose its internal values, so this block is computed by the tiny 48-dimension model on the same tokens to show the steps.');
    }
    if (R.source === 'gpt2-full') {
      const b1 = text(gMain, 1196, 140, 'REAL GPT-2', 'badge badge-real', { 'text-anchor': 'middle' });
      setTip(b1, () => 'Tokens and next-token probabilities come from the real GPT-2 (124M parameters), running in your browser.');
      const b2 = text(gMain, 1006, 113, 'REAL GPT-2 INTERNALS', 'badge badge-real', { 'text-anchor': 'end' });
      setTip(b2, () => `Every number in this block is GPT-2's own: ${Dm.D} numbers per token, ${Dm.H} heads of ${Dm.DH}, an MLP of ${num(Dm.DFF)}. Strips and grids average long vectors into fewer cells so they fit.`);
    }

    for (let i = 0; i < n; i++) {
      const y = rowY(i), tok = R.tokens[i].text;
      // links
      el('path', { d: `M198 ${y} C226 ${y} 226 118 262 118 L836 118 C852 118 850 ${y} 866 ${y}`, class: 'residual appear', 'data-stage': 4, 'data-row': i }, gLinks);
      link(gLinks, `M198 ${y} L${X.q} ${y}`, '', 1, { 'data-row': i });
      link(gLinks, `M198 ${y} C250 ${y} 270 ${y - sH / 2 - 4} ${X.k} ${y}`, 'k', 1, { 'data-row': i });
      link(gLinks, `M198 ${y} C250 ${y} 300 ${y + sH / 2 + 4} ${X.v} ${y}`, 'v', 1, { 'data-row': i });
      const cx = X.mat + i * rowH + rowH / 2;
      link(gLinks, `M${X.q + 34} ${y} L${X.mat} ${y}`, 'q', 2, { 'data-row': i });
      link(gLinks, `M${X.k + 34} ${y} C${X.k + 70} ${y} ${cx} ${yTop - 40} ${cx} ${yTop}`, 'k', 2, { 'data-row': i, 'data-k': 1 });
      link(gLinks, `M${X.v + 34} ${y} C${X.v + 60} ${y} ${X.mat - 20} ${matBottom + 14} ${X.mat + matW / 2} ${matBottom + 14} S${X.ao - 20} ${y} ${X.ao} ${y}`, 'v', 4, { 'data-row': i, 'data-k': 1 });
      link(gLinks, `M${X.mat + matW} ${y} L${X.ao} ${y}`, 'a', 4, { 'data-row': i });
      link(gLinks, `M${X.ao + 32} ${y} L${X.m1} ${y}`, 'm', 5, { 'data-row': i });
      link(gLinks, `M${X.m1 + 26} ${y} L${X.mh} ${y}`, 'm', 5, { 'data-row': i });
      link(gLinks, `M${X.mh + 50} ${y} L${X.mo} ${y}`, 'm', 5, { 'data-row': i });

      // token + embedding
      const tg = el('g', { class: 'appear hot', 'data-stage': 0, 'data-row': i }, gMain);
      const tt = text(tg, 148, y + 5, tok, 'tok' + (i === state.newIndex ? ' newtok' : ''), { 'text-anchor': 'end' });
      setTip(tg, () => `Token <b>${esc(tok)}</b> · id ${R.tokens[i].id} · position ${i}`);
      const eg = strip(gMain, X.emb, y - sH / 2, 40, sH, R.emb[i], COLORS.emb, 8, { 'data-stage': 0, 'data-row': i });
      setTip(eg, () => `Embedding of <b>${esc(tok)}</b> = token embedding + ${isFull() ? 'learned position embedding' : 'positional encoding'} (${Dm.D} numbers)${vecHTML(R.emb[i])}`);

      // Q K V for current head
      [['q', L.q], ['k', L.k], ['v', L.v]].forEach(([key, arr]) => {
        const g = strip(gMain, X[key], y - sH / 2, 34, sH, arr[h][i], COLORS[key], 4, { 'data-stage': 1, 'data-row': i, 'data-k': key === 'q' ? null : 1 });
        const names = { q: 'Query: what this token is looking for', k: 'Key: what this token offers to others', v: 'Value: the information it passes on' };
        setTip(g, () => `<b>${key.toUpperCase()}</b> of <b>${esc(tok)}</b>, head ${h + 1} (${arr[h][i].length} numbers)<br>${names[key]}<br><span class="mono">${nums(arr[h][i])}</span>${vecHTML(arr[h][i], COLORS[key])}`);
      });

      // attention output, MLP
      const ag = strip(gMain, X.ao, y - sH / 2, 32, sH, L.attnOut[i], COLORS.a, 8, { 'data-stage': 4, 'data-row': i });
      setTip(ag, () => `Attention output for <b>${esc(tok)}</b>: all ${Dm.H} heads concatenated and projected (W<sub>O</sub>)${vecHTML(L.attnOut[i])}`);
      const m1 = strip(gMain, X.m1, y - sH / 2, 26, sH, L.res1[i], COLORS.o, 6, { 'data-stage': 5, 'data-row': i });
      setTip(m1, () => `Residual sum for <b>${esc(tok)}</b>: input + attention output${vecHTML(L.res1[i])}`);
      const mh = strip(gMain, X.mh, y - sH / 2 - 2, 50, sH + 4, L.hidden[i], COLORS.m, 12, { 'data-stage': 5, 'data-row': i });
      setTip(mh, () => `MLP hidden layer for <b>${esc(tok)}</b>: expanded to ${num(Dm.DFF)} numbers, then GELU${vecHTML(L.hidden[i], COLORS.m)}`);
      const mo = strip(gMain, X.mo, y - sH / 2, 30, sH, L.out[i], COLORS.o, 6, { 'data-stage': 5, 'data-row': i });
      setTip(mo, () => `Block ${state.layer + 1} output for <b>${esc(tok)}</b>, passed to the next block${vecHTML(L.out[i])}`);
      mo.addEventListener('click', () => openModal('mlp', i));
      mh.addEventListener('click', () => openModal('mlp', i));
    }

    // attention matrix + stacked heads
    const A = L.attn[h];
    for (let s = 3; s >= 1; s--) el('rect', { class: 'stack appear', 'data-stage': 3, x: X.mat + s * 5, y: yTop + s * 5, width: matW, height: matW, rx: 3 }, gMain);
    el('rect', { x: X.mat, y: yTop, width: matW, height: matW, fill: 'var(--surface)', stroke: 'var(--line2)', rx: 3, class: 'appear', 'data-stage': 3 }, gMain);
    const gm = el('g', {}, gMain);
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
      const c = el('rect', {
        class: 'mcell cell', x: X.mat + j * rowH + 1, y: yTop + i * rowH + 1, width: rowH - 2, height: rowH - 2, rx: 2,
        fill: COLORS.a, 'fill-opacity': 0, 'data-row': i, 'data-col': j, 'data-target': (0.06 + 0.94 * Math.sqrt(A[i][j])).toFixed(3)
      }, gm);
      c.style.transitionDelay = animate ? `${Math.min(900, (i * n + j) * (900 / (n * n)))}ms` : `${(i + j) * 12}ms`;
      setTip(c, () => `<b>${esc(R.tokens[i].text)}</b> attends to <b>${esc(R.tokens[j].text)}</b><br>weight ${(A[i][j] * 100).toFixed(1)}%  (head ${h + 1}, block ${state.layer + 1})`);
      c.addEventListener('click', () => openModal('attention'));
    }
    if (rowH >= 16) R.tokens.forEach((t, j) => text(gMain, X.mat + j * rowH + rowH / 2 + 4, matBottom + 10, t.text.slice(0, 10), 'lbl-small appear', {
      'text-anchor': 'end', transform: `rotate(-50 ${X.mat + j * rowH + rowH / 2 + 4} ${matBottom + 10})`, 'data-stage': 3, 'data-row': j, 'data-k': 1
    }));
    const hy = matBottom + 72;
    const hg = el('g', { class: 'appear', 'data-stage': 3 }, gMain);
    const ht = text(hg, X.mat + matW / 2 + 40, hy, `Head ${h + 1} of ${Dm.H}`, 'lbl-muted', { 'text-anchor': 'end' });
    setTip(ht, () => headHabit(L, h));
    navButton(hg, X.mat + matW / 2 + 48, hy - 12, -1, () => setHead(state.head - 1), h === 0);
    navButton(hg, X.mat + matW / 2 + 68, hy - 12, 1, () => setHead(state.head + 1), h === Dm.H - 1);

    // remaining blocks
    const yMid = yTop + matW / 2;
    for (let i = 0; i < n; i++) link(gLinks, `M${X.mo + 30} ${rowY(i)} C1018 ${rowY(i)} 1010 ${yMid} 1030 ${yMid}`, '', 6, { 'data-row': i });
    const sg = el('g', { class: 'appear hot', 'data-stage': 6 }, gMain);
    for (let s = 3; s >= 0; s--) el('rect', { class: 'stack', x: 1030 + s * 4, y: yMid - 26 + s * 4, width: 32, height: 52, rx: 4, fill: s ? 'var(--surface)' : 'var(--stack-front)', stroke: s ? 'var(--line2)' : 'var(--stack-front-line)' }, sg);
    text(sg, 1046, yMid + 4, '×' + (Dm.L - 1), 'lbl-small', { 'text-anchor': 'middle' });
    el('path', { d: 'M1045 76 L1045 96', stroke: 'var(--muted)', 'marker-end': '' }, sg);
    setTip(sg, () => `Blocks 2–${Dm.L} repeat the same attention + MLP steps.<br>Final state of <b>${esc(R.tokens[n - 1].text)}</b> (after layer norm, ${R.final.length} numbers) is used to predict the next token.${vecHTML(R.final)}`);

    // probabilities
    const P = state.probs, rows = P.slice(0, 8), mxp = Math.max(...rows.map(r => r.prob), 1e-6);
    rows.forEach((r, ri) => {
      const y = yTop + 10 + ri * 32;
      link(gLinks, `M1066 ${yMid} C1080 ${yMid} 1074 ${y} 1090 ${y}`, 'p', 7, { 'stroke-width': (0.6 + 4 * r.prob).toFixed(2) });
      const g = el('g', { class: 'appear hot', 'data-stage': 7 }, gMain);
      text(g, 1150, y + 5, disp(r.token), 'prob-tok' + (r.kept ? '' : ' out'), { 'text-anchor': 'end' });
      el('rect', { class: 'bar-bg', x: 1156, y: y - 7, width: 80, height: 14, rx: 2 }, g);
      const bar = el('rect', { class: 'bar' + (r.chosen ? ' chosen' : '') + (r.kept ? '' : ' out'), x: 1156, y: y - 7, height: 14, rx: 2, 'data-w': (80 * r.prob / mxp).toFixed(1) }, g);
      bar.style.width = '0px';
      text(g, 1240, y + 4, (r.prob * 100).toFixed(1) + '%', 'pct');
      setTip(g, () => `<b>${esc(disp(r.token))}</b><br>logit ${r.logit.toFixed(2)} → ÷T ${r.scaled.toFixed(2)}<br>softmax ${(r.pAll * 100).toFixed(1)}% → after ${state.mode} ${(r.prob * 100).toFixed(1)}%${r.kept ? '' : '<br><i>filtered out by ' + state.mode + '</i>'}${r.chosen ? '<br><b>sampled</b>' : ''}<br>Click to append this token.`);
      g.addEventListener('click', () => appendToken(r.token));
    });

    // lengths for drawing animation
    svg.querySelectorAll('.drawn').forEach(p => p.style.setProperty('--len', Math.ceil(p.getTotalLength()) + 1));
    svg.classList.toggle('flowing', state.flowing);

    const stageTimes = [0, 350, 750, 1100, 2100, 2600, 3100, 3500];
    const show = s => {
      svg.querySelectorAll(`[data-stage="${s}"]`).forEach(e => e.classList.add('on'));
      if (s === 3) svg.querySelectorAll('.mcell').forEach(c => c.setAttribute('fill-opacity', c.dataset.target));
      if (s === 7) svg.querySelectorAll('.bar').forEach(b => (b.style.width = b.dataset.w + 'px'));
    };
    if (animate) {
      stageTimes.forEach((t, s) => timers.push(setTimeout(() => show(s), t)));
    } else {
      svg.querySelectorAll('.drawn').forEach(p => (p.style.transition = 'none'));
      requestAnimationFrame(() => { for (let s = 0; s < 8; s++) show(s); });
    }
  }

  // ---------- hover linking ----------
  function highlight(row, col) {
    svg.querySelectorAll('[data-row]').forEach(e => {
      const r = +e.dataset.row;
      let keep = r === row;
      if (e.classList.contains('mcell')) keep = r === row && (col == null || +e.dataset.col === col);
      else if (col != null && e.dataset.k && r === col) keep = true;
      e.classList.toggle('dim', !keep);
    });
  }
  function clearHighlight() { svg.querySelectorAll('.dim').forEach(e => e.classList.remove('dim')); }

  svg.addEventListener('mousemove', e => {
    const t = e.target.closest('[data-row]');
    if (t && !t.classList.contains('residual')) {
      const isCell = t.classList.contains('mcell');
      highlight(+t.dataset.row, isCell ? +t.dataset.col : null);
    } else clearHighlight();
  });
  svg.addEventListener('mouseleave', () => { clearHighlight(); tip.hidden = true; });
  life.on(document, 'mousemove', e => {
    let n = e.target, fn = null;
    while (n && n !== document && !(fn = tips.get(n))) n = n.parentNode;
    if (!fn) { tip.hidden = true; return; }
    tip.innerHTML = fn(); tip.hidden = false;
    const w = tip.offsetWidth, hgt = tip.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y + hgt > innerHeight - 8) y = e.clientY - hgt - 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  });

  // ---------- actions ----------
  function setLayer(l) { state.layer = Math.max(0, Math.min(dims().L - 1, l)); render(false); }
  function setHead(hh) { state.head = Math.max(0, Math.min(dims().H - 1, hh)); render(false); }
  let runSeq = 0;
  async function runText(t, animate = true) {
    state.text = t;
    if ($('#prompt').value !== t) $('#prompt').value = t;
    const seq = ++runSeq;
    let res;
    if (state.engine === 'gpt2' && GPT2.isReady()) {
      try {
        const g = await GPT2.predict(t, M.MAX_TOKENS);
        if (seq !== runSeq) return;
        res = g ? M.run(t, g) : null;
        if (res) { res.logits = g.logits; res.source = 'gpt2'; res.vocabSize = g.vocabSize; }
      } catch (e) {
        console.error(e);
        setEngineStatus('GPT-2 failed, using the tiny model: ' + e.message, true);
        state.engine = state.wantEngine = 'tiny'; syncEngineUI();
        res = M.run(t);
      }
    } else if (state.engine === 'full' && GPT2Full.isReady()) {
      $('.stage-wrap').classList.add('loading');
      try {
        res = await GPT2Full.run(t, M.MAX_TOKENS);
      } catch (e) {
        console.error(e);
        setEngineStatus('GPT-2 full internals failed, using the tiny model: ' + e.message, true);
        state.engine = state.wantEngine = 'tiny'; syncEngineUI();
        res = M.run(t);
      }
    } else res = M.run(t);
    if (seq !== runSeq) return;
    $('.stage-wrap').classList.remove('loading');
    if (res && !res.dims) res.dims = TINY_DIMS;
    state.result = res; resample(); render(animate); updateGenerate(); refreshModal(); updateFootnote();
  }
  function appendToken(tok) {
    if (!state.result || state.result.tokens.length >= M.MAX_TOKENS) return;
    state.newIndex = state.result.tokens.length;
    if (isGPT2()) runText((/^\s/.test(tok) ? state.text.replace(/ +$/, '') : state.text) + tok);
    else runText(state.text.replace(/\s+$/, '') + (/^[.,!?;:]$/.test(tok) ? '' : ' ') + tok);
  }
  function updateGenerate() {
    const full = state.result && state.result.tokens.length >= M.MAX_TOKENS;
    $('#generate').disabled = state.busy || full;
    $('#generate').title = full ? `This demo stops at ${M.MAX_TOKENS} tokens` : 'Sample the next token';
  }
  $('#generate').addEventListener('click', () => {
    if (state.busy || !state.result) return;
    resample(); render(false);
    const chosen = state.probs.find(p => p.chosen);
    if (chosen.token == null) chosen.token = GPT2.decode(chosen.id);
    const bar = [...svg.querySelectorAll('.bar')].find(b => b.classList.contains('chosen'));
    if (bar) bar.parentNode.classList.add('pulse');
    state.busy = true; updateGenerate();
    setTimeout(() => { state.busy = false; appendToken(chosen.token); }, 900);
  });
  let debounce;
  $('#prompt').addEventListener('input', e => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.newIndex = -1; runText(e.target.value, true); }, 450);
  });
  $('#prompt').addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(debounce); state.newIndex = -1; runText(e.target.value, true); } });
  $('#examples').addEventListener('change', e => { if (e.target.value) { state.newIndex = -1; runText(e.target.value, true); } e.target.value = ''; });
  $('#temp').addEventListener('input', e => {
    state.T = +e.target.value; $('#tempVal').textContent = state.T.toFixed(2).replace(/0$/, '');
    resample(); render(false); refreshModal();
  });
  function syncKP() {
    const s = $('#kp');
    if (state.mode === 'top-k') { s.min = 1; s.max = 20; s.step = 1; s.value = state.k; $('#kpVal').textContent = 'k=' + state.k; }
    else { s.min = 0.05; s.max = 1; s.step = 0.05; s.value = state.p; $('#kpVal').textContent = 'p=' + state.p.toFixed(2); }
  }
  document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', e => { state.mode = e.target.value; syncKP(); resample(); render(false); refreshModal(); }));
  $('#kp').addEventListener('input', e => {
    if (state.mode === 'top-k') state.k = +e.target.value; else state.p = +e.target.value;
    syncKP(); resample(); render(false); refreshModal();
  });
  $('#play').addEventListener('click', () => {
    state.flowing = !state.flowing;
    $('#play').classList.toggle('paused', !state.flowing);
    svg.classList.toggle('flowing', state.flowing);
  });

  // ---------- zoom-in modals ----------
  const modal = { kind: null, step: 0, steps: [], row: null };
  function matHTML(Mx, opts = {}) {
    const rows = Mx.length, cols = Mx[0].length, c = opts.cell || (cols > 24 ? 9 : 22);
    const mx = opts.max || maxAbs(Mx);
    const color = opts.color ? (v => (Number.isFinite(v) ? hexA(opts.color, 0.06 + 0.94 * Math.min(1, Math.abs(v) / mx)) : 'var(--soft)')) : (v => divColor(v, mx));
    let html = `<div class="mat-wrap"><div style="display:grid;grid-template-columns:${opts.rowLabels ? 'auto ' : ''}repeat(${cols},${c}px);gap:1px;align-items:center">`;
    if (opts.colLabels) {
      if (opts.rowLabels) html += '<span></span>';
      // colShow(j) false hides a label above the grid but keeps it in the cell's tooltip
      opts.colLabels.forEach((l, j) => (html += `<span style="font-size:10px;color:var(--muted2);writing-mode:vertical-rl;transform:rotate(180deg);justify-self:center;max-height:70px;overflow:${opts.colShow ? 'visible' : 'hidden'}">${!opts.colShow || opts.colShow(j) ? esc(l) : ''}</span>`));
    }
    Mx.forEach((row, i) => {
      if (opts.rowLabels) html += `<span style="font-size:12px;color:var(--ink2);text-align:right;padding-right:6px">${esc(opts.rowLabels[i])}</span>`;
      row.forEach((v, j) => {
        const show = opts.numbers && c >= 30;
        html += `<div title="${opts.rowLabels ? esc(opts.rowLabels[i]) + ' · ' : ''}${opts.colLabels ? esc(opts.colLabels[j]) + ': ' : ''}${fmt(v)}" style="width:${c}px;height:${c}px;border-radius:2px;background:${color(v)};font-size:10px;display:flex;align-items:center;justify-content:center;color:${Number.isFinite(v) && Math.abs(v) / mx > 0.6 ? '#fff' : 'var(--ink2)'};animation:cellin .4s ease both;animation-delay:${Math.min(600, (i * cols + j) * 4)}ms">${show ? (Number.isFinite(v) ? (opts.pct ? Math.round(v * 100) : fmt(v)) : '−∞') : ''}</div>`;
      });
    });
    html += `</div>${opts.cap ? `<div class="cap">${opts.cap}</div>` : ''}</div>`;
    return html;
  }
  const op = s => `<span class="op">${s}</span>`;
  const transpose = A => A[0].map((_, j) => A.map(r => r[j]));
  const length = v => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  const mean = v => v.reduce((s, x) => s + x, 0) / v.length;
  const spread = v => { const m = mean(v); return Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / v.length); };
  const worstGap = (a, b, c) => Math.max(...a.map((x, i) => Math.abs(x + b[i] - c[i]))); // |a + b - c| at its largest
  const bars = (rows, unit) => { // a table of [label, value] rows with a bar each
    const mx = Math.max(...rows.map(r => r[1]), 1e-6);
    return `<table class="num-table fade"><tr><th></th><th>${unit}</th></tr>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${fmt(v)} <span class="hbar" style="width:${(120 * v / mx).toFixed(0)}px"></span></td></tr>`).join('')}</table>`;
  };

  // The sinusoidal formula for one pair of dimensions (2k, 2k+1) over positions 0 to 100, with this text's positions marked.
  function waveSvg(D, k, n) {
    const P = 100, W = 520, H = 120, x = p => 34 + (p / P) * (W - 50), y = v => 58 - v * 42;
    const f = p => p / Math.pow(10000, (2 * k) / D);
    const line = fn => Array.from({ length: 401 }, (_, i) => { const p = (i / 400) * P; return `${x(p).toFixed(1)},${y(fn(f(p))).toFixed(1)}`; }).join(' ');
    const dots = (fn, c) => Array.from({ length: n }, (_, p) => `<circle cx="${x(p).toFixed(1)}" cy="${y(fn(f(p))).toFixed(1)}" r="3" fill="${c}"/>`).join('');
    const wave = Math.round(2 * Math.PI * Math.pow(10000, (2 * k) / D));
    return `<svg width="${W}" height="${H + 14}" viewBox="0 0 ${W} ${H + 14}" style="max-width:100%;overflow:visible">
      <line x1="34" y1="58" x2="${W - 16}" y2="58" stroke="var(--line2)"/><line x1="34" y1="12" x2="34" y2="104" stroke="var(--line2)"/>
      ${[1, 0, -1].map(v => `<text x="26" y="${y(v) + 4}" font-size="10" fill="var(--muted2)" text-anchor="end">${v}</text>`).join('')}
      ${[0, 50, 100].map(p => `<text x="${x(p)}" y="${H}" font-size="10" fill="var(--muted2)" text-anchor="middle">${p}</text>`).join('')}
      <polyline fill="none" stroke="${COLORS.q}" stroke-width="2" points="${line(Math.sin)}"/>
      <polyline fill="none" stroke="#f97316" stroke-width="2" points="${line(Math.cos)}"/>
      ${dots(Math.sin, COLORS.q)}${dots(Math.cos, '#f97316')}
      <text x="${W - 16}" y="${H + 12}" font-size="11" fill="var(--muted2)" text-anchor="end">position · dims ${2 * k} (sin, blue) and ${2 * k + 1} (cos, orange) · one wave every ${wave} positions</text>
    </svg>`;
  }

  // A block as boxes in a row. arcs are [from, to]: a residual that leaves after item `from` and joins at the + of item `to`.
  function blockSvg(items, arcs) {
    const W = { io: 30, ln: 40, attn: 84, mlp: 52, add: 22 }, FILL = { ln: '#9ca3af', attn: COLORS.a, mlp: COLORS.m }, gap = 16, cy = 74;
    let x = 4;
    const pos = items.map(([label, kind]) => { const p = { label, kind, x, w: W[kind] }; x += W[kind] + gap; return p; });
    const width = x - gap + 4;
    let s = `<svg width="${width}" height="100" viewBox="0 0 ${width} 100" style="max-width:100%;overflow:visible">`;
    pos.slice(1).forEach((p, i) => (s += `<line x1="${pos[i].x + pos[i].w}" y1="${cy}" x2="${p.x}" y2="${cy}" stroke="var(--line2)" stroke-width="1.5"/>`));
    arcs.forEach(([from, to], i) => {
      const x1 = pos[from].x + pos[from].w + gap / 2, x2 = pos[to].x + pos[to].w / 2;
      s += `<path d="M${x1} ${cy} V30 H${x2} V${cy - 11}" fill="none" stroke="${COLORS.o}" stroke-width="1.5" stroke-dasharray="4 3"/>`;
      if (i === 0) s += `<text x="${(x1 + x2) / 2}" y="24" font-size="11" fill="${COLORS.o}" text-anchor="middle">residual</text>`;
    });
    pos.forEach(p => {
      const cx = p.x + p.w / 2;
      if (p.kind === 'io') s += `<text x="${cx}" y="${cy + 4}" font-size="13" fill="var(--ink2)" text-anchor="middle">${p.label}</text>`;
      else if (p.kind === 'add') s += `<circle cx="${cx}" cy="${cy}" r="11" fill="var(--surface)" stroke="var(--ink2)" stroke-width="1.5"/><text x="${cx}" y="${cy + 5}" font-size="15" fill="var(--ink2)" text-anchor="middle">+</text>`;
      else s += `<rect x="${p.x}" y="${cy - 15}" width="${p.w}" height="30" rx="6" fill="${FILL[p.kind]}"/><text x="${cx}" y="${cy + 4}" font-size="12" fill="#fff" text-anchor="middle">${p.label}</text>`;
    });
    return s + '</svg>';
  }
  const PRE_NORM = [[['x', 'io'], ['LN', 'ln'], ['Attention', 'attn'], ['+', 'add'], ['LN', 'ln'], ['MLP', 'mlp'], ['+', 'add'], ['out', 'io']], [[0, 3], [3, 6]]];
  const POST_NORM = [[['x', 'io'], ['Attention', 'attn'], ['+', 'add'], ['LN', 'ln'], ['MLP', 'mlp'], ['+', 'add'], ['LN', 'ln'], ['out', 'io']], [[0, 2], [3, 5]]];

  function buildSteps(kind) {
    const R = state.result, toks = R.tokens.map(t => t.text), n = toks.length, Dm = dims(), full = isFull();
    const L = R.layers[state.layer], h = state.head;
    const chunk = (v, w) => Array.from({ length: Math.ceil(v.length / w) }, (_, r) => v.slice(r * w, r * w + w));
    const sv = (v, cells) => (v.length > cells ? pool(v, cells) : v);
    const tokenPicker = i => `<p class="picker">Token: <select id="rowPick">${toks.map((t, j) => `<option value="${j}" ${j === i ? 'selected' : ''}>${j}: ${esc(t)}</option>`).join('')}</select> · Block ${state.layer + 1}</p>`;
    if (kind === 'embedding') {
      const EC = 64, SC = 48; // cells per row for the embedding grids and for the three small grids in Sum
      const embNote = poolNote(Dm.D, EC) ? ` Each row below shows the ${Dm.D} numbers averaged into ${EC} cells for display.` : '';
      const cellE = Dm.D > EC ? 12 : 13;
      return {
        title: 'Embedding', steps: [
          ['Tokenize', () => `<p class="explain">The text is split into <b>tokens</b>. Each token maps to an integer id in the vocabulary. ${full ? 'These are GPT-2\'s real tokens and ids: byte-pair encoding over 50,257 sub-word pieces, where a leading space belongs to the token. The embedding numbers in the next steps are GPT-2\'s own too.' : R.source === 'gpt2' ? 'These are GPT-2\'s real tokens and ids: byte-pair encoding over 50,257 sub-word pieces, where a leading space belongs to the token. The embedding numbers in the next steps are illustrative, from the tiny model.' : 'GPT-2 uses about 50k sub-word tokens; the tiny model splits on words and punctuation.'}</p>
            <div>${R.tokens.map((t, i) => `<span class="tok-chip" style="animation-delay:${i * 80}ms">${esc(t.text)}<small>${t.id}</small></span>`).join('')}</div>`],
          ['Token embedding', () => `<p class="explain">Each id looks up a row in the <b>token embedding matrix</b>: a learned vector of ${Dm.D} numbers that captures what the token means. Blue is positive, orange is negative.${embNote}</p>${matHTML(fit(R.tokEmb, EC), { rowLabels: toks, cell: cellE, cap: poolNote(Dm.D, EC) })}`],
          [full ? 'Position embedding' : 'Positional encoding', () => `<p class="explain">Attention by itself ignores word order, so a <b>positional vector</b> is added for each position ${full ? 'GPT-2 learned one vector for each of its 1,024 positions.' : '(sinusoidal here; GPT-2 learns them).'}${embNote}</p>${matHTML(fit(R.posEmb, EC), { rowLabels: toks.map((t, i) => 'pos ' + i), cell: cellE, cap: poolNote(Dm.D, EC) })}
            <p class="explain" style="margin-top:18px">${full ? 'The original transformer (2017) used a formula instead of learned vectors, shown below for comparison.' : 'The vectors above come from a formula.'} Dimension pair (2k, 2k+1) gets PE(pos, 2k) = sin(pos / 10000<sup>2k/d</sup>) and PE(pos, 2k+1) = cos(pos / 10000<sup>2k/d</sup>), with d = ${Dm.D}. Low pairs are fast waves that tell neighbouring tokens apart; high pairs are slow waves that give a rough sense of where in the text a token sits. Together every position gets a unique pattern, and moving k places along is the same rotation wherever you start, so relative distance is easy to read. The dots are this text's ${n} position${n === 1 ? '' : 's'}.</p>
            <div class="flowrow">${waveSvg(Dm.D, 0, n)}${waveSvg(Dm.D, Math.round(Dm.D / 10), n)}</div>
            <p class="muted" style="font-size:12px">Most newer models use neither: rotary embeddings (RoPE) rotate each query and key by its position instead of adding a vector. See <a href="/transformer-tricks">Transformer tricks</a>.</p>`],
          ['Sum', () => `<p class="explain">Token embedding + positional ${full ? 'embedding' : 'encoding'} = the <b>input embedding</b> that enters Transformer Block 1.${poolNote(Dm.D, SC) ? ` Each row is ${Dm.D} numbers averaged into ${SC} cells for display.` : ''}</p>
            <div class="flowrow">${matHTML(fit(R.tokEmb, SC), { rowLabels: toks, cell: 5, cap: 'token' })}${op('+')}${matHTML(fit(R.posEmb, SC), { cell: 5, cap: 'position' })}${op('=')}${matHTML(fit(R.emb, SC), { cell: 5, cap: 'embedding' })}</div>`]
        ]
      };
    }
    if (kind === 'attention') {
      const QC = 16; // cells per row for a head's Q, K, V and output
      const pooled = Dm.DH > QC, Q = fit(L.q[h], QC), K = fit(L.k[h], QC), V = fit(L.v[h], QC), A = L.attn[h], HO = fit(L.headOut[h], QC);
      const qNote = pooled ? ` Each grid shows a head's ${Dm.DH} numbers per token averaged into ${QC} cells for display.` : '';
      const cq = pooled ? 14 : 30, cs = pooled ? 12 : 22;
      const head = `<p class="picker">Block ${state.layer + 1}, head ${h + 1} of ${Dm.H}. Head size d<sub>k</sub> = ${Dm.DH}. ${headHabit(L, h, true)} Change block or head on the main view.</p>`;
      return {
        title: 'Multi-head Self Attention', steps: [
          ['Q, K, V', () => head + `<p class="explain">The layer-normed input is multiplied by three weight matrices to give a <b>Query</b>, <b>Key</b> and <b>Value</b> for every token. The ${Dm.D} numbers are split across ${Dm.H} heads, so each head works with ${Dm.DH}.${qNote}</p>
            <div class="flowrow">${matHTML(Q, { rowLabels: toks, color: COLORS.q, cell: cq, numbers: !pooled, cap: 'Query' })}${matHTML(K, { color: COLORS.k, cell: cq, numbers: !pooled, cap: 'Key' })}${matHTML(V, { color: COLORS.v, cell: cq, numbers: !pooled, cap: 'Value' })}</div>`],
          ['Q · Kᵀ', () => head + `<p class="explain">Every query is compared with every key using a dot product. A high score means "this token is relevant to me".${pooled ? ` The scores use all ${Dm.DH} numbers; Q and Kᵀ are averaged for display.` : ''}</p>
            <div class="flowrow">${matHTML(Q, { rowLabels: toks, color: COLORS.q, cell: cs, cap: 'Q' })}${op('×')}${matHTML(transpose(K), { color: COLORS.k, cell: cs, cap: 'Kᵀ' })}${op('=')}${matHTML(L.raw[h], { rowLabels: toks, colLabels: toks, cell: 34, numbers: true, cap: 'scores' })}</div>`],
          ['Scale', () => head + `<p class="explain">Scores are divided by √d<sub>k</sub> = ${+Math.sqrt(Dm.DH).toFixed(2)} so they don't grow too large for softmax.${L.habit ? ' (In this toy model each head\'s positional habit is also added here.)' : ''}</p>${matHTML(L.scaled[h], { rowLabels: toks, colLabels: toks, cell: 34, numbers: true })}`],
          ['Causal mask', () => head + `<p class="explain">A token may not look at tokens that come <b>after</b> it, so those scores are set to −∞. This is what lets GPT generate left to right.</p>${matHTML(L.masked[h], { rowLabels: toks, colLabels: toks, cell: 34, numbers: true })}`],
          ['Softmax', () => head + `<p class="explain">Softmax turns each row into weights that sum to 100%. Row <i>i</i> says how much token <i>i</i> attends to each earlier token.${full ? ' These are GPT-2\'s own attention weights.' : ''}</p>${matHTML(A, { rowLabels: toks, colLabels: toks, cell: 34, numbers: true, pct: true, color: COLORS.a, max: 1 })}`],
          ['× V', () => head + `<p class="explain">Each token's output is the attention-weighted mix of the Value vectors. That is this head's answer: ${Dm.DH} numbers per token. The next step joins all ${Dm.H} heads.${qNote}</p>
            <div class="flowrow">${matHTML(A, { rowLabels: toks, cell: 22, color: COLORS.a, max: 1, cap: 'attention' })}${op('×')}${matHTML(V, { color: COLORS.v, cell: pooled ? 14 : 22, cap: 'V' })}${op('=')}${matHTML(HO, { rowLabels: toks, color: COLORS.a, cell: cq, numbers: !pooled, cap: 'head output' })}</div>`],
          ['Concat · W<sub>O</sub>', () => {
            // GPT-2: 768 numbers -> 96 cells, 8 per head, so no cell mixes two heads
            const CC = Dm.D > 96 ? 96 : Dm.D, per = CC / Dm.H, cell = CC > 48 ? 7 : 12;
            const heads = Array.from({ length: CC }, (_, j) => `head ${Math.floor(j / per) + 1}`);
            const note = poolNote(Dm.D, CC) ? ` Each row is ${Dm.D} numbers averaged into ${CC} cells, ${per} per head.` : '';
            return head + `<p class="explain">This is the <b>multi-head</b> part. All ${Dm.H} heads ran side by side on the same tokens, each with its own Q, K and V weights, so each could learn a different pattern. Their ${Dm.DH}-number outputs are placed end to end (concatenated) to give ${Dm.H} × ${Dm.DH} = ${Dm.D} numbers per token. One more learned matrix, <b>W<sub>O</sub></b> (${Dm.D} × ${Dm.D}), mixes what the heads found into the <b>attention output</b>, which is added to the residual stream.${note} Columns ${h * per + 1} to ${(h + 1) * per} come from head ${h + 1}, the one in the earlier steps.</p>
              <div class="flowrow" style="flex-direction:column;align-items:flex-start">${matHTML(fit(L.concat, CC), { rowLabels: toks, colLabels: heads, colShow: j => j % per === 0, cell, cap: `${Dm.H} heads, concatenated` })}${op('× W<sub>O</sub> =')}${matHTML(fit(L.attnOut, CC), { rowLabels: toks, cell, cap: 'attention output' })}</div>`;
          }]
        ]
      };
    }
    if (kind === 'block') {
      const i = modal.row == null ? n - 1 : modal.row;
      const picker = tokenPicker(i);
      const LC = 64;
      const lnNote = poolNote(Dm.D, LC) ? ` Grids show ${Dm.D} numbers averaged into ${LC} cells.` : '';
      const x = L.input[i], y = L.res1[i], z = L.out[i];
      const gaps = Math.max(worstGap(x, L.attnOut[i], y), worstGap(y, L.mlpOut[i], z));
      const stream = [['embedding (into block 1)', length(R.layers[0].input[i])], ...R.layers.map((B, l) => [`after block ${l + 1}`, length(B.out[i])])];
      const grew = stream[stream.length - 1][1] / stream[0][1];
      return {
        title: `Transformer Block ${state.layer + 1}`, steps: [
          ['Layer norm', () => picker + `<p class="explain"><b>Layer norm</b> rescales each token's vector on its own: subtract its mean, divide by its spread, so every token enters attention at the same scale however large its residual stream has grown.${full ? ' GPT-2 then multiplies by a learned scale and adds a learned shift, so its output is not exactly mean 0 and spread 1.' : ' (The tiny model skips the learned scale and shift that GPT-2 adds.)'}${lnNote}</p>
            <div class="flowrow">${matHTML(chunk(sv(x, LC), 16), { cell: 14, cap: `block input: mean ${fmt(mean(x))}, spread ${fmt(spread(x))}` })}${op('→ LN →')}${matHTML(chunk(sv(L.ln1[i], LC), 16), { cell: 14, cap: `into attention: mean ${fmt(mean(L.ln1[i]))}, spread ${fmt(spread(L.ln1[i]))}` })}</div>
            <p class="explain" style="margin-top:14px">The same happens again before the MLP, and once more after the last block, before the output.</p>`],
          ['One block', () => picker + `<p class="explain">GPT-2 normalises <b>before</b> each sub-layer and adds the result back to a running total, the <b>residual stream</b>:</p>
            <p class="explain"><code>y = x + Attention(LN(x))</code><br><code>out = y + MLP(LN(y))</code></p>
            ${blockSvg(...PRE_NORM)}
            <p class="explain" style="margin-top:12px">The length of each vector for the token <b>${esc(toks[i])}</b> in block ${state.layer + 1}. Attention and the MLP each add a change; neither replaces the stream. Check: x + attention output and y + MLP output match the model's own sums to within ${gaps.toExponential(1)}.</p>
            ${bars([['x, block input', length(x)], ['LN(x)', length(L.ln1[i])], ['attention output', length(L.attnOut[i])], ['y = x + attention', length(y)], ['MLP output', length(L.mlpOut[i])], ['out = y + MLP', length(z)]], 'length')}`],
          ['Pre-norm vs post-norm', () => `<p class="explain">The original transformer (2017) put layer norm <b>after</b> each addition. Most diagrams, including many explainers, still draw it this way:</p>
            <p class="explain"><code>y = LN(x + Attention(x))</code><br><code>out = LN(y + MLP(y))</code></p>
            ${blockSvg(...POST_NORM)}
            <p class="explain" style="margin-top:16px">GPT-2 moved it <b>before</b> each sub-layer (pre-norm) and added one final layer norm after the last block:</p>
            ${blockSvg(...PRE_NORM)}
            <p class="explain" style="margin-top:16px">Why it matters: in pre-norm the residual stream is a plain sum from the embedding to the last block, and nothing rescales it on the way. The training signal reaches the early blocks directly, so deep stacks train stably without a long learning-rate warm-up. Post-norm passes the stream through a norm in every block, which makes deep models harder to train. The cost is that the stream's size is left to grow, which is why pre-norm needs the final layer norm. Most large models since use pre-norm, often with the cheaper RMSNorm (see <a href="/transformer-tricks">Transformer tricks</a>).</p>`],
          [`Repeat ×${Dm.L}`, () => picker + `<p class="explain">All ${Dm.L} blocks have the same shape but their own weights. Each one reads the residual stream, adds its attention and MLP changes, and passes it on. Below is the length of the vector for the token <b>${esc(toks[i])}</b> after each block: here it ${grew >= 1 ? `grows ${grew.toFixed(1)}× from the embedding to the last block` : `shrinks to ${(grew * 100).toFixed(0)}% of the embedding's length`}.${full ? ' In GPT-2 the first token\'s vector becomes far larger than any other within a few blocks; it is where many heads park spare attention. Pick token 0 to compare.' : ''} After the last block a final layer norm brings it back to a fixed scale for the output step.</p>
            ${bars(stream, 'length')}`]
        ]
      };
    }
    if (kind === 'mlp') {
      const i = modal.row == null ? n - 1 : modal.row;
      // average long vectors 8 to a cell (GPT-2: 768 -> 96, 3,072 -> 384) so the expansion still looks 4x wider
      const f = Math.max(1, Math.ceil(Dm.D / 96)), dc = Dm.D / f, fc = Dm.DFF / f;
      const capD = (name) => name + (f > 1 ? ', ' + poolNote(Dm.D, dc) : ` (${Dm.D})`);
      const capF = (name) => name + (f > 1 ? ', ' + poolNote(Dm.DFF, fc) : '');
      const picker = tokenPicker(i);
      const geluSvg = (() => {
        const pts = []; for (let x = -4; x <= 4; x += 0.1) { const g = 0.5 * x * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (x + 0.044715 * x ** 3))); pts.push(`${(x + 4) * 20},${80 - g * 18}`); }
        return `<svg width="170" height="110" style="overflow:visible"><line x1="0" y1="80" x2="160" y2="80" stroke="var(--line2)"/><line x1="80" y1="0" x2="80" y2="100" stroke="var(--line2)"/><polyline fill="none" stroke="${COLORS.m}" stroke-width="2.5" points="${pts.join(' ')}" style="stroke-dasharray:400;animation:drawg 1.2s ease both"/><text x="4" y="104" font-size="11" fill="var(--muted2)">GELU(x)</text></svg><style>@keyframes drawg{from{stroke-dashoffset:400}to{stroke-dashoffset:0}}</style>`;
      })();
      return {
        title: 'MLP (feed-forward network)', steps: [
          ['Input', () => picker + `<p class="explain">After attention, the residual stream for each token goes through an MLP <b>on its own</b>; tokens do not mix here. It is layer-normed first.</p><div class="flowrow">${matHTML(chunk(sv(L.res1[i], dc), 24), { cell: 16, cap: capD('residual') })}${op('→')}${matHTML(chunk(sv(L.res1n[i], dc), 24), { cell: 16, cap: capD('layer norm') })}</div>`],
          ['Expand ×4', () => picker + `<p class="explain">A linear layer expands ${Dm.D} numbers to ${num(Dm.DFF)} (4×). The wider space lets the model store and look up facts.</p>${matHTML(chunk(sv(L.hiddenPre[i], fc), 24), { cell: 16, cap: f > 1 ? capF('pre-activations') : Dm.DFF + ' pre-activations' })}`],
          ['GELU', () => picker + `<p class="explain">The GELU non-linearity keeps positive values and squashes negatives toward zero.</p><div class="flowrow">${geluSvg}${matHTML(chunk(sv(L.hidden[i], fc), 24), { cell: 16, color: COLORS.m, cap: capF('after GELU') })}</div>`],
          ['Project back', () => picker + `<p class="explain">A second linear layer compresses ${num(Dm.DFF)} back down to ${Dm.D}.</p>${matHTML(chunk(sv(L.mlpOut[i], dc), 24), { cell: 16, cap: capD('MLP output') })}`],
          ['Add residual', () => picker + `<p class="explain">The MLP output is <b>added</b> to its input (a residual connection). The result goes to the next Transformer Block.${f > 1 ? ` Each grid is ${Dm.D} numbers averaged into ${dc} cells for display.` : ''}</p><div class="flowrow">${matHTML(chunk(sv(L.res1[i], dc), 12), { cell: 14, cap: 'residual' })}${op('+')}${matHTML(chunk(sv(L.mlpOut[i], dc), 12), { cell: 14, cap: 'MLP output' })}${op('=')}${matHTML(chunk(sv(L.out[i], dc), 12), { cell: 14, cap: 'block output' })}</div>`]
        ]
      };
    }
    // probabilities
    const P = state.probs.slice(0, 12), extra = state.probs.length - 12;
    const table = upto => {
      const cols = ['Token', 'Logit', 'Logit ÷ T', 'Softmax', `After ${state.mode}`];
      const mxl = Math.max(...P.map(p => p.logit)), mnl = Math.min(...P.map(p => p.logit)) - 0.5;
      const lw = l => (6 + 40 * (l - mnl) / Math.max(1e-6, mxl - mnl)).toFixed(0);
      let html = `<table class="num-table fade"><tr>${cols.slice(0, upto + 1).map(c => `<th>${c}</th>`).join('')}</tr>`;
      P.forEach(p => {
        const cells = [esc(disp(p.token ?? GPT2.decode(p.id))) + (p.chosen && upto >= 4 ? ' ⟵ sampled' : ''), p.logit.toFixed(2) + ` <span class="hbar" style="width:${lw(p.logit)}px"></span>`, p.scaled.toFixed(2),
          (p.pAll * 100).toFixed(1) + '% <span class="hbar" style="width:' + (80 * p.pAll).toFixed(0) + 'px"></span>',
          p.kept ? (p.prob * 100).toFixed(1) + '% <span class="hbar" style="background:#5b4fd6;width:' + (80 * p.prob).toFixed(0) + 'px"></span>' : '<span class="muted">filtered</span>'];
        html += `<tr style="${p.chosen && upto >= 4 ? 'font-weight:700' : ''}">${cells.slice(0, upto + 1).map((c, ci) => `<td class="${ci === 4 && !p.kept ? 'dimc' : ''}">${c}</td>`).join('')}</tr>`;
      });
      return html + `</table><p class="muted" style="font-size:12px">…and ${extra} more tokens in the vocabulary.</p>`;
    };
    return {
      title: 'Output probabilities', steps: [
        ['Final state', () => `<p class="explain">After all ${Dm.L} blocks, the last token (<b>${esc(toks[n - 1])}</b>) holds everything needed to predict what comes next. It goes through the final layer norm and is multiplied by the embedding matrix to give one score (<b>logit</b>) per vocabulary token: <code>logits = LN(h) · Eᵀ</code>. That is the same matrix E from the Embedding step, used in reverse (<b>weight tying</b>), so there is no separate output matrix W<sub>vocab</sub>. For GPT-2 that saves 50,257 × 768 = 38.6 million parameters, almost a third of its 124 million. Some larger models learn a separate output matrix instead.${R.source === 'gpt2' ? ' Here the scores come from real GPT-2, whose state has 768 numbers and whose vocabulary has 50,257 tokens. The vector below is the tiny model\'s, shown for illustration.' : full ? ` These are GPT-2's own numbers: its final state has ${Dm.D} numbers and its vocabulary has ${num(R.vocabSize)} tokens. A few of the ${Dm.D} numbers are far larger than the rest, so most cells look pale.` : ''}</p>${matHTML(chunk(R.final.length > 96 ? pool(R.final, 96) : R.final, 48), { cell: 14, cap: 'final hidden state' + (R.final.length > 96 ? ', ' + poolNote(R.final.length, 96) : ' (' + Dm.D + ')') })}`],
        ['Logits', () => `<p class="explain">Higher logit means the model thinks that token is more likely.</p>` + table(1)],
        ['Temperature', () => `<p class="explain">Logits are divided by the temperature <b>T = ${state.T}</b>. T &lt; 1 sharpens the distribution (safer), T &gt; 1 flattens it (more creative). Try the slider above.</p>` + table(2)],
        ['Softmax', () => `<p class="explain">Softmax converts scores into probabilities that sum to 100%.</p>` + table(3)],
        ['Filter', () => `<p class="explain">${state.mode === 'top-k' ? `<b>Top-k</b> keeps only the ${state.k} most likely tokens` : `<b>Top-p</b> keeps the smallest set whose probabilities add up to ${state.p}`}, then renormalizes.</p>` + table(4)],
        ['Sample', () => `<p class="explain">A token is drawn at random using these probabilities. This time it was <b>${esc(disp((c => c.token ?? GPT2.decode(c.id))(state.probs.find(p => p.chosen))))}</b>. Click <b>Generate</b> to append it and run the model again.</p>` + table(4)]
      ]
    };
  }
  function renderModal() {
    const spec = buildSteps(modal.kind);
    modal.steps = spec.steps;
    modal.step = Math.min(modal.step, spec.steps.length - 1);
    $('#modalTitle').textContent = spec.title;
    $('#modalSteps').innerHTML = spec.steps.map((s, i) => `<button data-i="${i}" class="${i === modal.step ? 'active' : i < modal.step ? 'done' : ''}">${i + 1}. ${s[0]}</button>`).join('');
    $('#modalBody').innerHTML = `<div class="fade">${spec.steps[modal.step][1]()}</div>`;
    $('#stepInfo').textContent = `Step ${modal.step + 1} of ${spec.steps.length}`;
    $('#stepPrev').disabled = modal.step === 0;
    $('#stepNext').textContent = modal.step === spec.steps.length - 1 ? 'Done' : 'Next ›';
    const rp = $('#rowPick'); if (rp) rp.addEventListener('change', e => { modal.row = +e.target.value; renderModal(); });
  }
  function openModal(kind, row) {
    if (!state.result) return;
    modal.kind = kind; modal.step = 0; modal.row = row ?? null;
    $('#modal').hidden = false; tip.hidden = true; renderModal();
  }
  function refreshModal() { if (!$('#modal').hidden && state.result) renderModal(); }
  function closeModal() { $('#modal').hidden = true; }
  $('#modalSteps').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { modal.step = +b.dataset.i; renderModal(); } });
  $('#stepPrev').addEventListener('click', () => { modal.step--; renderModal(); });
  $('#stepNext').addEventListener('click', () => { if (modal.step >= modal.steps.length - 1) closeModal(); else { modal.step++; renderModal(); } });
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  life.on(document, 'keydown', e => {
    if ($('#modal').hidden) return;
    if (e.key === 'Escape') closeModal();
    if (e.key === 'ArrowRight' && modal.step < modal.steps.length - 1) { modal.step++; renderModal(); }
    if (e.key === 'ArrowLeft' && modal.step > 0) { modal.step--; renderModal(); }
  });

  if (/[?&]static/.test(location.search)) { document.body.classList.add('static'); state.flowing = false; $('#play').classList.add('paused'); }
  // ---------- model switch ----------
  function setEngineStatus(msg, err) {
    $('#engineStatus').textContent = msg;
    $('.engine-status').classList.toggle('err', !!err);
  }
  function syncEngineUI() {
    document.querySelectorAll('input[name=engine]').forEach(r => (r.checked = r.value === state.wantEngine));
    if (state.engine === 'tiny' && state.wantEngine === 'tiny' && !$('.engine-status').classList.contains('err')) setEngineStatus('Built-in demo model');
  }
  function updateFootnote() {
    const zoom = ' Hover anything; click <b>⊕</b> labels to zoom in.';
    $('#footnote').innerHTML = isFull()
      ? 'Every value on this page is <b>GPT-2\'s own</b>: tokens, embeddings, queries, keys and values, attention, the MLP, the residual stream and the next-token probabilities. They come from a custom export of GPT-2 (124M parameters, 8-bit weights) running in your browser. Raw scores, scaling, masking and head outputs are recomputed from its queries, keys and values. Long vectors are averaged into fewer cells for display.' + zoom
      : isGPT2()
        ? 'Tokens and next-token probabilities come from <b>real GPT-2</b> (124M parameters, 8-bit) running in your browser. The block diagram is computed by the tiny 48-dimension model on the same tokens, because the browser build of GPT-2 does not expose its internal values. Choose GPT-2 full internals to see its real values.' + zoom
        : 'A tiny 12-layer, 12-head GPT-style model (d<sub>model</sub>=48, GPT-2 small uses 768) runs every step in your browser. Its weights are untrained, so next-token scores are blended with a small n-gram model. Switch Model to GPT-2 for real predictions.' + zoom;
  }
  const ENGINES = {
    gpt2: { name: 'GPT-2', ready: () => GPT2.isReady(), load: cb => GPT2.load(cb), fail: 'Could not load GPT-2. Check your connection. ' },
    full: { name: 'GPT-2 full internals', ready: () => GPT2Full.isReady(), load: cb => GPT2Full.load(cb), fail: 'Could not load GPT-2 full internals. ' }
  };
  async function chooseEngine(engine) {
    const before = state.engine;
    state.wantEngine = engine;
    syncEngineUI();
    try { localStorage.setItem('engine', engine); } catch (e) { /* storage unavailable */ }
    if (engine === 'tiny') {
      state.engine = 'tiny'; setEngineStatus('Built-in demo model');
      $('#progress').hidden = true; $('#engineSpin').hidden = true; state.newIndex = -1; runText(state.text, false); return;
    }
    const E = ENGINES[engine];
    const giveUp = msg => {
      $('#progress').hidden = true; $('#engineSpin').hidden = true;
      setEngineStatus(msg, true);
      if (state.wantEngine === engine) { state.wantEngine = before; syncEngineUI(); }
    };
    if (engine === 'full') {
      const a = await GPT2Full.available();
      if (!a.ok) return giveUp(a.reason);
    }
    if (!E.ready()) {
      $('#progress').hidden = false; $('#progress i').style.width = '0'; $('#engineSpin').hidden = false;
      setEngineStatus(`Loading ${E.name}…`);
      try {
        await E.load((loaded, total, phase) => {
          $('#progress i').style.width = (100 * loaded / total).toFixed(1) + '%';
          setEngineStatus(phase === 'init' || phase === 'preparing' ? 'Preparing the model; the first time can take up to a minute…' : total < 1e6 ? 'Downloading…' : `Downloading ${(loaded / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`);
        });
      } catch (e) {
        console.error(e);
        return giveUp(E.fail + (e.message || ''));
      }
      $('#progress').hidden = true; $('#engineSpin').hidden = true;
    }
    if (state.wantEngine !== engine) return; // switched while loading
    state.engine = engine; setEngineStatus(`${E.name} ready`);
    state.newIndex = -1; runText(state.text, true);
  }
  document.querySelectorAll('input[name=engine]').forEach(r => r.addEventListener('change', e => chooseEngine(e.target.value)));

  // The full-internals option needs an HTTP server and the exported model file.
  function showFullAvailability(a) {
    const r = $('input[name=engine][value=full]'), lab = r.closest('label'), hint = $('#fullHint');
    r.disabled = !a.ok;
    lab.classList.toggle('off', !a.ok);
    lab.title = a.ok ? `Every number on the page comes from GPT-2 itself. Downloads ${a.sizeMB} MB once.` : a.reason;
    if (a.ok) lab.lastChild.textContent = ` GPT-2 full internals (${a.sizeMB} MB)`;
    hint.hidden = a.ok;
    hint.textContent = a.ok ? '' : a.code === 'file'
      ? 'Full internals are off: run tools/export_gpt2_explainer.py, then serve this folder over HTTP.'
      : 'Full internals are off: run tools/export_gpt2_explainer.py to create the model file, then reload.';
  }

  syncKP();
  updateFootnote();
  runText(state.text, !document.body.classList.contains('static'));
  const qs = new URLSearchParams(location.search);
  let wanted = null;
  try { wanted = localStorage.getItem('engine'); } catch (e) { /* storage unavailable */ }
  if (/[?&]gpt2/.test(location.search)) wanted = 'gpt2';
  if (qs.has('full')) wanted = 'full';
  if (wanted === 'gpt2') chooseEngine('gpt2');
  GPT2Full.available().then(a => { showFullAvailability(a); if (wanted === 'full' && a.ok) chooseEngine('full'); });
  if (qs.get('zoom')) { openModal(qs.get('zoom')); modal.step = +(qs.get('step') || 0); renderModal(); }
}
