import { GPT2 } from '@/lib/gpt2';
import { Site } from '@/lib/site';

/** Runs the page's interactive parts. Returns nothing; `life` undoes timers and listeners on unmount. */
export function mount(root, life) {
  const { $, $$, esc, pct } = Site;
  // [review, true label, kind]: half plain, half deliberately hard
  const DATA = [
    ['The staff were friendly and the room was spotless.', 'positive', 'plain'],
    ['Brilliant film, I laughed from start to finish.', 'positive', 'plain'],
    ['Fast delivery and the jacket fits perfectly.', 'positive', 'plain'],
    ['Best pizza I have had in years.', 'positive', 'plain'],
    ['The app is simple, quick and does exactly what I need.', 'positive', 'plain'],
    ['A gripping book that I could not put down.', 'positive', 'plain'],
    ['Great value for money, I would buy it again.', 'positive', 'plain'],
    ['The concert was amazing and the sound was perfect.', 'positive', 'plain'],
    ['Comfortable seats, a clean train, and it arrived on time.', 'positive', 'plain'],
    ['My new headphones sound fantastic.', 'positive', 'plain'],
    ['The teacher explained everything clearly and patiently.', 'positive', 'plain'],
    ['Lovely little café with excellent coffee.', 'positive', 'plain'],
    ['The hotel upgraded our room and the view was stunning.', 'positive', 'plain'],
    ['Setup took two minutes and it has worked flawlessly since.', 'positive', 'plain'],
    ['A beautiful garden, well worth the visit.', 'positive', 'plain'],
    ['The nurses looked after my mother wonderfully.', 'positive', 'plain'],
    ['Smooth check-in and a delicious breakfast.', 'positive', 'plain'],
    ['This blender makes perfect smoothies in seconds.', 'positive', 'plain'],
    ['The food was cold and the waiter was rude.', 'negative', 'plain'],
    ['It stopped working after a week.', 'negative', 'plain'],
    ['The room smelled of smoke and the bed was broken.', 'negative', 'plain'],
    ['Customer service hung up on me twice.', 'negative', 'plain'],
    ['The battery barely lasts an hour.', 'negative', 'plain'],
    ['A complete waste of money.', 'negative', 'plain'],
    ['The train was cancelled and nobody told us why.', 'negative', 'plain'],
    ['My parcel arrived damaged and two weeks late.', 'negative', 'plain'],
    ['The app crashes every time I open it.', 'negative', 'plain'],
    ['Overpriced, noisy and dirty.', 'negative', 'plain'],
    ['The instructions were useless and parts were missing.', 'negative', 'plain'],
    ['The sequel is a lazy copy of the first film.', 'negative', 'plain'],
    ['Not bad at all, I would happily go back.', 'positive', 'negation'],
    ['I was not disappointed for a second.', 'positive', 'negation'],
    ['Never had a better meal in this town.', 'positive', 'negation'],
    ["I can't fault the service.", 'positive', 'negation'],
    ['There was nothing I did not like about it.', 'positive', 'negation'],
    ['Not worth the money.', 'negative', 'negation'],
    ['I would not recommend this to anyone.', 'negative', 'negation'],
    ['The film was not as good as the reviews said.', 'negative', 'negation'],
    ['Nobody on the staff seemed to care.', 'negative', 'negation'],
    ["I can't say I enjoyed any of it.", 'negative', 'negation'],
    ['The start is slow, but the ending makes it all worthwhile.', 'positive', 'mixed'],
    ['A bit pricey, but the quality is superb.', 'positive', 'mixed'],
    ['The queue was long, yet the food was worth every minute.', 'positive', 'mixed'],
    ['Small screen, but the battery is incredible and I love it.', 'positive', 'mixed'],
    ['Not perfect, but easily the best phone I have owned.', 'positive', 'mixed'],
    ['Lovely staff, shame the room was filthy.', 'negative', 'mixed'],
    ['The screen is gorgeous, but it broke within a month.', 'negative', 'mixed'],
    ['Good idea, terrible execution.', 'negative', 'mixed'],
    ['The first half is fun, then it falls apart completely.', 'negative', 'mixed'],
    ['Nice design, but it is far too slow to use.', 'negative', 'mixed'],
    ['Oh great, another update that deletes all my settings.', 'negative', 'sarcasm'],
    ['Wow, only three hours on hold. Fantastic service.', 'negative', 'sarcasm'],
    ['I just love paying extra for a seat that does not recline.', 'negative', 'sarcasm'],
    ['What a treat, a hotel room with a view of the bins.', 'negative', 'sarcasm'],
    ['Brilliant, the charger broke on day one.', 'negative', 'sarcasm'],
    ['Five stars for the cold soup, truly a culinary adventure.', 'negative', 'sarcasm'],
    ['Thanks for the fast delivery, it only took a month.', 'negative', 'sarcasm'],
    ['Sure, everyone enjoys a phone that overheats in their pocket.', 'negative', 'sarcasm'],
    ['Terrible news: I now want to eat here every single day.', 'positive', 'sarcasm'],
    ['Warning: this book will ruin your sleep because you cannot stop reading.', 'positive', 'sarcasm']
  ];
  const ex = (r, l) => `Review: ${r}\nSentiment: ${l}\n\n`;
  const PROMPTS = {
    'Instruction only': 'Classify the sentiment of the review as positive or negative.\n\nReview: {review}\nSentiment:',
    'Few-shot prompt': ex('The worst purchase I have ever made.', 'negative') + ex('Absolutely fantastic, I would go again.', 'positive') + ex('Rude staff and dirty rooms.', 'negative') + ex('Great value and lovely design.', 'positive') + 'Review: {review}\nSentiment:'
  };
  const FIXES = { temp: 'Temperature scaling', ctx: 'Contextual calibration', both: 'Both, lean removed first' };
  const FILTERS = { all: 'All 60', wrong: 'Wrong only', plain: 'Plain', negation: 'Negation', mixed: 'Mixed', sarcasm: 'Sarcasm' };
  const S = { prompt: 'Instruction only', bins: '5', fix: 'both', src: 'cal', filter: 'all', fmt: 'Statement' };
  const results = {}; // prompt name -> { d: [log-odds per review], dcf, T: [even, odd], Tc: [even, odd] }
  let ready = false, busy = false;

  const sig = x => 1 / (1 + Math.exp(-x));
  async function labelProbs(prompt, labels) {
    // probability of each label (possibly several tokens) continuing `prompt`, as in the Prompting lab
    const base = GPT2.encode(prompt);
    const out = [];
    for (const lab of labels) {
      const ids = GPT2.encode(lab);
      let logp = 0, seq = base.slice();
      for (const id of ids) {
        const p = GPT2.softmax(await GPT2.nextLogits(seq), 1);
        logp += Math.log(Math.max(p[id], 1e-30)); seq.push(id);
      }
      out.push({ label: lab, ids, logp, p: Math.exp(logp) });
    }
    return out;
  }
  // log-odds of positive over negative; renormalising over the two labels gives sigmoid(d)
  async function logOdds(prompt) { const [pos, neg] = await labelProbs(prompt, [' positive', ' negative']); return pos.logp - neg.logp; }

  // temperature that minimises the log loss on a labelled subset, after an optional shift
  function fitT(idx, d, shift) {
    let best = 1, bestLoss = Infinity;
    for (let T = 0.05; T <= 20; T *= 1.02) {
      let loss = 0;
      idx.forEach(i => { const p = sig((d[i] - shift) / T); loss -= Math.log(Math.max(1e-12, DATA[i][1] === 'positive' ? p : 1 - p)); });
      if (loss < bestLoss) { bestLoss = loss; best = T; }
    }
    return best;
  }
  const EVEN = DATA.map((_, i) => i).filter(i => i % 2 === 0), ODD = DATA.map((_, i) => i).filter(i => i % 2 === 1);

  async function score(name) {
    if (results[name]) return results[name];
    const tpl = PROMPTS[name], d = [];
    $('#runBar').hidden = false;
    for (let i = 0; i < DATA.length; i++) {
      $('#runStatus').textContent = `Scoring review ${i + 1} of ${DATA.length} with the ${name.toLowerCase()}…`;
      $('#runBar i').style.width = (100 * i / DATA.length).toFixed(1) + '%';
      d.push(await logOdds(tpl.replace('{review}', DATA[i][0])));
    }
    const dcf = await logOdds(tpl.replace('{review}', 'N/A'));
    // two-fold cross-fitting: each half is corrected with a temperature learned on the other half
    const r = { d, dcf, T: [fitT(EVEN, d, 0), fitT(ODD, d, 0)], Tc: [fitT(EVEN, d, dcf), fitT(ODD, d, dcf)] };
    $('#runBar').hidden = true;
    results[name] = r;
    return r;
  }
  // rows with confidence under a given correction: 'raw' | 'temp' | 'ctx' | 'both'
  function rows(res, fix) {
    return DATA.map(([review, label, kind], i) => {
      const other = i % 2 === 0 ? 1 : 0; // index of the half that did NOT include this review
      const z = fix === 'temp' ? res.d[i] / res.T[other] : fix === 'ctx' ? res.d[i] - res.dcf : fix === 'both' ? (res.d[i] - res.dcf) / res.Tc[other] : res.d[i];
      const p = sig(z), pred = p >= 0.5 ? 'positive' : 'negative';
      return { i, review, label, kind, p, pred, conf: Math.max(p, 1 - p), ok: pred === label };
    });
  }
  function calib(rs, nb) {
    const w = 0.5 / nb;
    const bins = Array.from({ length: nb }, (_, b) => ({ lo: 0.5 + b * w, hi: 0.5 + (b + 1) * w, n: 0, right: 0, sum: 0 }));
    rs.forEach(r => { const b = bins[Math.min(nb - 1, Math.floor((r.conf - 0.5) / w + 1e-9))]; b.n++; b.right += r.ok; b.sum += r.conf; });
    let ece = 0;
    bins.forEach(b => { if (!b.n) return; b.acc = b.right / b.n; b.conf = b.sum / b.n; ece += b.n / rs.length * Math.abs(b.acc - b.conf); });
    return { bins, ece };
  }
  const mean = (a, f) => a.reduce((s, x) => s + f(x), 0) / (a.length || 1);

  // ---------- charts ----------
  function drawRel(svg, rs, nb) {
    const { bins, ece } = calib(rs, nb);
    const W = 560, H = 320, l = 48, r = 14, t = 16, b = 46, pw = W - l - r, ph = H - t - b;
    const x = c => l + (c - 0.5) / 0.5 * pw, y = a => t + ph - a * ph;
    let s = '';
    [0, 0.25, 0.5, 0.75, 1].forEach(a => (s += `<line x1="${l}" x2="${W - r}" y1="${y(a)}" y2="${y(a)}" stroke="var(--line)"></line><text x="${l - 6}" y="${y(a) + 4}" text-anchor="end">${a * 100}%</text>`));
    for (let k = 0; k <= 5; k++) s += `<text x="${x(0.5 + k * 0.1)}" y="${t + ph + 16}" text-anchor="middle">${50 + k * 10}%</text>`;
    s += `<text class="ax" x="${l + pw / 2}" y="${H - 8}" text-anchor="middle">Confidence of the predicted label</text>`;
    s += `<text class="ax" transform="translate(13 ${t + ph / 2}) rotate(-90)" text-anchor="middle">Accuracy</text>`;
    bins.forEach((bn, k) => {
      s += `<rect class="hov" data-b="${k}" x="${x(bn.lo)}" y="${t}" width="${x(bn.hi) - x(bn.lo)}" height="${ph}"></rect>`;
      if (!bn.n) return;
      const x0 = x(bn.lo) + 3, bw = Math.max(2, x(bn.hi) - x(bn.lo) - 6), h = Math.max(1.5, y(0) - y(bn.acc));
      s += `<rect x="${x0}" y="${y(0) - h}" width="${bw}" height="${h}" rx="2" fill="var(--s1)" pointer-events="none"></rect>`;
      s += h >= 20 ? `<text x="${x0 + bw / 2}" y="${y(0) - h + 14}" text-anchor="middle" style="fill:#fff" pointer-events="none">${bn.n}</text>`
        : `<text x="${x0 + bw / 2}" y="${y(0) - h - 4}" text-anchor="middle" pointer-events="none">${bn.n}</text>`;
    });
    s += `<line x1="${x(0.5)}" y1="${y(0.5)}" x2="${x(1)}" y2="${y(1)}" stroke="var(--ink2)" stroke-width="1.5" stroke-dasharray="5 4" pointer-events="none"></line>`;
    svg.innerHTML = s;
    svg._bins = bins;
    return { bins, ece };
  }
  const relTip = el => {
    const bn = el.closest('svg')._bins[+el.dataset.b];
    const range = `${Math.round(bn.lo * 100)} to ${Math.round(bn.hi * 100)}%`;
    if (!bn.n) return `<b>Confidence ${range}</b><br>No reviews in this bin`;
    const gap = bn.acc - bn.conf;
    return `<b>Confidence ${range}</b><br>${bn.n} review${bn.n > 1 ? 's' : ''}<br>Average confidence ${pct(bn.conf, 0)}<br>Accuracy ${pct(bn.acc, 0)}, ${bn.right} of ${bn.n} right<br>${Math.abs(gap) < 0.005 ? 'On the diagonal' : `${Math.abs(gap * 100).toFixed(0)} points ${gap > 0 ? 'above' : 'below'} the diagonal`}`;
  };
  ['#relChart', '#relBefore', '#relAfter'].forEach(id => Site.bindTips($(id), '.hov', relTip));

  function drawCov(rs, th) {
    const svg = $('#covChart'), N = rs.length;
    const sorted = rs.slice().sort((a, b) => b.conf - a.conf);
    let right = 0;
    const pts = sorted.map((r, k) => { right += r.ok; return { cov: (k + 1) / N, acc: right / (k + 1), conf: r.conf, n: k + 1, right }; });
    const W = 560, H = 280, l = 48, rgt = 14, t = 14, b = 46, pw = W - l - rgt, ph = H - t - b;
    // the y axis starts just below the lowest accuracy on the curve, so its shape is readable
    const minAcc = Math.min(...pts.map(p => p.acc)), step = minAcc >= 0.5 ? 0.1 : 0.25;
    const lo = Math.max(0, Math.floor(minAcc / step - 1e-9) * step);
    const x = c => l + c * pw, y = a => t + ph - (a - lo) / (1 - lo) * ph;
    let s = '';
    for (let a = lo; a <= 1.0001; a += step) s += `<line x1="${l}" x2="${W - rgt}" y1="${y(a)}" y2="${y(a)}" stroke="var(--line)"></line><text x="${l - 6}" y="${y(a) + 4}" text-anchor="end">${Math.round(a * 100)}%</text>`;
    [0, 0.25, 0.5, 0.75, 1].forEach(c => (s += `<text x="${x(c)}" y="${t + ph + 16}" text-anchor="middle">${c * 100}%</text>`));
    s += `<text class="ax" x="${l + pw / 2}" y="${H - 8}" text-anchor="middle">Coverage: share answered automatically</text>`;
    s += `<text class="ax" transform="translate(13 ${t + ph / 2}) rotate(-90)" text-anchor="middle">Accuracy</text>`;
    const all = pts[N - 1].acc;
    s += `<line x1="${x(0)}" x2="${x(1)}" y1="${y(all)}" y2="${y(all)}" stroke="var(--faint)" stroke-width="1.5" stroke-dasharray="5 4"></line>`;
    s += `<path d="M${pts.map(p => `${x(p.cov).toFixed(1)} ${y(p.acc).toFixed(1)}`).join(' L')}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round"></path>`;
    pts.forEach((p, k) => (s += `<rect class="hov" data-k="${k}" x="${x(k / N)}" y="${t}" width="${pw / N}" height="${ph}"></rect>`));
    const kept = rs.filter(r => r.conf >= th);
    if (kept.length) {
      const cov = kept.length / N, acc = kept.filter(r => r.ok).length / kept.length;
      s += `<line x1="${x(cov)}" x2="${x(cov)}" y1="${t}" y2="${t + ph}" stroke="var(--ink2)" stroke-dasharray="2 3" pointer-events="none"></line>`;
      s += `<circle cx="${x(cov)}" cy="${y(acc)}" r="5.5" fill="var(--ink)" stroke="var(--surface)" stroke-width="2" pointer-events="none"></circle>`;
    }
    svg.innerHTML = s;
    svg._pts = pts;
  }
  Site.bindTips($('#covChart'), '.hov', el => {
    const p = $('#covChart')._pts[+el.dataset.k];
    return `<b>Answer the ${p.n} most confident</b><br>Coverage ${pct(p.cov, 0)}<br>Accuracy ${pct(p.acc, 0)}, ${p.right} of ${p.n} right<br>Needs a threshold of ${p.conf.toFixed(2)}`;
  });

  // ---------- rendering ----------
  function renderAll() {
    const res = results[S.prompt]; if (!res) return;
    const raw = rows(res, 'raw');
    const nb = +S.bins, c = calib(raw, nb), acc = mean(raw, r => r.ok), conf = mean(raw, r => r.conf);
    $('#sAcc').textContent = pct(acc, 0);
    $('#sConf').textContent = pct(conf, 0);
    $('#sEce').textContent = c.ece.toFixed(3);
    $('#sPos').textContent = `${raw.filter(r => r.pred === 'positive').length} / 60`;
    renderTable(raw);
    drawRel($('#relChart'), raw, nb);
    $('#eceLine').innerHTML = `<b>Expected Calibration Error: ${c.ece.toFixed(3)}.</b> It is the gap between confidence and accuracy in each bin, averaged with each bin weighted by its number of reviews. Zero means perfectly calibrated.`;
    const gap = acc - conf;
    $('#verdict').innerHTML = gap > 0.05
      ? `<b>Underconfident.</b> GPT-2 is right ${pct(acc, 0)} of the time but its average confidence is only ${pct(conf, 0)}. A rule such as "send anything below 80% to a person" would send ${raw.filter(r => r.conf < 0.8).length} of 60 reviews to people, even though most of its answers are right.`
      : gap < -0.05
        ? `<b>Overconfident.</b> GPT-2's average confidence is ${pct(conf, 0)} but it is right only ${pct(acc, 0)} of the time. It says positive for ${raw.filter(r => r.pred === 'positive').length} of 60 reviews, so its confidence mostly reflects a lean towards one label, not knowledge of the review.`
        : `<b>Roughly calibrated on average.</b> Average confidence ${pct(conf, 0)} is close to accuracy ${pct(acc, 0)}. Check the bars too: the average can hide gaps in single bins.`;
    renderFix(res, raw);
    renderCov();
  }
  function renderTable(raw) {
    const keep = r => (S.filter === 'all' ? true : S.filter === 'wrong' ? !r.ok : r.kind === S.filter);
    const list = raw.filter(keep);
    $('#revTable tbody').innerHTML = list.length ? list.map(r => `<tr><td>${esc(r.review)}</td><td><span class="kind">${r.kind}</span></td><td>${r.label}</td>
      <td><span class="${r.ok ? 'ok' : 'no'}">${r.ok ? '✓' : '✗'}</span> ${r.pred}</td>
      <td style="white-space:nowrap"><span class="cbar"><i style="width:${((r.conf - 0.5) * 200).toFixed(1)}%"></i></span>${pct(r.conf, 0)}</td></tr>`).join('')
      : '<tr><td colspan="5" class="muted">No reviews match this filter.</td></tr>';
  }
  function renderFix(res, raw) {
    const after = rows(res, S.fix);
    const nb = +S.bins, c0 = drawRel($('#relBefore'), raw, nb), c1 = drawRel($('#relAfter'), after, nb);
    $('#afterTitle').textContent = `After: ${FIXES[S.fix].toLowerCase()}`;
    $('#fEce0').textContent = c0.ece.toFixed(3);
    $('#fEce1').textContent = c1.ece.toFixed(3);
    $('#fAcc0').textContent = pct(mean(raw, r => r.ok), 0);
    $('#fAcc1').textContent = pct(mean(after, r => r.ok), 0);
    const pf = Math.exp(res.dcf) / (1 + Math.exp(res.dcf));
    const temps = S.fix === 'both' ? res.Tc : res.T;
    const tInfo = `To keep the test fair, the temperature is fitted on the odd-numbered reviews and applied to the even-numbered ones, then the other way round. No review helps fit its own correction. Fitted temperatures: ${temps[0].toFixed(2)} and ${temps[1].toFixed(2)}.`;
    const cInfo = `For "N/A", GPT-2 gives positive ${pct(pf, 0)} and negative ${pct(1 - pf, 0)}, so every review is shifted by that lean.`;
    $('#fitInfo').textContent = S.fix === 'temp' ? tInfo : S.fix === 'ctx' ? cInfo : `${cInfo} ${tInfo}`;
  }
  function renderCov() {
    const res = results[S.prompt]; if (!res) return;
    const th = +$('#th').value;
    $('#vTh').textContent = th.toFixed(2);
    const rs = rows(res, S.src === 'cal' ? S.fix : 'raw');
    const kept = rs.filter(r => r.conf >= th), right = kept.filter(r => r.ok).length, wrong = kept.length - right;
    const caught = rs.filter(r => r.conf < th && !r.ok).length;
    $('#cCov').textContent = pct(kept.length / rs.length, 0);
    $('#cAcc').textContent = kept.length ? pct(right / kept.length, 0) : '–';
    $('#cErr').textContent = `${wrong}`;
    $('#cHum').textContent = `${rs.length - kept.length}`;
    drawCov(rs, th);
    const allWrong = rs.filter(r => !r.ok).length;
    $('#covText').textContent = kept.length
      ? `At ${th.toFixed(2)}, the model answers ${kept.length} of 60 reviews and gets ${right} right. ${wrong} of its ${allWrong} errors slip through, and a person checks ${rs.length - kept.length} reviews, catching the other ${caught}.`
      : `At ${th.toFixed(2)}, no review is confident enough, so a person checks all 60. Lower the threshold to automate some of the work.`;
  }

  // ---------- factual recall ----------
  const CAPS = [['France', 'Paris'], ['Germany', 'Berlin'], ['Italy', 'Rome'], ['Spain', 'Madrid'], ['Japan', 'Tokyo'], ['China', 'Beijing'], ['Egypt', 'Cairo'], ['Canada', 'Ottawa'], ['Australia', 'Canberra'], ['Brazil', 'Brasília'], ['Turkey', 'Ankara'], ['Nigeria', 'Abuja'], ['Poland', 'Warsaw'], ['Argentina', 'Buenos Aires'], ['Switzerland', 'Bern']];
  const FORMATS = {
    'Statement': c => `The capital of Greece is Athens.\nThe capital of England is London.\nThe capital of ${c} is`,
    'Question and answer': c => `Q: What is the capital of Greece?\nA: Athens\n\nQ: What is the capital of England?\nA: London\n\nQ: What is the capital of ${c}?\nA:`
  };
  const capResults = {};
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  async function greedy(prompt, maxTok = 5) {
    let seq = GPT2.encode(prompt), logp = 0; const out = [];
    for (let k = 0; k < maxTok; k++) {
      const p = GPT2.softmax(await GPT2.nextLogits(seq), 1);
      let best = 0; for (let j = 1; j < p.length; j++) if (p[j] > p[best]) best = j;
      if (out.length && /[.,\n]/.test(GPT2.decode(best))) break;
      out.push(best); logp += Math.log(p[best]); seq = seq.concat(best);
    }
    return { text: GPT2.decodeMany(out).trim(), p: Math.exp(logp) };
  }
  async function runCaps(fmt) {
    if (!capResults[fmt]) {
      const out = [];
      for (let i = 0; i < CAPS.length; i++) {
        const [country, cap] = CAPS[i];
        $('#runStatus').textContent = `Asking for the capital of ${country}, ${i + 1} of ${CAPS.length}…`;
        const prompt = FORMATS[fmt](country);
        const g = await greedy(prompt);
        const ok = norm(g.text) === norm(cap);
        const pRight = ok ? g.p : (await labelProbs(prompt, [' ' + norm(cap).replace(/\b\w/g, m => m.toUpperCase())]))[0].p;
        out.push({ country, cap, answer: g.text, p: g.p, ok, pRight });
      }
      capResults[fmt] = out;
    }
    renderCaps();
  }
  function renderCaps() {
    const rs = capResults[S.fmt]; if (!rs) return;
    $('#capPrompt').textContent = FORMATS[S.fmt]('Canada');
    const right = rs.filter(r => r.ok), wrong = rs.filter(r => !r.ok);
    $('#kRight').textContent = `${right.length} / ${rs.length}`;
    $('#kPR').textContent = right.length ? pct(mean(right, r => r.p), 0) : '–';
    $('#kPW').textContent = wrong.length ? pct(mean(wrong, r => r.p), 0) : '–';
    const top = wrong.slice().sort((a, b) => b.p - a.p)[0];
    $('#kTop').textContent = top ? `${top.answer || '?'}, ${pct(top.p, 0)}` : 'none';
    $('#capTable tbody').innerHTML = rs.map(r => `<tr><td>${esc(r.country)}</td><td><span class="${r.ok ? 'ok' : 'no'}">${r.ok ? '✓' : '✗'}</span> ${esc(r.answer || 'no answer')}</td>
      <td style="white-space:nowrap"><span class="cbar"><i style="width:${(r.p * 100).toFixed(1)}%;background:${r.ok ? 'var(--s1)' : 'var(--s2)'}"></i></span>${pct(r.p, 0)}</td>
      <td>${esc(r.cap)}</td><td class="num">${pct(r.pRight, r.pRight < 0.01 ? 2 : 0)}</td></tr>`).join('');
    // strip chart: probability of each answer, one row for right and one for wrong
    const W = 560, H = 120, l = 62, rgt = 14, pw = W - l - rgt, rowsY = { right: 30, wrong: 66 };
    const x = p => l + p * pw;
    let s = '';
    [0, 0.25, 0.5, 0.75, 1].forEach(p => (s += `<line x1="${x(p)}" x2="${x(p)}" y1="12" y2="84" stroke="var(--line)"></line><text x="${x(p)}" y="100" text-anchor="middle">${p * 100}%</text>`));
    s += `<text class="ax" x="${l - 8}" y="${rowsY.right + 4}" text-anchor="end">Right</text><text class="ax" x="${l - 8}" y="${rowsY.wrong + 4}" text-anchor="end">Wrong</text>`;
    s += `<text class="ax" x="${l + pw / 2}" y="${H - 4}" text-anchor="middle">Probability GPT-2 gave its own answer</text>`;
    rs.forEach((r, i) => (s += `<circle class="cap" data-i="${i}" cx="${x(r.p).toFixed(1)}" cy="${r.ok ? rowsY.right : rowsY.wrong}" r="6.5" fill="${r.ok ? 'var(--s1)' : 'var(--s2)'}" fill-opacity=".85" stroke="var(--surface)" stroke-width="1.5"></circle>`));
    $('#capChart').innerHTML = s;
  }
  Site.bindTips($('#capChart'), '.cap', el => {
    const r = capResults[S.fmt][+el.dataset.i];
    return `<b>${esc(r.country)}</b><br>GPT-2 says ${esc(r.answer || 'nothing')}, ${pct(r.p, 0)}<br>${r.ok ? 'Right' : `Wrong: the capital is ${esc(r.cap)}, which got ${pct(r.pRight, 1)}`}`;
  });

  // ---------- controls ----------
  function chips(mount, options, key, onPick) {
    Object.entries(options).forEach(([value, label]) => {
      const b = document.createElement('button');
      b.className = 'chip-btn' + (String(S[key]) === value ? ' on' : ''); b.textContent = label; b.dataset.v = value;
      b.addEventListener('click', () => {
        if (busy && (key === 'prompt' || key === 'fmt')) return;
        S[key] = value;
        $$('.chip-btn', mount).forEach(x => x.classList.toggle('on', x === b));
        onPick();
      });
      mount.appendChild(b);
    });
  }
  const setBusy = v => { busy = v; $$('#promptChips .chip-btn, #fmtChips .chip-btn').forEach(b => (b.disabled = v)); };
  async function run(task) {
    setBusy(true);
    try { await task(); $('#runStatus').textContent = ''; }
    catch (e) { console.error(e); $('#runStatus').textContent = 'Something went wrong: ' + (e.message || e); }
    setBusy(false);
  }
  const showPrompt = () => ($('#tplText').textContent = PROMPTS[S.prompt]);
  chips($('#promptChips'), Object.fromEntries(Object.keys(PROMPTS).map(k => [k, k])), 'prompt', () => { showPrompt(); if (ready) run(async () => { await score(S.prompt); renderAll(); }); });
  chips($('#binChips'), { 5: '5 bins', 10: '10 bins' }, 'bins', renderAll);
  chips($('#fixChips'), FIXES, 'fix', () => { const res = results[S.prompt]; if (res) { renderFix(res, rows(res, 'raw')); renderCov(); } });
  chips($('#srcChips'), { raw: 'Raw', cal: 'After the fix above' }, 'src', renderCov);
  chips($('#filterChips'), FILTERS, 'filter', () => { const res = results[S.prompt]; if (res) renderTable(rows(res, 'raw')); });
  chips($('#fmtChips'), Object.fromEntries(Object.keys(FORMATS).map(k => [k, k])), 'fmt', () => { $('#capPrompt').textContent = FORMATS[S.fmt]('Canada'); if (ready) run(() => runCaps(S.fmt)); });
  $('#th').addEventListener('input', renderCov);
  showPrompt();
  $('#capPrompt').textContent = FORMATS[S.fmt]('Canada');
  $('#vTh').textContent = (+$('#th').value).toFixed(2);

  Site.modelGate($('#gate'), {
    title: 'GPT-2', sizeMB: 128, autoKey: 'gpt2-loaded', isReady: GPT2.isReady,
    what: 'This page reads its next-token probabilities to measure how confident it is.',
    loader: cb => GPT2.load(cb),
    onReady: () => {
      ready = true; $('#lab').classList.remove('locked');
      run(async () => { await score(S.prompt); renderAll(); await runCaps(S.fmt); });
    }
  });
}
