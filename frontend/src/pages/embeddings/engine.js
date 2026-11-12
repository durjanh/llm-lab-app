import { Embedder } from '@/lib/embedder';
import { LocalEmbedder } from '@/lib/localEmbedder';
import { Reranker } from '@/lib/reranker';
import { Site } from '@/lib/site';

/** Runs the page's interactive parts. Returns nothing; `life` undoes timers and listeners on unmount. */
export function mount(root, life) {
  const { $, esc } = Site;
  const TOPICS = [
    ['Pets', 'var(--s1)', ['The dog refused to eat its dinner.', 'My cat sleeps on the windowsill all afternoon.', 'We adopted a puppy from the rescue centre.', 'The vet said the kitten needs another vaccine.', 'Our parrot learned to whistle a tune.']],
    ['Money', 'var(--s2)', ['The central bank raised interest rates again.', 'I moved my savings into an index fund.', 'Mortgage repayments went up this month.', 'The company reported higher quarterly profits.', 'Inflation makes groceries more expensive.']],
    ['Space', 'var(--s3)', ['The rocket launched a satellite into orbit.', 'Astronomers found a planet around a nearby star.', 'The astronauts docked with the space station.', 'A meteor shower lit up the night sky.', 'The telescope captured images of a distant galaxy.']]
  ];
  const QUERIES = ['My puppy will not touch his food.', 'Is now a good time to buy a house?', 'How do astronauts reach the ISS?', 'We had a picnic on the river bank.', 'The bank raised its rates.'];
  const STOP = new Set('a an the to of and or in on at for from with into is are was were be been it its my our your his her their this that these those i we you he she they do does did not no will would can could how what when who why where which now up again all more if me am any by so as there s t don'.split(' '));
  let ready = false;
  let E = Embedder; // the model that embeds: MiniLM in the browser, or the open model in Docker (see the end of mount)
  let points = TOPICS.flatMap(([topic, color, ss]) => ss.map(text => ({ text, topic, color })));

  // ---------- PCA ----------
  function pca2(X) {
    const n = X.length, d = X[0].length;
    const mean = new Array(d).fill(0);
    X.forEach(x => x.forEach((v, i) => (mean[i] += v / n)));
    const C = X.map(x => x.map((v, i) => v - mean[i]));
    const comps = [];
    for (let c = 0; c < 2; c++) {
      let v = Array.from({ length: d }, (_, i) => Math.sin(i * (c + 1.7)) + 0.01);
      for (let it = 0; it < 80; it++) {
        const s = C.map(r => r.reduce((a, x, i) => a + x * v[i], 0));
        const w = new Array(d).fill(0);
        C.forEach((r, j) => r.forEach((x, i) => (w[i] += s[j] * x)));
        comps.forEach(p => { const dp = w.reduce((a, x, i) => a + x * p[i], 0); for (let i = 0; i < d; i++) w[i] -= dp * p[i]; });
        const nrm = Math.hypot(...w) || 1; v = w.map(x => x / nrm);
      }
      comps.push(v);
    }
    return { mean, comps, project: x => comps.map(p => p.reduce((a, pv, i) => a + pv * (x[i] - mean[i]), 0)) };
  }
  const words = s => new Set((s.toLowerCase().match(/[a-z0-9']+/g) || []).filter(w => !STOP.has(w)));

  async function renderMap() {
    if (!ready) return;
    const q = $('#query').value.trim();
    const vecs = await E.embed(points.map(p => p.text));
    const pca = pca2(vecs);
    const xy = vecs.map(pca.project);
    let qv = null, qxy = null;
    if (q) { [qv] = await E.embed([q], 'query'); qxy = pca.project(qv); }
    const all = qxy ? xy.concat([qxy]) : xy;
    const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const W = 600, H = 420, pad = 34;
    const sx = x => pad + (x - x0) / (x1 - x0 || 1) * (W - 2 * pad), sy = y => H - pad - (y - y0) / (y1 - y0 || 1) * (H - 2 * pad);
    const sims = qv ? vecs.map(v => E.cosine(qv, v)) : [];
    const order = sims.map((s, i) => i).sort((a, b) => sims[b] - sims[a]);
    let s = '';
    if (qv) order.slice(0, 3).forEach(i => (s += `<line x1="${sx(qxy[0])}" y1="${sy(qxy[1])}" x2="${sx(xy[i][0])}" y2="${sy(xy[i][1])}" stroke="var(--faint)" stroke-dasharray="4 3"></line>`));
    xy.forEach((p, i) => (s += `<circle class="pt" data-i="${i}" cx="${sx(p[0]).toFixed(1)}" cy="${sy(p[1]).toFixed(1)}" r="7" fill="${points[i].color}" stroke="var(--surface)" stroke-width="2"></circle>`));
    if (qxy) {
      const cx = sx(qxy[0]), cy = sy(qxy[1]);
      s += `<g class="pt" data-q="1"><path d="M${cx} ${cy - 10} L${cx + 9} ${cy} L${cx} ${cy + 10} L${cx - 9} ${cy} Z" fill="var(--ink)" stroke="var(--surface)" stroke-width="2"></path></g><text x="${cx + 12}" y="${cy + 4}" style="fill:var(--ink);font-weight:600">query</text>`;
    }
    $('#map').innerHTML = s;
    const topicsShown = [...new Set(points.map(p => p.topic))];
    $('#mapLegend').innerHTML = topicsShown.map(t => `<span style="--c:${points.find(p => p.topic === t).color}">${t}</span>`).join('') + (qxy ? '<span style="--c:var(--ink)">Your query</span>' : '');
    if (qv) {
      const qw = words(q);
      $('#nnTable tbody').innerHTML = order.slice(0, 8).map(i => {
        const shared = [...words(points[i].text)].filter(w => qw.has(w));
        return `<tr class="fade-in"><td><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${points[i].color};margin-right:6px"></span>${esc(points[i].text)}</td>
          <td class="num"><b>${sims[i].toFixed(2)}</b><br><span class="hbar" style="width:${Math.max(2, sims[i] * 70).toFixed(0)}px"></span></td>
          <td class="num">${shared.length}${shared.length ? `<br><span class="small muted">${esc(shared.join(', '))}</span>` : ''}</td></tr>`;
      }).join('');
    }
  }
  Site.bindTips($('#map'), '.pt', el => (el.dataset.q ? `<b>Query</b><br>${esc($('#query').value)}` : `<b>${points[+el.dataset.i].topic}</b><br>${esc(points[+el.dataset.i].text)}`));
  QUERIES.forEach(q => { const b = document.createElement('button'); b.className = 'chip-btn'; b.textContent = q; b.addEventListener('click', () => { $('#query').value = q; renderMap(); }); $('#qPresets').appendChild(b); });
  $('#search').addEventListener('click', renderMap);
  $('#query').addEventListener('keydown', e => { if (e.key === 'Enter') renderMap(); });
  $('#addSent').addEventListener('click', () => {
    const t = $('#query').value.trim(); if (!t || points.some(p => p.text === t)) return;
    points.push({ text: t, topic: 'Your sentences', color: 'var(--faint)' }); renderMap();
  });

  // ---------- RAG ----------
  const HANDBOOK = `# Northwind Employee Handbook
## Annual leave
Full-time employees receive 25 days of paid annual leave per year, plus public holidays. Leave accrues monthly and up to 5 unused days can be carried into the next year. Book leave through the HR portal at least two weeks in advance for absences longer than three days.
## Sickness absence
If you are ill, tell your line manager before 10am on your first day of absence. You can self-certify for up to 7 calendar days. For longer absences, a fit note from a doctor is required. Company sick pay covers up to 20 working days per year at full salary.
## Expenses
Claim business expenses within 30 days using the Expenses app, with a photo of every receipt. Taxis are reimbursed only when public transport is unavailable or you are travelling between 10pm and 6am. Meals while travelling are covered up to £35 per day. Alcohol is never reimbursed.
## Travel
Book all flights and hotels through the travel desk. Economy class is standard for flights under six hours, and premium economy is allowed for longer flights. Hotels should cost no more than £180 per night in London and £140 per night elsewhere in the UK.
## Remote working
Employees may work remotely up to three days per week, agreed with their manager. Teams meet in the office every Tuesday. When working abroad, you may work remotely for a maximum of 20 days per year and must inform HR beforehand.
## Equipment
Every employee receives a laptop, a monitor and a headset. Report lost or stolen equipment to the IT service desk within 24 hours by calling extension 4400. Do not install unapproved software; request it through the IT portal instead.
## Information security
Lock your screen whenever you leave your desk. Never share your password, including with IT staff. Report suspicious emails using the Report Phishing button. Customer data must only be stored in approved systems and never on personal devices.
## Learning and development
Each employee has a learning budget of £1,000 per year for courses, books and conferences. Requests above £500 need approval from your manager. You also get five learning days per year.`;
  const RAG_Q = ['How many vacation days do I get?', 'Can I claim a taxi to the airport at 5am?', 'What should I do if I lose my laptop?', 'Can I work from Spain for a month?', "What's the hotel limit in Manchester?", 'Who won the 2022 World Cup?', 'Is there a £35 limit?', 'What happens between 10pm and 6am?', 'Can I self-certify?'];
  const SHORTLIST = 8, RRF_K = 60;
  // words with structure
  const W = [];
  HANDBOOK.split('\n').forEach((line, li) => {
    const heading = line.startsWith('#'), sec = line.startsWith('## ');
    const txt = line.replace(/^#+\s*/, '');
    txt.split(/\s+/).filter(Boolean).forEach((w, i, arr) => W.push({ w, heading, sectionStart: sec && i === 0, title: line.startsWith('# '), br: i === arr.length - 1 }));
  });
  function chunks() {
    const mode = $('#mode').value, out = [];
    if (mode === 'section') {
      let cur = null;
      W.forEach((w, i) => { if (w.sectionStart || i === 0) { cur = { start: i, end: i }; out.push(cur); } cur.end = i + 1; });
    } else {
      const size = +$('#size').value, step = Math.max(1, size - Math.round(size * (+$('#overlap').value) / 100));
      for (let s = 0; s < W.length; s += step) { out.push({ start: s, end: Math.min(W.length, s + size) }); if (s + size >= W.length) break; }
    }
    out.forEach((c, i) => { c.i = i; c.text = W.slice(c.start, c.end).map(w => w.w).join(' '); });
    return out;
  }
  // ---------- keyword search: BM25 ----------
  // Lower-case words. Amounts such as £1,000 and codes such as 4400 stay whole; common words are dropped.
  const terms = s => (s.toLowerCase().match(/[a-z0-9£]+(?:[.,][0-9]+)*/g) || []).filter(w => !STOP.has(w));
  function bm25(cs, q, k1 = 1.2, b = 0.75) {
    const docs = cs.map(c => terms(c.text));
    const N = docs.length, avg = docs.reduce((a, d) => a + d.length, 0) / N;
    const df = new Map();
    docs.forEach(d => new Set(d).forEach(t => df.set(t, (df.get(t) || 0) + 1)));
    const qt = [...new Set(terms(q))];
    docs.forEach((d, j) => {
      const tf = new Map();
      d.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
      let s = 0; const hit = [];
      qt.forEach(t => {
        const f = tf.get(t); if (!f) return;
        const n = df.get(t), idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * f * (k1 + 1) / (f + k1 * (1 - b + b * d.length / avg));
        hit.push(t);
      });
      cs[j].kw = s; cs[j].terms = hit;
    });
  }

  const METHOD = {
    embed: { key: 'emb', by: 'by meaning', name: 'meaning' },
    bm25: { key: 'kw', by: 'by keyword score', name: 'keywords' },
    hybrid: { key: 'rrf', by: 'by fused rank', name: 'hybrid search' }
  };
  function ruleText(m, K, th) {
    if (m === 'embed') return `<b>Rule for embeddings only:</b> rank chunks by meaning score and keep the top ${K} that reach the ${th} minimum.`;
    if (m === 'bm25') return `<b>Rule for keywords only:</b> rank chunks by BM25 and keep the top ${K} that share at least one keyword with the question. Common words such as "the" and "how" do not count. BM25 scores grow with the number and rarity of matching words and have no fixed scale, so the minimum similarity is switched off.`;
    return `<b>Rule for hybrid:</b> each chunk scores 1 ÷ (60 + meaning rank) + 1 ÷ (60 + keyword rank). A chunk with no shared keyword gets no keyword part. This is reciprocal rank fusion: a chunk near the top of either list rises, and the two kinds of score never need to be compared. Keep the top ${K} chunks that have some evidence: a meaning score of at least ${th}, or at least one shared keyword.`;
  }
  function syncLabels() {
    $('#vSize').textContent = $('#size').value; $('#vOv').textContent = $('#overlap').value + '%';
    $('#vK').textContent = $('#topk').value; $('#vTh').textContent = (+$('#thresh').value).toFixed(2);
    const fixed = $('#mode').value === 'fixed', m = $('#method').value;
    $('#size').disabled = $('#overlap').disabled = !fixed;
    $('#thresh').disabled = m === 'bm25';
    $('#thLabel').classList.toggle('off', m === 'bm25');
    $('#ruleNote').innerHTML = ruleText(m, $('#topk').value, (+$('#thresh').value).toFixed(2));
  }
  let ragBusy = false, ragPending = false;
  async function runRag() {
    if (!ready) return;
    if (ragBusy) { ragPending = true; return; }
    ragBusy = true; syncLabels();
    try { await retrieve(); } catch (e) { console.error(e); $('#rrInfo').textContent = 'Reranking failed: ' + (e.message || e); }
    ragBusy = false;
    if (ragPending) { ragPending = false; runRag(); }
  }
  async function retrieve() {
    const q = $('#ragQ').value.trim(), K = +$('#topk').value, th = +$('#thresh').value;
    const method = $('#method').value, key = METHOD[method].key;
    const cs = chunks();
    const vecs = await E.embed(cs.map(c => c.text));
    const [qv] = await E.embed([q || ' '], 'query');
    cs.forEach((c, i) => (c.emb = E.cosine(qv, vecs[i])));
    bm25(cs, q);
    cs.slice().sort((a, b) => b.emb - a.emb).forEach((c, r) => (c.eRank = r + 1));
    cs.filter(c => c.kw > 0).sort((a, b) => b.kw - a.kw).forEach((c, r) => (c.kRank = r + 1));
    cs.forEach(c => (c.rrf = 1 / (RRF_K + c.eRank) + (c.kRank ? 1 / (RRF_K + c.kRank) : 0)));
    const ranked = cs.slice().sort((a, b) => b[key] - a[key] || a.eRank - b.eRank);
    ranked.forEach((c, r) => (c.mRank = r + 1));
    const ok = c => (method === 'embed' ? c.emb >= th : method === 'bm25' ? c.kw > 0 : c.emb >= th || c.kw > 0);
    const passing = ranked.filter(ok);
    // optional second stage: a cross-encoder reorders the shortlist
    let order = ranked, final = passing, reranked = null, ms = 0;
    const wantRR = $('#rerank').checked;
    if (wantRR && Reranker.isReady() && passing.length) {
      const pool = passing.slice(0, SHORTLIST);
      const s = await Reranker.score(q || ' ', pool.map(c => c.text));
      ms = Reranker.lastRun().ms;
      pool.forEach((c, j) => (c.rr = s[j]));
      reranked = pool.slice().sort((a, b) => b.rr - a.rr);
      reranked.forEach((c, j) => (c.rrRank = j + 1));
      final = reranked.concat(passing.slice(SHORTLIST));
      order = reranked.concat(ranked.filter(c => !pool.includes(c)));
    }
    const hits = final.slice(0, K);
    hits.forEach((c, r) => (c.rank = r + 1));
    // document view
    const owner = W.map(() => []);
    cs.forEach(c => { for (let i = c.start; i < c.end; i++) owner[i].push(c); });
    let html = '';
    W.forEach((w, i) => {
      const startHits = hits.filter(c => c.start === i);
      startHits.forEach(c => (html += `<span class="badge" id="chunk${c.i}">${c.rank}</span>`));
      cs.filter(c => c.start === i && !c.rank).forEach(c => (html += `<span id="chunk${c.i}"></span>`));
      const own = owner[i], hit = own.some(c => c.rank);
      const cls = hit ? 'hit' : 'c' + (own[0] ? own[0].i % 2 : 0);
      html += `<span class="w ${cls}${w.heading ? ' h' : ''}">${esc(w.w)}</span>${w.br ? '<br>' : ' '}`;
    });
    $('#doc').innerHTML = html;
    // score list: the method's own score, plus both ranks so you can see why a chunk was picked
    const maxKw = Math.max(1e-9, ...cs.map(c => c.kw));
    const barW = c => (method === 'embed' ? c.emb : method === 'bm25' ? c.kw / maxKw : c.rrf * (RRF_K + 1) / 2);
    const val = c => (method === 'embed' ? c.emb.toFixed(2) : method === 'bm25' ? c.kw.toFixed(2) : c.rrf.toFixed(4));
    const fade = method === 'embed' ? `Faded rows fall below the ${th.toFixed(2)} minimum.` : method === 'bm25' ? 'Faded rows share no keyword with the question.' : `Faded rows have neither a meaning score of ${th.toFixed(2)} nor a shared keyword.`;
    $('#scoreTitle').textContent = `All ${cs.length} chunks, ranked ${METHOD[method].by}${reranked ? `, top ${reranked.length} reranked` : ''}`;
    $('#scores').innerHTML = order.map(c => `<div class="srow${c.rank ? ' hit' : ''}${ok(c) ? '' : ' below'}" data-i="${c.i}" title="Click to find in the document">
      <span class="mono">${c.rank ? '#' + c.rank : ''}</span><span class="bar" style="width:${Math.max(1, barW(c) * 100).toFixed(1)}%"></span><span class="mono">${val(c)}</span>
      <span class="why"><span>Meaning <b>#${c.eRank}</b> · ${c.emb.toFixed(2)}</span><span>Keywords ${c.kRank ? `<b>#${c.kRank}</b> · ${c.kw.toFixed(2)}${c.terms.map(t => ` <i>${esc(t)}</i>`).join('')}` : '<b>no match</b>'}</span>${c.rrRank ? `<span class="rr">Reranked <b>#${c.mRank} → #${c.rrRank}</b> · ${c.rr.toFixed(1)}</span>` : ''}</span>
      <span class="txt">${esc(c.text.slice(0, 110))}</span></div>`).join('') + `<p class="small muted" style="margin-top:6px">${fade}</p>`;
    // reranker status
    let info = '';
    if (wantRR && !Reranker.isReady()) info = 'Load the reranker to reorder the shortlist.';
    else if (wantRR && !passing.length) info = 'No chunk passed the rule above, so there is nothing to rerank.';
    else if (reranked) {
      const top = reranked[0];
      info = `Reranked ${reranked.length} chunk${reranked.length > 1 ? 's' : ''}${ms ? ` in ${Math.max(1, Math.round(ms))} ms` : ', reusing scores already computed for this question'}. ` +
        (top.mRank === 1 ? `The reranker agrees with ${METHOD[method].name} on the top chunk.` : `The chunk that ${METHOD[method].name} ranked #${top.mRank} is now #1.`) +
        ' Reranker scores are raw relevance scores: higher is better, and a large negative score means the model sees no match.';
    }
    $('#rrInfo').textContent = info;
    // assembled prompt
    const none = method === 'embed' ? `No chunk reached the ${th.toFixed(2)} minimum, so there is nothing reliable to give the model.`
      : method === 'bm25' ? 'No chunk shares a keyword with the question, so there is nothing to give the model.'
        : `No chunk reached the ${th.toFixed(2)} meaning minimum or shared a keyword, so there is nothing reliable to give the model.`;
    const body = hits.length
      ? `Answer the question using only the documents below. Cite the document number for each fact.\nIf the documents do not contain the answer, say you don't know.\n\n<span class="tag">&lt;documents&gt;</span>\n${hits.map(c => `<span class="tag">&lt;document index="${c.rank}" source="handbook, chunk ${c.i + 1}"&gt;</span>\n${esc(c.text)}\n<span class="tag">&lt;/document&gt;</span>`).join('\n')}\n<span class="tag">&lt;/documents&gt;</span>\n\n<span class="q">Question: ${esc(q)}</span>`
      : `<span class="q">${none}\nBest practice: skip the call, or answer "I couldn't find that in the handbook."</span>`;
    $('#assembled').innerHTML = body;
    const wc = hits.reduce((a, c) => a + (c.end - c.start), 0);
    $('#assembledInfo').textContent = hits.length ? `${hits.length} of ${cs.length} chunks retrieved, about ${wc} words of context instead of the whole ${W.length}-word handbook.` : '';
  }
  $('#scores').addEventListener('click', e => { const r = e.target.closest('.srow'); if (!r) return; const t = document.getElementById('chunk' + r.dataset.i); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  RAG_Q.forEach(q => { const b = document.createElement('button'); b.className = 'chip-btn'; b.textContent = q; b.addEventListener('click', () => { $('#ragQ').value = q; runRag(); }); $('#ragPresets').appendChild(b); });
  $('#ragGo').addEventListener('click', runRag);
  $('#ragQ').addEventListener('keydown', e => { if (e.key === 'Enter') runRag(); });
  ['mode', 'size', 'overlap', 'topk', 'thresh', 'method'].forEach(id => $('#' + id).addEventListener('input', () => { syncLabels(); runRag(); }));
  let rrGate = false;
  $('#rerank').addEventListener('change', () => {
    const on = $('#rerank').checked;
    if (on && !rrGate) {
      rrGate = true;
      Site.modelGate($('#rrGate'), {
        title: 'MS MARCO reranker', sizeMB: Reranker.sizeMB, autoKey: 'reranker-loaded', isReady: Reranker.isReady,
        what: 'It is a small cross-encoder that reads a question and a chunk together and scores how well they match.',
        loader: cb => Reranker.load(cb),
        onReady: runRag
      });
    }
    $('#rrGate').hidden = !on;
    runRag();
  });
  syncLabels();

  Site.modelGate($('#gate'), {
    title: 'MiniLM embedding model', sizeMB: 23, autoKey: 'minilm-loaded', isReady: Embedder.isReady,
    what: 'It turns each sentence into 384 numbers. It is a small model built only for embeddings, not for writing text.',
    loader: cb => Embedder.load(cb),
    onReady: async () => { if (E !== Embedder) return; ready = true; $('#lab').classList.remove('locked'); await renderMap(); runRag(); }
  });

  // ---------- which model embeds ----------
  // The open model in Docker Model Runner is offered when the backend has one (LLM_LAB_LOCAL_EMBED_MODEL). Scores from
  // different models are on different scales, so each has its own starting minimum similarity.
  const MIN_SIM = { browser: 0.3, local: 0.55 };
  const showDims = () => root.querySelectorAll('[data-dims]').forEach(el => (el.textContent = E.dims || '…'));
  async function useModel(which) {
    E = which === 'local' ? LocalEmbedder : Embedder;
    ready = E.isReady();
    $('#lab').classList.toggle('locked', !ready);
    $('#gate').hidden = which === 'local';
    $('#thresh').value = MIN_SIM[which];
    $('#embedNote').textContent = which === 'local'
      ? `${LocalEmbedder.model} runs in Docker Model Runner on this machine: free, and the text never leaves it. Its scores run higher than MiniLM's, so the minimum similarity starts at ${MIN_SIM.local}.`
      : 'MiniLM runs in this browser tab.';
    syncLabels(); showDims();
    if (!ready) return;
    try { await renderMap(); showDims(); runRag(); } catch (e) { console.error(e); $('#embedNote').textContent = 'The local model did not answer: ' + (e.message || e); }
  }
  LocalEmbedder.info().then(info => {
    if (!info.configured || !root.isConnected) return;
    const local = $('#embedModel').querySelector('option[value="local"]');
    local.textContent = `${info.model} (local Docker, free)`;
    if (!LocalEmbedder.isReady()) {
      local.disabled = true;
      $('#embedNote').textContent = info.running ? `The local server does not have ${info.model}: run ./tools/local-model.sh --embed.` : 'The local model server is not running: start Docker Desktop, then reload.';
    }
    $('#embedChoice').hidden = false;
  });
  $('#embedModel').addEventListener('change', e => useModel(e.target.value));
}
