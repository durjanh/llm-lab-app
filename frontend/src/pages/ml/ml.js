/* Machine learning algorithms lab: every algorithm below is implemented here and runs in the browser. */
import { Site } from '@/lib/site';
const { $, $$, esc, mulberry32 } = Site;

// ---------- colours from the theme ----------
const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'cross'];
function theme() {
  const c = getComputedStyle(document.body), v = n => c.getPropertyValue(n).trim();
  return { cls: ['--s1', '--s2', '--s3', '--s4', '--s5'].map(v), ink: v('--ink'), ink2: v('--ink2'), muted: v('--muted'), line: v('--line'), surface: v('--surface'), brand: v('--brand'), bad: v('--bad') };
}
function rgba(col, a) {
  if (col.startsWith('#')) { const h = col.length === 4 ? col.slice(1).split('').map(x => x + x).join('') : col.slice(1); const n = parseInt(h, 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
  const m = col.match(/\d+(\.\d+)?/g); return m ? `rgba(${m[0]},${m[1]},${m[2]},${a})` : col;
}

// ---------- random data ----------
const gauss = rng => { let u = 0; while (!u) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };
const DATA = {
  linear: { name: 'Two groups', K: 2, gen: (r, n) => Array.from({ length: n }, (_, i) => { const c = i % 2; return { x: (c ? 0.4 : -0.4) + gauss(r) * 0.3, y: (c ? 0.25 : -0.25) + gauss(r) * 0.3, c }; }) },
  moons: { name: 'Two moons', K: 2, gen: (r, n) => Array.from({ length: n }, (_, i) => {
    // the standard interleaving half-circles, centred and scaled to the plot
    const c = i % 2, t = Math.PI * Math.floor(i / 2) / Math.max(1, Math.floor(n / 2) - 1); // evenly spaced along each arc
    const x = c ? 1 - Math.cos(t) : Math.cos(t), y = c ? 0.5 - Math.sin(t) : Math.sin(t);
    return { x: (x - 0.5) * 0.7 + gauss(r) * 0.06, y: (y - 0.25) * 0.7 + gauss(r) * 0.06, c };
  }) },
  circles: { name: 'Circle inside a ring', K: 2, gen: (r, n) => Array.from({ length: n }, (_, i) => { const c = i % 2, a = 2 * Math.PI * r(), rad = (c ? 0.78 : 0.33) + gauss(r) * 0.07; return { x: rad * Math.cos(a), y: rad * Math.sin(a), c }; }) },
  xor: { name: 'Checkerboard (XOR)', K: 2, gen: (r, n) => Array.from({ length: n }, () => { const x = r() * 1.8 - 0.9, y = r() * 1.8 - 0.9; return { x, y, c: (x > 0) === (y > 0) ? 0 : 1 }; }) },
  spiral: { name: 'Two spirals', K: 2, gen: (r, n) => Array.from({ length: n }, (_, i) => { const c = i % 2, t = 0.25 + 2.6 * Math.PI * (Math.floor(i / 2) / (n / 2)), rad = t / (2.85 * Math.PI) * 0.92; const a = t + c * Math.PI; return { x: rad * Math.cos(a) + gauss(r) * 0.03, y: rad * Math.sin(a) + gauss(r) * 0.03, c }; }) },
  blobs3: { name: 'Three groups', K: 3, gen: (r, n) => { const C = [[-0.55, -0.35], [0.5, -0.35], [0, 0.5]]; return Array.from({ length: n }, (_, i) => { const c = i % 3; return { x: C[c][0] + gauss(r) * 0.22, y: C[c][1] + gauss(r) * 0.2, c }; }); } }
};
const makeData = (name, seed, n) => DATA[name].gen(mulberry32(seed), n);

// ---------- plot ----------
const XR = 1.36, YR = 1.02;
function Plot(host, opts = {}) {
  host.innerHTML = '';
  const cv = document.createElement('canvas'); cv.className = 'plot'; host.appendChild(cv);
  const W = 560, H = opts.height || 420, ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1; cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', opts.label || 'Interactive plot');
  const sx = x => (x + XR) / (2 * XR) * W, sy = y => (1 - (y + YR) / (2 * YR)) * H;
  const ix = px => px / W * 2 * XR - XR, iy = py => (1 - py / H) * 2 * YR - YR;
  const p = {
    cv, ctx, W, H, sx, sy,
    toData(e) { const b = cv.getBoundingClientRect(); return { x: ix((e.clientX - b.left) / b.width * W), y: iy((e.clientY - b.top) / b.height * H) }; },
    clear() { const t = theme(); ctx.clearRect(0, 0, W, H); ctx.fillStyle = t.surface; ctx.fillRect(0, 0, W, H); ctx.strokeStyle = rgba(t.muted, 0.18); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(sx(0), 0); ctx.lineTo(sx(0), H); ctx.moveTo(0, sy(0)); ctx.lineTo(W, sy(0)); ctx.stroke(); },
    region(proba, K, res = 6) {
      const t = theme();
      for (let py = 0; py < H; py += res) for (let px = 0; px < W; px += res) {
        const pr = proba(ix(px + res / 2), iy(py + res / 2)); let k = 0; for (let j = 1; j < pr.length; j++) if (pr[j] > pr[k]) k = j;
        const conf = K > 1 ? (pr[k] - 1 / K) / (1 - 1 / K) : pr[k];
        ctx.fillStyle = rgba(t.cls[k], 0.07 + 0.3 * Math.max(0, Math.min(1, conf))); ctx.fillRect(px, py, res, res);
      }
    },
    marker(x, y, shape, fill, stroke, r = 4.5, hollow = false) {
      const X = sx(x), Y = sy(y); ctx.beginPath();
      if (shape === 'square') ctx.rect(X - r, Y - r, 2 * r, 2 * r);
      else if (shape === 'triangle') { ctx.moveTo(X, Y - r * 1.2); ctx.lineTo(X + r * 1.1, Y + r * 0.8); ctx.lineTo(X - r * 1.1, Y + r * 0.8); ctx.closePath(); }
      else if (shape === 'diamond') { ctx.moveTo(X, Y - r * 1.25); ctx.lineTo(X + r * 1.1, Y); ctx.lineTo(X, Y + r * 1.25); ctx.lineTo(X - r * 1.1, Y); ctx.closePath(); }
      else if (shape === 'cross') { ctx.moveTo(X - r, Y - r); ctx.lineTo(X + r, Y + r); ctx.moveTo(X + r, Y - r); ctx.lineTo(X - r, Y + r); ctx.strokeStyle = fill; ctx.lineWidth = 2; ctx.stroke(); return; }
      else ctx.arc(X, Y, r, 0, 2 * Math.PI);
      if (hollow) { ctx.strokeStyle = fill; ctx.lineWidth = 1.8; ctx.stroke(); } else { ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke(); }
    },
    points(pts, o = {}) {
      const t = theme();
      pts.forEach(q => { const k = o.colorOf ? o.colorOf(q) : q.c; const col = k < 0 ? t.muted : t.cls[k % 5]; this.marker(q.x, q.y, k < 0 ? 'cross' : SHAPES[k % 5], col, t.surface, o.r || 4.5, o.hollow); });
    },
    line(x1, y1, x2, y2, col, w = 1.5, dash) { ctx.beginPath(); ctx.setLineDash(dash || []); ctx.moveTo(sx(x1), sy(y1)); ctx.lineTo(sx(x2), sy(y2)); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.stroke(); ctx.setLineDash([]); },
    ring(x, y, r, col) { ctx.beginPath(); ctx.arc(sx(x), sy(y), r, 0, 2 * Math.PI); ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke(); },
    ellipse(x, y, rx, ry, col, dash) { ctx.beginPath(); ctx.setLineDash(dash || []); ctx.ellipse(sx(x), sy(y), rx / (2 * XR) * W, ry / (2 * YR) * H, 0, 0, 2 * Math.PI); ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]); },
    label(x, y, text, col) { ctx.font = '12px -apple-system, sans-serif'; ctx.fillStyle = col; ctx.fillText(text, sx(x), sy(y)); }
  };
  host._plot = p;
  return p;
}

// ---------- controls ----------
function Controls(host, onChange) {
  host.innerHTML = '';
  const vals = {};
  const api = {
    range(key, label, min, max, step, value, fmt = v => v) {
      const l = document.createElement('label'); l.innerHTML = `${label} <span class="mono"></span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}">`;
      const inp = l.querySelector('input'), out = l.querySelector('.mono');
      const set = () => { vals[key] = +inp.value; out.textContent = fmt(+inp.value); };
      inp.addEventListener('input', () => { set(); onChange(key); }); set(); host.appendChild(l); return api;
    },
    select(key, label, options, value) {
      const l = document.createElement('label'); l.innerHTML = `${label} <span></span><select>${options.map(([v, t]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
      const s = l.querySelector('select'); vals[key] = s.value; s.addEventListener('change', () => { vals[key] = s.value; onChange(key); }); host.appendChild(l); return api;
    },
    button(label, fn, primary) { const b = document.createElement('button'); b.className = 'btn small' + (primary ? ' primary' : ''); b.textContent = label; b.style.alignSelf = 'end'; b.addEventListener('click', fn); host.appendChild(b); return api; },
    vals
  };
  return api;
}
const pct = v => (v * 100).toFixed(0) + '%';
const accuracy = (pts, proba) => pts.filter(p => { const pr = proba(p.x, p.y); let k = 0; for (let j = 1; j < pr.length; j++) if (pr[j] > pr[k]) k = j; return k === p.c; }).length / pts.length;
const dataOptions = names => names.map(n => [n, DATA[n].name]);
const softmax = z => { const m = Math.max(...z); const e = z.map(v => Math.exp(v - m)); const s = e.reduce((a, b) => a + b, 0); return e.map(v => v / s); };
const sigmoid = z => 1 / (1 + Math.exp(-z));

// ---------- decision trees (shared by tree, forest and boosting) ----------
function gini(counts, n) { let s = 1; for (const c of counts) s -= (c / n) * (c / n); return s; }
function buildTree(pts, K, maxDepth, minLeaf, rng, depth = 0) {
  const counts = new Array(K).fill(0); pts.forEach(p => counts[p.c]++);
  const node = { counts, n: pts.length };
  if (depth >= maxDepth || pts.length < 2 * minLeaf || counts.filter(c => c > 0).length < 2) return node;
  const feats = rng ? [rng() < 0.5 ? 'x' : 'y'] : ['x', 'y'];
  let best = null;
  for (const f of feats) {
    const s = pts.slice().sort((a, b) => a[f] - b[f]), left = new Array(K).fill(0), right = counts.slice();
    for (let i = 0; i < s.length - 1; i++) {
      left[s[i].c]++; right[s[i].c]--;
      if (s[i][f] === s[i + 1][f] || i + 1 < minLeaf || s.length - i - 1 < minLeaf) continue;
      const nl = i + 1, nr = s.length - nl, score = (nl * gini(left, nl) + nr * gini(right, nr)) / s.length;
      if (!best || score < best.score) best = { f, t: (s[i][f] + s[i + 1][f]) / 2, score };
    }
  }
  if (!best || best.score >= gini(counts, pts.length) - 1e-9) return node;
  node.f = best.f; node.t = best.t;
  node.l = buildTree(pts.filter(p => p[best.f] < best.t), K, maxDepth, minLeaf, rng, depth + 1);
  node.r = buildTree(pts.filter(p => p[best.f] >= best.t), K, maxDepth, minLeaf, rng, depth + 1);
  return node;
}
function treeProba(node, x, y) { while (node.f) node = (node.f === 'x' ? x : y) < node.t ? node.l : node.r; return node.counts.map(c => (c + 0.01) / (node.n + 0.01 * node.counts.length)); }
function treeText(node, names, indent = '') {
  if (!node.f) { let k = 0; node.counts.forEach((c, j) => { if (c > node.counts[k]) k = j; }); return `${indent}→ predict ${names[k]}  (${node.counts.join(' / ')})\n`; }
  return `${indent}if ${node.f} < ${node.t.toFixed(2)}:\n${treeText(node.l, names, indent + '   ')}${indent}else:\n${treeText(node.r, names, indent + '   ')}`;
}
const leaves = n => (n.f ? leaves(n.l) + leaves(n.r) : 1);
// regression tree on residuals, for gradient boosting
function buildRegTree(pts, g, h, maxDepth, depth = 0) {
  const G = g.reduce((a, b) => a + b, 0), Hs = h.reduce((a, b) => a + b, 0);
  const node = { v: G / (Hs + 1e-6) };
  if (depth >= maxDepth || pts.length < 4) return node;
  let best = null;
  for (const f of ['x', 'y']) {
    const idx = pts.map((_, i) => i).sort((a, b) => pts[a][f] - pts[b][f]);
    let gl = 0, hl = 0;
    for (let k = 0; k < idx.length - 1; k++) {
      gl += g[idx[k]]; hl += h[idx[k]];
      if (pts[idx[k]][f] === pts[idx[k + 1]][f] || k < 1 || idx.length - k - 1 < 2) continue;
      const gain = gl * gl / (hl + 1e-6) + (G - gl) ** 2 / (Hs - hl + 1e-6) - G * G / (Hs + 1e-6);
      if (!best || gain > best.gain) best = { f, t: (pts[idx[k]][f] + pts[idx[k + 1]][f]) / 2, gain };
    }
  }
  if (!best || best.gain <= 1e-9) return node;
  const L = [], R = [];
  pts.forEach((p, i) => (p[best.f] < best.t ? L : R).push(i));
  node.f = best.f; node.t = best.t;
  node.l = buildRegTree(L.map(i => pts[i]), L.map(i => g[i]), L.map(i => h[i]), maxDepth, depth + 1);
  node.r = buildRegTree(R.map(i => pts[i]), R.map(i => g[i]), R.map(i => h[i]), maxDepth, depth + 1);
  return node;
}
const regTreeVal = (n, x, y) => { while (n.f) n = (n.f === 'x' ? x : y) < n.t ? n.l : n.r; return n.v; };

// ---------- a small neural network with backpropagation ----------
function MLP(sizes, act, rng, out) {
  const L = sizes.length - 1, W = [], B = [], vW = [], vB = [];
  for (let l = 0; l < L; l++) {
    const s = Math.sqrt(2 / (sizes[l] + sizes[l + 1]));
    W.push(Array.from({ length: sizes[l + 1] }, () => Array.from({ length: sizes[l] }, () => gauss(rng) * s)));
    B.push(new Array(sizes[l + 1]).fill(0));
    vW.push(W[l].map(r => r.map(() => 0))); vB.push(new Array(sizes[l + 1]).fill(0));
  }
  const f = act === 'relu' ? z => Math.max(0, z) : Math.tanh, df = act === 'relu' ? (a, z) => (z > 0 ? 1 : 0) : a => 1 - a * a;
  function forward(x) {
    const A = [x], Z = [];
    for (let l = 0; l < L; l++) {
      const z = W[l].map((row, i) => row.reduce((s, w, j) => s + w * A[l][j], B[l][i])); Z.push(z);
      A.push(l === L - 1 ? (out === 'softmax' ? softmax(z) : z) : z.map(f));
    }
    return { A, Z };
  }
  function trainBatch(X, Y, lr, mom = 0.9) {
    const gW = W.map(m => m.map(r => r.map(() => 0))), gB = B.map(b => b.map(() => 0));
    let loss = 0;
    X.forEach((x, n) => {
      const { A, Z } = forward(x);
      let d;
      if (out === 'softmax') { d = A[L].map((p, k) => p - (k === Y[n] ? 1 : 0)); loss -= Math.log(Math.max(A[L][Y[n]], 1e-12)); }
      else { d = A[L].map((p, k) => p - Y[n][k]); loss += d.reduce((s, v) => s + v * v, 0) / 2; }
      for (let l = L - 1; l >= 0; l--) {
        d.forEach((dv, i) => { gB[l][i] += dv; for (let j = 0; j < A[l].length; j++) gW[l][i][j] += dv * A[l][j]; });
        if (l > 0) d = A[l].map((a, j) => df(a, Z[l - 1][j]) * d.reduce((s, dv, i) => s + dv * W[l][i][j], 0));
      }
    });
    const n = X.length;
    for (let l = 0; l < L; l++) {
      for (let i = 0; i < W[l].length; i++) {
        for (let j = 0; j < W[l][i].length; j++) { vW[l][i][j] = mom * vW[l][i][j] - lr * gW[l][i][j] / n; W[l][i][j] += vW[l][i][j]; }
        vB[l][i] = mom * vB[l][i] - lr * gB[l][i] / n; B[l][i] += vB[l][i];
      }
    }
    return loss / n;
  }
  return { forward: x => forward(x).A, trainBatch, hidden: x => forward(x).A[Math.floor(L / 2)] };
}

// ---------- small SVG line chart ----------
function lineChart(series, opts) {
  const W = 520, H = opts.h || 170, l = 40, r = 10, t = 10, b = 26, pw = W - l - r, ph = H - t - b;
  const xs = series.flatMap(s => s.pts.map(p => p[0])), x0 = opts.x0 ?? Math.min(...xs), x1 = opts.x1 ?? Math.max(...xs);
  const y0 = opts.y0 ?? 0, y1 = opts.y1 ?? Math.max(...series.flatMap(s => s.pts.map(p => p[1])), 1e-9);
  const sx = x => l + (x - x0) / (x1 - x0 || 1) * pw;
  const sy = y => opts.log ? t + (1 - (Math.log10(Math.max(y, 10 ** y0)) - y0) / (y1 - y0)) * ph : t + (1 - (y - y0) / (y1 - y0 || 1)) * ph;
  let s = `<svg class="mini" viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:auto;display:block" role="img" aria-label="${esc(opts.label || 'chart')}">`;
  (opts.yTicks || [y0, (y0 + y1) / 2, y1]).forEach(v => { const y = opts.log ? sy(10 ** v) : sy(v); s += `<line x1="${l}" x2="${W - r}" y1="${y}" y2="${y}" stroke="var(--line)"></line><text x="${l - 5}" y="${y + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${opts.fmtY ? opts.fmtY(v) : +v.toFixed(2)}</text>`; });
  s += `<text x="${l + pw / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(opts.xLabel || '')}</text>`;
  series.forEach(se => {
    if (se.bars) se.pts.forEach(([x, y]) => { const bw = Math.max(2, pw / se.pts.length - 3), yy = opts.log ? sy(Math.max(y, 10 ** y0)) : sy(y); s += `<rect x="${sx(x) - bw / 2}" y="${yy}" width="${bw}" height="${Math.max(1, t + ph - yy)}" rx="2" fill="${se.color}"><title>${esc(se.tip ? se.tip(x, y) : y)}</title></rect>`; });
    else s += `<polyline fill="none" stroke="${se.color}" stroke-width="2" ${se.dash ? 'stroke-dasharray="5 4"' : ''} points="${se.pts.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ')}"></polyline>`;
  });
  if (opts.marker != null) s += `<line x1="${sx(opts.marker)}" x2="${sx(opts.marker)}" y1="${t}" y2="${t + ph}" stroke="var(--ink2)" stroke-dasharray="3 3"></line>`;
  return s + '</svg>' + (opts.legend ? `<div class="legend">${series.filter(se => se.name).map(se => `<span style="--c:${se.color}">${esc(se.name)}</span>`).join('')}</div>` : '');
}

export const __ML = { theme, rgba, gauss, DATA, makeData, Plot, Controls, pct, accuracy, dataOptions, softmax, sigmoid, buildTree, treeProba, treeText, leaves, buildRegTree, regTreeVal, MLP, lineChart, SHAPES };
