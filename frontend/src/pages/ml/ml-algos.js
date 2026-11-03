import { Site } from '@/lib/site';
import { __ML } from './ml';
const { $, $$, esc, mulberry32 } = Site;
const M = __ML;
const { Plot, Controls, makeData, DATA, pct, accuracy, dataOptions, sigmoid, softmax, buildTree, treeProba, treeText, leaves, buildRegTree, regTreeVal, MLP, lineChart, theme, rgba, gauss } = M;

// ---------- shared classifier demo ----------
// cfg: { datasets, data, params(ctrl), fit(train, P, K, rng) -> { proba } | iterative: init(...) -> { step(n), proba, loss } }
function classifier(env, cfg) {
  let plot, train, test, model, K, frame = 0;
  const ctrl = Controls(env.ctrl, key => { if (key === 'data' || key === 'n' || cfg.refit?.includes(key) || !cfg.live?.includes(key)) rebuild(); else draw(); });
  ctrl.select('data', 'Dataset', dataOptions(cfg.datasets), cfg.data).range('n', 'Training points', 40, 300, 10, 160);
  cfg.params(ctrl);
  if (cfg.init) ctrl.button('Retrain', () => rebuild(), true);
  plot = Plot(env.plot, { label: cfg.label });
  function rebuild() {
    const P = ctrl.vals, ds = P.data;
    K = DATA[ds].K;
    train = makeData(ds, 7, P.n); test = makeData(ds, 99, 200);
    if (cfg.init) { model = cfg.init(train, P, K, mulberry32(3)); frame = 0; env.loop(() => { model.step(cfg.stepsPerFrame || 5); frame++; if (frame % 2 === 0) draw(10); return frame < (cfg.frames || 200); }, () => draw()); }
    else { model = cfg.fit(train, P, K, mulberry32(3)); draw(); }
  }
  function draw(res = 6) {
    const t = theme();
    plot.clear(); plot.region(model.proba, K, res);
    if (cfg.decorate) cfg.decorate(plot, model, train, ctrl.vals, t);
    plot.points(test, { hollow: true, r: 3.5 }); plot.points(train);
    const tr = accuracy(train, model.proba), te = accuracy(test, model.proba);
    env.readout.innerHTML = `<span>Training accuracy <b>${pct(tr)}</b></span><span>Held-out accuracy <b>${pct(te)}</b></span>${tr - te > 0.08 ? '<span style="color:var(--bad)">Large gap: overfitting</span>' : ''}${model.loss ? `<span>Loss <b>${model.loss().toFixed(3)}</b></span>` : ''}${cfg.extraReadout ? cfg.extraReadout(model, ctrl.vals) : ''}`;
    env.legend(K, true);
    if (cfg.after) cfg.after(env, model, ctrl.vals, train, test);
  }
  env.redraw = () => draw();
  env.onTheme(() => draw());
  rebuild();
}

// ---------- algorithms ----------
const A = [];
const add = a => A.push(a);

add({ id: 'linear', name: 'Linear regression', family: 'Supervised', group: 'Predict a number',
  how: 'Draws the straight line, or flat surface when there are more inputs, that keeps the squared vertical distance to the points as small as possible. Training nudges the slope and intercept downhill on that error. Click the plot to add a point and watch one outlier drag the line.',
  formula: 'y = b₀ + b₁x₁ + b₂x₂ + …\nminimise  Σ (yᵢ − ŷᵢ)²',
  best: ['Predicting a number when the relationship is roughly straight', 'Quick, explainable baselines', 'Seeing which inputs move the result'],
  avoid: ['Strongly curved relationships', 'Data with big outliers, since squared error lets one point drag the line'],
  examples: ['House prices from size and location', 'Demand forecasting', 'Estimating delivery times'],
  ai: 'Scaling laws, like the one in the <a href="/building">How LLMs are built</a> lab, are straight-line fits on a log-log scale. Linear probes, a single linear layer trained on a model\'s embeddings, are a standard way to test what a model has learned.',
  row: ['Predicting a number', 'Weighted sum of the inputs', 'Curves and outliers', 'House prices, demand forecasts'],
  demo(env) {
    let pts, w = 0, b = 0, extraPts = [];
    const plot = Plot(env.plot, { label: 'Scatter with fitted line' });
    const ctrl = Controls(env.ctrl, key => { if (key === 'noise') { gen(); fit(); } else fit(); });
    ctrl.range('noise', 'Noise', 0, 0.5, 0.01, 0.15).range('lr', 'Learning rate', 0.01, 1, 0.01, 0.3)
      .button('Add an outlier', () => { extraPts.push({ x: 0.9, y: -0.9 }); fit(); }).button('Reset', () => { extraPts = []; gen(); fit(); });
    function gen() { const r = mulberry32(11); pts = Array.from({ length: 40 }, () => { const x = r() * 2 - 1; return { x, y: 0.55 * x - 0.1 + gauss(r) * ctrl.vals.noise }; }); }
    const all = () => pts.concat(extraPts);
    function closed() { const P = all(), n = P.length, mx = P.reduce((a, p) => a + p.x, 0) / n, my = P.reduce((a, p) => a + p.y, 0) / n; const sxy = P.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0), sxx = P.reduce((a, p) => a + (p.x - mx) ** 2, 0); const b1 = sxy / sxx; return [b1, my - b1 * mx]; }
    function fit() {
      w = 0; b = 0; let it = 0;
      env.loop(() => {
        const P = all(), n = P.length; let gw = 0, gb = 0;
        for (let s = 0; s < 3; s++) { gw = 0; gb = 0; P.forEach(p => { const e = w * p.x + b - p.y; gw += e * p.x; gb += e; }); w -= ctrl.vals.lr * gw / n * 2; b -= ctrl.vals.lr * gb / n * 2; }
        draw(); return ++it < 120;
      }, draw);
    }
    function draw() {
      const t = theme(), P = all(), mse = P.reduce((a, p) => a + (w * p.x + b - p.y) ** 2, 0) / P.length, [cw, cb] = closed();
      plot.clear();
      P.forEach(p => plot.line(p.x, p.y, p.x, w * p.x + b, rgba(t.muted, 0.5), 1));
      plot.line(-1.3, w * -1.3 + b, 1.3, w * 1.3 + b, t.cls[1], 2.5);
      pts.forEach(p => plot.marker(p.x, p.y, 'circle', t.cls[0], t.surface));
      extraPts.forEach(p => plot.marker(p.x, p.y, 'diamond', t.bad, t.surface, 6));
      env.readout.innerHTML = `<span>Line <b>y = ${w.toFixed(2)}x ${b >= 0 ? '+' : '−'} ${Math.abs(b).toFixed(2)}</b></span><span>Mean squared error <b>${mse.toFixed(4)}</b></span><span>Exact solution <b>y = ${cw.toFixed(2)}x ${cb >= 0 ? '+' : '−'} ${Math.abs(cb).toFixed(2)}</b></span>`;
      env.legendCustom([[t.cls[0], 'Data'], [t.cls[1], 'Fitted line'], [t.bad, 'Outliers you added'], [t.muted, 'Errors being squared']]);
    }
    env.plotClick(pt => { extraPts.push(pt); fit(); });
    env.onTheme(draw);
    gen(); fit();
  } });

add({ id: 'logistic', name: 'Logistic regression', family: 'Supervised', group: 'Predict a category',
  how: 'Computes a weighted sum like linear regression, then squashes it through the sigmoid into a probability between 0 and 1. The 50% boundary is a straight line, unless you add extra features such as squares and products, which lets the same model draw curves.',
  formula: 'P(y = 1) = 1 / (1 + e^−(b₀ + b₁x₁ + b₂x₂))\nloss: cross-entropy',
  best: ['Yes-or-no decisions with sensible probabilities', 'A strong, explainable baseline for text and tabular data'],
  avoid: ['Curved boundaries, unless you engineer features', 'Many inputs that interact in complicated ways'],
  examples: ['Spam or not spam', 'Will a customer cancel', 'Click prediction for adverts'],
  ai: 'An LLM\'s final layer is a multinomial logistic regression: a weighted sum for every token in the vocabulary, then softmax. The reward model in the <a href="/building#pref">How LLMs are built</a> lab uses the same logistic loss on preference pairs.',
  row: ['Yes-or-no decisions', 'Weighted sum through a sigmoid', 'Curved boundaries', 'Spam filters, churn prediction'],
  demo(env) {
    classifier(env, { datasets: ['linear', 'moons', 'circles', 'xor'], data: 'linear', label: 'Logistic regression decision regions', frames: 220, stepsPerFrame: 8, refit: ['poly', 'l2'],
      params: c => c.select('poly', 'Features', [['lin', 'x and y only'], ['poly', 'Add x², y² and x·y']], 'lin').range('l2', 'Regularisation', 0, 0.1, 0.005, 0.001),
      init(train, P) {
        const phi = (x, y) => P.poly === 'poly' ? [x, y, x * x, y * y, x * y] : [x, y];
        const w = new Array(phi(0, 0).length).fill(0); let b = 0, L = 0;
        return {
          step(n) { for (let s = 0; s < n; s++) { const g = w.map(() => 0); let gb = 0; L = 0; train.forEach(p => { const f = phi(p.x, p.y), pr = sigmoid(f.reduce((a, v, j) => a + v * w[j], b)); const e = pr - p.c; f.forEach((v, j) => (g[j] += e * v)); gb += e; L -= Math.log(Math.max(p.c ? pr : 1 - pr, 1e-12)); }); w.forEach((_, j) => (w[j] -= 1.5 * (g[j] / train.length + P.l2 * w[j]))); b -= 1.5 * gb / train.length; L /= train.length; } },
          proba: (x, y) => { const p = sigmoid(phi(x, y).reduce((a, v, j) => a + v * w[j], b)); return [1 - p, p]; },
          loss: () => L, w, b: () => b
        };
      },
      extraReadout: m => `<span>Weights <b>${m.w.map(v => v.toFixed(1)).join(', ')}</b></span>` });
  } });

add({ id: 'tree', name: 'Decision tree', family: 'Supervised', group: 'Predict a category',
  how: 'Asks a sequence of yes-or-no questions, such as "is x below 0.3?". Each question is chosen to make the groups beneath it as pure as possible, measured by Gini impurity. Deep trees fit the training data perfectly and generalise poorly: raise the depth and watch the gap open.',
  formula: 'choose the split that minimises\nweighted Gini = Σ (nₖ / n) · (1 − Σ pᵢ²)',
  best: ['Decisions that must be explained as rules', 'Mixed numeric and category inputs', 'Quick insight into which inputs matter'],
  avoid: ['Using one tree alone when accuracy matters', 'Unstable data: small changes can reshape the whole tree'],
  examples: ['Loan approval rules', 'Triage questionnaires', 'Support ticket routing'],
  ai: 'Trees are the building block of random forests and gradient boosting. Hand-written routing logic in AI products, such as which model or tool handles a request, is often a decision tree in disguise.',
  row: ['Explainable rules', 'A sequence of yes-or-no splits', 'Overfitting when deep', 'Loan approval, triage'],
  demo(env) {
    classifier(env, { datasets: ['moons', 'xor', 'blobs3', 'circles', 'spiral'], data: 'moons', label: 'Decision tree regions',
      params: c => c.range('depth', 'Maximum depth', 1, 12, 1, 3).range('minLeaf', 'Minimum points per leaf', 1, 20, 1, 2),
      fit: (train, P, K) => { const root = buildTree(train, K, P.depth, P.minLeaf); return { root, proba: (x, y) => treeProba(root, x, y) }; },
      extraReadout: m => `<span>Leaves <b>${leaves(m.root)}</b></span>`,
      after: (env, m, P) => { env.extra.innerHTML = `<div class="small muted" style="margin-top:6px">The rules this tree learned:</div><div class="tree-text">${esc(treeText(m.root, ['blue', 'orange', 'aqua']))}</div>`; } });
  } });

add({ id: 'forest', name: 'Random forest', family: 'Supervised', group: 'Predict a category',
  how: 'Trains many decision trees, each on a random resample of the data and with a random input considered at each split, then averages their votes. Each tree overfits in its own way, and averaging cancels much of it out. Compare one tree with fifty.',
  formula: 'P(class | x) = (1 / T) Σₜ treeₜ(x)\neach tree: bootstrap sample + random features per split',
  best: ['Strong accuracy on tabular data with little tuning', 'Noisy data', 'Built-in measures of which inputs matter'],
  avoid: ['When you need one readable rule', 'Tight latency budgets with very large forests'],
  examples: ['Fraud detection', 'Credit risk', 'Predicting equipment failure from sensors'],
  ai: 'Often used to score or filter data around AI systems, such as flagging risky transactions before or after a model call, where a fast and well-understood model is safer than a generative one.',
  row: ['Accurate tabular models', 'Many random trees vote', 'Less interpretable, larger', 'Fraud detection, credit risk'],
  demo(env) {
    classifier(env, { datasets: ['moons', 'xor', 'blobs3', 'circles', 'spiral'], data: 'moons', label: 'Random forest regions',
      params: c => c.range('trees', 'Trees', 1, 60, 1, 25).range('depth', 'Depth of each tree', 1, 12, 1, 6),
      fit: (train, P, K, rng) => {
        const trees = Array.from({ length: P.trees }, () => buildTree(Array.from({ length: train.length }, () => train[Math.floor(rng() * train.length)]), K, P.depth, 1, rng));
        return { proba: (x, y) => { const s = new Array(K).fill(0); trees.forEach(t => treeProba(t, x, y).forEach((v, j) => (s[j] += v / trees.length))); return s; } };
      } });
  } });

add({ id: 'gbm', name: 'Gradient boosting', family: 'Supervised', group: 'Predict a category',
  how: 'Builds small trees one after another. Each new tree is fitted to the errors the ensemble is still making and added with a small learning rate. More rounds fit the training data better; eventually held-out accuracy stops improving, which the chart below shows.',
  formula: 'F₀ = log-odds of the base rate\nFₘ(x) = Fₘ₋₁(x) + η · treeₘ(x)\neach tree fits the gradient of the loss',
  best: ['Top accuracy on spreadsheet-style data', 'Ranking and scoring problems'],
  avoid: ['Tiny datasets', 'Images, audio and raw text', 'When training must be instant'],
  examples: ['Credit scoring', 'Insurance pricing', 'Search result ranking', 'Demand forecasting'],
  ai: 'Libraries such as XGBoost and LightGBM remain the default for tabular data, even next to LLMs. Search engines have long used boosted trees to rank results, the same job a reranker does in a RAG pipeline.',
  row: ['Best-in-class tabular accuracy', 'Trees added to fix remaining errors', 'Needs tuning; can overfit', 'Credit scoring, search ranking'],
  demo(env) {
    classifier(env, { datasets: ['moons', 'xor', 'circles', 'spiral', 'linear'], data: 'moons', label: 'Gradient boosting regions', live: ['rounds'],
      params: c => c.range('rounds', 'Rounds shown', 1, 200, 1, 40).range('eta', 'Learning rate', 0.02, 1, 0.02, 0.3).range('depth', 'Depth of each tree', 1, 4, 1, 2),
      fit(train, P, K, rng) {
        const base = Math.log((train.filter(p => p.c).length + 1) / (train.filter(p => !p.c).length + 1)), trees = [];
        const F = train.map(() => base);
        for (let m = 0; m < 200; m++) {
          const p = F.map(sigmoid), g = train.map((q, i) => q.c - p[i]), h = p.map(v => v * (1 - v));
          const t = buildRegTree(train, g, h, P.depth); trees.push(t);
          train.forEach((q, i) => (F[i] += P.eta * regTreeVal(t, q.x, q.y)));
        }
        const model = { trees, upto: () => P.rounds, proba: (x, y) => { let f = base; for (let m = 0; m < P.rounds; m++) f += P.eta * regTreeVal(trees[m], x, y); const pr = sigmoid(f); return [1 - pr, pr]; } };
        const test = makeData(P.data, 99, 200), acc = (pts, r) => pts.filter(q => { let f = base; for (let m = 0; m < r; m++) f += P.eta * regTreeVal(trees[m], q.x, q.y); return (f > 0 ? 1 : 0) === q.c; }).length / pts.length;
        model.curve = [1, 5, 10, 20, 30, 40, 60, 80, 100, 130, 160, 200].map(r => [r, acc(train, r), acc(test, r)]);
        return model;
      },
      after: (env, m, P) => { env.extra.innerHTML = '<div class="small muted" style="margin-top:6px">Accuracy as rounds are added</div>' + lineChart([{ name: 'Training', color: 'var(--s1)', pts: m.curve.map(c => [c[0], c[1]]) }, { name: 'Held-out', color: 'var(--s2)', pts: m.curve.map(c => [c[0], c[2]]) }], { y0: 0.5, y1: 1, yTicks: [0.5, 0.75, 1], fmtY: v => pct(v), xLabel: 'rounds', marker: P.rounds, legend: true, label: 'Accuracy by boosting round' }); } });
  } });

add({ id: 'svm', name: 'Support vector machine', family: 'Supervised', group: 'Predict a category',
  how: 'Finds the boundary with the widest margin between the classes. Only the points on or inside the margin, the support vectors, decide where it goes; they are ringed. A kernel compares points through a similarity function, which lets the boundary curve.',
  formula: 'minimise  λ‖w‖² + mean( max(0, 1 − y · f(x)) )\nRBF kernel: k(a, b) = exp(−γ ‖a − b‖²)',
  best: ['Small to medium datasets with many features, such as text', 'Classes with a clear gap between them'],
  avoid: ['Very large datasets, where kernel methods slow down', 'When you need probabilities out of the box'],
  examples: ['Text categorisation before deep learning', 'Handwriting recognition on small datasets', 'Bioinformatics'],
  ai: 'This demo approximates the RBF kernel with random Fourier features: random cosine features whose dot products mimic the kernel. Similar random-feature tricks appear in research on making attention cheaper.',
  row: ['Clear margins, many features', 'Widest-margin boundary', 'Slow on big data', 'Text categorisation, bioinformatics'],
  demo(env) {
    classifier(env, { datasets: ['linear', 'moons', 'circles', 'xor'], data: 'linear', label: 'Support vector machine regions', frames: 150, stepsPerFrame: 1, refit: ['kernel', 'gamma', 'lam'],
      params: c => c.select('kernel', 'Kernel', [['linear', 'Linear'], ['rbf', 'RBF, curved']], 'linear').range('gamma', 'RBF width γ', 1, 30, 1, 8).range('lam', 'Regularisation λ', 0.0005, 0.05, 0.0005, 0.005),
      init(train, P, K, rng) {
        // Pegasos: stochastic sub-gradient descent on the hinge loss, with the bias as a constant feature
        const D = 150, om = Array.from({ length: D }, () => [gauss(rng) * Math.sqrt(2 * P.gamma), gauss(rng) * Math.sqrt(2 * P.gamma)]), ph = Array.from({ length: D }, () => rng() * 2 * Math.PI);
        const z = P.kernel === 'rbf' ? (x, y) => om.map((o, i) => Math.sqrt(2 / D) * Math.cos(o[0] * x + o[1] * y + ph[i])).concat([1]) : (x, y) => [x, y, 1];
        const Z = train.map(p => z(p.x, p.y)), Y = train.map(p => (p.c ? 1 : -1)), w = new Array(Z[0].length).fill(0); let t = 0;
        const f = zz => zz.reduce((a, v, j) => a + v * w[j], 0), cap = 1 / Math.sqrt(P.lam);
        return {
          step(n) { for (let s = 0; s < n * 40; s++) { t++; const i = Math.floor(rng() * train.length), eta = 1 / (P.lam * t), m = Y[i] * f(Z[i]); for (let j = 0; j < w.length; j++) w[j] *= 1 - eta * P.lam; if (m < 1) for (let j = 0; j < w.length; j++) w[j] += eta * Y[i] * Z[i][j]; const nrm = Math.hypot(...w); if (nrm > cap) for (let j = 0; j < w.length; j++) w[j] *= cap / nrm; } },
          proba: (x, y) => { const p = sigmoid(2 * f(z(x, y))); return [1 - p, p]; },
          margin: (x, y) => f(z(x, y)), w, linear: P.kernel !== 'rbf'
        };
      },
      decorate(plot, m, train, P, t) {
        if (m.linear && Math.abs(m.w[1]) > 1e-6) [[0, 2.5], [1, 1.2], [-1, 1.2]].forEach(([lv, wd]) => { const yAt = x => (lv - m.w[2] - m.w[0] * x) / m.w[1]; plot.line(-1.36, yAt(-1.36), 1.36, yAt(1.36), lv ? t.muted : t.ink2, wd, lv ? [5, 4] : null); });
        train.forEach(p => { if ((p.c ? 1 : -1) * m.margin(p.x, p.y) <= 1) plot.ring(p.x, p.y, 8, t.ink2); });
      },
      extraReadout: (m, P) => `<span>Support vectors <b>ringed</b></span>` });
  } });

add({ id: 'knn', name: 'k-nearest neighbours', family: 'Supervised', group: 'Predict a category',
  how: 'Does no training at all. To classify a new point it finds the k closest training points and takes a vote. Small k follows every wiggle and noise; large k smooths the boundary. Hover over the plot to see the neighbours being consulted.',
  formula: 'ŷ(x) = majority class of the k nearest training points\ndistance = √((x₁ − x′₁)² + (x₂ − x′₂)²)',
  best: ['Small datasets where similar examples have similar answers', 'Recommendation by similarity'],
  avoid: ['Raw high-dimensional data, where every point is far from every other', 'Inputs on different scales, unless you normalise them'],
  examples: ['"Customers like you also bought"', 'Finding similar documents or images'],
  ai: 'Retrieval in RAG is nearest-neighbour search: the question\'s embedding is compared with each chunk\'s and the closest are returned, exactly as in the <a href="/embeddings">Embeddings & RAG</a> lab. Vector databases use approximate methods such as HNSW to do it over millions of vectors.',
  row: ['Similarity-based answers', 'Vote of the k closest points', 'Slow and noisy in high dimensions', 'Recommendations, RAG retrieval'],
  demo(env) {
    let hover = null, lastTrain = null;
    classifier(env, { datasets: ['moons', 'blobs3', 'xor', 'circles', 'spiral'], data: 'moons', label: 'k-nearest-neighbour regions',
      params: c => c.range('k', 'k, neighbours consulted', 1, 31, 2, 7),
      fit: (train, P, K) => { lastTrain = train; return { proba: (x, y) => { const d = train.map(p => [(p.x - x) ** 2 + (p.y - y) ** 2, p.c]).sort((a, b) => a[0] - b[0]).slice(0, P.k); const s = new Array(K).fill(0); d.forEach(([, c]) => (s[c] += 1 / P.k)); return s; }, k: P.k }; },
      decorate(plot, m, train, P, t) { if (hover) { train.map(p => [(p.x - hover.x) ** 2 + (p.y - hover.y) ** 2, p]).sort((a, b) => a[0] - b[0]).slice(0, P.k).forEach(([, p]) => plot.line(hover.x, hover.y, p.x, p.y, t.ink2, 1)); plot.marker(hover.x, hover.y, 'diamond', t.ink, t.surface, 6); } } });
    env.plotMove(pt => { hover = pt; env.redraw && env.redraw(); });
  } });

add({ id: 'nb', name: 'Naive Bayes', family: 'Supervised', group: 'Predict a category',
  how: 'Uses Bayes\' theorem with a bold simplification: every input is assumed independent once you know the class. Here each class is modelled as a bell curve along x times a bell curve along y, drawn as ellipses. It is fast and needs little data, even though the assumption is rarely true.',
  formula: 'P(class | x) ∝ P(class) · Π P(xᵢ | class)\neach P(xᵢ | class) is a bell curve here',
  best: ['Text classification with word counts', 'Very small datasets', 'Fast baselines'],
  avoid: ['Strongly related inputs, which make its probabilities overconfident', 'When accuracy matters more than speed'],
  examples: ['Early email spam filters', 'Sentiment and topic tagging', 'Medical screening baselines'],
  ai: 'A good first baseline for any text classifier you are tempted to hand to an LLM. If Naive Bayes is already very accurate on your labelled data, the LLM may not be worth its cost and latency.',
  row: ['Fast text classification', 'Bayes\' theorem with independent features', 'Correlated features', 'Spam filtering, sentiment'],
  demo(env) {
    classifier(env, { datasets: ['blobs3', 'linear', 'moons', 'circles'], data: 'blobs3', label: 'Naive Bayes regions',
      params: c => c,
      fit(train, P, K) {
        const st = Array.from({ length: K }, (_, k) => { const q = train.filter(p => p.c === k), n = q.length || 1, mx = q.reduce((a, p) => a + p.x, 0) / n, my = q.reduce((a, p) => a + p.y, 0) / n; return { prior: n / train.length, mx, my, vx: q.reduce((a, p) => a + (p.x - mx) ** 2, 0) / n + 1e-3, vy: q.reduce((a, p) => a + (p.y - my) ** 2, 0) / n + 1e-3 }; });
        const ll = (s, x, y) => Math.log(s.prior) - 0.5 * (Math.log(2 * Math.PI * s.vx) + (x - s.mx) ** 2 / s.vx + Math.log(2 * Math.PI * s.vy) + (y - s.my) ** 2 / s.vy);
        return { st, proba: (x, y) => softmax(st.map(s => ll(s, x, y))) };
      },
      decorate(plot, m, train, P, t) { m.st.forEach((s, k) => { plot.ellipse(s.mx, s.my, Math.sqrt(s.vx), Math.sqrt(s.vy), t.cls[k]); plot.ellipse(s.mx, s.my, 2 * Math.sqrt(s.vx), 2 * Math.sqrt(s.vy), t.cls[k], [4, 4]); }); } });
  } });

add({ id: 'mlp', name: 'Neural network (MLP)', family: 'Supervised', group: 'Predict a category',
  how: 'Layers of simple units, each a weighted sum followed by a non-linearity such as tanh or ReLU. Backpropagation works out how every weight affects the loss, and gradient descent adjusts them. Watch the boundary bend as it trains; try the spirals with two layers.',
  formula: 'h = act(W₁x + b₁)\nŷ = softmax(W₂h + b₂)\nweights updated by backpropagation',
  best: ['Non-linear patterns in medium to large datasets', 'A component inside bigger models'],
  avoid: ['Small tabular datasets, where boosted trees usually win', 'When decisions must be explained'],
  examples: ['Recommendation scoring', 'Tabular prediction at scale', 'Classifier heads on pretrained models'],
  ai: 'Every transformer layer contains an MLP: the feed-forward block you can open in the <a href="/transformer">Transformer explainer</a>. In a standard transformer layer it holds about two thirds of the parameters.',
  row: ['Flexible non-linear patterns', 'Layers of weighted sums and activations', 'Needs data and tuning', 'Recommendation, tabular at scale'],
  demo(env) {
    classifier(env, { datasets: ['moons', 'circles', 'xor', 'spiral', 'blobs3'], data: 'moons', label: 'Neural network regions', frames: 400, stepsPerFrame: 3, refit: ['hidden', 'layers', 'act', 'lr'],
      params: c => c.range('hidden', 'Units per layer', 2, 24, 1, 10).range('layers', 'Hidden layers', 1, 3, 1, 2).select('act', 'Activation', [['tanh', 'tanh'], ['relu', 'ReLU']], 'tanh').range('lr', 'Learning rate', 0.01, 0.5, 0.01, 0.1),
      init(train, P, K, rng) {
        const net = MLP([2, ...new Array(P.layers).fill(P.hidden), K], P.act, rng, 'softmax'), X = train.map(p => [p.x, p.y]), Y = train.map(p => p.c); let L = 0;
        return { step(n) { for (let s = 0; s < n; s++) L = net.trainBatch(X, Y, P.lr); }, proba: (x, y) => { const a = net.forward([x, y]); return a[a.length - 1]; }, loss: () => L };
      } });
  } });

// ---------- unsupervised ----------
const blobsU = (seed, n) => { const r = mulberry32(seed), C = [[-0.7, 0.45], [0.6, 0.5], [-0.35, -0.5], [0.55, -0.45]]; return Array.from({ length: n }, (_, i) => { const c = C[i % 4]; return { x: c[0] + gauss(r) * 0.16, y: c[1] + gauss(r) * 0.14 }; }); };

add({ id: 'kmeans', name: 'k-means', family: 'Unsupervised', group: 'Find groups',
  how: 'Places k centres, assigns every point to its nearest centre, moves each centre to the middle of its points, and repeats until nothing changes. Press Step to watch one round at a time. You choose k: the elbow chart shows where adding clusters stops helping.',
  formula: 'minimise  Σ ‖xᵢ − μ(cluster of i)‖²\nrepeat: assign to nearest μ, then μ = mean of its points',
  best: ['Round, similar-sized clusters', 'Compressing data into a few prototypes'],
  avoid: ['Long, curved or very uneven clusters', 'When you cannot guess k', 'Data with outliers'],
  examples: ['Customer segmentation', 'Reducing an image to a palette of colours', 'Grouping support tickets'],
  ai: 'Vector databases often use k-means to split embeddings into clusters, called IVF indexes, so a search only checks the nearest few clusters. Product quantisation compresses embeddings with k-means codebooks.',
  row: ['Round clusters, segmentation', 'Assign to nearest centre, re-centre, repeat', 'Must choose k; round clusters only', 'Customer segments, vector indexes'],
  demo(env) {
    const plot = Plot(env.plot, { label: 'k-means clustering' });
    let pts, cents, assign, iter, phase;
    const ctrl = Controls(env.ctrl, key => reset());
    ctrl.range('k', 'k, number of clusters', 1, 5, 1, 4).select('init', 'Starting centres', [['random', 'Random points'], ['pp', 'k-means++, spread out']], 'random').range('seed', 'Random start', 1, 20, 1, 3)
      .button('Step', () => step()).button('Run to the end', () => run(), true);
    const dist = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    function initCents(k, r) {
      if (ctrl.vals.init === 'random') return Array.from({ length: k }, () => ({ ...pts[Math.floor(r() * pts.length)] }));
      const c = [{ ...pts[Math.floor(r() * pts.length)] }];
      while (c.length < k) { const d = pts.map(p => Math.min(...c.map(q => dist(p, q)))), s = d.reduce((a, b) => a + b, 0); let t = r() * s, i = 0; while ((t -= d[i]) > 0) i++; c.push({ ...pts[i] }); }
      return c;
    }
    const inertia = (P, C, As) => P.reduce((a, p, i) => a + dist(p, C[As[i]]), 0);
    function full(P, k, r) { let C = initCents(k, r), As = P.map(() => 0); for (let it = 0; it < 50; it++) { As = P.map(p => C.reduce((bi, c, j) => (dist(p, c) < dist(p, C[bi]) ? j : bi), 0)); C = C.map((c, j) => { const m = P.filter((_, i) => As[i] === j); return m.length ? { x: m.reduce((a, p) => a + p.x, 0) / m.length, y: m.reduce((a, p) => a + p.y, 0) / m.length } : c; }); } return inertia(P, C, As); }
    function reset() { pts = blobsU(21, 160); const r = mulberry32(ctrl.vals.seed); cents = initCents(ctrl.vals.k, r); assign = null; iter = 0; phase = 'assign'; draw();
      const el = Array.from({ length: 8 }, (_, i) => [i + 1, full(pts, i + 1, mulberry32(5))]);
      env.extra.innerHTML = '<div class="small muted" style="margin-top:6px">Elbow chart: total squared distance to the nearest centre, for each k</div>' + lineChart([{ color: 'var(--s1)', pts: el }], { y0: 0, y1: el[0][1], xLabel: 'k', marker: ctrl.vals.k, fmtY: v => v.toFixed(0), label: 'Elbow chart' }); }
    function step() {
      if (phase === 'assign') { assign = pts.map(p => cents.reduce((bi, c, j) => (dist(p, c) < dist(p, cents[bi]) ? j : bi), 0)); phase = 'update'; }
      else { const moved = cents.map((c, j) => { const m = pts.filter((_, i) => assign[i] === j); return m.length ? { x: m.reduce((a, p) => a + p.x, 0) / m.length, y: m.reduce((a, p) => a + p.y, 0) / m.length } : c; }); const shift = moved.reduce((a, c, j) => a + dist(c, cents[j]), 0); cents = moved; iter++; phase = 'assign'; if (shift < 1e-9) phase = 'done'; }
      draw();
    }
    function run() { let n = 0; env.loop(() => { if (phase === 'done' || n++ > 60) return false; step(); return true; }, draw, 6); }
    function draw() {
      const t = theme(); plot.clear();
      if (assign) pts.forEach((p, i) => plot.marker(p.x, p.y, M.SHAPES[assign[i]], t.cls[assign[i]], t.surface, 4)); else pts.forEach(p => plot.marker(p.x, p.y, 'circle', t.muted, t.surface, 4));
      cents.forEach((c, j) => { plot.marker(c.x, c.y, M.SHAPES[j], t.cls[j], t.ink, 9); });
      env.readout.innerHTML = `<span>Round <b>${iter}</b></span><span>Next step <b>${phase === 'done' ? 'none, converged' : phase === 'assign' ? 'assign points to the nearest centre' : 'move centres to the mean'}</b></span>${assign ? `<span>Total squared distance <b>${inertia(pts, cents, assign).toFixed(2)}</b></span>` : ''}`;
      env.legendCustom(cents.map((c, j) => [t.cls[j], `Cluster ${j + 1}`]).concat([[t.ink, 'Large markers are centres']]));
    }
    env.onTheme(draw); reset();
  } });

add({ id: 'hier', name: 'Hierarchical clustering', family: 'Unsupervised', group: 'Find groups',
  how: 'Starts with every point as its own cluster and repeatedly merges the two closest clusters. The dendrogram records every merge and the distance at which it happened, so you can cut it at any height to get as many clusters as you want.',
  formula: 'repeat: merge the closest pair of clusters\nsingle linkage = closest points, complete = farthest, average = mean distance',
  best: ['Small datasets where the nested structure itself is useful', 'Choosing the number of clusters after seeing the tree'],
  avoid: ['Large datasets, since it compares every pair', 'Noisy data with single linkage, which chains clusters together'],
  examples: ['Gene expression analysis', 'Building taxonomies of products or documents'],
  ai: 'Used to build topic hierarchies from document embeddings, so a large collection can be browsed from broad themes down to specific ones.',
  row: ['Nested groups, small data', 'Merge the closest clusters repeatedly', 'Slow on large data', 'Gene expression, taxonomies'],
  demo(env) {
    const plot = Plot(env.plot, { label: 'Hierarchical clustering' });
    const ctrl = Controls(env.ctrl, () => run());
    ctrl.select('link', 'Linkage', [['average', 'Average'], ['single', 'Single'], ['complete', 'Complete']], 'average').range('cut', 'Clusters after the cut', 1, 5, 1, 4);
    const pts = blobsU(33, 36);
    function run() {
      const n = pts.length, D = pts.map(a => pts.map(b => Math.hypot(a.x - b.x, a.y - b.y)));
      let clusters = pts.map((_, i) => ({ id: i, members: [i], h: 0 })); const merges = []; let nextId = n;
      const cd = (A, B) => { const ds = []; A.members.forEach(i => B.members.forEach(j => ds.push(D[i][j]))); return ctrl.vals.link === 'single' ? Math.min(...ds) : ctrl.vals.link === 'complete' ? Math.max(...ds) : ds.reduce((a, b) => a + b, 0) / ds.length; };
      while (clusters.length > 1) { let best = null; for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) { const d = cd(clusters[i], clusters[j]); if (!best || d < best.d) best = { i, j, d }; } const A = clusters[best.i], B = clusters[best.j], C = { id: nextId++, members: A.members.concat(B.members), h: best.d, a: A, b: B }; merges.push(C); clusters = clusters.filter((_, k) => k !== best.i && k !== best.j).concat([C]); }
      const root = clusters[0], k = ctrl.vals.cut;
      let parts = [root]; while (parts.length < k) { parts.sort((a, b) => b.h - a.h); const top = parts.shift(); if (!top.a) { parts.push(top); break; } parts.push(top.a, top.b); }
      const lab = new Array(n).fill(0); parts.sort((a, b) => Math.min(...a.members) - Math.min(...b.members)).forEach((p, ci) => p.members.forEach(i => (lab[i] = ci)));
      const cutH = parts.reduce((m, p) => Math.max(m, p.h), 0) + 1e-6, nextH = Math.min(...merges.filter(m => m.h > cutH - 1e-6).map(m => m.h).concat([root.h]));
      const t = theme(); plot.clear(); pts.forEach((p, i) => plot.marker(p.x, p.y, M.SHAPES[lab[i]], t.cls[lab[i]], t.surface, 5));
      // dendrogram
      const order = []; (function walk(c) { if (!c.a) order.push(c.members[0]); else { walk(c.a); walk(c.b); } })(root);
      const W = 520, H = 200, l = 36, b = 8, top = 10, sx = i => l + (order.indexOf(i) + 0.5) / n * (W - l - 8), sy = h => top + (1 - h / root.h) * (H - top - b);
      let svg = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:auto;display:block" role="img" aria-label="Dendrogram">`;
      const pos = c => (c.a ? (pos(c.a) + pos(c.b)) / 2 : sx(c.members[0]));
      (function draw(c) { if (!c.a) return; const x1 = pos(c.a), x2 = pos(c.b), y = sy(c.h); const col = c.h < cutH ? t.cls[lab[c.members[0]]] : t.muted; svg += `<path d="M${x1} ${sy(c.a.h)} V${y} H${x2} V${sy(c.b.h)}" fill="none" stroke="${col}" stroke-width="1.5"></path>`; draw(c.a); draw(c.b); })(root);
      const cy = sy((cutH + nextH) / 2); svg += `<line x1="${l}" x2="${W - 8}" y1="${cy}" y2="${cy}" stroke="${t.ink2}" stroke-dasharray="5 4"></line><text x="${l - 4}" y="${cy + 4}" text-anchor="end" font-size="10" fill="var(--muted)">cut</text></svg>`;
      env.extra.innerHTML = '<div class="small muted" style="margin-top:6px">Dendrogram: each join is a merge, higher means further apart. The dashed line is the cut.</div>' + svg;
      env.readout.innerHTML = `<span>Clusters <b>${parts.length}</b></span><span>Merges recorded <b>${merges.length}</b></span>`;
      env.legendCustom(parts.map((_, j) => [t.cls[j], `Cluster ${j + 1}`]));
    }
    env.onTheme(run); run();
  } });

add({ id: 'dbscan', name: 'DBSCAN', family: 'Unsupervised', group: 'Find groups',
  how: 'Calls a point a core point if at least minPts points lie within distance ε of it. Clusters grow outward from core points, and points that no cluster reaches are labelled noise, shown as crosses. It finds clusters of any shape and works out how many there are.',
  formula: 'core point: |{ y : ‖x − y‖ ≤ ε }| ≥ minPts\nclusters = connected regions of core points',
  best: ['Clusters with odd shapes', 'Data with noise you want flagged', 'Not knowing how many clusters there are'],
  avoid: ['Clusters with very different densities', 'High-dimensional data without reducing it first'],
  examples: ['Geographic hotspots', 'Grouping GPS traces', 'Flagging outliers in sensor data'],
  ai: 'BERTopic, a widely used topic-modelling library, clusters document embeddings with HDBSCAN, a density-based relative of DBSCAN. The noise label is useful for finding documents that fit no topic.',
  row: ['Odd shapes, noisy data', 'Grow clusters from dense regions', 'Struggles with varying density', 'Geographic hotspots, topic discovery'],
  demo(env) {
    const plot = Plot(env.plot, { label: 'DBSCAN clustering' });
    // settings that separate each dataset cleanly; the sliders let you break them
    const DEF = { moons: [0.15, 5], circles: [0.2, 6], blobs: [0.17, 4] };
    const setRange = (i, v) => { const inp = env.ctrl.querySelectorAll('input[type=range]')[i]; inp.value = v; inp.dispatchEvent(new Event('input')); };
    const ctrl = Controls(env.ctrl, key => { if (key === 'data') { const [e, m] = DEF[ctrl.vals.data]; setRange(0, e); setRange(1, m); } run(); });
    ctrl.select('data', 'Dataset', [['moons', 'Two moons'], ['circles', 'Circle inside a ring'], ['blobs', 'Four groups']], 'moons').range('eps', 'ε, neighbourhood radius', 0.04, 0.4, 0.01, 0.15).range('minPts', 'minPts', 2, 12, 1, 5);
    function run() {
      const P = ctrl.vals, r = mulberry32(4);
      let pts = P.data === 'blobs' ? blobsU(21, 160) : makeData(P.data, 5, 200).map(p => ({ x: p.x, y: p.y }));
      pts = pts.concat(Array.from({ length: 12 }, () => ({ x: r() * 2.4 - 1.2, y: r() * 1.8 - 0.9 })));
      const n = pts.length, nb = pts.map(a => pts.map((b, j) => j).filter(j => Math.hypot(a.x - pts[j].x, a.y - pts[j].y) <= P.eps));
      const core = nb.map(x => x.length >= P.minPts), lab = new Array(n).fill(-2); let c = 0;
      for (let i = 0; i < n; i++) { if (lab[i] !== -2 || !core[i]) continue; const q = [i]; lab[i] = c; while (q.length) { const j = q.pop(); if (!core[j]) continue; nb[j].forEach(k => { if (lab[k] === -2 || lab[k] === -1) { if (lab[k] === -2 && core[k]) q.push(k); lab[k] = c; } }); } c++; }
      for (let i = 0; i < n; i++) if (lab[i] === -2) lab[i] = -1;
      const t = theme(); plot.clear();
      pts.forEach((p, i) => { if (lab[i] < 0) plot.marker(p.x, p.y, 'cross', t.muted, t.surface, 4); else plot.marker(p.x, p.y, M.SHAPES[lab[i] % 5], t.cls[lab[i] % 5], t.surface, core[i] ? 5 : 3); });
      const noise = lab.filter(v => v < 0).length;
      env.readout.innerHTML = `<span>Clusters found <b>${c}</b></span><span>Noise points <b>${noise}</b></span><span>Core points drawn larger than border points</span>${c > 5 ? '<span>More than five clusters reuse colours</span>' : ''}`;
      env.legendCustom(Array.from({ length: Math.min(c, 5) }, (_, j) => [t.cls[j], `Cluster ${j + 1}`]).concat([[t.muted, 'Noise']]));
    }
    env.onTheme(run); run();
  } });

add({ id: 'pca', name: 'Principal component analysis', family: 'Unsupervised', group: 'Simplify data',
  how: 'Finds the directions along which the data varies most. The first principal component is the direction of greatest spread and the second is at right angles to it. Keeping only the first few gives a smaller version of the data that loses as little variance as possible. Press Project to flatten the data onto the first component.',
  formula: 'Σ = covariance of the centred data\nprincipal components = eigenvectors of Σ, ranked by eigenvalue',
  best: ['Visualising high-dimensional data', 'Compressing correlated inputs', 'Removing noise before another model'],
  avoid: ['Non-linear structure', 'Cases where the low-variance directions are the ones that matter'],
  examples: ['Image compression', 'Finding the main factors in survey data', 'Speeding up other models'],
  ai: 'The meaning map in the <a href="/embeddings">Embeddings & RAG</a> lab squashes 384-dimensional embeddings onto two dimensions with PCA.',
  row: ['Fewer dimensions, visualisation', 'Directions of greatest variance', 'Linear only; hard to interpret', 'Image compression, embedding maps'],
  demo(env) {
    const plot = Plot(env.plot, { label: 'Principal component analysis' });
    let proj = 0, pts, eig;
    const ctrl = Controls(env.ctrl, () => { proj = 0; gen(); draw(); });
    ctrl.range('angle', 'Direction of the data, degrees', 0, 180, 1, 30).range('ratio', 'How stretched', 1, 8, 0.1, 4)
      .button('Project onto the first component', () => { let f = 0; env.loop(() => { proj = Math.min(1, ++f / 40); draw(); return proj < 1; }, draw); }, true).button('Reset', () => { proj = 0; draw(); });
    function gen() {
      const r = mulberry32(8), a = ctrl.vals.angle * Math.PI / 180, s1 = 0.38, s2 = s1 / ctrl.vals.ratio;
      pts = Array.from({ length: 140 }, () => { const u = gauss(r) * s1, v = gauss(r) * s2; return { x: u * Math.cos(a) - v * Math.sin(a), y: u * Math.sin(a) + v * Math.cos(a) }; });
      const n = pts.length, mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
      const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0) / n, syy = pts.reduce((s, p) => s + (p.y - my) ** 2, 0) / n, sxy = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / n;
      const tr = sxx + syy, det = sxx * syy - sxy * sxy, l1 = tr / 2 + Math.sqrt(tr * tr / 4 - det), l2 = tr / 2 - Math.sqrt(tr * tr / 4 - det);
      let v1 = Math.abs(sxy) > 1e-12 ? [l1 - syy, sxy] : sxx >= syy ? [1, 0] : [0, 1]; const nv = Math.hypot(...v1); v1 = [v1[0] / nv, v1[1] / nv];
      eig = { mx, my, l1, l2, v1, v2: [-v1[1], v1[0]] };
    }
    function draw() {
      const t = theme(), { mx, my, l1, l2, v1, v2 } = eig; plot.clear();
      pts.forEach(p => { const d = (p.x - mx) * v1[0] + (p.y - my) * v1[1], px = mx + d * v1[0], py = my + d * v1[1]; const x = p.x + (px - p.x) * proj, y = p.y + (py - p.y) * proj; plot.marker(x, y, 'circle', t.cls[0], t.surface, 3.5); });
      [[v1, l1, t.cls[1], 'PC1'], [v2, l2, t.cls[2], 'PC2']].forEach(([v, l, col, name]) => { const L = 2 * Math.sqrt(l); plot.line(mx - v[0] * L, my - v[1] * L, mx + v[0] * L, my + v[1] * L, col, 3); plot.label(mx + v[0] * L + 0.03, my + v[1] * L + 0.03, name, col); });
      env.readout.innerHTML = `<span>Variance along PC1 <b>${pct(l1 / (l1 + l2))}</b></span><span>Along PC2 <b>${pct(l2 / (l1 + l2))}</b></span><span>${proj >= 1 ? 'Every point is now one number: its position along PC1' : 'Arrows are two standard deviations long'}</span>`;
      env.legendCustom([[t.cls[0], 'Data'], [t.cls[1], 'First component'], [t.cls[2], 'Second component']]);
    }
    env.onTheme(draw); gen(); draw();
  } });

add({ id: 'autoenc', name: 'Autoencoder', family: 'Unsupervised', group: 'Spot anomalies',
  how: 'A neural network trained to reproduce its input after squeezing it through a narrow bottleneck, here a single number. To succeed it must learn the curve the data lies on. Points that do not fit come back badly, so reconstruction error flags anomalies, ringed in red.',
  formula: 'z = encoder(x),  x̂ = decoder(z)\nminimise  ‖x − x̂‖²',
  best: ['Anomaly detection', 'Learning compact representations', 'Denoising'],
  avoid: ['Problems PCA already solves, since it is simpler', 'Small datasets', 'When you must explain why something is unusual'],
  examples: ['Fraud and fault detection', 'Denoising images', 'Compressing sensor data'],
  ai: 'Image generators such as Stable Diffusion work inside the compressed latent space of a variational autoencoder. Interpretability research uses sparse autoencoders to find human-readable features inside LLMs.',
  row: ['Anomaly detection, compression', 'Reconstruct the input through a bottleneck', 'Black box; can overfit', 'Fraud and fault detection'],
  demo(env) {
    const plot = Plot(env.plot, { label: 'Autoencoder reconstruction' });
    let net, pts, X, frame, L = 0;
    const ctrl = Controls(env.ctrl, k => (k === 'flag' ? draw() : start()));
    ctrl.range('flag', 'Flag the worst', 1, 15, 1, 6, v => v + ' points').range('bott', 'Bottleneck size', 1, 2, 1, 1).button('Retrain', () => start(), true);
    function start() {
      const r = mulberry32(12);
      pts = Array.from({ length: 140 }, () => { const x = r() * 2 - 1; return { x, y: 0.55 * Math.sin(2.6 * x) + gauss(r) * 0.04, anomaly: false }; })
        .concat([[-0.6, 0.6], [0.1, -0.6], [0.7, 0.7], [-0.2, 0.55], [0.85, -0.6], [-0.95, -0.7]].map(([x, y]) => ({ x, y, anomaly: true })));
      X = pts.map(p => [p.x, p.y]);
      net = MLP([2, 16, ctrl.vals.bott, 16, 2], 'tanh', mulberry32(5), 'linear'); frame = 0;
      env.loop(() => { for (let s = 0; s < 6; s++) L = net.trainBatch(X, X, 0.05); frame++; draw(); return frame < 260; }, draw);
    }
    function draw() {
      const t = theme(); plot.clear();
      const rec = X.map(x => { const a = net.forward(x); return a[a.length - 1]; }), err = rec.map((r, i) => (r[0] - X[i][0]) ** 2 + (r[1] - X[i][1]) ** 2);
      const worst = err.map((e, i) => [e, i]).sort((a, b) => b[0] - a[0]).slice(0, ctrl.vals.flag).map(x => x[1]);
      const curve = []; for (let i = 0; i <= 80; i++) { const x = -1.2 + 2.4 * i / 80; const a = net.forward([x, 0.55 * Math.sin(2.6 * x)]); curve.push(a[a.length - 1]); }
      for (let i = 1; i < curve.length; i++) plot.line(curve[i - 1][0], curve[i - 1][1], curve[i][0], curve[i][1], t.cls[1], 2.5);
      pts.forEach((p, i) => { if (worst.includes(i)) plot.line(p.x, p.y, rec[i][0], rec[i][1], t.bad, 1, [3, 3]); plot.marker(p.x, p.y, p.anomaly ? 'diamond' : 'circle', p.anomaly ? t.ink2 : t.cls[0], t.surface, p.anomaly ? 5.5 : 3.5); if (worst.includes(i)) plot.ring(p.x, p.y, 9, t.bad); });
      const caught = worst.filter(i => pts[i].anomaly).length;
      env.readout.innerHTML = `<span>Mean reconstruction error <b>${(err.reduce((a, b) => a + b, 0) / err.length).toFixed(4)}</b></span><span>Planted anomalies caught <b>${caught} of 6</b></span><span>Training step <b>${frame * 6}</b></span>`;
      env.legendCustom([[t.cls[0], 'Normal data'], [t.ink2, 'Planted anomalies'], [t.cls[1], 'What the network can reproduce'], [t.bad, 'Flagged: worst reconstructions']]);
    }
    env.onTheme(draw); start();
  } });

// ---------- deep learning on structure ----------
add({ id: 'cnn', name: 'Convolutional network (CNN)', family: 'Deep learning', group: 'Images and grids',
  how: 'Slides a small filter across an image and records how strongly each patch matches it. The same filter is reused at every position, so a pattern learned once is recognised everywhere. Pooling then shrinks the map. Draw on the grid and try different filters; a trained CNN learns thousands of filters like these by itself.',
  formula: 'feature(i, j) = Σₐ Σᵦ kernel(a, b) · image(i + a, j + b)\nthen ReLU, then 2 × 2 max pooling',
  best: ['Images, video and audio spectrograms', 'Any grid-shaped data with local patterns'],
  avoid: ['Tabular data', 'Tasks needing relationships across the whole input, where transformers often do better'],
  examples: ['Medical image analysis', 'Defect detection on production lines', 'Face and object detection'],
  ai: 'Still widely used for vision, often alongside or inside vision transformers. Multimodal LLMs need an image encoder that turns a picture into tokens, built from convolutional or transformer layers.',
  row: ['Images and grids', 'Shared filters slid across the input', 'Needs lots of labelled images', 'Medical imaging, defect detection'],
  demo(env) {
    env.plot.innerHTML = '';
    const N = 12, img = new Array(N * N).fill(0);
    const PRE = { seven: ['111111111100', '000000001100', '000000011000', '000000110000', '000001100000', '000011000000', '000110000000', '001100000000'], cross: ['000001100000', '000001100000', '000001100000', '111111111111', '111111111111', '000001100000', '000001100000', '000001100000'], box: ['111111111111', '100000000001', '100000000001', '100000000001', '100000000001', '100000000001', '100000000001', '111111111111'], diag: ['100000000000', '010000000000', '001000000000', '000100000000', '000010000000', '000001000000', '000000100000', '000000010000'] };
    const KER = { vert: [[-1, 0, 1], [-1, 0, 1], [-1, 0, 1]], horiz: [[-1, -1, -1], [0, 0, 0], [1, 1, 1]], diag: [[0, 1, 2], [-1, 0, 1], [-2, -1, 0]], blur: [[1 / 9, 1 / 9, 1 / 9], [1 / 9, 1 / 9, 1 / 9], [1 / 9, 1 / 9, 1 / 9]], sharpen: [[0, -1, 0], [-1, 5, -1], [0, -1, 0]] };
    const ctrl = Controls(env.ctrl, () => draw());
    ctrl.select('pre', 'Picture', [['seven', 'A seven'], ['cross', 'A plus sign'], ['box', 'A box'], ['diag', 'A diagonal line'], ['clear', 'Blank, draw your own']], 'seven').select('ker', 'Filter', [['vert', 'Vertical edges'], ['horiz', 'Horizontal edges'], ['diag', 'Diagonal edges'], ['blur', 'Blur'], ['sharpen', 'Sharpen']], 'vert').select('relu', 'After the filter', [['relu', 'ReLU: keep positive matches'], ['raw', 'Raw values']], 'relu');
    env.ctrl.querySelector('select').addEventListener('change', e => load(e.target.value));
    function load(name) { img.fill(0); if (PRE[name]) PRE[name].forEach((row, y) => row.split('').forEach((v, x) => (img[(y + 2) * N + x] = +v))); draw(); }
    const host = document.createElement('div'); host.className = 'cnn-row'; env.plot.appendChild(host);
    let painting = null;
    function grid(vals, n, cell, colorFn, cls) { return `<div class="grid-img ${cls || ''}" style="grid-template-columns:repeat(${n},${cell}px);--c:${cell}px">${vals.map((v, i) => `<i data-i="${i}" style="background:${colorFn(v)}"></i>`).join('')}</div>`; }
    function draw() {
      const t = theme(), k = KER[ctrl.vals.ker], O = N - 2, out = new Array(O * O).fill(0);
      for (let y = 0; y < O; y++) for (let x = 0; x < O; x++) { let s = 0; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) s += k[a][b] * img[(y + a) * N + x + b]; out[y * O + x] = ctrl.vals.relu === 'relu' ? Math.max(0, s) : s; }
      const P = O / 2, pool = new Array(P * P).fill(0); for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) pool[y * P + x] = Math.max(out[(2 * y) * O + 2 * x], out[(2 * y) * O + 2 * x + 1], out[(2 * y + 1) * O + 2 * x], out[(2 * y + 1) * O + 2 * x + 1]);
      const mx = Math.max(1e-6, ...out.map(Math.abs));
      const div = v => (v >= 0 ? rgba(t.cls[0], 0.06 + 0.94 * Math.min(1, v / mx)) : rgba(t.cls[1], 0.06 + 0.94 * Math.min(1, -v / mx)));
      host.innerHTML = `<div>${grid(img, N, 18, v => (v ? t.ink : t.surface), 'paint')}<div class="cap">Input, 12 × 12. Click or drag to draw.</div></div>
        <div><div class="kernel">${k.flat().map(v => `<span>${Math.abs(v) < 1 && v !== 0 ? v.toFixed(2) : v}</span>`).join('')}</div><div class="cap">The 3 × 3 filter. The same nine numbers are used at every position.</div></div>
        <div>${grid(out, O, 16, div)}<div class="cap">Feature map, 10 × 10: how strongly each patch matches. ${ctrl.vals.relu === 'raw' ? 'Blue is positive, orange negative.' : ''}</div></div>
        <div>${grid(pool, P, 26, div)}<div class="cap">After 2 × 2 max pooling, 5 × 5: the strongest match in each block survives.</div></div>`;
      const paint = host.querySelector('.paint');
      paint.addEventListener('pointerdown', e => { const c = e.target.closest('i'); if (!c) return; painting = img[+c.dataset.i] ? 0 : 1; img[+c.dataset.i] = painting; draw(); });
      paint.addEventListener('pointerover', e => { const c = e.target.closest('i'); if (c && painting !== null && e.buttons) { img[+c.dataset.i] = painting; draw(); } });
      env.readout.innerHTML = `<span>Weights in this filter <b>9</b>, shared across <b>${O * O}</b> positions</span><span>A fully connected layer doing the same job would need <b>${(N * N * O * O).toLocaleString('en-GB')}</b> weights</span>`;
    }
    document.addEventListener('pointerup', () => (painting = null), { signal: env.signal });
    env.legendCustom([]); env.onTheme(draw); load('seven');
  } });

add({ id: 'rnn', name: 'Recurrent network (RNN)', family: 'Deep learning', group: 'Sequences',
  how: 'Reads a sequence one step at a time, carrying a hidden state that mixes each new input with what came before. Training sends the error back through every step, multiplying by the same weight each time, so the influence of early inputs shrinks towards nothing or blows up. Move the recurrent weight to see both.',
  formula: 'hₜ = tanh(w · hₜ₋₁ + u · xₜ)\n∂h_T / ∂x_t ∝ Π (w · tanh′)  over the steps in between',
  best: ['Streaming data that arrives one step at a time', 'Small sequence models on devices'],
  avoid: ['Long sequences, unless you use LSTM or GRU cells', 'When you can process the whole sequence at once'],
  examples: ['Earlier speech recognition and translation systems', 'Sensor and time-series forecasting', 'Keyboard next-word suggestions'],
  ai: 'Transformers replaced RNNs for language because attention links any two positions in a single step and trains in parallel. Recurrence is returning in state-space models such as Mamba, which aim to keep the cost of long contexts down.',
  row: ['Step-by-step sequences', 'Hidden state carried through time', 'Vanishing or exploding gradients', 'Older speech and translation, time series'],
  demo(env) {
    env.plot.innerHTML = '<div id="rnnCharts"></div>';
    const ctrl = Controls(env.ctrl, () => draw());
    ctrl.range('w', 'Recurrent weight w', 0.3, 1.6, 0.05, 0.9).range('u', 'Input weight u', 0.2, 1.5, 0.05, 0.8).select('seq', 'Input sequence', [['spike', 'One spike at step 1'], ['random', 'Random inputs']], 'spike');
    function draw() {
      const T = 40, r = mulberry32(2), x = Array.from({ length: T }, (_, i) => (ctrl.vals.seq === 'spike' ? (i === 0 ? 1 : 0) : gauss(r) * 0.5));
      const h = []; let prev = 0; x.forEach(v => { prev = Math.tanh(ctrl.vals.w * prev + ctrl.vals.u * v); h.push(prev); });
      const infl = x.map((_, t) => { let g = ctrl.vals.u * (1 - h[t] ** 2); for (let s = t + 1; s < T; s++) g *= ctrl.vals.w * (1 - h[s] ** 2); return Math.abs(g); });
      const lo = -8, hi = 2;
      document.getElementById('rnnCharts').innerHTML = '<div class="small muted">Hidden state over 40 steps</div>' + lineChart([{ color: 'var(--s1)', pts: h.map((v, i) => [i + 1, v]) }], { y0: -1, y1: 1, yTicks: [-1, 0, 1], xLabel: 'step', h: 150, label: 'Hidden state' })
        + '<div class="small muted" style="margin-top:8px">How much each input still affects the final state, on a log scale</div>' + lineChart([{ bars: true, color: 'var(--s2)', pts: infl.map((v, i) => [i + 1, v]), tip: (s, v) => `step ${s}: ${v.toExponential(1)}` }], { log: true, y0: lo, y1: hi, yTicks: [-8, -4, 0, 2], fmtY: v => '10^' + v, xLabel: 'input step', h: 190, label: 'Influence of each input' });
      const first = infl[0], last = infl[T - 1];
      env.readout.innerHTML = `<span>Influence of step 1 on the end <b>${first.toExponential(1)}</b></span><span>Of step 40 <b>${last.toExponential(1)}</b></span><span><b>${first < last * 0.05 ? 'Vanishing: early inputs are almost forgotten' : first > last * 20 ? 'Exploding: early inputs dominate' : 'Early and late inputs still both count'}</b></span>`;
    }
    env.legendCustom([]); env.onTheme(draw); draw();
  } });

add({ id: 'transformer', name: 'Transformer', family: 'Deep learning', group: 'Sequences',
  how: 'Every token looks at every earlier token through attention, weighting each by relevance, then passes through an MLP. Stacking these layers and training on next-token prediction produces large language models. Because any two positions connect in one step, it avoids the RNN\'s fading memory and trains in parallel.',
  formula: 'Attention(Q, K, V) = softmax(Q Kᵀ / √dₖ) V',
  best: ['Language and code', 'Images, audio and video with enough data', 'Long-range structure'],
  avoid: ['Small datasets with no pretrained model to start from', 'Tight compute budgets on long inputs, since attention cost grows with the square of the length'],
  examples: ['Chat and code assistants', 'Translation', 'Speech recognition such as Whisper'],
  ai: 'This is the architecture behind every LLM in this lab. The <a href="/transformer">Transformer explainer</a> shows one running step by step, and <a href="/building">How LLMs are built</a> shows how one is trained.',
  row: ['Language, code, multimodal', 'Attention plus MLP, stacked', 'Heavy compute; quadratic in length', 'Chat assistants, translation, speech'],
  demo(env) {
    env.plot.innerHTML = `<div class="card"><h3 style="margin-top:0">Steps for word 1 to reach word 40</h3>
      <div class="readout" style="font-size:15px"><span>RNN <b>39 sequential steps</b>, each one shrinking or distorting the signal</span><span>Transformer <b>1 attention step</b>, for any pair of positions</span></div>
      <p class="small muted">That direct connection, plus training every position in parallel on GPUs, is why transformers took over language. The price is that attention compares every pair of tokens, so its cost grows with the square of the context length.</p>
      <div class="row"><a class="btn primary" href="/transformer">Open the Transformer explainer</a><a class="btn" href="/building">How LLMs are built</a></div></div>`;
    env.ctrl.innerHTML = ''; env.readout.innerHTML = ''; env.legendCustom([]);
  } });

export const __ML_ALGOS = A;
