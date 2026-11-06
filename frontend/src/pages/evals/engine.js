import { GPT2 } from '@/lib/gpt2';
import { messagesService, statusService } from '@/services';
import { Site } from '@/lib/site';

/** Runs the page's interactive parts. Returns nothing; `life` undoes timers and listeners on unmount. */
export function mount(root, life) {
  const { requestAnimationFrame } = life;  // stopped when you leave the page
  const { $, esc, pct } = Site;
  const RESAMPLES = 2000;
  const LABELS = [' positive', ' negative'];
  const COLOR = { A: 'var(--s1)', B: 'var(--s2)', D: 'var(--s3)' };
  const KIND_ORDER = ['plain', 'sarcasm', 'negation', 'mixed'];
  const MINUS = '−';
  const p0 = v => pct(v, 0), p1 = v => pct(v, 1);
  const pts = (v, d = 1) => { const r = Math.abs(v * 100).toFixed(d); return +r === 0 ? '0' : (v > 0 ? '+' : MINUS) + r; };
  const kindPill = k => `<span class="kind${k === 'plain' ? '' : ' hard'}">${esc(k)}</span>`;
  const mark = ok => `<span class="${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'}</span>`;

  // ---------- 1. the labelled test set ----------
  const BUILTIN = [
    ['The staff were warm and the room was spotless.', 'positive', 'plain'],
    ['It stopped charging after a week.', 'negative', 'plain'],
    ['Not bad at all.', 'positive', 'negation'],
    ['Oh great, another update that deletes all my settings.', 'negative', 'sarcasm'],
    ['Fast delivery and the fit is perfect.', 'positive', 'plain'],
    ['The screen is gorgeous, but the battery died in a week and I sent it back.', 'negative', 'mixed'],
    ['Cold chips and a rude waiter.', 'negative', 'plain'],
    ['Best pizza I have had in years.', 'positive', 'plain'],
    ["I can't say I enjoyed a single minute.", 'negative', 'negation'],
    ['Slow to start, but by the end I was in tears. Wonderful.', 'positive', 'mixed'],
    ['The app crashes every time I open the camera.', 'negative', 'plain'],
    ['The app is simple, quick and does exactly what I need.', 'positive', 'plain'],
    ['Wow, only two hours on hold. Truly outstanding service.', 'negative', 'sarcasm'],
    ['Dull characters and a plot that goes nowhere.', 'negative', 'plain'],
    ['A gripping thriller with a brilliant twist.', 'positive', 'plain'],
    ['Never had a better meal in this town.', 'positive', 'negation'],
    ['The zip broke on the first day.', 'negative', 'plain'],
    ['The food was great but the service was so bad we will not return.', 'negative', 'mixed'],
    ['Comfortable shoes that look great with everything.', 'positive', 'plain'],
    ['We waited ninety minutes and nobody apologised.', 'negative', 'plain'],
    ['I just love paying extra for a seat that does not recline.', 'negative', 'sarcasm'],
    ['The teacher explained everything clearly and patiently.', 'positive', 'plain'],
    ['Not worth the money.', 'negative', 'negation'],
    ['Overpriced, noisy and badly organised.', 'negative', 'plain'],
    ['A bit pricey, but honestly worth every penny.', 'positive', 'mixed'],
    ['Lovely views, friendly locals, we will be back.', 'positive', 'plain'],
    ['The instructions were useless and two screws were missing.', 'negative', 'plain'],
    ['This book ruined my weekend. I could not put it down.', 'positive', 'sarcasm'],
    ['Setup took five minutes and it has worked flawlessly since.', 'positive', 'plain'],
    ['The sound is tinny and the volume is weak.', 'negative', 'plain'],
    ['No complaints whatsoever.', 'positive', 'negation'],
    ['Lovely staff, shame about the filthy bathroom and the noise.', 'negative', 'mixed'],
    ['The soup was rich and full of flavour.', 'positive', 'plain'],
    ['The paint started peeling within a month.', 'negative', 'plain'],
    ['Fantastic, the new charger melted on day one.', 'negative', 'sarcasm'],
    ['Great sound quality for the price.', 'positive', 'plain'],
    ['Support closed my ticket without fixing anything.', 'negative', 'plain'],
    ['It was not good, and not cheap either.', 'negative', 'negation'],
    ['Our guide was funny and knew so much.', 'positive', 'plain'],
    ['The first half drags, yet the ending makes it all worthwhile.', 'positive', 'mixed'],
    ['The hotel looked nothing like the photos.', 'negative', 'plain'],
    ['The coat is warm, light and beautifully made.', 'positive', 'plain'],
    ['What a treat, the lift was broken again and we live on the ninth floor.', 'negative', 'sarcasm'],
    ['My order arrived late and the box was crushed.', 'negative', 'plain'],
    ['Customer service sorted my problem in one call.', 'positive', 'plain'],
    ['I did not expect to like it this much.', 'positive', 'negation'],
    ['Far too salty and the portion was tiny.', 'negative', 'plain'],
    ['A charming film that the whole family enjoyed.', 'positive', 'plain'],
    ['The box was dented, but the vase inside was perfect and it is beautiful.', 'positive', 'mixed'],
    ['The update made my laptop painfully slow.', 'negative', 'plain'],
    ['The battery easily lasts two days.', 'positive', 'plain'],
    ['Uncomfortable seats and the screen kept freezing.', 'negative', 'plain'],
    ['Clean trains and they ran on time.', 'positive', 'plain'],
    ['A boring lecture that could have been an email.', 'negative', 'plain'],
    ['Delicious coffee and a cosy atmosphere.', 'positive', 'plain'],
    ['The headphones hurt my ears after ten minutes.', 'negative', 'plain'],
    ['The kids loved it and so did we.', 'positive', 'plain'],
    ['Brilliant value, I have already ordered another.', 'positive', 'plain'],
    ['The nurse was kind and made me feel at ease.', 'positive', 'plain'],
    ['The room smelled of smoke and the sheets were stained.', 'negative', 'plain']
  ];
  const MIN_CASES = 4;
  let data = [], nextId = 1;
  function resetData() { data = BUILTIN.map(([text, label, kind]) => ({ id: nextId++, text, label, kind })); }

  function renderData() {
    const pos = data.filter(d => d.label === 'positive').length;
    $('#dN').textContent = data.length;
    $('#dPos').textContent = pos;
    $('#dNeg').textContent = data.length - pos;
    $('#dHard').textContent = data.filter(d => d.kind !== 'plain').length;
    const canRemove = data.length > MIN_CASES;
    $('#dataTable tbody').innerHTML = data.map((d, i) => `<tr><td class="num">${i + 1}</td><td>${esc(d.text)}</td><td>${d.label}</td><td>${kindPill(d.kind)}</td>
      <td><button class="x" data-id="${d.id}" aria-label="Remove case ${i + 1}" title="Remove this case"${canRemove ? '' : ' disabled'}>×</button></td></tr>`).join('');
  }
  function dataChanged() { renderData(); if (ready) scoreAll(); }
  $('#dataTable').addEventListener('click', e => {
    const b = e.target.closest('.x'); if (!b || data.length <= MIN_CASES) return;
    data = data.filter(d => d.id !== +b.dataset.id); dataChanged();
  });
  function addCase() {
    const text = $('#newText').value.trim().slice(0, 300);
    if (!text) { $('#newText').focus(); return; }
    data.push({ id: nextId++, text, label: $('#newLabel').value, kind: $('#newKind').value });
    $('#newText').value = ''; dataChanged();
    const wrap = $('#dataTable').closest('.scroll'); wrap.scrollTop = wrap.scrollHeight;
  }
  $('#addCase').addEventListener('click', addCase);
  $('#newText').addEventListener('keydown', e => { if (e.key === 'Enter') addCase(); });
  $('#resetData').addEventListener('click', () => { resetData(); dataChanged(); });

  // ---------- 2a. exact match ----------
  const EM = ['positive', ' Positive', 'positive.', 'POSITIVE\n', 'Positive!', 'It is positive.', 'pos', 'negative'];
  const norm = s => s.trim().toLowerCase().replace(/[.!?,;:]+$/, '').trim();
  $('#emTable tbody').innerHTML = EM.map(o => `<tr><td class="mono">${esc(JSON.stringify(o))}</td><td>${mark(o === 'positive')}</td><td>${mark(norm(o) === 'positive')}</td></tr>`).join('');
  function emTry() {
    const o = $('#emTry').value;
    $('#emTryOut').innerHTML = `Strict: ${mark(o === 'positive')} ${o === 'positive' ? 'pass' : 'fail'} · Normalised to <span class="mono">${esc(JSON.stringify(norm(o)))}</span>: ${mark(norm(o) === 'positive')} ${norm(o) === 'positive' ? 'pass' : 'fail'}`;
  }
  $('#emTry').addEventListener('input', emTry); emTry();

  // ---------- 2b. code-based rubric ----------
  const TICKET = 'Order 4471. A customer bought a standing desk on 3 March. It arrived on 10 March with a cracked leg, and she has sent photos. She wants a replacement, not a refund, and needs it before 24 March because she starts working from home that day. Her email is j.doe@example.com.';
  const CANDS = [
    { text: 'Standing desk arrived with a cracked leg. The customer wants a replacement, not a refund, before 24 March.', human: true },
    { text: 'The customer is unhappy with her order and wants it sorted out quickly.', human: false },
    { text: 'The customer, who can be reached at j.doe@example.com, ordered a standing desk on 3 March, and when it was finally delivered on 10 March she found that one of its legs was cracked, which she has documented with photos, so she is now asking for a replacement rather than a refund and needs it before 24 March.', human: false },
    { text: 'Desk delivered with a broken leg. The customer is asking for a refund.', human: false },
    { text: 'The desk is not cracked and the customer does not want a replacement. There is no deadline of 24 March.', human: false },
    { text: 'Replacement needed by the 24th for a desk that arrived with a split leg. Photos supplied.', human: true }
  ];
  const words = s => (s.trim() ? s.trim().split(/\s+/).length : 0);
  const CRITERIA = [
    { name: 'Names the product', rule: 'desk', test: s => /\bdesks?\b/i.test(s) },
    { name: 'Says how it was damaged', rule: 'crack, broken, damaged or split', test: s => /crack|broken|damaged|split/i.test(s) },
    { name: 'Wants a replacement', rule: 'replace', test: s => /replace/i.test(s) },
    { name: 'Gives the deadline', rule: '24 March', test: s => /\b24(th)?\s+march\b|\bmarch\s+24/i.test(s) },
    { name: '40 words or fewer', rule: 'word count', test: s => words(s) <= 40 },
    { name: 'No email address', rule: 'no name@domain', test: s => !/[\w.+-]+@[\w-]+(\.[\w-]+)+/.test(s) }
  ];
  const mine = () => $('#mySummary').value.trim();
  const textOf = i => (i < CANDS.length ? CANDS[i].text : mine());
  const labelOf = i => (i < CANDS.length ? `Summary ${i + 1}` : 'Your summary');
  const judged = {};  // index -> { score, reason, pass }
  $('#ticket').innerHTML = `<b>Ticket.</b> ${esc(TICKET)}`;

  function renderRubric() {
    const rows = CANDS.map((c, i) => ({ i, text: c.text, human: c.human }));
    if (mine()) rows.push({ i: CANDS.length, text: mine(), human: null });
    let agree = 0, jAgree = 0, jCount = 0;
    const body = rows.map(r => {
      const res = CRITERIA.map(c => c.test(r.text));
      const pass = res.every(Boolean);
      if (r.human !== null && pass === r.human) agree++;
      const j = judged[r.i] && judged[r.i].text === r.text ? judged[r.i] : null;
      if (j && r.human !== null) { jCount++; if (j.pass === r.human) jAgree++; }
      const wc = words(r.text);
      return `<tr><td><b>${r.i < CANDS.length ? r.i + 1 + '.' : 'Yours.'}</b> ${esc(r.text)}</td>
        ${res.map((ok, k) => `<td class="c">${mark(ok)}${k === 4 ? `<span class="crit">${wc}</span>` : ''}</td>`).join('')}
        <td class="c">${mark(pass)} ${pass ? 'pass' : 'fail'}</td>
        <td class="c">${r.human === null ? '<span class="muted">you decide</span>' : r.human ? 'pass' : 'fail'}</td>
        <td class="c">${j ? `${j.score} · ${j.pass ? 'pass' : 'fail'}` : '<span class="muted">–</span>'}</td></tr>`;
    }).join('');
    $('#rubricTable').innerHTML = `<thead><tr><th>Summary</th>${CRITERIA.map(c => `<th class="c">${c.name}<span class="crit">${esc(c.rule)}</span></th>`).join('')}<th class="c">Code grader</th><th class="c">Person</th><th class="c">LLM judge</th></tr></thead><tbody>${body}</tbody>`;
    $('#rubricAgree').innerHTML = `The code grader agrees with the person on <b>${agree} of ${CANDS.length}</b> summaries.` +
      (jCount ? ` The LLM judge agrees on <b>${jAgree} of ${jCount}</b> judged so far.` : ' Judge them with live Claude to compare the LLM judge.');
  }

  // ---------- 2c. LLM as judge ----------
  const RUBRIC = '<rubric>\n1. Names the product and says how it was damaged.\n2. Says the customer wants a replacement, not a refund.\n3. Gives the deadline of 24 March.\n4. Uses 40 words or fewer.\n5. Leaves out the customer\'s email address.\n6. Says nothing the ticket does not support.\n</rubric>';
  const JUDGE_SYSTEM = 'You grade summaries of customer support tickets against a rubric. Judge only what the rubric asks. Do not reward length or style.';
  const judgeUser = s => `<ticket>\n${TICKET}\n</ticket>\n\n<summary>\n${s}\n</summary>\n\n${RUBRIC}\n\nGive a one-sentence reason, then a score from 1 to 5. 5 means every rubric point is met. 3 means one point is missed. 1 means the summary is wrong or misleading.`;
  const pairUser = (a, b) => `<ticket>\n${TICKET}\n</ticket>\n\n<summary_1>\n${a}\n</summary_1>\n\n<summary_2>\n${b}\n</summary_2>\n\n${RUBRIC}\n\nWhich summary meets the rubric better? Give a one-sentence reason, then answer 1 or 2.`;
  const SCORE_SCHEMA = { type: 'object', properties: { reason: { type: 'string' }, score: { type: 'integer', enum: [1, 2, 3, 4, 5] } }, required: ['reason', 'score'], additionalProperties: false };
  const PAIR_SCHEMA = { type: 'object', properties: { reason: { type: 'string' }, better: { type: 'integer', enum: [1, 2] } }, required: ['reason', 'better'], additionalProperties: false };
  const judgeBody = (user, schema) => ({ max_tokens: 4096, system: JUDGE_SYSTEM, messages: [{ role: 'user', content: user }], output_config: { effort: 'low', format: { type: 'json_schema', schema } } });

  const tagged = s => esc(s).replace(/&lt;\/?[a-z_0-9]+&gt;/g, m => `<span class="tag">${m}</span>`);
  function renderJudgePrompt() {
    const i = +$('#jPick').value;
    $('#jPrompt').innerHTML = `<span class="role">system</span>\n${esc(JUDGE_SYSTEM)}\n\n<span class="role">user</span>\n${tagged(judgeUser(textOf(i)))}\n\n<span class="role">output_config.format.schema</span>\n${esc(JSON.stringify(SCORE_SCHEMA))}`;
  }
  function fillSelects() {
    const n = CANDS.length + (mine() ? 1 : 0);
    ['#jPick', '#pFirst', '#pSecond'].forEach((sel, k) => {
      const el = $(sel), prev = el.value === '' ? [0, 0, 2][k] : +el.value;
      el.innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i}">${labelOf(i)}</option>`).join('');
      el.value = String(Math.min(prev, n - 1));
    });
  }

  let liveOK = false, judging = false;
  const HELP = 'To run the judge, do the one-time setup in the Start section of <code>README.md</code>, start the backend from the project folder with <code>python -m backend --budget 1</code>, then reload this page. The server holds your API key, so the page never sees it. The script <code>python/08_eval_with_judge.py</code> runs the same kind of judge over a whole set and measures how often it agrees with human labels. Until then, the request on the left is exactly what would be sent.';
  function setJudgeButtons() { ['#jOne', '#jAll', '#pRun'].forEach(s => ($(s).disabled = !liveOK || judging)); }
  async function refreshLive() {
    const st = $('#liveState');
    let s;
    try { s = await statusService.status(); }
    catch (e) { s = { available: false, reason: e.message }; }
    liveOK = !!(s && s.available && s.has_credentials);
    st.className = 'live-state ' + (liveOK ? 'on' : 'off');
    st.innerHTML = liveOK ? `Live runs are available. Judge model: <code>${esc(s.default_model || 'server default')}</code>.` : `Live runs are not available. ${esc((s && s.reason) || '')}`;
    $('#liveHelp').innerHTML = liveOK ? '<span class="muted">Each call costs a little money. The time and the cost reported by the server are shown with each result.</span>' : HELP;
    setJudgeButtons();
  }

  async function callJudge(body) {
    const r = await messagesService.create(body);
    const m = (r && r.message) || {};
    if (m.stop_reason === 'refusal') throw new Error('The judge declined to answer.');
    const txt = (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let j;
    try { j = JSON.parse(txt); } catch (e) { throw new Error('The judge did not return valid JSON.'); }
    return { j, ms: r.timing && r.timing.total_ms, cost: r.cost_usd };
  }
  const meta = r => `<span class="muted small">${r.ms != null ? (r.ms / 1000).toFixed(1) + ' s' : ''}${typeof r.cost === 'number' ? `, $${r.cost.toFixed(4)}` : ''}</span>`;
  async function judgeIndex(i) {
    const text = textOf(i);
    const r = await callJudge(judgeBody(judgeUser(text), SCORE_SCHEMA));
    const score = r.j.score;
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new Error('The judge returned a score outside 1 to 5.');
    judged[i] = { text, score, reason: String(r.j.reason || ''), pass: score >= 4 };
    renderRubric();
    return r;
  }
  async function judgeOne() {
    const i = +$('#jPick').value, out = $('#jOut');
    judging = true; setJudgeButtons(); out.innerHTML = '<span class="muted">Asking the judge…</span>';
    try {
      const r = await judgeIndex(i), j = judged[i];
      const human = i < CANDS.length ? ` The person marked it <b>${CANDS[i].human ? 'pass' : 'fail'}</b>.` : '';
      out.innerHTML = `<b>${labelOf(i)}: score ${j.score} of 5, ${j.pass ? 'pass' : 'fail'}.</b> ${esc(j.reason)}${human} ${meta(r)}`;
    } catch (e) { out.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
    judging = false; setJudgeButtons();
  }
  async function judgeAll() {
    const out = $('#jOut');
    judging = true; setJudgeButtons();
    let cost = 0, ms = 0, failed = 0;
    for (let i = 0; i < CANDS.length; i++) {
      out.innerHTML = `<span class="muted">Judging summary ${i + 1} of ${CANDS.length}…</span>`;
      try { const r = await judgeIndex(i); cost += r.cost || 0; ms += r.ms || 0; } catch (e) { failed++; }
    }
    let agree = 0, n = 0;
    CANDS.forEach((c, i) => { if (judged[i] && judged[i].text === c.text) { n++; if (judged[i].pass === c.human) agree++; } });
    out.innerHTML = `<b>The judge agrees with the person on ${agree} of ${n} summaries.</b> See the LLM judge column in the table above.${failed ? ` <span class="err">${failed} calls failed.</span>` : ''} <span class="muted small">${(ms / 1000).toFixed(1)} s in total, $${cost.toFixed(4)}</span>`;
    judging = false; setJudgeButtons();
  }
  async function runPair() {
    const a = +$('#pFirst').value, b = +$('#pSecond').value, out = $('#pOut');
    if (a === b) { out.innerHTML = '<span class="err">Pick two different summaries.</span>'; return; }
    judging = true; setJudgeButtons(); out.innerHTML = '<span class="muted">Asking the judge twice…</span>';
    try {
      const r1 = await callJudge(judgeBody(pairUser(textOf(a), textOf(b)), PAIR_SCHEMA));
      const r2 = await callJudge(judgeBody(pairUser(textOf(b), textOf(a)), PAIR_SCHEMA));
      if (![1, 2].includes(r1.j.better) || ![1, 2].includes(r2.j.better)) throw new Error('The judge did not answer 1 or 2.');
      const w1 = r1.j.better === 1 ? a : b, w2 = r2.j.better === 1 ? b : a, same = w1 === w2;
      out.innerHTML = `<div>${labelOf(a)} shown first: the judge picked <b>${labelOf(w1)}</b>. ${esc(r1.j.reason || '')}</div>
        <div style="margin-top:4px">${labelOf(b)} shown first: the judge picked <b>${labelOf(w2)}</b>. ${esc(r2.j.reason || '')}</div>
        <div style="margin-top:6px">${same ? `${mark(true)} <b>Consistent.</b> The verdict survived the swap.` : `${mark(false)} <b>Position bias.</b> The verdict followed the order, so this comparison tells you nothing.`} ${meta({ ms: (r1.ms || 0) + (r2.ms || 0), cost: (r1.cost || 0) + (r2.cost || 0) })}</div>`;
    } catch (e) { out.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
    judging = false; setJudgeButtons();
  }
  $('#jPick').addEventListener('change', renderJudgePrompt);
  $('#jOne').addEventListener('click', judgeOne);
  $('#jAll').addEventListener('click', judgeAll);
  $('#pRun').addEventListener('click', runPair);
  $('#liveCheck').addEventListener('click', refreshLive);
  $('#mySummary').addEventListener('input', () => { renderRubric(); fillSelects(); renderJudgePrompt(); });

  // ---------- 3. scoring two prompts with GPT-2 ----------
  const ex = (r, l) => `Review: ${r}\nSentiment: ${l}\n\n`;
  const TAIL = 'Review: {review}\nSentiment:';
  const PRESETS = {
    'Zero-shot': TAIL,
    'Instruction only': 'Classify the sentiment of the review as positive or negative.\n\n' + TAIL,
    'Few-shot, balanced': ex('Absolutely fantastic, I would go again.', 'positive') + ex('The worst purchase I have ever made.', 'negative') + ex('Great value and lovely design.', 'positive') + ex('Rude staff and dirty rooms.', 'negative') + TAIL,
    'Few-shot, hard cases': ex('I was not disappointed in the slightest.', 'positive') + ex('Oh wonderful, it broke again.', 'negative') + ex('Expensive, but I would buy it again.', 'positive') + ex('Not what I hoped for at all.', 'negative') + TAIL,
    'Few-shot, hard cases, reordered': ex('Oh wonderful, it broke again.', 'negative') + ex('I was not disappointed in the slightest.', 'positive') + ex('Not what I hoped for at all.', 'negative') + ex('Expensive, but I would buy it again.', 'positive') + TAIL,
    'Few-shot, all positive': ex('Absolutely fantastic, I would go again.', 'positive') + ex('Great value and lovely design.', 'positive') + ex('Wonderful, everyone should try it.', 'positive') + ex('Really enjoyed it.', 'positive') + TAIL
  };
  const slots = { A: { name: 'Few-shot, balanced' }, B: { name: 'Few-shot, hard cases' } };
  let ready = false, busy = false, again = false, scored = null;

  function setSlotName(s, name) { slots[s].name = name; $('#name' + s).textContent = name; }
  ['A', 'B'].forEach(s => {
    const box = $('#presets' + s), tpl = $('#tpl' + s);
    Object.keys(PRESETS).forEach(name => {
      const b = document.createElement('button');
      b.className = 'chip-btn' + (name === slots[s].name ? ' on' : ''); b.textContent = name;
      b.addEventListener('click', () => {
        tpl.value = PRESETS[name]; setSlotName(s, name);
        box.querySelectorAll('.chip-btn').forEach(x => x.classList.toggle('on', x === b));
        scoreAll();
      });
      box.appendChild(b);
    });
    tpl.value = PRESETS[slots[s].name]; setSlotName(s, slots[s].name);
    tpl.addEventListener('input', () => {
      setSlotName(s, 'Custom ' + s);
      box.querySelectorAll('.chip-btn').forEach(x => x.classList.remove('on'));
      if (ready && !busy) $('#progTxt').textContent = `Prompt ${s} changed. Run again to update the results.`;
    });
  });

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
  const memo = new Map();
  async function scoreText(tpl, text) {
    const prompt = tpl.split('{review}').join(text);
    if (memo.has(prompt)) return { r: memo.get(prompt), fresh: false };
    const [pos, neg] = await labelProbs(prompt, LABELS);
    const r = { pp: pos.p / (pos.p + neg.p), mass: pos.p + neg.p };
    memo.set(prompt, r);
    if (memo.size > 4000) memo.delete(memo.keys().next().value);
    return { r, fresh: true };
  }
  const predOf = pp => (pp >= 0.5 ? 'positive' : 'negative');
  const okOf = (r, label) => predOf(r.pp) === label;

  function ppCell(r, label, color) {
    const ok = okOf(r, label);
    return `<td style="white-space:nowrap" title="P(positive) = ${p1(r.pp)}, predicted ${predOf(r.pp)}"><span class="pp"><i style="width:${(r.pp * 100).toFixed(1)}%;background:${color}"></i></span>${mark(ok)} <span class="small muted">${p0(r.pp)}</span></td>`;
  }
  const resRow = it => `<tr class="fade-in"><td>${esc(it.text)}${it.kind === 'plain' ? '' : ' ' + kindPill(it.kind)}</td><td>${it.label}</td>${ppCell(it.a, it.label, COLOR.A)}${ppCell(it.b, it.label, COLOR.B)}</tr>`;

  async function scoreAll() {
    if (!ready) return;
    if (busy) { again = true; return; }
    const tA = $('#tplA').value, tB = $('#tplB').value;
    for (const [s, t] of [['A', tA], ['B', tB]]) {
      if (!t.includes('{review}')) { $('#progTxt').innerHTML = `<span style="color:var(--bad)">Prompt ${s} needs a {review} placeholder.</span>`; return; }
    }
    busy = true; again = false; $('#runAB').disabled = true;
    const items = data.slice(), total = items.length * 2, out = [];
    const prog = $('#prog'), bar = $('#prog i'), txt = $('#progTxt'), tbody = $('#resTable tbody');
    let done = 0, fresh = 0;
    prog.hidden = false; bar.style.width = '0%'; txt.textContent = 'Scoring…';
    tbody.innerHTML = '';
    for (const d of items) {
      const a = await scoreText(tA, d.text); done++;
      const b = await scoreText(tB, d.text); done++;
      fresh += a.fresh + b.fresh;
      const it = { ...d, a: a.r, b: b.r };
      out.push(it);
      tbody.insertAdjacentHTML('beforeend', resRow(it));
      bar.style.width = (100 * done / total).toFixed(1) + '%';
      txt.textContent = `Scored ${done} of ${total} prompts`;
    }
    prog.hidden = true;
    txt.textContent = `Done. ${total} prompts scored, ${fresh} of them new and ${total - fresh} remembered from earlier runs.`;
    scored = { items: out, A: { name: slots.A.name, tpl: tA }, B: { name: slots.B.name, tpl: tB } };
    busy = false; $('#runAB').disabled = false;
    renderScored();
    analyse(true);
    if (again) scoreAll();
  }
  $('#runAB').addEventListener('click', scoreAll);

  function renderScored() {
    const it = scored.items, N = it.length;
    const kA = it.filter(x => okOf(x.a, x.label)).length, kB = it.filter(x => okOf(x.b, x.label)).length;
    const fixed = it.filter(x => !okOf(x.a, x.label) && okOf(x.b, x.label)).length;
    const broke = it.filter(x => okOf(x.a, x.label) && !okOf(x.b, x.label)).length;
    $('#sA').innerHTML = `${kA} / ${N} <span class="small muted">${p0(kA / N)}</span>`;
    $('#sB').innerHTML = `${kB} / ${N} <span class="small muted">${p0(kB / N)}</span>`;
    const posA = it.filter(x => x.a.pp >= 0.5).length, posB = it.filter(x => x.b.pp >= 0.5).length, truePos = it.filter(x => x.label === 'positive').length;
    $('#predLine').innerHTML = `Prompt A said positive for <b>${posA} of ${N}</b> cases and Prompt B for <b>${posB}</b>. ${truePos} are really positive. A prompt that always gives the same answer scores ${p0(Math.max(truePos, N - truePos) / N)} here, so that is the floor to beat, not a starting point.`;
    $('#sFix').textContent = fixed;
    $('#sBrk').textContent = broke;
    const kinds = KIND_ORDER.filter(k => it.some(x => x.kind === k));
    const row = (name, xs) => {
      const a = xs.filter(x => okOf(x.a, x.label)).length, b = xs.filter(x => okOf(x.b, x.label)).length;
      return `<tr><td>${name}</td><td class="num">${xs.length}</td><td class="num">${a} <span class="muted small">${p0(a / xs.length)}</span></td><td class="num">${b} <span class="muted small">${p0(b / xs.length)}</span></td></tr>`;
    };
    $('#kindTable tbody').innerHTML = kinds.map(k => row(kindPill(k), it.filter(x => x.kind === k))).join('') +
      (kinds.length > 1 ? row('<b>All</b>', it) : '');
  }

  // ---------- 4. bootstrap confidence intervals ----------
  let nSel = 'all', subSeed = 1, an = null;
  const ciOf = arr => { arr.sort(); return [arr[Math.floor(0.025 * RESAMPLES)], arr[Math.ceil(0.975 * RESAMPLES) - 1]]; };
  function bootPair(a, b, seed) {
    // resample cases with replacement; A and B always get the same draw
    const n = a.length, rng = Site.mulberry32(seed);
    const ra = new Float64Array(RESAMPLES), rb = new Float64Array(RESAMPLES), rd = new Float64Array(RESAMPLES);
    for (let r = 0; r < RESAMPLES; r++) {
      let sa = 0, sb = 0;
      for (let k = 0; k < n; k++) { const i = Math.floor(rng() * n); sa += a[i]; sb += b[i]; }
      ra[r] = sa / n; rb[r] = sb / n; rd[r] = (sb - sa) / n;
    }
    return { a: ciOf(ra), b: ciOf(rb), d: ciOf(rd) };
  }
  function bootOne(a, seed) {
    const n = a.length, rng = Site.mulberry32(seed), ra = new Float64Array(RESAMPLES);
    for (let r = 0; r < RESAMPLES; r++) { let s = 0; for (let k = 0; k < n; k++) s += a[Math.floor(rng() * n)]; ra[r] = s / n; }
    return ciOf(ra);
  }
  function shuffledOrder(n) {
    const idx = Array.from({ length: n }, (_, i) => i), rng = Site.mulberry32(77 + subSeed * 101);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    return idx;
  }
  const sizesFor = N => [8, 20, 40].filter(x => x < N).concat([N]);
  function selN() { const N = scored.items.length; return nSel === 'all' || nSel >= N ? N : nSel; }
  function subset(n) { return shuffledOrder(scored.items.length).slice(0, n).map(i => scored.items[i]); }

  function analyse(recordIt) {
    if (!scored) return;
    const N = scored.items.length;
    if (nSel !== 'all' && nSel >= N) nSel = 'all';
    const sizes = sizesFor(N), n0 = selN();
    an = { N, sel: n0, rows: sizes.map(n => {
      const items = subset(n);
      const a = items.map(x => +okOf(x.a, x.label)), b = items.map(x => +okOf(x.b, x.label));
      const kA = a.reduce((s, v) => s + v, 0), kB = b.reduce((s, v) => s + v, 0);
      const ci = bootPair(a, b, 1000 + n);
      return { n, kA, kB, accA: kA / n, accB: kB / n, d: (kB - kA) / n, ciA: ci.a, ciB: ci.b, ciD: ci.d,
        fixed: items.filter(x => !okOf(x.a, x.label) && okOf(x.b, x.label)).length,
        broke: items.filter(x => okOf(x.a, x.label) && !okOf(x.b, x.label)).length };
    }) };
    $('#nChips').innerHTML = sizes.map(n => `<button class="chip-btn${n === n0 ? ' on' : ''}" data-n="${n}">${n === N ? 'All ' + N : n}</button>`).join('');
    $('#redraw').disabled = n0 === N;
    const r = an.rows.find(x => x.n === n0);
    $('#cA').textContent = p1(r.accA); $('#cAk').textContent = `Prompt A · 95% interval ${p0(r.ciA[0])} to ${p0(r.ciA[1])}`;
    $('#cB').textContent = p1(r.accB); $('#cBk').textContent = `Prompt B · 95% interval ${p0(r.ciB[0])} to ${p0(r.ciB[1])}`;
    $('#cD').textContent = pts(r.d) + ' pts'; $('#cDk').textContent = `B − A · 95% interval ${pts(r.ciD[0], 0)} to ${pts(r.ciD[1], 0)} points`;
    $('#cOne').textContent = (100 / r.n).toFixed(1) + ' pts'; $('#cOnek').textContent = `one case is worth this much at ${r.n} cases`;
    const v = $('#verdict'), lo = pts(r.ciD[0], 0), hi = pts(r.ciD[1], 0);
    if (r.ciD[0] > 0) {
      v.className = 'verdict good';
      v.innerHTML = `<span class="badge">✓ Distinguishable from noise.</span>B scores ${Math.abs(100 * r.d).toFixed(1)} points higher, and the 95% interval for B − A runs from ${lo} to ${hi} points. It does not include zero, so the improvement is real at this sample size. Before shipping, ask whether the low end, ${lo} points, is still worth having.`;
    } else if (r.ciD[1] < 0) {
      v.className = 'verdict bad';
      v.innerHTML = `<span class="badge">✗ B is worse, beyond the noise.</span>B scores ${Math.abs(100 * r.d).toFixed(1)} points lower, and the 95% interval for B − A runs from ${lo} to ${hi} points. It does not include zero, so do not ship B.`;
    } else {
      v.className = 'verdict';
      v.innerHTML = `<span class="badge">≈ Not distinguishable from noise.</span>B − A is ${pts(r.d)} points, but the 95% interval runs from ${lo} to ${hi} points and includes zero. With ${r.n} cases you cannot tell these prompts apart. Add cases before deciding, or treat them as equivalent.`;
    }
    const w = r.ciB[1] - r.ciB[0];
    $('#smallNote').innerHTML = r.n <= 10
      ? `<b>With only ${r.n} cases,</b> one case is worth ${(100 / r.n).toFixed(1)} points, so going from 6 to 7 correct looks like a big gain. Prompt B's interval here is ${(100 * w).toFixed(0)} points wide, so a jump like that is noise. Press "Draw a different sample" a few times and watch the winner change.`
      : `<b>Try 8 cases.</b> One case is then worth 12.5 points, so going from 6 to 7 correct looks like a big gain. At ${r.n} cases one case is worth ${(100 / r.n).toFixed(1)} points and Prompt B's interval is ${(100 * w).toFixed(0)} points wide. Watch the intervals widen as the sample shrinks.`;
    $('#nLegend').innerHTML = `<span style="--c:${COLOR.A}">Prompt A: ${esc(scored.A.name)}</span><span style="--c:${COLOR.B}">Prompt B: ${esc(scored.B.name)}</span>`;
    $('#dLegend').innerHTML = `<span class="line" style="--c:var(--faint)">zero line: no difference</span>`;
    drawN(); drawDiff();
    if (recordIt) recordGreedy(r);
    sample(recordIt);
  }
  $('#nChips').addEventListener('click', e => {
    const b = e.target.closest('[data-n]'); if (!b || !scored) return;
    const n = +b.dataset.n; nSel = n >= scored.items.length ? 'all' : n; analyse(true);
  });
  $('#redraw').addEventListener('click', () => { if (!scored) return; subSeed++; analyse(true); });

  // ---------- 5. run-to-run variance ----------
  let temp = 1, nRuns = 20, sampSeed = 1, samp = null;
  function tempered(pp, T) {
    if (T <= 0) return pp >= 0.5 ? 1 : 0;
    const a = Math.pow(pp, 1 / T), b = Math.pow(1 - pp, 1 / T);
    return a + b > 0 ? a / (a + b) : (pp >= 0.5 ? 1 : 0);
  }
  function sample(recordIt) {
    if (!scored) return;
    const n = selN(), items = subset(n), rng = Site.mulberry32(5000 + sampSeed * 7919 + n);
    const res = { n, T: temp, runs: nRuns, A: { accs: [], per: new Float64Array(n) }, B: { accs: [], per: new Float64Array(n) } };
    const probs = items.map(x => [tempered(x.a.pp, temp), tempered(x.b.pp, temp)]);
    for (let r = 0; r < nRuns; r++) {
      let ca = 0, cb = 0;
      items.forEach((x, i) => {
        const okA = (rng() < probs[i][0] ? 'positive' : 'negative') === x.label;
        const okB = (rng() < probs[i][1] ? 'positive' : 'negative') === x.label;
        ca += okA; cb += okB; res.A.per[i] += okA; res.B.per[i] += okB;
      });
      res.A.accs.push(ca); res.B.accs.push(cb);
    }
    ['A', 'B'].forEach((s, k) => {
      const o = res[s], accs = o.accs.map(c => c / n);
      o.mean = accs.reduce((a, v) => a + v, 0) / nRuns;
      o.min = Math.min(...accs); o.max = Math.max(...accs);
      o.greedy = items.filter(x => okOf(k ? x.b : x.a, x.label)).length / n;
    });
    res.wins = res.A.accs.filter((c, r) => res.B.accs[r] > c).length;
    res.ties = res.A.accs.filter((c, r) => res.B.accs[r] === c).length;
    res.losses = nRuns - res.wins - res.ties;
    samp = res;
    $('#vA').textContent = p1(res.A.mean); $('#vAk').textContent = `Prompt A mean · runs ranged ${p0(res.A.min)} to ${p0(res.A.max)}`;
    $('#vB').textContent = p1(res.B.mean); $('#vBk').textContent = `Prompt B mean · runs ranged ${p0(res.B.min)} to ${p0(res.B.max)}`;
    $('#vW').textContent = `${res.wins} of ${nRuns}`; $('#vWk').textContent = `runs where B beat A · ${res.ties} tied · ${res.losses} where A won`;
    let note;
    if (temp === 0) note = 'At temperature 0 every run is identical, so there is no spread to see. Hosted models can still vary a little between identical calls, so measure rather than assume.';
    else {
      const bAhead = res.B.mean >= res.A.mean, misled = bAhead ? res.ties + res.losses : res.ties + res.wins;
      const lead = `On average Prompt ${bAhead ? 'B' : 'A'} is ahead by ${Math.abs(100 * (res.B.mean - res.A.mean)).toFixed(1)} points over ${nRuns} runs of ${n} cases.`;
      note = misled ? `${lead} Yet a single run of each would have shown a tie or the other prompt winning in <b>${misled} of ${nRuns}</b> tries. Average several runs per case before deciding.`
        : `${lead} It won every one of the ${nRuns} runs, so here the gap is larger than the run-to-run spread.`;
    }
    $('#sNote').innerHTML = note;
    $('#sLegend').innerHTML = `<span style="--c:${COLOR.A}">Prompt A: ${esc(scored.A.name)}</span><span style="--c:${COLOR.B}">Prompt B: ${esc(scored.B.name)}</span><span class="line" style="--c:var(--ink2)">greedy run, always the top label</span>`;
    drawStrip();
    if (recordIt) recordSampled(res);
  }
  $('#temp').addEventListener('input', () => { temp = +$('#temp').value; $('#tempV').textContent = temp.toFixed(1); sample(false); });
  $('#temp').addEventListener('change', () => { temp = +$('#temp').value; sample(true); });
  $('#nRuns').addEventListener('change', () => { nRuns = +$('#nRuns').value; sample(true); });
  $('#resample').addEventListener('click', () => { sampSeed++; sample(true); });

  // ---------- 6. runs history ----------
  const hist = [], histKeys = new Set();
  let histId = 0;
  function record(e, key) {
    if (histKeys.has(key)) return;
    histKeys.add(key); e.id = ++histId; hist.unshift(e);
    if (hist.length > 40) hist.pop();
    renderHist();
  }
  const subKey = n => subset(n).map(x => x.id).join(',');
  function recordGreedy(r) {
    const key = subKey(r.n);
    record({ slot: 'A', name: scored.A.name, n: r.n, mode: 'greedy', acc: r.accA, ci: r.ciA, range: null }, `A|${scored.A.tpl}|${key}|greedy`);
    record({ slot: 'B', name: scored.B.name, n: r.n, mode: 'greedy', acc: r.accB, ci: r.ciB, range: null }, `B|${scored.B.tpl}|${key}|greedy`);
  }
  function recordSampled(res) {
    const key = subKey(res.n), mode = `sampled, temperature ${res.T.toFixed(1)}, ${res.runs} runs`;
    ['A', 'B'].forEach(s => {
      const o = res[s], per = Array.from(o.per, v => v / res.runs);
      record({ slot: s, name: scored[s].name, n: res.n, mode, acc: o.mean, ci: bootOne(per, 3000 + res.n), range: res.T === 0 ? null : [o.min, o.max] },
        `${s}|${scored[s].tpl}|${key}|T${res.T}|R${res.runs}|S${sampSeed}`);
    });
  }
  function renderHist() {
    $('#histCount').textContent = hist.length ? `${hist.length} run${hist.length === 1 ? '' : 's'} recorded, newest first. The chart shows the latest 12.` : '';
    $('#histTable tbody').innerHTML = hist.length ? hist.map(h => `<tr><td class="num">${h.id}</td><td style="white-space:nowrap"><span class="slot" style="background:${COLOR[h.slot]}"></span>${h.slot} · ${esc(h.name)}</td><td class="num">${h.n}</td><td>${h.mode}</td><td class="num">${p1(h.acc)}</td><td class="num">${p0(h.ci[0])} to ${p0(h.ci[1])}</td><td class="num">${h.range ? `${p0(h.range[0])} to ${p0(h.range[1])}` : '<span class="muted">none</span>'}</td></tr>`).join('')
      : '<tr><td colspan="7" class="muted">Runs appear here as you go.</td></tr>';
    $('#hLegend').innerHTML = hist.length ? `<span style="--c:${COLOR.A}">Prompt A slot</span><span style="--c:${COLOR.B}">Prompt B slot</span><span class="small muted" style="--c:transparent">Dot: accuracy. Whisker: 95% interval.</span>` : '';
    drawHist();
  }
  $('#clearHist').addEventListener('click', () => { hist.length = 0; histKeys.clear(); renderHist(); });

  // ---------- charts: inline SVG ----------
  const GRID = 'var(--line)';
  const widthOf = el => Math.max(260, Math.floor(el.clientWidth || 600));
  const svgWrap = (w, h, label, body) => `<svg class="chart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">${body}</svg>`;
  const placeholder = msg => `<div class="placeholder">${msg}</div>`;
  function xGrid(ticks, x, top, bottom, fmt) {
    return ticks.map(t => `<line x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${bottom}" stroke="${GRID}"></line><text x="${x(t)}" y="${bottom + 14}" text-anchor="middle">${fmt(t)}</text>`).join('');
  }
  function whisker(x, v, lo, hi, y, color, tipHtml) {
    const x1 = x(lo), x2 = x(hi), xd = x(v);
    const hx = Math.min(x1, xd - 12) - 4, hw = Math.max(x2, xd + 12) + 4 - hx;
    return `<g class="mark" data-tip="${esc(tipHtml)}"><rect class="hit" x="${hx}" y="${y - 11}" width="${hw}" height="22"></rect>
      <line x1="${x1}" x2="${x2}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="2" stroke-linecap="round"></line>
      <line x1="${x1}" x2="${x1}" y1="${y - 4}" y2="${y + 4}" stroke="${color}" stroke-width="2" stroke-linecap="round"></line>
      <line x1="${x2}" x2="${x2}" y1="${y - 4}" y2="${y + 4}" stroke="${color}" stroke-width="2" stroke-linecap="round"></line>
      <circle cx="${xd}" cy="${y}" r="5" fill="${color}" stroke="var(--surface)" stroke-width="2"></circle></g>`;
  }

  function drawN() {
    const el = $('#nChart');
    if (!an) { el.innerHTML = placeholder('Load GPT-2 to see this chart.'); return; }
    const W = widthOf(el), L = 66, R = 14, top = 6, rowH = 46, H = top + rowH * an.rows.length + 22;
    const x = v => L + v * (W - L - R);
    let s = xGrid([0, 0.25, 0.5, 0.75, 1], x, top, H - 22, p0);
    an.rows.forEach((r, i) => {
      const y0 = top + i * rowH, yc = y0 + rowH / 2, sel = r.n === an.sel;
      if (sel) s += `<rect x="0" y="${y0 + 2}" width="${W}" height="${rowH - 4}" rx="6" fill="var(--soft)"></rect>`;
      s += `<text class="lbl${sel ? ' sel' : ''}" x="${L - 10}" y="${yc + 4}" text-anchor="end">${r.n === an.N ? 'All ' + r.n : r.n + ' cases'}</text>`;
      s += whisker(x, r.accA, r.ciA[0], r.ciA[1], yc - 8, COLOR.A, `<b>${p1(r.accA)}</b> · Prompt A, ${esc(scored.A.name)}<br>${r.kA} of ${r.n} correct<br>95% interval ${p1(r.ciA[0])} to ${p1(r.ciA[1])}`);
      s += whisker(x, r.accB, r.ciB[0], r.ciB[1], yc + 8, COLOR.B, `<b>${p1(r.accB)}</b> · Prompt B, ${esc(scored.B.name)}<br>${r.kB} of ${r.n} correct<br>95% interval ${p1(r.ciB[0])} to ${p1(r.ciB[1])}`);
    });
    el.innerHTML = svgWrap(W, H, 'Accuracy of prompts A and B with 95% intervals at each sample size', s);
  }

  function drawDiff() {
    const el = $('#dChart');
    if (!an) { el.innerHTML = placeholder('Load GPT-2 to see this chart.'); return; }
    const m = Math.max(...an.rows.map(r => Math.max(Math.abs(r.ciD[0]), Math.abs(r.ciD[1]))), 0.05);
    const D = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1].find(v => v >= m * 1.05) || 1;
    const W = widthOf(el), L = 66, R = 14, top = 22, rowH = 46, H = top + rowH * an.rows.length + 22;
    const x = v => L + (v + D) / (2 * D) * (W - L - R);
    let s = xGrid([-D, -D / 2, 0, D / 2, D], x, top, H - 22, v => pts(v, 0));
    s += `<line x1="${x(0)}" x2="${x(0)}" y1="${top - 4}" y2="${H - 22}" stroke="var(--faint)"></line>`;
    s += `<text x="${x(0) - 6}" y="12" text-anchor="end">← B worse</text><text x="${x(0) + 6}" y="12">B better →</text>`;
    an.rows.forEach((r, i) => {
      const y0 = top + i * rowH, yc = y0 + rowH / 2, sel = r.n === an.sel;
      if (sel) s += `<rect x="0" y="${y0 + 2}" width="${W}" height="${rowH - 4}" rx="6" fill="var(--soft)"></rect>`;
      s += `<text class="lbl${sel ? ' sel' : ''}" x="${L - 10}" y="${yc + 4}" text-anchor="end">${r.n === an.N ? 'All ' + r.n : r.n + ' cases'}</text>`;
      s += whisker(x, r.d, r.ciD[0], r.ciD[1], yc, COLOR.D, `<b>${pts(r.d)} points</b> · B − A at ${r.n} cases<br>95% interval ${pts(r.ciD[0])} to ${pts(r.ciD[1])} points<br>B fixed ${r.fixed} cases and broke ${r.broke}`);
    });
    el.innerHTML = svgWrap(W, H, 'Difference in accuracy between B and A with 95% intervals at each sample size', s);
  }

  function drawStrip() {
    const el = $('#sChart');
    if (!samp) { el.innerHTML = placeholder('Load GPT-2 to see this chart.'); return; }
    const n = samp.n, all = [];
    ['A', 'B'].forEach(k => { samp[k].accs.forEach(c => all.push(c / n)); all.push(samp[k].greedy); });
    let lo = Math.max(0, Math.floor((Math.min(...all) - 0.05) * 20) / 20), hi = Math.min(1, Math.ceil((Math.max(...all) + 0.05) * 20) / 20);
    while (hi - lo < 0.3) { if (lo > 0) lo = Math.max(0, lo - 0.05); if (hi < 1) hi = Math.min(1, hi + 0.05); if (lo === 0 && hi === 1) break; }
    const step = hi - lo > 0.5 ? 0.1 : 0.05, ticks = [];
    for (let t = Math.ceil(lo / step - 1e-9) * step; t <= hi + 1e-9; t += step) ticks.push(+t.toFixed(4));
    const W = widthOf(el), L = 78, R = 14, gap = 10;
    const x = v => L + (v - lo) / (hi - lo) * (W - L - R);
    const stacks = ['A', 'B'].map(k => { const m = {}; samp[k].accs.forEach(c => (m[c] = (m[c] || 0) + 1)); return m; });
    const maxStack = Math.max(...stacks.map(m => Math.max(...Object.values(m))));
    const rowH = Math.max(64, maxStack * gap + 30), top = 4, H = top + rowH * 2 + 22;
    let s = xGrid(ticks, x, top, H - 22, p0);
    ['A', 'B'].forEach((k, ri) => {
      const base = top + (ri + 1) * rowH - 8, o = samp[k], seen = {};
      s += `<line x1="${L}" x2="${W - R}" y1="${base + 2}" y2="${base + 2}" stroke="var(--line2)"></line>`;
      s += `<text class="lbl" x="${L - 10}" y="${base - 4}" text-anchor="end">Prompt ${k}</text>`;
      s += `<g class="mark" data-tip="${esc(`<b>${p1(o.greedy)}</b> · Prompt ${k}, greedy run<br>Always takes the more likely label`)}"><rect class="hit" x="${x(o.greedy) - 6}" y="${base - rowH + 14}" width="12" height="${rowH - 12}"></rect><line x1="${x(o.greedy)}" x2="${x(o.greedy)}" y1="${base - rowH + 16}" y2="${base + 2}" stroke="var(--ink2)" stroke-width="1.5"></line></g>`;
      o.accs.forEach((c, r) => {
        const j = (seen[c] = (seen[c] || 0) + 1) - 1, cx = x(c / n), cy = base - 5 - j * gap;
        s += `<g class="mark" data-tip="${esc(`<b>${p1(c / n)}</b> · Prompt ${k}, run ${r + 1}<br>${c} of ${n} correct at temperature ${samp.T.toFixed(1)}`)}"><circle class="hit" cx="${cx}" cy="${cy}" r="11"></circle><circle cx="${cx}" cy="${cy}" r="4.5" fill="${COLOR[k]}" stroke="var(--surface)" stroke-width="2"></circle></g>`;
      });
    });
    el.innerHTML = svgWrap(W, H, 'Accuracy of each repeated sampled run for prompts A and B', s);
  }

  function drawHist() {
    const el = $('#hChart');
    if (!hist.length) { el.innerHTML = ''; return; }
    const rows = hist.slice(0, 12), W = widthOf(el), L = 8, R = 14, top = 4, rowH = 40, H = top + rowH * rows.length + 22;
    const x = v => L + v * (W - L - R), maxChars = Math.floor((W - L - R) / 6.6);
    let s = xGrid([0, 0.25, 0.5, 0.75, 1], x, top, H - 22, p0);
    rows.forEach((h, i) => {
      const y0 = top + i * rowH;
      let label = `Run ${h.id} · ${h.slot}: ${h.name} · ${h.n} cases · ${h.mode}`;
      if (label.length > maxChars) label = label.slice(0, maxChars - 1) + '…';
      s += `<text class="lbl" x="${L}" y="${y0 + 13}">${esc(label)}</text>`;
      s += whisker(x, h.acc, h.ci[0], h.ci[1], y0 + 28, COLOR[h.slot], `<b>${p1(h.acc)}</b> · run ${h.id}, Prompt ${h.slot}: ${esc(h.name)}<br>${h.n} cases, ${h.mode}<br>95% interval ${p1(h.ci[0])} to ${p1(h.ci[1])}${h.range ? `<br>Runs ranged ${p1(h.range[0])} to ${p1(h.range[1])}` : ''}`);
    });
    el.innerHTML = svgWrap(W, H, 'Accuracy with 95% intervals for each recorded run', s);
  }

  ['#nChart', '#dChart', '#sChart', '#hChart'].forEach(id => Site.bindTips($(id), '.mark', el => el.dataset.tip));
  let rz = 0, lastW = 0;
  life.on(window, 'resize', () => {
    cancelAnimationFrame(rz);
    rz = requestAnimationFrame(() => { if (innerWidth === lastW) return; lastW = innerWidth; drawN(); drawDiff(); drawStrip(); drawHist(); });
  });

  // ---------- start ----------
  resetData(); renderData(); renderRubric(); fillSelects(); renderJudgePrompt(); refreshLive();
  drawN(); drawDiff(); drawStrip(); lastW = innerWidth;

  Site.modelGate($('#gate'), {
    title: 'GPT-2', sizeMB: 128, autoKey: 'gpt2-loaded', isReady: GPT2.isReady,
    what: 'This page reads its next-token probabilities to classify the test set.',
    loader: cb => GPT2.load(cb),
    onReady: async () => { ready = true; $('#lab').classList.remove('locked'); await scoreAll(); }
  });
}
