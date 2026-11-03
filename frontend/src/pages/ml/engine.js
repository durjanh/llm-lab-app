import { Site } from '@/lib/site';
import { __ML } from './ml';
import { __ML_ALGOS } from './ml-algos';

/** Runs the page's interactive parts. Returns nothing; `life` undoes timers and listeners on unmount. */
export function mount(root, life) {
  const { requestAnimationFrame } = life;  // stopped when you leave the page
  const { $, $$, esc } = Site;
  const A = __ML_ALGOS, byId = Object.fromEntries(A.map(a => [a.id, a]));
  const GROUPS = ['Predict a number', 'Predict a category', 'Find groups', 'Simplify data', 'Spot anomalies', 'Images and grids', 'Sequences'];

  // ---------- picker ----------
  $('#algoGroups').innerHTML = GROUPS.map(g => `<div class="algo-group"><h3>${g}</h3><div class="algo-btns">${A.filter(a => a.group === g).map(a => `<button data-id="${a.id}">${esc(a.name)}</button>`).join('')}</div></div>`).join('');
  $('#algoGroups').addEventListener('click', e => { const b = e.target.closest('button[data-id]'); if (b) select(b.dataset.id, true); });

  // ---------- demo environment ----------
  let current = null;
  function makeEnv() {
    const ac = new AbortController();
    let raf = null, themeFns = [];
    const env = {
      plot: $('#plotArea'), ctrl: $('#controls'), readout: $('#readout'), extra: $('#extra'), signal: ac.signal,
      loop(fn, onDone, every = 1) {
        cancelAnimationFrame(raf); let f = 0;
        const tick = () => { if (f++ % every === 0 && fn() === false) { onDone && onDone(); return; } raf = requestAnimationFrame(tick); };
        raf = requestAnimationFrame(tick);
      },
      onTheme(fn) { themeFns.push(fn); },
      plotClick(fn) { const p = env.plot._plot; if (p) p.cv.addEventListener('click', e => fn(p.toData(e)), { signal: ac.signal }); },
      plotMove(fn) { const p = env.plot._plot; if (!p) return; p.cv.addEventListener('mousemove', e => fn(p.toData(e)), { signal: ac.signal }); p.cv.addEventListener('mouseleave', () => fn(null), { signal: ac.signal }); },
      legend(K, withHeldOut) {
        const t = __ML.theme(), names = ['Blue class', 'Orange class', 'Aqua class'];
        env.legendCustom(names.slice(0, K).map((n, k) => [t.cls[k], n]), withHeldOut ? 'Filled markers are training points; hollow ones are held out for testing. Shading shows the prediction, stronger where the model is surer.' : '');
      },
      legendCustom(items, note) {
        let el = $('#plotLegend'); if (!el) { el = document.createElement('div'); el.id = 'plotLegend'; $('#plotArea').after(el); }
        el.innerHTML = (items.length ? `<div class="legend">${items.map(([c, n]) => `<span style="--c:${c}">${esc(n)}</span>`).join('')}</div>` : '') + (note ? `<p class="small muted" style="margin:4px 0 0">${note}</p>` : '');
      },
      destroy() { cancelAnimationFrame(raf); ac.abort(); themeFns = []; },
      fireTheme() { themeFns.forEach(f => f()); }
    };
    return env;
  }
  life.on(document, 'themechange', () => current && current.env.fireTheme());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => current && current.env.fireTheme());

  function list(items) { return `<ul>${items.map(x => `<li>${x}</li>`).join('')}</ul>`; }
  function select(id, scroll) {
    const a = byId[id] || A[0];
    if (current) current.env.destroy();
    $$('#algoGroups button').forEach(b => b.classList.toggle('on', b.dataset.id === a.id));
    ['#controls', '#readout', '#extra'].forEach(s => ($(s).innerHTML = ''));
    const leg = $('#plotLegend'); if (leg) leg.innerHTML = '';
    $('#info').innerHTML = `<div class="kicker">${a.family} · ${a.group}</div><h2>${esc(a.name)}</h2><p>${a.how}</p>
      <div class="formula">${esc(a.formula)}</div>
      <div class="facts"><div><h4>Use it for</h4>${list(a.best)}</div><div><h4>Avoid it when</h4>${list(a.avoid)}</div><div><h4>Real-world examples</h4>${list(a.examples)}</div></div>
      <div class="ai-link"><b>Where it shows up in AI today.</b> ${a.ai}</div>`;
    const env = makeEnv();
    current = { a, env };
    a.demo(env);
    try { history.replaceState(history.state, '', '#' + a.id); } catch (e) { /* file:// may block */ }
    if (scroll) $('#plotArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- helper ----------
  const GOALS = { yes: [['number', 'Predict a number'], ['category', 'Predict a category']], no: [['groups', 'Find groups'], ['simplify', 'Simplify or visualise many columns'], ['anomaly', 'Spot unusual cases']] };
  const RULES = {
    'number|table': [['gbm', 'Usually the most accurate on tabular data'], ['forest', 'Accurate with little tuning'], ['linear', 'Explainable baseline; start here']],
    'number|text': [['transformer', 'Fine-tune or embed with a pretrained model, then predict'], ['linear', 'Linear model on text embeddings as a baseline']],
    'number|image': [['cnn', 'Learns visual features directly'], ['transformer', 'Vision transformers, given enough data or a pretrained model']],
    'number|seq': [['gbm', 'With lagged values as features, often a strong forecaster'], ['rnn', 'Step-by-step models for streaming data'], ['transformer', 'For long, complex sequences with plenty of data']],
    'category|table': [['gbm', 'Usually the most accurate on tabular data'], ['forest', 'Accurate with little tuning'], ['logistic', 'Explainable baseline with probabilities'], ['tree', 'When the rules must be readable']],
    'category|text': [['nb', 'Very fast baseline on word counts'], ['logistic', 'Strong on word features or embeddings'], ['transformer', 'Most accurate; fine-tune a pretrained model or use an LLM']],
    'category|image': [['cnn', 'The classic choice for images'], ['transformer', 'Vision transformers, especially pretrained ones'], ['knn', 'Nearest neighbours on image embeddings for small label sets']],
    'category|seq': [['transformer', 'Best on long sequences'], ['rnn', 'Lightweight, step-by-step'], ['gbm', 'With summary features of the sequence']],
    'groups|table': [['kmeans', 'Fast, round clusters; you choose how many'], ['dbscan', 'Any shape, flags noise, finds the count itself'], ['hier', 'Small data where the nested structure helps']],
    'groups|text': [['kmeans', 'On sentence embeddings, quick topic groups'], ['dbscan', 'On embeddings, finds topics and leaves out odd documents'], ['hier', 'Topic hierarchies for browsing']],
    'groups|image': [['kmeans', 'On image embeddings'], ['dbscan', 'On image embeddings, with noise detection']],
    'groups|seq': [['kmeans', 'On features summarising each sequence'], ['dbscan', 'On those features, with outliers flagged']],
    'simplify|table': [['pca', 'Fast, linear, easy to explain'], ['autoenc', 'Non-linear structure, more data needed']],
    'simplify|text': [['pca', 'Project embeddings to 2D for a map'], ['autoenc', 'Learned compression']],
    'simplify|image': [['autoenc', 'Learned compression of images'], ['pca', 'Classic linear compression']],
    'simplify|seq': [['pca', 'On windows of the sequence'], ['autoenc', 'Learned compression of patterns']],
    'anomaly|table': [['autoenc', 'Flags rows it cannot reconstruct'], ['dbscan', 'Points in no dense region are noise'], ['knn', 'Distance to nearest neighbours as a score']],
    'anomaly|text': [['dbscan', 'Documents far from every topic'], ['autoenc', 'Reconstruction error on embeddings']],
    'anomaly|image': [['autoenc', 'Images it reconstructs badly'], ['knn', 'Distance to known-good examples']],
    'anomaly|seq': [['autoenc', 'Windows it reconstructs badly'], ['rnn', 'Large errors when predicting the next step']]
  };
  const PREF = { explain: ['linear', 'logistic', 'tree', 'nb', 'kmeans', 'pca', 'hier'], small: ['linear', 'logistic', 'nb', 'knn', 'tree', 'hier', 'pca'], speed: ['linear', 'logistic', 'nb', 'kmeans', 'pca', 'knn'], accuracy: ['gbm', 'forest', 'transformer', 'cnn', 'mlp', 'autoenc'] };
  function renderHelper() {
    const lab = $('#hLabels').value, cur = $('#hGoal').value;
    $('#hGoal').innerHTML = GOALS[lab].map(([v, t]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${t}</option>`).join('');
    const key = `${$('#hGoal').value}|${$('#hData').value}`, pri = PREF[$('#hPri').value];
    const recs = (RULES[key] || []).slice().sort((a, b) => (pri.includes(b[0]) ? 1 : 0) - (pri.includes(a[0]) ? 1 : 0));
    $('#recs').innerHTML = recs.map(([id, why], i) => `<li><button class="btn small" data-id="${id}">Try it</button><b>${i + 1}. ${esc(byId[id].name)}</b><br><span class="small muted">${why}${pri.includes(id) && $('#hPri').value !== 'accuracy' ? '. Fits your priority.' : ''}</span></li>`).join('') || '<li>No suggestion for this combination.</li>';
  }
  ['#hLabels', '#hGoal', '#hData', '#hPri'].forEach(s => $(s).addEventListener('change', renderHelper));
  $('#recs').addEventListener('click', e => { const b = e.target.closest('button[data-id]'); if (b) select(b.dataset.id, true); });
  renderHelper();

  // ---------- comparison table ----------
  let fam = 'All';
  function renderTable() {
    $('#cmpFilter').innerHTML = ['All', 'Supervised', 'Unsupervised', 'Deep learning'].map(f => `<button class="chip-btn${f === fam ? ' on' : ''}" data-f="${f}">${f}</button>`).join('');
    $('#cmpTable').innerHTML = `<thead><tr><th>Algorithm</th><th>Family</th><th>Best for</th><th>How it decides</th><th>Watch out for</th><th>Real-world use</th></tr></thead><tbody>${A.filter(a => fam === 'All' || a.family === fam).map(a => `<tr><td><a href="#${a.id}" data-id="${a.id}">${esc(a.name)}</a></td><td>${a.family}</td>${a.row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
  }
  $('#cmpFilter').addEventListener('click', e => { const b = e.target.closest('button[data-f]'); if (b) { fam = b.dataset.f; renderTable(); } });
  $('#cmpTable').addEventListener('click', e => { const l = e.target.closest('a[data-id]'); if (l) { e.preventDefault(); select(l.dataset.id, true); } });
  renderTable();

  select((location.hash || '').slice(1) || 'logistic');
}
