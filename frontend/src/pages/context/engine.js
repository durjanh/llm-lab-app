import { Site } from '@/lib/site';

/** Runs the page's interactive parts. Returns nothing; `life` undoes timers and listeners on unmount. */
export function mount(root, life) {
  const { setInterval, requestAnimationFrame } = life;  // stopped when you leave the page
  const { $, fmtInt, esc } = Site;
  const v = id => +$('#' + id).value;
  const fmtS = s => (s < 1 ? (s * 1000).toFixed(0) + ' ms' : s.toFixed(s < 10 ? 2 : 1) + ' s');
  const compact = n => { const a = Math.abs(n); return a >= 1e12 ? (n / 1e12).toFixed(1) + 'T' : a >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : a >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(Math.round(n)); };
  const bytes = b => (b >= 1e9 ? (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e3).toFixed(0) + ' KB');
  const money = d => '$' + (d >= 100 ? d.toFixed(0) : d >= 1 ? d.toFixed(2) : d.toFixed(3));

  // ---------- 1. prefill vs decode ----------
  let timing = null;
  function renderTime() {
    const P = v('P'), G = v('G'), PS = v('PS'), DS = v('DS'), OV = v('OV') / 1000;
    $('#vP').textContent = fmtInt(P); $('#vG').textContent = fmtInt(G); $('#vPS').textContent = fmtInt(PS); $('#vDS').textContent = fmtInt(DS); $('#vOV').textContent = fmtInt(OV * 1000);
    const pre = P / PS, ttft = OV + pre, dec = G / DS, tot = ttft + dec;
    timing = { ttft, tot };
    $('#tTTFT').textContent = fmtS(ttft); $('#tDec').textContent = fmtS(dec); $('#tTot').textContent = fmtS(tot);
    $('#timebar').innerHTML = [[OV, 'var(--s1)', 'Network and queueing'], [pre, 'var(--s2)', 'Prefill'], [dec, 'var(--s3)', 'Decode']]
      .map(([t, c, l]) => `<i style="flex:0 0 ${(100 * t / tot).toFixed(2)}%;background:${c}" title="${l}: ${fmtS(t)}"></i>`).join('');
    drawLanes(1);
    renderKVCounts();
  }
  function drawLanes(frac) {
    const { ttft, tot } = timing, f0 = ttft / tot;
    const s = $('#laneS'), n = $('#laneN');
    $('.cursor', s).style.left = $('.cursor', n).style.left = (frac * 100).toFixed(2) + '%';
    const st = $('.txt', s); st.style.left = (f0 * 100) + '%'; st.style.width = Math.max(0, frac - f0) * 100 + '%';
    const nt = $('.txt', n); nt.style.left = '0'; nt.style.width = frac >= 0.999 ? '100%' : '0';
    s.previousElementSibling.textContent = `Streaming: first words at ${fmtS(ttft)}`;
    n.previousElementSibling.textContent = `Not streaming: all at ${fmtS(tot)}`;
  }
  let raf = null;
  $('#playT').addEventListener('click', () => {
    cancelAnimationFrame(raf);
    const dur = Math.min(timing.tot, 8) * 1000, t0 = performance.now();
    const step = now => { const f = Math.min(1, (now - t0) / dur); drawLanes(f); if (f < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
  });
  ['P', 'G', 'PS', 'DS', 'OV'].forEach(id => $('#' + id).addEventListener('input', renderTime));

  // ---------- 2. KV cache grid ----------
  const cv = $('#kvGrid'), ctx = cv.getContext('2d');
  const PD = 6, GD = 14;
  let kvTimer = null;
  function drawKV(rows) {
    const dpr = window.devicePixelRatio || 1, W = 640, H = 300;
    cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const left = 70, top = 26, cols = PD + GD, cw = (W - left - 10) / cols, rh = (H - top - 8) / (GD + 1);
    const on = $('#kvOn').checked;
    const css = getComputedStyle(document.body), col = n => css.getPropertyValue(n).trim();
    ctx.font = '11px -apple-system, sans-serif'; ctx.fillStyle = col('--muted');
    ctx.fillText('prompt', left, 14); ctx.fillText('generated tokens', left + PD * cw, 14);
    for (let r = 0; r <= Math.min(rows, GD); r++) {
      ctx.fillStyle = col('--muted'); ctx.fillText(r === 0 ? 'prefill' : 'step ' + r, 4, top + r * rh + rh * 0.7);
      const visible = r === 0 ? PD : PD + r;
      for (let c = 0; c < visible; c++) {
        const isNew = r === 0 || c === visible - 1;
        let fill;
        if (r === 0) fill = col('--s2');
        else if (isNew) fill = col('--s3');
        else fill = on ? col('--line') : col('--s3');
        ctx.fillStyle = fill;
        ctx.fillRect(left + c * cw + 1, top + r * rh + 1, cw - 2, rh - 2);
      }
    }
    ctx.fillStyle = col('--ink2');
    ctx.fillText(on ? 'Grey cells are read from the cache instead of recomputed.' : 'Without a cache, every step reprocesses every earlier token.', left, H - 2 + 0);
  }
  function animateKV() {
    clearInterval(kvTimer); let r = 0; drawKV(0);
    kvTimer = setInterval(() => { r++; drawKV(r); if (r >= GD) clearInterval(kvTimer); }, 90);
  }
  function renderKVCounts() {
    const P = v('P'), G = v('G');
    const withC = P + (G - 1), without = G * P + (G * (G - 1)) / 2;
    $('#kvWith').textContent = compact(withC);
    $('#kvWithout').textContent = compact(without);
    $('#kvRatio').textContent = (without / withC).toFixed(0) + '× less';
  }
  $('#kvOn').addEventListener('change', animateKV);
  life.on(document, 'themechange', () => drawKV(GD));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => drawKV(GD));
  $('#kvPlay').addEventListener('click', animateKV);

  // ---------- KV memory ----------
  const MODELS = {
    'GPT-2 small, 124M': { L: 12, kv: 12, hd: 64 },
    'Llama 3.1 8B': { L: 32, kv: 8, hd: 128 },
    'Llama 3.1 8B without grouped-query attention': { L: 32, kv: 32, hd: 128 },
    'Llama 3.1 70B': { L: 80, kv: 8, hd: 128 }
  };
  $('#mPreset').innerHTML = Object.keys(MODELS).map((k, i) => `<option ${i === 1 ? 'selected' : ''}>${k}</option>`).join('') + '<option>Custom</option>';
  function applyPreset() { const m = MODELS[$('#mPreset').value]; if (!m) return; $('#mL').value = m.L; $('#mKV').value = m.kv; $('#mHD').value = m.hd; renderMem(); }
  function renderMem() {
    const L = v('mL'), kv = v('mKV'), hd = v('mHD'), B = v('mB'), ctxT = Math.round(Math.pow(2, v('mCtx'))), seq = v('mSeq');
    $('#vCtx').textContent = (ctxT >= 1048576 ? +(ctxT / 1048576).toFixed(2) + 'M' : Math.round(ctxT / 1024) + 'K') + ' tokens'; $('#vSeq').textContent = seq;
    const perTok = 2 * L * kv * hd * B, perSeq = perTok * ctxT, all = perSeq * seq;
    $('#kvTok').textContent = bytes(perTok); $('#kvSeqM').textContent = bytes(perSeq); $('#kvAll').textContent = bytes(all);
    $('#attnOps').textContent = compact(ctxT * ctxT);
    const gpu = 80e9, max = Math.max(all, gpu) * 1.08, W = 900, x0 = 10, w = W - 20;
    const bw = w * all / max, gx = x0 + w * gpu / max;
    $('#kvBarWrap').innerHTML = `<svg class="chart" viewBox="0 0 ${W} 64" role="img" aria-label="KV cache memory compared with one 80 GB GPU">
      <rect x="${x0}" y="14" width="${w}" height="22" rx="4" fill="var(--soft)"></rect>
      <rect x="${x0}" y="14" width="${Math.max(2, bw)}" height="22" rx="4" fill="var(--s1)"><title>KV cache: ${bytes(all)}</title></rect>
      <line class="gpu-line" x1="${gx}" x2="${gx}" y1="6" y2="44"></line>
      <text x="${gx}" y="58" text-anchor="${gx > W - 120 ? 'end' : 'middle'}">one 80 GB GPU</text>
      <text x="${x0}" y="58">KV cache for all sequences: ${bytes(all)}</text></svg>`;
  }
  $('#mPreset').addEventListener('change', applyPreset);
  ['mL', 'mKV', 'mHD'].forEach(id => $('#' + id).addEventListener('input', () => { $('#mPreset').value = 'Custom'; renderMem(); }));
  ['mB', 'mCtx', 'mSeq'].forEach(id => $('#' + id).addEventListener('input', renderMem));

  // ---------- 3. conversation cost ----------
  const PRICES = { opus: [4, 20, 0.2], sonnet: [2, 10, 0.2] };
  function applyPrices() { const p = PRICES[$('#cPreset').value]; if (!p) return; $('#pIn').value = p[0]; $('#pOut').value = p[1]; $('#pRead').value = p[2]; renderCost(); }
  $('#cPreset').addEventListener('change', applyPrices);
  ['pIn', 'pOut', 'pRead'].forEach(id => $('#' + id).addEventListener('input', () => { $('#cPreset').value = 'custom'; renderCost(); }));
  ['cPre', 'cU', 'cR', 'cA', 'cT', 'cCache'].forEach(id => $('#' + id).addEventListener('input', renderCost));

  const SERIES = [['full', 'Input at full price', 'var(--s1)'], ['write', 'Written to cache, 1.25× price', 'var(--s2)'], ['read', 'Read from cache', 'var(--s3)']];
  let costRows = [];
  function renderCost() {
    const pre = v('cPre'), u = v('cU'), r = v('cR'), a = v('cA'), T = v('cT'), caching = $('#cCache').checked;
    const pin = v('pIn') / 1e6, pout = v('pOut') / 1e6, pread = v('pRead') / 1e6;
    [['vPre', pre], ['vU', u], ['vR', r], ['vA', a], ['vT', T]].forEach(([id, x]) => ($('#' + id).textContent = fmtInt(x)));
    costRows = []; let hist = 0, prevIn = 0, totIn = 0, costNo = 0, costYes = 0;
    for (let t = 1; t <= T; t++) {
      const input = pre + hist + u + r;
      const outC = a * pout;
      const noCache = input * pin + outC;
      let full = input, write = 0, read = 0;
      if (caching) { read = t === 1 ? 0 : prevIn; write = input - read; full = 0; }
      const withCache = read * pread + write * pin * 1.25 + outC;
      costRows.push({ t, input, full, write, read, out: a, noCache, withCache, cost: caching ? withCache : noCache });
      totIn += input; costNo += noCache; costYes += withCache;
      prevIn = input; hist += u + r + a;
    }
    $('#cTokIn').textContent = compact(totIn);
    $('#cNo').textContent = money(costNo);
    $('#cYes').textContent = money(costYes);
    $('#cSave').textContent = (100 * (1 - costYes / costNo)).toFixed(0) + '%';
    drawCostChart(caching);
    $('#costTable').innerHTML = `<thead><tr><th class="num">Call</th><th class="num">Input tokens</th><th class="num">Full price</th><th class="num">Cache write</th><th class="num">Cache read</th><th class="num">Output</th><th class="num">Cost</th></tr></thead><tbody>${costRows.map(x =>
      `<tr><td class="num">${x.t}</td><td class="num">${fmtInt(x.input)}</td><td class="num">${fmtInt(x.full)}</td><td class="num">${fmtInt(x.write)}</td><td class="num">${fmtInt(x.read)}</td><td class="num">${fmtInt(x.out)}</td><td class="num">${money(x.cost)}</td></tr>`).join('')}</tbody>`;
  }
  function niceMax(m) { const p = Math.pow(10, Math.floor(Math.log10(m))); return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(s => s * p).find(x => x >= m); }
  function drawCostChart(caching) {
    const W = 900, H = 300, l = 56, rgt = 10, top = 12, bot = 26, pw = W - l - rgt, ph = H - top - bot;
    const max = niceMax(Math.max(...costRows.map(x => x.input)) || 1);
    const n = costRows.length, slot = pw / n, bw = Math.max(2, Math.min(28, slot - 3));
    let s = '';
    for (let i = 0; i <= 4; i++) {
      const y = top + ph - ph * i / 4;
      s += `<line x1="${l}" x2="${W - rgt}" y1="${y}" y2="${y}" stroke="var(--line)"></line><text x="${l - 6}" y="${y + 4}" text-anchor="end">${compact(max * i / 4)}</text>`;
    }
    costRows.forEach((x, i) => {
      const cx = l + i * slot + (slot - bw) / 2;
      let y = top + ph, segs = caching ? [['read', x.read], ['write', x.write]] : [['full', x.full]];
      s += `<g class="bar" data-i="${i}">`;
      segs.forEach(([k, val], si) => {
        const h = ph * val / max; if (h <= 0) return;
        y -= h;
        const color = SERIES.find(z => z[0] === k)[2];
        const isTop = si === segs.length - 1 || segs.slice(si + 1).every(z => z[1] <= 0);
        s += isTop ? `<path d="M${cx} ${y + h} V${y + Math.min(4, h)} Q${cx} ${y} ${cx + Math.min(4, bw / 2)} ${y} H${cx + bw - Math.min(4, bw / 2)} Q${cx + bw} ${y} ${cx + bw} ${y + Math.min(4, h)} V${y + h} Z" fill="${color}"></path>`
          : `<rect x="${cx}" y="${y}" width="${bw}" height="${Math.max(0, h - 2)}" fill="${color}"></rect>`;
      });
      s += `<rect x="${l + i * slot}" y="${top}" width="${slot}" height="${ph}" fill="transparent"></rect></g>`;
      if (n <= 30 || (i + 1) % 5 === 0 || i === 0) s += `<text x="${cx + bw / 2}" y="${H - 8}" text-anchor="middle">${i + 1}</text>`;
    });
    $('#costChart').innerHTML = s;
    $('#costLegend').innerHTML = SERIES.filter(z => caching ? z[0] !== 'full' : z[0] === 'full').map(z => `<span style="--c:${z[2]}">${z[1]}</span>`).join('') + '<span class="small muted" style="--c:transparent">Each bar is one API call; height is its input tokens</span>';
  }
  Site.bindTips($('#costChart'), '.bar', el => {
    const x = costRows[+el.dataset.i];
    return `<b>Call ${x.t}</b><br>Input tokens: ${fmtInt(x.input)}${x.read ? `<br>Read from cache: ${fmtInt(x.read)}` : ''}${x.write ? `<br>Written to cache: ${fmtInt(x.write)}` : ''}<br>Output tokens: ${fmtInt(x.out)}<br>Cost of this call: <b>${money(x.cost)}</b>`;
  });

  renderTime(); animateKV(); applyPreset(); applyPrices();
}
