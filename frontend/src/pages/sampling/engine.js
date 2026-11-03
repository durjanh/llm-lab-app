import { GPT2 } from '@/lib/gpt2';
import { Site } from '@/lib/site';

/** Runs the page's interactive parts. Returns nothing; `life` undoes timers and listeners on unmount. */
export function mount(root, life) {
  const { $, $$, esc, pct, mulberry32 } = Site;
  const PRESETS = {
    Greedy: { t: 0, k: 0, p: 1, r: 1 },
    Balanced: { t: 0.7, k: 0, p: 0.9, r: 1 },
    Creative: { t: 1.2, k: 0, p: 0.98, r: 1 },
    'Greedy + penalty': { t: 0, k: 0, p: 1, r: 1.3 },
    'Top-k 5': { t: 1, k: 5, p: 1, r: 1 }
  };
  const START = ['Greedy', 'Balanced', 'Creative'];
  const EOS = 50256;
  let running = false, stopFlag = false;

  // ---------- setting cards ----------
  const cards = START.map((name, ci) => {
    const el = document.createElement('div');
    el.className = 'card cfg';
    el.innerHTML = `<h3><select class="preset" aria-label="Preset">${Object.keys(PRESETS).map(p => `<option ${p === name ? 'selected' : ''}>${p}</option>`).join('')}<option>Custom</option></select></h3>
      <div class="param"><span>Temperature</span><input type="range" class="t" min="0" max="2" step="0.05"><span class="val tv"></span></div>
      <div class="param"><span>Top-k (0 = off)</span><input type="number" class="k" min="0" max="200"><span></span></div>
      <div class="param"><span>Top-p</span><input type="range" class="p" min="0.05" max="1" step="0.01"><span class="val pv"></span></div>
      <div class="param"><span>Repetition penalty</span><input type="range" class="r" min="1" max="2" step="0.05"><span class="val rv"></span></div>
      <div class="samples"></div>
      <div class="metrics"><div><b class="m-conf">–</b>avg confidence</div><div><b class="m-div">–</b>diversity</div><div><b class="m-loop">–</b>loops</div></div>`;
    $('#cfgs').appendChild(el);
    const apply = p => { $('.t', el).value = p.t; $('.k', el).value = p.k; $('.p', el).value = p.p; $('.r', el).value = p.r; labels(); };
    const labels = () => {
      const t = +$('.t', el).value;
      $('.tv', el).textContent = t === 0 ? 'greedy' : t.toFixed(2);
      $('.pv', el).textContent = (+$('.p', el).value).toFixed(2);
      $('.rv', el).textContent = (+$('.r', el).value).toFixed(2);
    };
    $('.preset', el).addEventListener('change', e => { if (PRESETS[e.target.value]) apply(PRESETS[e.target.value]); });
    el.addEventListener('input', e => { if (!e.target.classList.contains('preset')) { $('.preset', el).value = 'Custom'; labels(); } });
    apply(PRESETS[name]);
    return { el, get: () => ({ t: +$('.t', el).value, k: Math.max(0, Math.round(+$('.k', el).value || 0)), p: +$('.p', el).value, r: +$('.r', el).value }) };
  });

  // ---------- decoding ----------
  function decodeStep(logits, seqIds, cfg, rng) {
    const raw = GPT2.softmax(logits, 1);
    let adj = logits;
    if (cfg.r > 1) {
      adj = Float32Array.from(logits);
      for (const id of new Set(seqIds)) adj[id] = adj[id] > 0 ? adj[id] / cfg.r : adj[id] * cfg.r;
    }
    let chosen, finalP;
    if (cfg.t === 0) {
      chosen = 0; for (let i = 1; i < adj.length; i++) if (adj[i] > adj[chosen]) chosen = i;
      finalP = 1;
    } else {
      const probs = GPT2.softmax(adj, cfg.t);
      const order = Array.from(probs.keys()).sort((a, b) => probs[b] - probs[a]);
      let keep = order.length;
      if (cfg.k > 0) keep = Math.min(keep, cfg.k);
      if (cfg.p < 1) { let c = 0, i = 0; for (; i < keep; i++) { c += probs[order[i]]; if (c >= cfg.p) { i++; break; } } keep = Math.max(1, i); }
      let s = 0; for (let i = 0; i < keep; i++) s += probs[order[i]];
      let r = rng() * s; chosen = order[keep - 1];
      for (let i = 0; i < keep; i++) { r -= probs[order[i]]; if (r <= 0) { chosen = order[i]; break; } }
      finalP = probs[chosen] / s;
    }
    const alts = GPT2.topIndices(raw, 5).map(id => ({ id, p: raw[id] }));
    return { id: chosen, pRaw: raw[chosen], pFinal: finalP, alts };
  }
  const bucket = p => (p >= 0.7 ? '' : p >= 0.4 ? 'b1' : p >= 0.15 ? 'b2' : 'b3');

  function tokenHTML(tk, step) {
    const s = GPT2.decode(tk.id);
    const body = esc(s).replace(/\n/g, '↵<br>');
    return `<span class="gt new ${bucket(tk.pRaw)}" data-step="${step}">${body}</span>`;
  }
  Site.bindTips(document.getElementById('cfgs'), '.gt', el => {
    const sm = el.closest('.sample'), tk = sm._tokens[+el.dataset.step];
    return `<b>${esc(JSON.stringify(GPT2.decode(tk.id)))}</b><br>Model's probability: <b>${pct(tk.pRaw)}</b><br>After your settings: ${pct(tk.pFinal)}<div style="margin-top:6px">${tk.alts.map(a =>
      `<div class="alt-row"><span class="mono">${esc(JSON.stringify(GPT2.decode(a.id)))}${a.id === tk.id ? ' ✓' : ''}</span><span style="width:${Math.max(2, a.p * 100).toFixed(0)}%"></span><span>${pct(a.p, 0)}</span></div>`).join('')}</div>`;
  });

  function metrics(card) {
    const samples = $$('.sample', card.el).map(s => s._tokens || []);
    const all = samples.flat();
    if (!all.length) return;
    $('.m-conf', card.el).textContent = pct(all.reduce((a, t) => a + t.pRaw, 0) / all.length, 0);
    let bi = 0; const uniq = new Set();
    samples.forEach(ts => { for (let i = 1; i < ts.length; i++) { bi++; uniq.add(ts[i - 1].id + ',' + ts[i].id); } });
    $('.m-div', card.el).textContent = bi ? pct(uniq.size / bi, 0) : '–';
    let loops = 0;
    samples.forEach(ts => { const seen = new Set(); for (let i = 2; i < ts.length; i++) { const k = ts[i - 2].id + ',' + ts[i - 1].id + ',' + ts[i].id; if (seen.has(k)) loops++; seen.add(k); } });
    $('.m-loop', card.el).textContent = loops;
  }

  async function run() {
    if (running) return;
    const prompt = $('#prompt').value;
    const pIds = GPT2.encode(prompt);
    if (!pIds.length) return;
    running = true; stopFlag = false; $('#run').disabled = true; $('#stop').disabled = false;
    const N = +$('#nSamp').value, maxNew = +$('#maxTok').value;
    const baseSeed = $('#fixSeed').checked ? (+$('#seed').value || 0) : Math.floor(Math.random() * 1e9);
    const jobs = [];
    cards.forEach((card, ci) => {
      const box = $('.samples', card.el); box.innerHTML = '';
      $$('.metrics b', card.el).forEach(b => (b.textContent = '–'));
      const cfg = card.get();
      for (let s = 0; s < N; s++) {
        const el = document.createElement('div'); el.className = 'sample';
        el.innerHTML = `<span class="prompt">${esc(prompt)}</span>`; el._tokens = [];
        box.appendChild(el);
        jobs.push({ card, cfg, el, ids: pIds.slice(), rng: mulberry32(baseSeed + 1000 * s + 7), done: false });
      }
    });
    try {
      for (let step = 0; step < maxNew && !stopFlag; step++) {
        for (const j of jobs) {
          if (j.done || stopFlag) continue;
          const logits = await GPT2.nextLogits(j.ids);
          const tk = decodeStep(logits, j.ids, j.cfg, j.rng);
          if (tk.id === EOS) { j.done = true; continue; }
          j.ids.push(tk.id); j.el._tokens.push(tk);
          j.el.insertAdjacentHTML('beforeend', tokenHTML(tk, j.el._tokens.length - 1));
        }
        cards.forEach(metrics);
      }
    } catch (e) {
      console.error(e);
      jobs[0].el.insertAdjacentHTML('beforeend', `<p style="color:var(--bad)">Generation failed: ${esc(e.message)}</p>`);
    }
    running = false; $('#run').disabled = false; $('#stop').disabled = true;
  }

  $('#run').addEventListener('click', run);
  $('#stop').addEventListener('click', () => (stopFlag = true));
  $('#prompt').addEventListener('keydown', e => { if (e.key === 'Enter') run(); });
  $('#examples').addEventListener('change', e => { $('#prompt').value = e.target.value; run(); });
  ['maxTok', 'nSamp'].forEach(id => $('#' + id).addEventListener('input', e => ($('#' + id + 'V').textContent = e.target.value)));

  Site.modelGate($('#gate'), {
    title: 'GPT-2', sizeMB: 128, autoKey: 'gpt2-loaded', isReady: GPT2.isReady,
    what: 'This page generates text with it, one token at a time.',
    loader: cb => GPT2.load(cb),
    onReady: () => { $('#lab').classList.remove('locked'); run(); }
  });
}
