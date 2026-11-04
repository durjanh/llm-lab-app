/* The training page's transformer section: trains the tiny transformer in tinyTransformer.ts live and
 * draws its loss, its attention scores and one head's attention pattern as it learns. */
import type { Life } from '@/lib/lifecycle';
import { Site } from '@/lib/site';
import * as TT from './tinyTransformer';

type Task = 'induction' | 'text';

const T = 16; // context length
const D = 32; // embedding size
const HIDDEN = 32; // MLP hidden units, when the MLP is on
const BATCH = 16;
const MIN_RUN = 4;
const EVAL_N = 48;
const EVAL_EVERY = 25;
const RUN_STEPS = 2000;
const SLICE = 14; // ms of training per slice, so the page stays responsive
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

const TEXT = `Peter Piper picked a peck of pickled peppers. A peck of pickled peppers Peter Piper picked. If Peter Piper picked a peck of pickled peppers, where's the peck of pickled peppers Peter Piper picked?
How much wood would a woodchuck chuck if a woodchuck could chuck wood? A woodchuck would chuck as much wood as a woodchuck could chuck if a woodchuck could chuck wood.
She sells sea shells by the sea shore. The shells she sells are sea shells, I'm sure. So if she sells sea shells on the sea shore, then I'm sure she sells sea shore shells.
Betty Botter bought some butter, but she said the butter's bitter. If I put it in my batter, it will make my batter bitter. But a bit of better butter will make my batter better.`;

interface Point {
  step: number;
  loss: number;
  rep: number | null; // loss on the second copy
  acc: number | null; // accuracy on the second copy
  ind: number | null; // best induction score among the last layer's heads
  prev: number; // best previous-token score among the first layer's heads
}

interface Run {
  task: Task;
  layers: number;
  heads: number;
  mlp: boolean;
  step: number;
  last: Point;
}

/** Starts the section. Training runs in short slices through `life`, so it stops when you leave the page. */
export function mount(root: HTMLElement | null, life: Life): void {
  if (!root || !root.querySelector('#atCard')) return;
  const el = <E extends Element = HTMLElement>(id: string) => root.querySelector('#' + id) as E;
  const { esc, fmtInt } = Site;

  const chars = [...new Set(TEXT)].sort();
  const textIds = Array.from(TEXT, (c) => chars.indexOf(c));
  const show = (c: string) => (c === ' ' ? '·' : c === '\n' ? '↵' : c);

  const S = {
    task: 'induction' as Task,
    layers: 2,
    mlp: false,
    heads: 1,
    lr: 0.003,
    M: null as TT.Model | null,
    V: LETTERS.length,
    step: 0,
    target: RUN_STEPS,
    running: false,
    diverged: false,
    data: TT.seeded(2),
    evalInd: [] as TT.InductionExample[],
    evalText: [] as TT.Example[],
    sample: null as TT.Example | null,
    sampleRun: null as TT.InductionExample | null,
    sampleRand: TT.seeded(7),
    points: [] as Point[],
    formedAt: null as number | null,
    view: { l: 1, h: 0 },
    text: '',
    rate: 0,
    rateT: 0,
    rateSteps: 0,
    history: [] as Run[],
    ran: { task: 'induction' as Task, layers: 2, heads: 1, mlp: false },
    shown: -1,
  };

  const lrOf = (v: number) => Math.pow(10, v);

  function newSample() {
    if (S.task === 'induction') {
      S.sampleRun = TT.inductionExample(S.V, T, S.sampleRand, MIN_RUN);
      S.sample = S.sampleRun;
    } else {
      S.sampleRun = null;
      S.sample = TT.textExample(textIds, T, Math.floor(S.sampleRand() * (textIds.length - T - 1)));
    }
    S.shown = -1;
  }

  /** Keeps a line about the run being replaced, so 1 and 2 layers can be compared. */
  function archive() {
    if (!S.M || S.step < 100 || !S.points.length) return;
    S.history.unshift({ ...S.ran, step: S.step, last: S.points[S.points.length - 1] });
    S.history.length = Math.min(S.history.length, 6);
  }

  function reset() {
    S.running = false;
    S.ran = { task: S.task, layers: S.layers, heads: S.heads, mlp: S.mlp };
    S.diverged = false;
    S.V = S.task === 'induction' ? LETTERS.length : chars.length;
    S.M = TT.create({ V: S.V, T, d: D, layers: S.layers, heads: S.heads, F: S.mlp ? HIDDEN : 0 }, TT.seeded(1));
    S.data = TT.seeded(2);
    const ev = TT.seeded(99);
    S.evalInd =
      S.task === 'induction' ? Array.from({ length: EVAL_N }, () => TT.inductionExample(S.V, T, ev, MIN_RUN)) : [];
    S.evalText =
      S.task === 'text'
        ? Array.from({ length: EVAL_N }, (_, i) =>
            TT.textExample(textIds, T, Math.floor((i * (textIds.length - T - 1)) / EVAL_N)),
          )
        : [];
    S.step = 0;
    S.target = RUN_STEPS;
    S.points = [];
    S.formedAt = null;
    S.text = '';
    S.view = { l: S.layers - 1, h: 0 };
    S.sampleRand = TT.seeded(7);
    newSample();
    evaluate();
    buildViewChips();
    render(true);
  }

  function example(): TT.Example {
    if (S.task === 'induction') return TT.inductionExample(S.V, T, S.data, MIN_RUN);
    return TT.textExample(textIds, T, Math.floor(S.data() * (textIds.length - T - 1)));
  }

  function evaluate() {
    const M = S.M;
    if (!M) return;
    const best = (rows: number[][], l: number) => Math.max(...rows[l]);
    if (S.task === 'induction') {
      const e = TT.evalInduction(M, S.evalInd);
      const p: Point = {
        step: S.step,
        loss: e.loss,
        rep: e.repeatLoss,
        acc: e.repeatAcc,
        ind: best(e.scores.induction, S.layers - 1),
        prev: best(e.scores.previous, 0),
      };
      S.points.push(p);
      if (S.formedAt === null && S.step > 0 && (p.acc ?? 0) >= 0.8 && (p.ind ?? 0) >= 0.5) S.formedAt = S.step;
    } else {
      const e = TT.evalText(M, S.evalText);
      S.points.push({ step: S.step, loss: e.loss, rep: null, acc: null, ind: null, prev: best(e.previous, 0) });
      if (S.step % 250 === 0) {
        const seed = textIds.slice(0, T);
        S.text = TT.generate(M, seed, 90, 0.7, TT.seeded(S.step + 3))
          .map((i) => chars[i])
          .join('');
      }
    }
  }

  // ---------- the training loop: about 14 ms of steps, then yield to the browser ----------
  function pump() {
    if (!S.running || !S.M) return;
    const t0 = performance.now();
    try {
      while (S.running && performance.now() - t0 < SLICE) {
        const batch = Array.from({ length: BATCH }, example);
        const loss = TT.trainStep(S.M, batch, S.lr);
        if (!Number.isFinite(loss)) {
          S.running = false;
          S.diverged = true;
          break;
        }
        S.step++;
        S.rateSteps++;
        if (S.step % EVAL_EVERY === 0 || S.step >= S.target) evaluate();
        if (S.step >= S.target) S.running = false;
      }
    } catch (err) {
      console.error(err);
      S.running = false;
    }
    scheduleRender();
    if (S.running) life.setTimeout(pump, 0);
  }

  function start() {
    if (!S.M || S.running) return;
    if (S.step >= S.target) S.target = S.step + RUN_STEPS;
    S.running = true;
    S.rateT = performance.now();
    S.rateSteps = 0;
    S.rate = 0;
    life.setTimeout(pump, 0);
    render(true);
  }

  // ---------- drawing ----------
  let queued = false,
    lastChart = 0;
  function scheduleRender() {
    if (queued) return;
    queued = true;
    life.requestAnimationFrame(() => {
      queued = false;
      render(false);
    });
  }

  interface Series {
    key: keyof Point;
    colour: string;
    label: string;
  }

  function chart(id: string, wrapId: string, series: Series[], yTop: number, yLabel: string, base?: number) {
    const svg = el<SVGSVGElement>(id);
    const W = Math.max(260, Math.round(el(wrapId).clientWidth || 500)),
      H = 220;
    const l = 38,
      r = 12,
      t = 14,
      b = 30,
      pw = W - l - r,
      ph = H - t - b;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const xMax = Math.max(S.target, S.step, 10);
    const X = (s: number) => l + (pw * s) / xMax,
      Y = (v: number) => t + ph * (1 - Math.min(v, yTop) / yTop);
    const ys = yTop > 2 ? 1 : 0.25;
    let g = '';
    for (let v = 0; v <= yTop + 1e-9; v += ys) {
      g += `<line class="grid" x1="${l}" x2="${l + pw}" y1="${Y(v)}" y2="${Y(v)}"></line><text x="${l - 6}" y="${Y(v) + 4}" text-anchor="end">${+v.toFixed(2)}</text>`;
    }
    const xs = xMax > 4000 ? 2000 : xMax > 1500 ? 1000 : 500;
    for (let s = 0; s <= xMax; s += xs) {
      g += `<text x="${X(s)}" y="${t + ph + 15}" text-anchor="${X(s) > W - 24 ? 'end' : 'middle'}">${fmtInt(s)}</text>`;
    }
    g += `<line class="axis" x1="${l}" x2="${l + pw}" y1="${t + ph}" y2="${t + ph}"></line>`;
    g += `<text x="${l - 6}" y="${t - 4}" text-anchor="start">${yLabel}</text><text x="${l + pw}" y="${H - 3}" text-anchor="end">training steps</text>`;
    if (base !== undefined) g += `<line class="base" x1="${l}" x2="${l + pw}" y1="${Y(base)}" y2="${Y(base)}"></line>`;
    if (S.formedAt !== null) {
      const x = X(S.formedAt);
      g += `<line class="xh" x1="${x}" x2="${x}" y1="${t}" y2="${t + ph}" style="stroke-dasharray:3 3"></line>`;
      g += `<text class="lbl" x="${x + 5}" y="${t + 11}">induction head</text>`;
    }
    for (const s of series) {
      const pts = S.points.filter((p) => p[s.key] !== null);
      if (pts.length < 2) continue;
      const d = pts
        .map((p, i) => `${i ? 'L' : 'M'}${X(p.step).toFixed(1)} ${Y(p[s.key] as number).toFixed(1)}`)
        .join('');
      g += `<path class="ln" d="${d}" style="stroke:${s.colour}"></path>`;
    }
    svg.innerHTML = g;
  }

  function grid() {
    const M = S.M,
      ex = S.sample;
    if (!M || !ex) return;
    TT.forward(M, ex.x);
    const { l, h } = S.view;
    const A = M.buf.L[l].A,
      base = h * T * T;
    const c = 22,
      pad = 20,
      W = pad + T * c;
    const lab = (v: number) => (S.task === 'induction' ? LETTERS[v] : show(chars[v]));
    const target = new Set<number>();
    const run = S.sampleRun;
    if (run) for (const t of TT.repeatedPositions(run, T)) target.add(t * T + (t - run.run + 1));
    let g = '';
    for (let j = 0; j < T; j++) {
      g += `<text x="${pad + j * c + c / 2}" y="${pad - 6}" text-anchor="middle">${esc(lab(ex.x[j]))}</text>`;
    }
    for (let i = 0; i < T; i++) {
      g += `<text x="${pad - 6}" y="${pad + i * c + c / 2 + 4}" text-anchor="end">${esc(lab(ex.x[i]))}</text>`;
      for (let j = 0; j < T; j++) {
        const x = pad + j * c,
          y = pad + i * c;
        if (j > i) {
          g += `<rect class="masked" x="${x}" y="${y}" width="${c - 1}" height="${c - 1}"></rect>`;
          continue;
        }
        const w = A[base + i * T + j];
        g += `<rect class="cell" data-i="${i}" data-j="${j}" x="${x}" y="${y}" width="${c - 1}" height="${c - 1}" style="fill-opacity:${Math.max(0.04, w).toFixed(3)}"></rect>`;
        if (target.has(i * T + j))
          g += `<rect class="target" x="${x + 1}" y="${y + 1}" width="${c - 3}" height="${c - 3}"></rect>`;
      }
    }
    const svg = el<SVGSVGElement>('atGrid');
    svg.setAttribute('viewBox', `0 0 ${W} ${W}`);
    svg.innerHTML = g;
    el('atGridCap').textContent = run
      ? `This sequence: ${run.start} filler letter${run.start === 1 ? '' : 's'}, then a run of ${run.run} letters, then the run again from position ${run.start + run.run}.`
      : 'A window of the training text. · is a space.';
  }

  const gridSvg = el<SVGSVGElement>('atGrid');
  life.on(gridSvg, 'pointermove', (e) => {
    const ev = e as PointerEvent,
      tgt = ev.target as Element;
    const M = S.M,
      ex = S.sample;
    if (!M || !ex || !tgt.classList.contains('cell')) return Site.tip(null);
    const i = +(tgt.getAttribute('data-i') ?? 0),
      j = +(tgt.getAttribute('data-j') ?? 0);
    TT.forward(M, ex.x);
    const w = M.buf.L[S.view.l].A[S.view.h * T * T + i * T + j];
    const lab = (v: number) => (S.task === 'induction' ? LETTERS[v] : show(chars[v]));
    Site.tip(
      `Position ${i} (<b>${esc(lab(ex.x[i]))}</b>) gives position ${j} (<b>${esc(lab(ex.x[j]))}</b>) <b>${(w * 100).toFixed(0)}%</b> of its attention.`,
      ev,
    );
  });
  life.on(gridSvg, 'pointerleave', () => Site.tip(null));

  function buildViewChips() {
    const box = el('atView');
    let h = '';
    for (let l = 0; l < S.layers; l++) {
      for (let k = 0; k < S.heads; k++) {
        const on = l === S.view.l && k === S.view.h;
        h += `<button class="chip-btn${on ? ' on' : ''}" data-l="${l}" data-h="${k}">Layer ${l + 1}, head ${k + 1}</button> `;
      }
    }
    box.innerHTML = h;
  }

  function note(): [string, string] {
    const p = S.points[S.points.length - 1];
    if (S.diverged) return ['bad', 'The loss stopped being a finite number. Lower the learning rate and press Reset.'];
    if (S.step === 0) {
      return [
        'info',
        S.task === 'induction'
          ? `Ready. The weights are random, so every letter gets about 1 in ${S.V} and attention is spread evenly. Press Train.`
          : 'Ready. The weights are random, so every character is equally likely. Press Train.',
      ];
    }
    if (S.task === 'text') {
      return [
        'ok',
        'Learning. The loss falls as the model learns which characters follow which. Look for heads that attend to the previous character, and to earlier copies of a word such as "pick" or "chuck".',
      ];
    }
    if (S.formedAt !== null) {
      return [
        'ok',
        `An induction head formed at about step ${fmtInt(S.formedAt)}. The model now gets ${Math.round((p.acc ?? 0) * 100)}% of the repeated letters right by looking back at the earlier copy.`,
      ];
    }
    if (S.layers === 1 && S.step >= 1500) {
      return [
        'warn',
        'One layer has stalled. It can guess among letters it has already seen, but it cannot find the letter that followed the earlier copy. Switch to 2 layers and train again.',
      ];
    }
    return [
      'info',
      'On the plateau. The model is learning letter frequencies and guessing among letters it has seen. With 2 layers, watch for the sudden drop.',
    ];
  }

  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);
  const num = (v: number | null | undefined) => (v === null || v === undefined ? '–' : v.toFixed(2));

  function render(force: boolean) {
    const p = S.points[S.points.length - 1],
      now = performance.now(),
      ind = S.task === 'induction';
    if (S.running && now - S.rateT > 800) {
      S.rate = (S.rateSteps * 1000) / (now - S.rateT);
      S.rateT = now;
      S.rateSteps = 0;
    }
    el('atStep').textContent = fmtInt(S.step);
    el('atStepK').textContent =
      `steps of ${fmtInt(S.target)}` + (S.running && S.rate ? `, ${fmtInt(S.rate)} a second` : '');
    el('atLoss').textContent = num(p?.loss);
    el('atRep').textContent = num(p?.rep);
    el('atAcc').textContent = pct(p?.acc);
    el('atInd').textContent = num(p?.ind);
    el('atPrev').textContent = num(p?.prev);
    for (const id of ['atRepBox', 'atAccBox', 'atIndBox']) el(id).hidden = !ind;
    const [cls, msg] = note();
    const v = el('atNote');
    if (v.textContent !== msg) {
      v.className = 'verdict ' + cls;
      v.textContent = msg;
    }
    el<HTMLButtonElement>('atGo').disabled = S.running || !S.M;
    el('atGo').textContent = S.step === 0 ? 'Train' : S.step >= S.target ? 'Train more' : 'Resume';
    el<HTMLButtonElement>('atPause').disabled = !S.running;
    el('atLrV').textContent = S.lr.toPrecision(2);
    el('atLossKey2').hidden = !ind;
    el('atScoreKeyInd').hidden = !ind;
    el('atScoreKeyAcc').hidden = !ind;
    el('atSampleBox').hidden = ind;
    el('atSample').innerHTML = S.text
      ? `<span class="seed">${esc(TEXT.slice(0, T))}</span>${esc(S.text)}`
      : 'A sample appears every 250 steps.';
    if (force || !S.running || now - lastChart > 150) {
      lastChart = now;
      chart(
        'atLossChart',
        'atLossWrap',
        [
          { key: 'loss', colour: 'var(--s1)', label: 'all positions' },
          { key: 'rep', colour: 'var(--s2)', label: 'second copy' },
        ],
        Math.ceil(Math.log(S.V) + 0.3),
        'loss',
        Math.log(S.V),
      );
      chart(
        'atScoreChart',
        'atScoreWrap',
        [
          { key: 'ind', colour: 'var(--s1)', label: 'induction score' },
          { key: 'prev', colour: 'var(--s3)', label: 'previous-token score' },
          { key: 'acc', colour: 'var(--s2)', label: 'accuracy on the second copy' },
        ],
        1,
        'score',
      );
    }
    if (force || S.shown !== S.step) {
      S.shown = S.step;
      grid();
    }
    renderHistory();
  }

  let historyHtml = '';
  function renderHistory() {
    const rows = S.history
      .map(
        (r) =>
          `<tr><td>${r.task === 'induction' ? 'Repeated pattern' : 'Short text'}</td><td class="num">${r.layers}</td><td class="num">${r.heads}</td><td>${r.mlp ? 'yes' : 'no'}</td><td class="num">${fmtInt(r.step)}</td><td class="num">${r.last.loss.toFixed(2)}</td><td class="num">${pct(r.last.acc)}</td><td class="num">${num(r.last.ind)}</td></tr>`,
      )
      .join('');
    const html = rows
      ? `<table class="t"><thead><tr><th>Task</th><th class="num">Layers</th><th class="num">Heads</th><th>MLP</th><th class="num">Steps</th><th class="num">Loss</th><th class="num">Accuracy on second copy</th><th class="num">Induction score</th></tr></thead><tbody>${rows}</tbody></table>`
      : '';
    if (html !== historyHtml) {
      historyHtml = html;
      el('atHistory').innerHTML = html;
      el('atHistoryBox').hidden = !html;
    }
  }

  // ---------- controls ----------
  life.on(el('atTask'), 'click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('.chip-btn');
    if (!b || b.dataset.t === S.task) return;
    archive();
    S.task = b.dataset.t as Task;
    root.querySelectorAll<HTMLElement>('#atTask .chip-btn').forEach((x) => x.classList.toggle('on', x === b));
    // Text needs the MLP to learn which letters follow which; the repeated pattern trains cleanest without it.
    S.mlp = S.task === 'text';
    el<HTMLInputElement>('atMlp').checked = S.mlp;
    reset();
  });
  life.on(el('atLayers'), 'change', () => {
    archive();
    S.layers = +el<HTMLSelectElement>('atLayers').value;
    reset();
  });
  life.on(el('atHeads'), 'change', () => {
    archive();
    S.heads = +el<HTMLSelectElement>('atHeads').value;
    reset();
  });
  life.on(el('atMlp'), 'change', () => {
    archive();
    S.mlp = el<HTMLInputElement>('atMlp').checked;
    reset();
  });
  life.on(el('atLr'), 'input', () => {
    S.lr = lrOf(+el<HTMLInputElement>('atLr').value);
    render(true);
  });
  life.on(el('atView'), 'click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('.chip-btn');
    if (!b) return;
    S.view = { l: +(b.dataset.l ?? 0), h: +(b.dataset.h ?? 0) };
    buildViewChips();
    render(true);
  });
  life.on(el('atNew'), 'click', () => {
    newSample();
    render(true);
  });
  life.on(el('atGo'), 'click', start);
  life.on(el('atPause'), 'click', () => {
    S.running = false;
    render(true);
  });
  life.on(el('atReset'), 'click', () => {
    archive();
    reset();
  });
  new life.ResizeObserver(() => render(true)).observe(el('atLossWrap'));

  S.lr = lrOf(+el<HTMLInputElement>('atLr').value);
  S.mlp = el<HTMLInputElement>('atMlp').checked;
  reset();
}
