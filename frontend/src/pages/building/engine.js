import { GPT2 } from '@/lib/gpt2';
import { Site } from '@/lib/site';

/** Runs the page's interactive parts. Returns nothing; `life` undoes timers and listeners on unmount. */
export function mount(root, life) {
  const { $, $$, esc, fmtInt } = Site;

  // ---------- 1. pipeline ----------
  const STAGES = [
    { name: 'Collect and clean data', what: 'Gather text from web pages, books, code and other sources, then filter it hard. Most of a web crawl is boilerplate, spam or duplicates.', in: 'Billions of crawled pages and other documents.', out: 'Trillions of tokens of cleaned, deduplicated text.', scale: 'Llama 3 was pretrained on over 15 trillion tokens.', you: 'What is rare or missing in the data is what the model gets wrong, and its knowledge stops at the date the data was collected.', link: ['#data', 'Try section 2'] },
    { name: 'Pretrain', what: 'Train a transformer to predict the next token across all of that text. Nearly all of the compute goes here.', in: 'The cleaned token stream.', out: 'A base model. It continues documents but does not reliably follow instructions.', scale: 'Meta reports 6.4 million H100 GPU-hours for Llama 3 70B.', you: 'Facts seen rarely in training are recalled poorly, which is one source of confident made-up answers.', link: ['training.html', 'See training in the Training lab'] },
    { name: 'Supervised fine-tuning', what: 'Continue training on example conversations: an instruction and a good response, with the loss only on the response.', in: 'Thousands to hundreds of thousands of example conversations.', out: 'A model that follows the chat format and answers questions.', scale: 'The LIMA study showed about 1,000 carefully chosen examples can already teach the format.', you: 'A few examples in your prompt work for the same reason: they show the format the model was tuned on.', link: ['#sft', 'Try section 4'] },
    { name: 'Preference tuning', what: 'Show the model pairs of answers and teach it which one people prefer, using RLHF with a reward model or DPO directly on the pairs.', in: 'Pairs of answers ranked by people, or by models checked against people.', out: 'An assistant tuned towards answers that are helpful, honest and harmless.', scale: 'Far less data than pretraining, but it shapes the behaviour you notice most.', you: 'Tone, length, hedging and refusals come from here. Ask explicitly if you need a different style.', link: ['#pref', 'Try section 4'] },
    { name: 'Evaluate', what: 'Measure perplexity on held-out text, scores on benchmark suites, head-to-head comparisons judged by people or models, and safety testing.', in: 'Held-out data, benchmarks, human and model judges.', out: 'Release decisions and published scores.', scale: 'Benchmarks can leak into training data and inflate scores.', you: 'Public scores rarely match your task. Build your own eval before choosing a model.', link: ['evals.html', 'Open the Evals lab'] },
    { name: 'Serve', what: 'Run the model for users: lower-precision weights, batching many requests together, and caching.', in: 'The trained weights.', out: 'An API with a price per token, a latency and a context limit.', scale: 'Serving cost depends on model size and context length far more than on training cost.', you: 'Price per token, latency and context limits all come from choices made here.', link: ['context.html', 'Open the Context & cost lab'] }
  ];
  let stage = 0;
  function renderPipe() {
    $('#pipe').innerHTML = STAGES.map((s, i) => `${i ? '<span class="arrow" aria-hidden="true">›</span>' : ''}<button data-i="${i}" class="${i === stage ? 'on' : ''}"><b>${i + 1}</b>${s.name}</button>`).join('');
    const s = STAGES[stage];
    $('#stageCard').innerHTML = `<h3 style="margin-top:0">${stage + 1}. ${s.name}</h3><p>${s.what}</p>
      <div class="stage-grid"><div><h4>Goes in</h4>${s.in}</div><div><h4>Comes out</h4>${s.out}</div><div><h4>Scale</h4>${s.scale}</div><div><h4>Why it matters to you</h4>${s.you}</div></div>
      <p class="small" style="margin:10px 0 0"><a href="${s.link[0]}">${s.link[1]}</a></p>`;
  }
  $('#pipe').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { stage = +b.dataset.i; renderPipe(); } });
  renderPipe();

  // ---------- 2. data pipeline ----------
  const BEES = 'Honeybees pollinate around a third of the crops we eat. As a bee collects nectar, pollen sticks to the fine hairs on its body and is carried to the next flower it visits. Some plants, such as almonds, depend almost entirely on bees. Farmers often rent hives during the flowering season, and beekeepers move colonies hundreds of miles to follow the bloom. Wild bees matter too: bumblebees can shake pollen loose by vibrating their flight muscles, a trick honeybees cannot perform.';
  const DOCS = [
    { url: 'beekeeping-weekly.example/how-bees-pollinate', text: `Home | Shop | Blog | Contact\nWe use cookies to improve your experience. Accept cookies?\n${BEES}\n© 2024 Beekeeping Weekly. All rights reserved.\nShare on Facebook | Share on X` },
    { url: 'news-aggregator.example/science/bees', text: `Menu | Science | Tech | Login\n${BEES}\nRelated stories | Sign up for our newsletter` },
    { url: 'garden-tips.example/pollination', text: `Home | Guides | Contact\n${BEES.replace('Wild bees matter too: bumblebees can shake pollen loose by vibrating their flight muscles, a trick honeybees cannot perform.', 'Gardeners can help by planting flowers that bloom at different times of year, so bees find food from spring to autumn.')}\n© 2023 Garden Tips` },
    { url: 'best-cheap-shoes.example', text: 'cheap shoes cheap shoes best cheap shoes buy cheap shoes online discount shoes cheap shoes sale cheap shoes free delivery cheap shoes cheap trainers cheap shoes for men cheap shoes for women cheap shoes deals cheap shoes cheap shoes best price shoes cheap shoes uk cheap shoes cheap shoes cheap shoes today cheap shoes cheap shoes offer cheap shoes cheap shoes now' },
    { url: 'old-site.example/missing-page', text: '404 Not Found\nThe page you requested could not be found.' },
    { url: 'boulangerie-paris.example/notre-histoire', text: "Notre boulangerie a ouvert ses portes en 1952 dans une petite rue du onzième arrondissement. Chaque matin, nos boulangers préparent la pâte avant l'aube et cuisent les baguettes au feu de bois. Nous utilisons une farine issue de moulins familiaux et un levain que nous entretenons depuis plus de soixante ans. Les habitants du quartier viennent chercher leur pain avant d'aller travailler, et le dimanche la file d'attente s'étend souvent jusqu'au coin de la rue." },
    { url: 'code-snippets.example/python-sum', text: 'def total(xs):\n    s = 0\n    for x in xs:\n        s += x\n    return s\n\nprint(total([1, 2, 3]))  # 6\nassert total([]) == 0\nnums = [n * 2 for n in range(10) if n % 2 == 0]\nprint(nums)' },
    { url: 'diy-forum.example/thread/4412', text: "Posted by dave_k in Woodwork\nHas anyone fixed a wobbly oak table where the leg joint has worked loose? I tried wood glue last year but it only lasted a few months. A friend suggested drilling out the old dowels and fitting new ones, which sounds like the right approach but I am nervous about splitting the leg. If anyone has done this and can talk me through it, email me at dave.k@example.com or call 07700 900123 in the evenings. Thanks in advance for any advice you can share." },
    { url: 'shop.example/product/red-kettle', text: '• Product: Electric kettle\n• Colour: Red\n• Capacity: 1.7 litres\n• Power: 3000 W\n• Price: £24.99\n• Delivery: 2 to 3 days\n• Rating: 4.6 out of 5\n• In stock: Yes\n• Warranty: 2 years\n• Returns: 30 days' },
    { url: 'placeholder-site.example', text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.' },
    { url: 'home-cooking.example/lentil-soup', text: 'Recipes | Seasonal | About\nThis lentil soup is cheap, filling and ready in forty minutes. Soften a chopped onion, two carrots and a stick of celery in olive oil for ten minutes. Add two crushed garlic cloves and a teaspoon of cumin, then stir in 250 grams of red lentils and a litre of vegetable stock. Simmer for twenty-five minutes until the lentils collapse, season with salt and lemon juice, and blend half of it if you like a thicker texture. It keeps well in the fridge for three days.\nPrint recipe | Save to favourites' },
    { url: 'news-site.example/latest', text: 'Council approves new cycle lanes on the high street and ...\nLocal bakery wins regional award for its sourdough ...\nSchool sports day moved indoors because of rain ...\nLibrary extends opening hours over the summer ...\nRoadworks expected to finish by the end of the month ...\nReader letters: parking charges and ...\nWeather: a mild and dry weekend ahead ...' },
    { url: 'history-of-maps.example/portolan-charts', text: 'Home | Articles | Shop\nPortolan charts were the first maps drawn mainly for sailors rather than scholars. They appeared in the Mediterranean in the late thirteenth century and were drawn on single sheets of vellum. Instead of lines of latitude and longitude, they used a web of compass lines radiating from points around the edge, which let a navigator read off a course between two ports. Their coastlines are strikingly accurate, which suggests they were built up from many measured voyages rather than copied from older maps.\nCookie settings | Privacy policy' }
  ];
  const STEPS = [
    ['extract', 'Extract text'], ['lang', 'English only'], ['rules', 'Quality rules'],
    ['exact', 'Exact duplicates'], ['near', 'Near-duplicates'], ['score', 'Quality score'], ['pii', 'Redact personal data']
  ];
  const on = Object.fromEntries(STEPS.map(([k]) => [k, true]));
  $('#stepToggles').innerHTML = STEPS.map(([k, label], i) => `<label><input type="checkbox" data-k="${k}" checked> ${i + 1}. ${label}</label>`).join('');
  const BOILER = [/\|/, /cookie/i, /©|all rights reserved/i, /^share on/i, /sign up for/i, /^related stories/i, /^print recipe/i, /privacy policy/i];
  // Tiny language identifier: counts function words from each language. Real pipelines use trained classifiers such as fastText.
  const LANGS = {
    English: new Set('the be to of and a in that have it for on with as is are was this you at by from or not but can which their its were so they we'.split(' ')),
    French: new Set('le la les de des du et un une en est nous que qui dans pour par au aux sur ses son leur'.split(' ')),
    Latin: new Set('et in ut ad ex id est sed non qui cum quis eu enim nisi sunt'.split(' '))
  };
  function detectLang(t) {
    const w = words(t).map(x => x.toLowerCase().replace(/[^a-zà-ÿ']/g, ''));
    const scores = Object.entries(LANGS).map(([name, set]) => [name, w.filter(x => set.has(x)).length]).sort((a, b) => b[1] - a[1]);
    return scores[0][1] === 0 ? ['unknown', 0] : scores[0];
  }
  const GOPHER_STOP = ['the', 'be', 'to', 'of', 'and', 'that', 'have', 'with'];
  const words = t => t.split(/\s+/).filter(Boolean);
  const norm = t => t.toLowerCase().replace(/[^a-z0-9à-ÿ\s]/g, ' ').replace(/\s+/g, ' ').trim();
  function shingles(t, k = 5) {
    const w = norm(t).split(' '), s = new Set();
    for (let i = 0; i + k <= w.length; i++) s.add(w.slice(i, i + k).join(' '));
    return s;
  }
  const jaccard = (a, b) => { let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter || 1); };
  function qualityRules(t) {
    const w = words(t), lines = t.split('\n').filter(l => l.trim());
    const lw = w.map(x => x.toLowerCase().replace(/[^a-z']/g, ''));
    const bullets = lines.filter(l => /^\s*[•\-*]/.test(l)).length / lines.length;
    if (bullets > 0.9) return `${Math.round(bullets * 100)}% of lines start with a bullet, so it is a list, not prose`;
    const ell = lines.filter(l => /(\.\.\.|…)\s*$/.test(l)).length / lines.length;
    if (ell > 0.3) return `${Math.round(ell * 100)}% of lines end with an ellipsis, a sign of truncated teasers`;
    const alpha = w.filter(x => /[a-zà-ÿ]/i.test(x)).length / w.length;
    if (alpha < 0.8) return `only ${Math.round(alpha * 100)}% of words contain a letter; the rule needs 80%`;
    if (w.length < 50) return `only ${w.length} words; the rule needs at least 50`;
    const counts = {}; lw.forEach(x => { if (x) counts[x] = (counts[x] || 0) + 1; });
    const topWord = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (topWord && topWord[1] / w.length > 0.15) return `"${topWord[0]}" makes up ${Math.round(100 * topWord[1] / w.length)}% of the words, which is spam-like repetition`;
    const meanLen = w.reduce((a, x) => a + x.length, 0) / w.length;
    if (meanLen < 3 || meanLen > 10) return `average word length ${meanLen.toFixed(1)}, outside 3 to 10`;
    const stops = GOPHER_STOP.filter(s => lw.includes(s)).length;
    if (stops < 2) return `only ${stops} of the common words "${GOPHER_STOP.join(', ')}"`;
    return null;
  }
  // A transparent stand-in for a trained quality classifier: rewards complete,
  // well-formed sentences of a sensible length and plain declarative prose.
  function qualityScore(t) {
    const sents = t.split(/(?<=[.!?])\s+/).filter(s => words(s).length > 2);
    if (!sents.length) return 0;
    const avg = words(t).length / sents.length;
    const lenScore = Math.max(0, 1 - Math.abs(avg - 20) / 20);
    const firstPerson = (t.match(/\b(I|I'm|my|me)\b/g) || []).length / words(t).length;
    const caps = sents.filter(s => /^[A-Z]/.test(s)).length / sents.length;
    const contact = /(@|\b\d{5}\s?\d{6}\b|call\b)/i.test(t) ? 1 : 0;
    return Math.max(0, Math.min(1, 0.55 * lenScore + 0.3 * caps + 0.15 - 2.5 * firstPerson - 0.25 * contact));
  }
  const PII = [[/[\w.+-]+@[\w-]+\.[\w.]+/g, '[EMAIL]'], [/\b0\d{4}\s?\d{6}\b/g, '[PHONE]']];
  let selDoc = 0;
  function runPipeline() {
    const nearT = +$('#near').value, qualT = +$('#qual').value;
    $('#vNear').textContent = nearT.toFixed(2); $('#vQual').textContent = qualT.toFixed(2);
    const res = DOCS.map(d => ({ ...d, lines: d.text.split('\n'), removedLines: [], clean: d.text, status: 'keep', at: null, why: '', redacted: false }));
    res.forEach(r => {
      if (on.extract) { r.removedLines = r.lines.filter(l => BOILER.some(rx => rx.test(l))); r.clean = r.lines.filter(l => !r.removedLines.includes(l)).join('\n'); }
      r.score = qualityScore(r.clean);
    });
    const alive = () => res.filter(r => r.status === 'keep');
    const drop = (r, at, why) => { r.status = 'drop'; r.at = at; r.why = why; };
    const counts = [['Crawled', res.length, res.reduce((a, r) => a + words(r.text).length, 0)]];
    if (on.extract) counts.push(['Extract text', res.length, res.reduce((a, r) => a + words(r.clean).length, 0)]);
    if (on.lang) {
      alive().forEach(r => { const [lang, n] = detectLang(r.clean); if (lang !== 'English' && lang !== 'unknown') drop(r, 'English only', `detected as ${lang}, from ${n} common ${lang} words`); });
      counts.push(['English only', alive().length, alive().reduce((a, r) => a + words(r.clean).length, 0)]);
    }
    if (on.rules) {
      alive().forEach(r => { const why = qualityRules(r.clean); if (why) drop(r, 'Quality rules', why); });
      counts.push(['Quality rules', alive().length, alive().reduce((a, r) => a + words(r.clean).length, 0)]);
    }
    if (on.exact) {
      const seen = new Map();
      alive().forEach(r => { const k = norm(r.clean); if (seen.has(k)) drop(r, 'Exact duplicates', `same text as ${seen.get(k)}`); else seen.set(k, r.url); });
      counts.push(['Exact duplicates', alive().length, alive().reduce((a, r) => a + words(r.clean).length, 0)]);
    }
    if (on.near) {
      const kept = [];
      alive().forEach(r => {
        const sh = shingles(r.clean);
        const hit = kept.map(k => ({ k, j: jaccard(sh, k.sh) })).sort((a, b) => b.j - a.j)[0];
        if (hit && hit.j >= nearT) drop(r, 'Near-duplicates', `${Math.round(hit.j * 100)}% of its five-word phrases also appear in ${hit.k.url}`);
        else kept.push({ url: r.url, sh });
      });
      counts.push(['Near-duplicates', alive().length, alive().reduce((a, r) => a + words(r.clean).length, 0)]);
    }
    if (on.score) {
      alive().forEach(r => { if (r.score < qualT) drop(r, 'Quality score', `score ${r.score.toFixed(2)} is below ${qualT.toFixed(2)}`); });
      counts.push(['Quality score', alive().length, alive().reduce((a, r) => a + words(r.clean).length, 0)]);
    }
    if (on.pii) {
      alive().forEach(r => { let t = r.clean; PII.forEach(([rx, rep]) => { t = t.replace(rx, rep); }); if (t !== r.clean) { r.redacted = true; r.clean = t; } });
      counts.push(['Redact personal data', alive().length, alive().reduce((a, r) => a + words(r.clean).length, 0)]);
    }
    drawFunnel(counts);
    const kept = alive();
    $('#funnelNote').textContent = `${kept.length} of ${res.length} pages survive, carrying ${fmtInt(counts[counts.length - 1][2])} of the ${fmtInt(counts[0][2])} crawled words.`;
    $('#docs').innerHTML = res.map((r, i) => `<div class="doc${i === selDoc ? ' sel' : ''}" data-i="${i}" role="button" tabindex="0">
        <div class="url">${esc(r.url)}</div><div class="snip">${esc(r.clean.replace(/\n/g, ' '))}</div>
        ${r.status === 'keep' ? `<span class="tag keep">Kept</span>${r.redacted ? ' <span class="tag redact">Redacted</span>' : ''}` : `<span class="tag drop">Removed: ${esc(r.at)}</span>`}
        <span class="small muted"> · quality ${r.score.toFixed(2)}</span></div>`).join('');
    showDoc(res[selDoc]);
    lastRes = res;
  }
  let lastRes = null;
  function showDoc(r) {
    const raw = r.lines.map(l => r.removedLines.includes(l) ? `<del>${esc(l)}</del>` : esc(l)).join('\n');
    const clean = esc(r.clean).replace(/\[(EMAIL|PHONE)\]/g, '<mark>[$1]</mark>');
    $('#docDetail').innerHTML = `<div class="detail"><div><b class="small">Before</b> <span class="small muted">${esc(r.url)}. Struck-through lines are boilerplate.</span><pre>${raw}</pre></div>
      <div><b class="small">After</b> <span class="small muted">${r.status === 'keep' ? 'Kept for training.' : 'Removed at ' + esc(r.at) + ': ' + esc(r.why) + '.'}</span><pre>${r.status === 'keep' ? clean : '<span class="muted">Not in the training data.</span>'}</pre></div></div>`;
  }
  function drawFunnel(counts) {
    const W = 720, rowH = 28, top = 6, left = 160, right = 150;
    const H = top + counts.length * rowH + 6;
    $('#funnel').setAttribute('viewBox', `0 0 ${W} ${H}`);
    const max = counts[0][1];
    $('#funnel').innerHTML = counts.map(([name, n, w], i) => {
      const y = top + i * rowH, bw = Math.max(2, (W - left - right) * n / max);
      return `<g class="fn" data-i="${i}"><text x="${left - 8}" y="${y + 17}" text-anchor="end" style="fill:var(--ink2);font-size:12px">${name}</text>
        <path d="M${left} ${y + 4} H${left + bw - 4} Q${left + bw} ${y + 4} ${left + bw} ${y + 8} V${y + 20} Q${left + bw} ${y + 24} ${left + bw - 4} ${y + 24} H${left} Z" fill="var(--s1)"></path>
        <text x="${left + bw + 8}" y="${y + 18}" style="fill:var(--ink2);font-size:12px">${n} pages · ${fmtInt(w)} words</text>
        <rect x="0" y="${y}" width="${W}" height="${rowH}" fill="transparent"></rect></g>`;
    }).join('');
  }
  Site.bindTips($('#funnel'), '.fn', el => { const i = +el.dataset.i; return `<b>${$$('#funnel .fn')[i].querySelector('text').textContent}</b><br>${$$('#funnel .fn')[i].querySelectorAll('text')[1].textContent}`; });
  $('#stepToggles').addEventListener('change', e => { on[e.target.dataset.k] = e.target.checked; runPipeline(); });
  ['near', 'qual'].forEach(id => $('#' + id).addEventListener('input', runPipeline));
  $('#docs').addEventListener('click', e => { const d = e.target.closest('.doc'); if (!d) return; selDoc = +d.dataset.i; $$('#docs .doc').forEach(x => x.classList.toggle('sel', x === d)); showDoc(lastRes[selDoc]); });
  $('#docs').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('doc')) e.target.click(); });
  runPipeline();

  // ---------- 3. scaling laws ----------
  const FIT = { E: 1.8172, A: 482.01, B: 2085.43, a: 0.3478, b: 0.3658 }; // Epoch AI 2024 re-fit of Chinchilla
  const loss = (N, D) => FIT.E + FIT.A / Math.pow(N, FIT.a) + FIT.B / Math.pow(D, FIT.b);
  const G = Math.pow((FIT.a * FIT.A) / (FIT.b * FIT.B), 1 / (FIT.a + FIT.b));
  const optN = C => G * Math.pow(C / 6, FIT.b / (FIT.a + FIT.b));
  const PRESETS = {
    'GPT-3 (175B, 300B tokens)': [175e9, 300e9],
    'Chinchilla (70B, 1.4T tokens)': [70e9, 1.4e12],
    'Llama 2 70B (2T tokens)': [70e9, 2e12],
    'Llama 3 8B (15T tokens)': [8e9, 15e12, 1.3e6],
    'Llama 3 70B (15T tokens)': [70e9, 15e12, 6.4e6]
  };
  $('#preset').innerHTML = Object.keys(PRESETS).map((k, i) => `<option ${i === 1 ? 'selected' : ''}>${k}</option>`).join('') + '<option>Custom</option>';
  const human = n => n >= 1e12 ? +(n / 1e12).toFixed(n >= 1e13 ? 0 : 1) + 'T' : n >= 1e9 ? +(n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B' : +(n / 1e6).toFixed(0) + 'M';
  const sci = x => { const e = Math.floor(Math.log10(x)); return `${(x / Math.pow(10, e)).toFixed(1)} × 10<sup>${e}</sup>`; };
  function applyPreset() { const p = PRESETS[$('#preset').value]; if (!p) return; $('#logN').value = Math.log10(p[0]); $('#logD').value = Math.log10(p[1]); renderScale(); }
  function renderScale() {
    const N = Math.pow(10, +$('#logN').value), D = Math.pow(10, +$('#logD').value);
    const tfl = +$('#tflops').value || 1, mfu = +$('#mfu').value / 100, gpus = Math.max(1, +$('#gpus').value || 1), price = +$('#gpuPrice').value || 0;
    $('#vN').textContent = human(N); $('#vD').textContent = human(D) + ' tokens'; $('#vMfu').textContent = Math.round(mfu * 100) + '%';
    const C = 6 * N * D, gpuHours = C / (tfl * 1e12 * mfu) / 3600, days = gpuHours / gpus / 24;
    const No = optN(C), Do = C / 6 / No;
    const stats = [
      [sci(C), 'training compute, in FLOPs'],
      [(D / N).toFixed(0), 'tokens per parameter; compute-optimal is about 20'],
      [loss(N, D).toFixed(3), `predicted loss; the best split of this compute gives ${loss(No, Do).toFixed(3)}`],
      [fmtInt(gpuHours), 'GPU-hours at this utilisation'],
      [days < 2 ? (days * 24).toFixed(0) + ' h' : days.toFixed(0) + ' days', `on ${fmtInt(gpus)} GPUs`],
      ['$' + fmtInt(gpuHours * price), 'compute cost at the GPU price above']
    ];
    $('#scaleStats').innerHTML = stats.map(([v, k]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join('');
    const ratio = D / N, p = PRESETS[$('#preset').value];
    let verdict = `For this much compute, the fitted law's best split is about <b>${human(No)} parameters on ${human(Do)} tokens</b>. `;
    verdict += ratio < 10 ? 'This model is <b>under-trained</b>: a smaller model trained on more tokens would reach a lower loss for the same compute.'
      : ratio > 40 ? 'This model is trained <b>well past compute-optimal</b>. Its training compute buys less loss than it could, but the model is small for its quality, so every request costs less to serve.'
      : 'This is close to <b>compute-optimal</b>.';
    if (p && p[2]) {
      const eff = C / (tfl * 1e12 * p[2] * 3600);
      verdict += ` Meta reports ${human(p[2]).replace('B', ' billion').replace('M', ' million')} H100 GPU-hours for this model. With the GPU peak above, that implies an effective utilisation of about ${Math.round(eff * 100)}% by this formula, and more if training used over 15 trillion tokens. Real runs lose time to restarts, evaluation and experiments.`;
    }
    $('#scaleVerdict').innerHTML = verdict;
    drawScale(C, N, D);
  }
  const SERIES = [[125e6, 'var(--s1)', '125M parameters'], [1.3e9, 'var(--s2)', '1.3B parameters'], [13e9, 'var(--s3)', '13B parameters'], [130e9, 'var(--s4)', '130B parameters']];
  const X0 = 18, X1 = 26, Y0 = 1.85, Y1 = 4.2;
  function drawScale(C, N, D) {
    const W = 720, H = 320, l = 50, r = 14, t = 12, b = 34, pw = W - l - r, ph = H - t - b;
    const sx = c => l + (Math.log10(c) - X0) / (X1 - X0) * pw, sy = y => t + (1 - (Math.min(Y1, Math.max(Y0, y)) - Y0) / (Y1 - Y0)) * ph;
    let s = '';
    for (let e = X0; e <= X1; e++) s += `<line x1="${sx(10 ** e)}" x2="${sx(10 ** e)}" y1="${t}" y2="${t + ph}" stroke="var(--line)"></line><text x="${sx(10 ** e)}" y="${H - 16}" text-anchor="middle">10<tspan dy="-5" font-size="9">${e}</tspan></text>`;
    for (let y = 2; y <= 4; y += 0.5) s += `<line x1="${l}" x2="${W - r}" y1="${sy(y)}" y2="${sy(y)}" stroke="var(--line)"></line><text x="${l - 6}" y="${sy(y) + 4}" text-anchor="end">${y.toFixed(1)}</text>`;
    s += `<text x="${l + pw / 2}" y="${H - 2}" text-anchor="middle">training compute, FLOPs</text><text x="12" y="${t + ph / 2}" transform="rotate(-90 12 ${t + ph / 2})" text-anchor="middle">loss</text>`;
    SERIES.forEach(([n, col]) => {
      const pts = [];
      for (let e = X0; e <= X1; e += 0.05) { const c = 10 ** e, d = c / (6 * n); if (d < 1e8) continue; const y = loss(n, d); if (y <= Y1) pts.push(`${sx(c).toFixed(1)},${sy(y).toFixed(1)}`); }
      if (pts.length) s += `<polyline fill="none" stroke="${col}" stroke-width="2" points="${pts.join(' ')}"></polyline>`;
    });
    const fr = []; for (let e = X0; e <= X1; e += 0.1) { const c = 10 ** e, no = optN(c); fr.push(`${sx(c).toFixed(1)},${sy(loss(no, c / 6 / no)).toFixed(1)}`); }
    s += `<polyline fill="none" stroke="var(--ink2)" stroke-width="1.5" stroke-dasharray="5 4" points="${fr.join(' ')}"></polyline>`;
    if (Math.log10(C) >= X0 && Math.log10(C) <= X1) s += `<circle cx="${sx(C)}" cy="${sy(loss(N, D))}" r="6" fill="var(--brand)" stroke="var(--surface)" stroke-width="2"></circle>`;
    s += `<line id="xh" x1="0" x2="0" y1="${t}" y2="${t + ph}" stroke="var(--muted)" stroke-dasharray="3 3" opacity="0"></line><rect id="hit" x="${l}" y="${t}" width="${pw}" height="${ph}" fill="transparent"></rect>`;
    $('#scaleChart').innerHTML = s;
    $('#scaleLegend').innerHTML = SERIES.map(([, c, name]) => `<span style="--c:${c}">${name}</span>`).join('') + '<span class="dash" style="--c:var(--ink2)">Best size for each budget</span><span class="sq" style="--c:var(--brand)">Your model</span>';
    const svg = $('#scaleChart'), hit = $('#hit'), xh = $('#xh');
    hit.addEventListener('mousemove', e => {
      const box = svg.getBoundingClientRect(), x = (e.clientX - box.left) / box.width * W;
      const c = 10 ** (X0 + (x - l) / pw * (X1 - X0)); xh.setAttribute('x1', x); xh.setAttribute('x2', x); xh.setAttribute('opacity', 1);
      const no = optN(c);
      Site.tip(`<b>${sci(c)} FLOPs</b><br>${SERIES.map(([n, , name]) => { const d = c / (6 * n); return d >= 1e8 ? `${name}: loss ${loss(n, d).toFixed(2)} on ${human(d)} tokens` : `${name}: too little data`; }).join('<br>')}<br>Best split: ${human(no)} parameters, loss ${loss(no, c / 6 / no).toFixed(2)}`, e);
    });
    hit.addEventListener('mouseleave', () => { xh.setAttribute('opacity', 0); Site.tip(null); });
  }
  $('#preset').addEventListener('change', applyPreset);
  ['logN', 'logD'].forEach(id => $('#' + id).addEventListener('input', () => { $('#preset').value = 'Custom'; renderScale(); }));
  ['tflops', 'mfu', 'gpus', 'gpuPrice'].forEach(id => $('#' + id).addEventListener('input', renderScale));
  applyPreset();

  // ---------- 4a. base model behaviour (GPT-2) ----------
  const BASE = [
    { label: 'Haiku', instr: 'Write a haiku about the sea.', doc: 'Three haiku about the sea.\n\nWaves fold into foam,\ngulls hang on the salted wind,\nthe tide pulls the sand.\n\n' },
    { label: 'Capital city', instr: 'What is the capital of France?', doc: 'Q: What is the capital of Italy?\nA: Rome.\n\nQ: What is the capital of France?\nA:' },
    { label: 'Email', instr: 'Write a short email declining a meeting.', doc: 'Subject: Re: Tuesday meeting\n\nHi Sam,\n\nThank you for the invitation to Tuesday\'s planning meeting. Unfortunately' }
  ];
  let baseSel = 0, gptReady = false, busy = false;
  BASE.forEach((p, i) => { const b = document.createElement('button'); b.className = 'chip-btn' + (i === 0 ? ' on' : ''); b.textContent = p.label; b.addEventListener('click', () => { baseSel = i; $$('#basePresets .chip-btn').forEach(x => x.classList.toggle('on', x === b)); runBase(); }); $('#basePresets').appendChild(b); });
  async function greedy(prompt, n = 30) {
    const ids = GPT2.encode(prompt), out = [];
    for (let i = 0; i < n; i++) {
      const l = Float32Array.from(await GPT2.nextLogits(ids.concat(out)));
      for (const id of new Set(out)) l[id] = l[id] > 0 ? l[id] / 1.3 : l[id] * 1.3;
      let best = 0; for (let j = 1; j < l.length; j++) if (l[j] > l[best]) best = j;
      if (best === 50256) break;
      out.push(best);
    }
    const text = GPT2.decodeMany(out);
    return text.trim() ? text : '\n[GPT-2 ended the document here. It treated the instruction as a complete text.]';
  }
  async function runBase() {
    if (!gptReady || busy) return;
    busy = true;
    const p = BASE[baseSel];
    $('#genInstr').innerHTML = `<span class="p">${esc(p.instr)}</span><span class="muted"> …</span>`;
    $('#genDoc').innerHTML = `<span class="p">${esc(p.doc)}</span><span class="muted"> …</span>`;
    $('#genInstr').innerHTML = `<span class="p">${esc(p.instr)}</span>${esc(await greedy(p.instr))}`;
    $('#genDoc').innerHTML = `<span class="p">${esc(p.doc)}</span>${esc(await greedy(p.doc))}`;
    busy = false;
  }

  // ---------- 4b. SFT loss mask ----------
  async function runSft() {
    if (!gptReady || busy) return;
    busy = true; $('#sftRun').disabled = true;
    const prefix = `User: ${$('#sftUser').value.trim()}\nAssistant:`, resp = ' ' + $('#sftAsst').value.trim();
    const pIds = GPT2.encode(prefix), rIds = GPT2.encode(resp).slice(0, 40);
    const rows = [];
    for (let i = 0; i < rIds.length; i++) {
      const pr = GPT2.softmax(await GPT2.nextLogits(pIds.concat(rIds.slice(0, i))), 1)[rIds[i]];
      rows.push({ id: rIds[i], p: pr, loss: -Math.log(Math.max(pr, 1e-12)) });
    }
    const avg = rows.reduce((a, r) => a + r.loss, 0) / rows.length, mx = Math.max(...rows.map(r => r.loss));
    const chip = (id, cls, style, title) => `<span class="tk ${cls}" style="${style}" title="${esc(title)}">${esc(GPT2.decode(id)).replace(/\n/g, '↵')}</span>`;
    $('#sftOut').innerHTML = `<div>${pIds.map(id => chip(id, 'prompt', '', 'Prompt token: no loss')).join('')}${rows.map(r => chip(r.id, '', `background:rgba(235,104,52,${(0.1 + 0.85 * r.loss / mx).toFixed(2)})`, `GPT-2 gave this token ${(r.p * 100).toFixed(1)}%, loss ${r.loss.toFixed(2)}`)).join('')}</div>
      <div class="stats"><div class="stat"><div class="v">${pIds.length}</div><div class="k">prompt tokens, no loss</div></div><div class="stat"><div class="v">${rows.length}</div><div class="k">response tokens, trained on</div></div>
      <div class="stat"><div class="v">${avg.toFixed(2)}</div><div class="k">average loss on the response; perplexity ${Math.exp(avg).toFixed(1)}</div></div></div>
      <p class="small muted">Darker means more surprising to the base model. Hover a token for its probability. Fine-tuning lowers this loss across thousands of examples, and the model ends each answer with a special end-of-turn token it also learns to predict.</p>`;
    busy = false; $('#sftRun').disabled = false;
  }
  $('#sftRun').addEventListener('click', runSft);

  // ---------- 4c. preference toy ----------
  const PAIRS = [
    { q: 'How many days are in a leap year?', a: { t: '366.', correct: 1 }, b: { t: 'Great question! A leap year is a fascinating part of our calendar system. Every four years, with a few exceptions, we add an extra day to February, which gives us a total of 366 days rather than the usual 365.', correct: 1 } },
    { q: 'What is the boiling point of water at sea level in Celsius?', a: { t: 'Water boils at 100 °C at sea level.', correct: 1 }, b: { t: 'That is a wonderful thing to ask about! Water is an amazing substance, and its boiling point depends on many factors, but in most everyday situations you can expect it to boil somewhere around 90 °C or so.', correct: 0 } },
    { q: 'Who wrote Pride and Prejudice?', a: { t: 'Charlotte Brontë wrote it in 1813, and it remains one of the most beloved novels in the English language, admired for its wit and its memorable heroine.', correct: 0 }, b: { t: 'Jane Austen, published in 1813.', correct: 1 } },
    { q: 'Is it safe to leave cooked rice out overnight?', a: { t: 'Not really. Bacteria can grow on rice left at room temperature, so cool it within an hour and keep it in the fridge.', correct: 1 }, b: { t: 'I think it might be fine in most cases, though it could perhaps depend on various factors such as the temperature of your kitchen, so you may want to consider it.', correct: 0 } },
    { q: 'What does HTTP stand for?', a: { t: 'Hypertext Transfer Protocol.', correct: 1 }, b: { t: 'Thank you so much for asking! HTTP is one of the foundational technologies of the modern web, and it stands for Hypertext Transfer Protocol, which defines how browsers and servers exchange messages.', correct: 1 } },
    { q: 'How many continents are there?', a: { t: 'Seven, in the most common convention: Africa, Antarctica, Asia, Australia, Europe, North America and South America.', correct: 1 }, b: { t: 'There are nine continents, and each one has its own unique geography, culture and history that make it a wonderful place to learn about.', correct: 0 } },
    { q: 'What is 15% of 200?', a: { t: 'It might be around 25, but I am not completely certain about that.', correct: 0 }, b: { t: '30.', correct: 1 } },
    { q: 'Can I use a USB-C cable to charge a laptop?', a: { t: 'Often, yes, if the laptop charges over USB-C and the cable and charger support enough power. Check the wattage your laptop needs.', correct: 1 }, b: { t: 'Absolutely, what a great question! USB-C is a truly versatile standard that works with every single laptop ever made, so you can plug any cable into any laptop and it will always charge perfectly.', correct: 0 } }
  ];
  const FEATS = [
    ['words', 'Length, per 25 words', t => t.split(/\s+/).length / 25],
    ['correct', 'Is correct', (t, x) => x.correct],
    ['flattery', 'Flattering opener', t => /great question|wonderful|thank you so much|fascinating|amazing/i.test(t) ? 1 : 0],
    ['hedge', 'Hedging', t => /\b(might|perhaps|I think|not completely|may want|could)\b/i.test(t) ? 1 : 0],
    ['concise', 'Under 20 words', t => t.split(/\s+/).length < 20 ? 1 : 0]
  ];
  const feat = x => FEATS.map(([, , f]) => f(x.t, x));
  const choice = PAIRS.map(() => null);
  function renderPairs() {
    $('#prefPairs').innerHTML = PAIRS.map((p, i) => `<div class="prompt-q">${i + 1}. ${esc(p.q)}</div><div class="pref">
      ${['a', 'b'].map(k => `<label><input type="radio" name="pp${i}" value="${k}" ${choice[i] === k ? 'checked' : ''}>${esc(p[k].t)}</label>`).join('')}</div>`).join('');
  }
  $('#prefPairs').addEventListener('change', e => { const m = e.target.name.match(/pp(\d+)/); if (m) { choice[+m[1]] = e.target.value; fitReward(); } });
  function fillRater(kind) {
    PAIRS.forEach((p, i) => {
      if (kind === 'careful') choice[i] = p.a.correct !== p.b.correct ? (p.a.correct ? 'a' : 'b') : (p.a.t.length <= p.b.t.length ? 'a' : 'b');
      else choice[i] = p.a.t.length >= p.b.t.length ? 'a' : 'b';
    });
    renderPairs(); fitReward();
  }
  $('#raterCareful').addEventListener('click', () => fillRater('careful'));
  $('#raterLong').addEventListener('click', () => fillRater('long'));
  $('#raterClear').addEventListener('click', () => { choice.fill(null); renderPairs(); fitReward(); });
  const NEW = { q: 'What is the chemical symbol for gold?', answers: [
    { t: 'Au.', correct: 1 },
    { t: 'Great question! Gold has fascinated people for thousands of years, and its chemical symbol is Au, which comes from the Latin word aurum. It is a dense, soft and highly valued metal used in jewellery and electronics.', correct: 1 },
    { t: 'What a wonderful question! Gold is one of the most amazing elements in the periodic table, and its chemical symbol is Ag, which reflects its long and fascinating history in human culture and trade.', correct: 0 }
  ] };
  function fitReward() {
    const data = PAIRS.map((p, i) => choice[i] && { w: feat(p[choice[i]]), l: feat(p[choice[i] === 'a' ? 'b' : 'a']) }).filter(Boolean);
    $('#newQ').textContent = `New question: ${NEW.q}`;
    if (data.length < 3) { $('#weights').innerHTML = '<p class="muted small">Answer at least three pairs.</p>'; $('#ranked').innerHTML = ''; return; }
    const w = new Array(FEATS.length).fill(0), lr = 0.5, l2 = 0.05;
    for (let it = 0; it < 800; it++) {
      const g = new Array(w.length).fill(0);
      data.forEach(d => {
        const diff = d.w.map((x, j) => x - d.l[j]), z = diff.reduce((a, x, j) => a + x * w[j], 0), p = 1 / (1 + Math.exp(-z));
        diff.forEach((x, j) => (g[j] += (p - 1) * x));
      });
      w.forEach((_, j) => (w[j] -= lr * (g[j] / data.length + l2 * w[j])));
    }
    const mx = Math.max(...w.map(Math.abs), 0.5);
    $('#weights').innerHTML = FEATS.map(([, name], j) => `<div class="wbar"><span>${name}</span><span class="track"><i class="${w[j] >= 0 ? 'pos' : 'neg'}" style="width:${(50 * Math.abs(w[j]) / mx).toFixed(1)}%"></i></span><span class="mono">${w[j] >= 0 ? '+' : ''}${w[j].toFixed(2)}</span></div>`).join('')
      + `<p class="small muted" style="margin-top:8px">Blue weights raise the reward, orange lower it. Fitted on your ${data.length} choices.</p>`;
    const scored = NEW.answers.map(a => ({ ...a, r: feat(a).reduce((s, x, j) => s + x * w[j], 0) })).sort((a, b) => b.r - a.r);
    $('#ranked').innerHTML = scored.map((a, i) => `<li><b class="score">${a.r >= 0 ? '+' : ''}${a.r.toFixed(2)}</b>${i === 0 ? '<b>Top: </b>' : ''}${esc(a.t)} <span class="tag ${a.correct ? 'keep' : 'drop'}">${a.correct ? 'correct' : 'wrong'}</span></li>`).join('')
      + (scored[0].correct ? '' : '<li style="border-color:var(--bad)"><b>Reward hacking.</b> The reward model learned to like long, flattering answers, so a wrong answer now outscores the right one. A model optimised against this reward would learn to pad and flatter.</li>');
  }
  renderPairs(); fitReward();

  // ---------- 6. memory ----------
  const MEM_SERIES = [['weights', 'Weights', 'var(--s1)'], ['grads', 'Gradients', 'var(--s2)'], ['opt', 'Optimiser state', 'var(--s3)'], ['adapters', 'Adapters, all training state', 'var(--s4)']];
  function renderMem() {
    const N = +$('#memN').value, mode = $('#memMode').value, ad = +$('#adPct').value / 100, gpu = +$('#gpuMem').value * 1e9;
    $('#vAd').textContent = (ad * 100).toFixed(1) + '% of parameters';
    $('#adPct').disabled = !(mode === 'lora' || mode === 'qlora');
    const parts = { weights: 0, grads: 0, opt: 0, adapters: 0 };
    if (mode.startsWith('inf')) parts.weights = N * { inf16: 2, inf8: 1, inf4: 0.5 }[mode];
    else if (mode === 'full') { parts.weights = N * 2; parts.grads = N * 2; parts.opt = N * 12; }
    else { parts.weights = N * (mode === 'lora' ? 2 : 0.5); parts.adapters = N * ad * 16; }
    const total = Object.values(parts).reduce((a, b) => a + b, 0), gb = x => x / 1e9;
    $('#memBar').innerHTML = MEM_SERIES.filter(([k]) => parts[k] > 0).map(([k, name, c]) => `<i style="flex:0 0 ${(100 * parts[k] / total).toFixed(2)}%;background:${c}" title="${name}: ${gb(parts[k]).toFixed(1)} GB"></i>`).join('');
    $('#memLegend').innerHTML = MEM_SERIES.filter(([k]) => parts[k] > 0).map(([k, name, c]) => `<span class="sq" style="--c:${c}">${name} ${gb(parts[k]).toFixed(gb(parts[k]) < 10 ? 1 : 0)} GB</span>`).join('');
    const bpp = total / N;
    $('#memStats').innerHTML = `<div class="stat"><div class="v">${gb(total) < 10 ? gb(total).toFixed(1) : fmtInt(gb(total))} GB</div><div class="k">before activations</div></div>
      <div class="stat"><div class="v">${bpp.toFixed(bpp < 1 ? 2 : 1)}</div><div class="k">bytes per parameter</div></div>
      <div class="stat"><div class="v">${Math.max(1, Math.ceil(total / (gpu * 0.9)))}</div><div class="k">GPUs of ${$('#gpuMem').value} GB, at 90% full, at minimum</div></div>`;
  }
  ['memN', 'memMode', 'adPct', 'gpuMem'].forEach(id => $('#' + id).addEventListener('input', renderMem));
  renderMem();

  // ---------- model gate ----------
  Site.modelGate($('#gate'), {
    title: 'GPT-2', sizeMB: 128, autoKey: 'gpt2-loaded', isReady: GPT2.isReady,
    what: 'The base-model and fine-tuning demos below use it.',
    loader: cb => GPT2.load(cb),
    onReady: async () => { gptReady = true; $('#gptLab').classList.remove('locked'); await runBase(); runSft(); }
  });
}
