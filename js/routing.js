(function () {
  const { $, $$, esc, fmtInt } = Site;

  // Anthropic list prices as of October 2026, US dollars per million tokens. Haiku's applies to prompts up to 100K tokens.
  const PRESETS = { opus: ['Claude Opus 5.5', 4, 20], sonnet: ['Claude Sonnet 5.5', 2, 10], haiku: ['Claude Haiku 5.5', 0.1, 0.5] };
  // Token counts, accuracy and latency are illustrative placeholders, labelled as such on the page.
  const DEFAULTS = {
    s: { preset: 'haiku', tin: 2000, tout: 500, accE: 95, accH: 60, lat: 1 },
    l: { preset: 'opus', tin: 2000, tout: 500, accE: 98, accH: 90, lat: 4 }
  };
  const STRATS = [
    { id: 'large', name: 'All large', color: 'var(--s1)', how: n => `Every task goes to ${n.l}.` },
    { id: 'small', name: 'All small', color: 'var(--s2)', how: n => `Every task goes to ${n.s}.` },
    { id: 'cascade', name: 'Cascade', color: 'var(--s3)', how: n => `${n.S} answers first. A failed check sends the task on to ${n.l}.` },
    { id: 'router', name: 'Router', color: 'var(--s4)', how: n => `A classifier sends tasks it thinks are hard to ${n.l}, and the rest to ${n.s}.` }
  ];

  // ---------- formatting ----------
  const pctS = (v, d = 1) => (v * 100).toFixed(d) + '%';
  function money(v) {
    if (!isFinite(v)) return 'n/a';
    if (v === 0) return '$0';
    if (v >= 100) return '$' + fmtInt(v);
    if (v >= 1) return '$' + v.toFixed(2);
    if (v < 1e-6) return 'under $0.000001';
    return '$' + Number(v.toPrecision(3)).toString();
  }
  const moneyTick = v => (v === 0 ? '$0' : '$' + Number(v.toPrecision(2)).toString());
  const secs = v => (v < 10 ? v.toFixed(2) : v.toFixed(1)) + ' s';

  // ---------- inputs ----------
  const num = id => { const v = parseFloat($('#' + id).value); return isFinite(v) && v > 0 ? v : 0; };
  const share = id => Math.min(100, num(id)) / 100;
  function setupModels() {
    ['s', 'l'].forEach(m => {
      const d = DEFAULTS[m], sel = $(`#${m}_preset`);
      sel.innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p[0]}</option>`).join('') + '<option value="custom">Custom</option>';
      sel.value = d.preset;
      ['tin', 'tout', 'accE', 'accH', 'lat'].forEach(k => ($(`#${m}_${k}`).value = d[k]));
      applyPreset(m);
      sel.addEventListener('change', () => { applyPreset(m); render(); });
      ['pin', 'pout'].forEach(k => $(`#${m}_${k}`).addEventListener('input', () => { sel.value = 'custom'; }));
    });
  }
  function applyPreset(m) {
    const p = PRESETS[$(`#${m}_preset`).value];
    if (!p) return;
    $(`#${m}_pin`).value = p[1]; $(`#${m}_pout`).value = p[2];
  }
  function readModel(m) {
    const p = { pin: num(m + '_pin'), pout: num(m + '_pout'), tin: num(m + '_tin'), tout: num(m + '_tout'), e: share(m + '_accE'), h: share(m + '_accH'), lat: num(m + '_lat') };
    p.cost = (p.tin * p.pin + p.tout * p.pout) / 1e6;
    const preset = PRESETS[$(`#${m}_preset`).value];
    p.name = preset ? preset[0] : m === 's' ? 'the small model' : 'the large model';
    return p;
  }

  // ---------- the model ----------
  function compute() {
    const S = readModel('s'), L = readModel('l');
    const h = share('hard'), e = 1 - h;
    const W = { volume: num('volume'), target: share('target'), catchR: share('catch'), falseR: share('fesc'), checkCost: num('checkCost'), checkLat: num('checkLat'), route: share('route'), routerCost: num('routerCost'), routerLat: num('routerLat') };
    const acc = m => e * m.e + h * m.h;
    // cascade, per task type: escalation probability and probability the final answer is right
    const escP = s => (1 - s) * W.catchR + s * W.falseR;
    const rightP = (s, l) => s * (1 - W.falseR) + escP(s) * l;
    const pEsc = e * escP(S.e) + h * escP(S.h);
    // router: probability a task goes to the large model
    const pLarge = h * W.route + e * (1 - W.route);
    const res = [
      { acc: acc(L), cost: L.cost, lat: L.lat, toLarge: 1 },
      { acc: acc(S), cost: S.cost, lat: S.lat, toLarge: 0 },
      { acc: e * rightP(S.e, L.e) + h * rightP(S.h, L.h), cost: S.cost + W.checkCost + pEsc * L.cost, lat: S.lat + W.checkLat + pEsc * L.lat, toLarge: pEsc },
      { acc: e * (W.route * S.e + (1 - W.route) * L.e) + h * (W.route * L.h + (1 - W.route) * S.h), cost: W.routerCost + pLarge * L.cost + (1 - pLarge) * S.cost, lat: W.routerLat + pLarge * L.lat + (1 - pLarge) * S.lat, toLarge: pLarge }
    ];
    res.forEach((r, i) => Object.assign(r, STRATS[i], { cpc: r.acc > 0 ? r.cost / r.acc : Infinity, monthly: r.cost * W.volume, meets: r.acc + 1e-9 >= W.target }));
    return { S, L, W, res, names: { s: S.name, l: L.name, S: S.name.charAt(0).toUpperCase() + S.name.slice(1) } };
  }

  // ---------- charts ----------
  function niceMax(m) {
    if (!(m > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(m)));
    return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map(s => s * p).find(x => x >= m * 1.0001);
  }
  // Horizontal bar: square at the baseline, 4px rounded data end.
  function hbar(x, y, w, h, fill) {
    if (w <= 0) return '';
    const r = Math.min(4, w / 2, h / 2);
    return `<path d="M${x} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x}Z" fill="${fill}"></path>`;
  }
  const widthOf = svg => Math.round(svg.getBoundingClientRect().width) || 900;
  function rowLabel(r, left, y, rowH, sub) {
    return `<text class="lbl" x="${left - 12}" y="${y + rowH / 2 + (sub ? -1 : 4)}" text-anchor="end">${r.name}</text>` +
      (sub ? `<text class="lbl-sub" x="${left - 12}" y="${y + rowH / 2 + 12}" text-anchor="end">${sub}</text>` : '');
  }
  function drawCpc(res) {
    const svg = $('#cpcChart'), W = widthOf(svg), narrow = W < 560;
    const left = narrow ? 96 : 136, right = narrow ? 66 : 96, top = 4, rowH = 42, bar = 20, bot = 22;
    const H = top + rowH * res.length + bot, pw = W - left - right;
    const max = niceMax(Math.max(0, ...res.filter(r => isFinite(r.cpc)).map(r => r.cpc)));
    const x = v => left + pw * Math.min(v, max) / max;
    let s = '';
    const ticks = narrow ? 2 : 4;
    for (let i = 0; i <= ticks; i++) {
      const v = max * i / ticks, gx = x(v);
      s += `<line class="${i ? 'grid' : 'base'}" x1="${gx}" x2="${gx}" y1="${top}" y2="${top + rowH * res.length}"></line><text x="${gx}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}">${moneyTick(v)}</text>`;
    }
    res.forEach((r, i) => {
      const y = top + i * rowH, by = y + (rowH - bar) / 2, w = isFinite(r.cpc) ? Math.max(2, x(r.cpc) - left) : 0;
      s += `<g class="row" data-i="${i}"><rect class="hit" x="0" y="${y + 1}" width="${W}" height="${rowH - 2}" rx="6"></rect>` +
        rowLabel(r, left, y, rowH, r.meets ? '' : 'below target') + hbar(left, by, w, bar, r.color) +
        `<text class="val" x="${left + w + 6}" y="${by + bar / 2 + 4}">${isFinite(r.cpc) ? money(r.cpc) : 'none correct'}</text></g>`;
    });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
    svg.innerHTML = s;
  }
  function drawAcc(res, target) {
    const svg = $('#accChart'), W = widthOf(svg), narrow = W < 560;
    const left = narrow ? 96 : 136, right = narrow ? 52 : 96, top = 18, rowH = 34, bot = 22;
    const H = top + rowH * res.length + bot, pw = W - left - right;
    const lo = Math.max(0, Math.floor((Math.min(target, ...res.map(r => r.acc)) - 0.04) * 20) / 20), hi = 1;
    const x = v => left + pw * (v - lo) / (hi - lo);
    // widest-spaced round step that still leaves about 52px between tick labels
    const step = [0.05, 0.1, 0.2, 0.25, 0.5].find(st => pw * st / (hi - lo) >= 52) || 0.5;
    let s = `<line class="base" x1="${left}" x2="${left}" y1="${top}" y2="${top + rowH * res.length}"></line>`;
    for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + 1e-9; k++) {
      const v = k * step, gx = x(v), first = v - lo < 1e-9;
      if (!first) s += `<line class="grid" x1="${gx}" x2="${gx}" y1="${top}" y2="${top + rowH * res.length}"></line>`;
      s += `<text x="${gx}" y="${H - 5}" text-anchor="${first ? 'start' : v > hi - 1e-9 ? 'end' : 'middle'}">${Math.round(v * 100)}%</text>`;
    }
    const tx = x(target);
    res.forEach((r, i) => {
      const y = top + i * rowH, cy = y + rowH / 2, cx = x(Math.max(lo, r.acc));
      const flip = cx < tx && cx + 56 > tx && cx - 56 > left; // keep the value label off the target line
      s += `<g class="row" data-i="${i}"><rect class="hit" x="0" y="${y + 1}" width="${W}" height="${rowH - 2}" rx="6"></rect>` + rowLabel(r, left, y, rowH, '') +
        `<circle class="dot" cx="${cx}" cy="${cy}" r="6" fill="${r.color}"></circle><text class="val" x="${flip ? cx - 11 : cx + 11}" y="${cy + 4}" text-anchor="${flip ? 'end' : 'start'}">${pctS(r.acc)}</text></g>`;
    });
    s += `<line class="target" x1="${tx}" x2="${tx}" y1="${top - 4}" y2="${top + rowH * res.length}"></line><text x="${tx}" y="${top - 7}" text-anchor="${tx > W - right - 40 ? 'end' : 'middle'}" style="fill:var(--ink2)">you need ${pctS(target, target * 1000 % 10 ? 1 : 0)}</text>`;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
    svg.innerHTML = s;
  }

  // ---------- render ----------
  let last = null;
  function render() {
    const c = compute(); last = c;
    const { S, L, W, res } = c;
    $('#v_hard').textContent = pctS(share('hard'), 0);
    $('#v_target').textContent = pctS(W.target, W.target * 1000 % 10 ? 1 : 0);
    $('#v_catch').textContent = pctS(W.catchR, 0); $('#v_fesc').textContent = pctS(W.falseR, 0); $('#v_route').textContent = pctS(W.route, 0);
    [['s', S], ['l', L]].forEach(([m, M]) => {
      $(`#${m}_derived`).innerHTML = `Cost per call: <b>${money(M.cost)}</b>. Accuracy across your workload: <b>${pctS(res[m === 'l' ? 0 : 1].acc)}</b>.`;
      const haikuPrice = M.pin === PRESETS.haiku[1] && M.pout === PRESETS.haiku[2];
      const warn = $(`#${m}_warn`);
      warn.hidden = !(haikuPrice && M.tin > 100000);
      warn.textContent = 'The Haiku 5.5 price here applies to prompts up to 100K tokens. Check the pricing page for longer prompts.';
    });

    const meeting = res.filter(r => r.meets && isFinite(r.cpc)).sort((a, b) => a.cpc - b.cpc);
    const best = meeting[0], cheapest = res.filter(r => isFinite(r.cpc)).sort((a, b) => a.cpc - b.cpc)[0];
    const tgt = pctS(W.target, W.target * 1000 % 10 ? 1 : 0);
    let v;
    if (best) {
      v = `At these numbers, <b>${best.name.toLowerCase() === 'cascade' || best.name === 'Router' ? 'the ' + best.name.toLowerCase() : best.name.toLowerCase()}</b> is the cheapest way to reach ${tgt} accuracy: ${money(best.cpc)} per correct answer, ${pctS(best.acc)} accurate.`;
      const large = res[0];
      if (best !== large && large.meets && isFinite(large.cpc) && best.cpc > 0) v += ` All large costs ${(large.cpc / best.cpc).toFixed(1)} times as much per correct answer.`;
      if (cheapest && cheapest !== best) v += ` ${cheapest.name} is cheaper, at ${money(cheapest.cpc)}, but only ${pctS(cheapest.acc)} accurate.`;
    } else {
      const top = res.slice().sort((a, b) => b.acc - a.acc)[0];
      v = `No strategy reaches ${tgt}. The most accurate is ${top.name.toLowerCase()}, at ${pctS(top.acc)}. Improve the models, the check or the router, or revisit the target.`;
    }
    $('#verdict').innerHTML = v;
    $('#tBest').textContent = best ? best.name : 'None';
    $('#tCpc').textContent = best ? money(best.cpc) : 'n/a';
    $('#tMonthly').textContent = best ? money(best.monthly) : 'n/a';
    $('#tLat').textContent = best ? secs(best.lat) : 'n/a';

    $('#legend').innerHTML = res.map(r => `<span style="--c:${r.color}">${r.name}</span>`).join('');
    drawCpc(res); drawAcc(res, W.target);
    $('#resTable').innerHTML = `<thead><tr><th>Strategy</th><th class="num">Accuracy</th><th class="num">Cost per task</th><th class="num">Cost per correct answer</th><th class="num">Monthly cost</th><th class="num">Average latency</th><th class="num">Sent to large model</th><th>Meets ${tgt}</th></tr></thead><tbody>` +
      res.map(r => `<tr class="${r === best ? 'best' : ''}" data-id="${r.id}"><td><span class="swatch" style="background:${r.color}"></span>${r.name}</td><td class="num">${pctS(r.acc)}</td><td class="num">${money(r.cost)}</td><td class="num">${money(r.cpc)}</td><td class="num">${money(r.monthly)}</td><td class="num">${secs(r.lat)}</td><td class="num">${pctS(r.toLarge, 0)}</td><td>${r.meets ? '<span class="ok">✓ Yes</span>' : '<span class="no">✗ No</span>'}</td></tr>`).join('') + '</tbody>';
  }
  function tipFor(el) {
    if (!last) return '';
    const r = last.res[+el.closest('g.row').dataset.i];
    return `<b>${r.name}</b><br>${esc(r.how(last.names))}<br>Accuracy: ${pctS(r.acc)}${r.meets ? '' : ', below your target'}<br>Cost per task: ${money(r.cost)}<br>Cost per correct answer: <b>${money(r.cpc)}</b><br>Monthly cost: ${money(r.monthly)}<br>Average latency: ${secs(r.lat)}<br>Sent to the large model: ${pctS(r.toLarge, 0)}`;
  }
  Site.bindTips($('#cpcChart'), 'g.row', tipFor);
  Site.bindTips($('#accChart'), 'g.row', tipFor);

  setupModels();
  $$('main input, main select').forEach(el => el.addEventListener('input', render));
  let raf = 0;
  window.addEventListener('resize', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); });
  render();
})();
