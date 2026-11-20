import { useEffect, useRef, useState } from 'react';
import { STILL_TIME, createStage } from '@/lib/canvasStage';
import { type Block, type Kind, type Run, type Strategy, k, usd } from './contextsim';

export interface WindowFlowProps {
  run: Run;
  window: number;
  strategy: Strategy;
  trigger: number | null;
  hasTools: boolean;
  /** The task's turns, whether or not the run gets through them. */
  totalTurns: number;
  priced: boolean;
  /** Changes whenever the run should start again from the beginning. */
  runKey: string;
}

const COLOR_VARS: Record<Kind | 'sent' | 'cachedSent', string> = {
  prefix: '--ink2',
  message: '--s1',
  result: '--s5',
  cleared: '--faint',
  summary: '--s3',
  sent: '--brand',
  cachedSent: '--brand-line',
};
const SPEEDS = { slow: 0.55, normal: 0.26, fast: 0.12 } as const;
type Speed = keyof typeof SPEEDS;

interface Dot {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  born: number;
  dur: number;
  color: string;
  bend: number;
  r: number;
}

/** The context window as a tall glass that fills turn by turn; every request sends all of it to the model. */
export function WindowFlow(props: WindowFlowProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const meter = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState<Speed>('normal');
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const [restartTick, setRestartTick] = useState(0);
  const restartRef = useRef(restartTick);
  restartRef.current = restartTick;

  useEffect(() => {
    const box = wrap.current!;
    let W = 0;
    let H = 0;
    const stage = createStage({
      canvas: canvas.current!,
      box,
      minWidth: 300,
      heightFor: (w) => (w < 600 ? 380 : 420),
      onSize: (w, h) => {
        W = w;
        H = h;
      },
      paused: () => pausedRef.current,
      before: () => {
        if (live.current.runKey !== key || restartRef.current !== restartSeen) restart();
      },
      step: advance,
      still: (t) => {
        draw(t);
        writeMeter(stage.reduce || isDone());
      },
    });
    const ctx = stage.ctx;
    const reduce = stage.reduce;

    let colors = {} as Record<string, string>;
    const readColors = () => {
      const v = stage.css;
      colors = Object.fromEntries(Object.entries(COLOR_VARS).map(([key, name]) => [key, v(name)]));
      Object.assign(colors, {
        ink: v('--ink'),
        muted: v('--muted'),
        line: v('--line2'),
        surface: v('--surface'),
        soft: v('--soft'),
        bad: v('--bad'),
        warn: v('--warn'),
      });
    };
    readColors();

    // Geometry, recomputed from W and H on every frame.
    const g = () => {
      const narrow = W < 600;
      const gx = narrow ? W * 0.38 : W * 0.42;
      const gw = narrow ? W * 0.24 : Math.min(170, W * 0.17);
      return {
        you: [Math.max(56, W * 0.1), H * 0.25] as [number, number],
        tools: [Math.max(56, W * 0.1), H * 0.7] as [number, number],
        sub: [W * 0.27, H * 0.86] as [number, number],
        model: [narrow ? W * 0.84 : W * 0.82, H * 0.45] as [number, number],
        gx,
        gw,
        top: H * 0.07,
        bottom: H * 0.93,
      };
    };

    // The state of the animation.
    let key = '';
    let turnIndex = -1;
    let heights = new Map<number, number>(); // block id -> current token height, eased towards the target
    let blocks: Block[] = [];
    let dots: Dot[] = [];
    let spent = 0;
    let sent = 0;
    let flash = 0;
    let lastEvent = '';
    let restartSeen = restartRef.current;
    let speedSeen = speedRef.current;

    const restart = () => {
      const p = live.current;
      key = p.runKey;
      restartSeen = restartRef.current;
      stage.restartClock();
      turnIndex = -1;
      heights = new Map();
      blocks = [];
      dots = [];
      spent = 0;
      sent = 0;
      flash = 0;
      lastEvent = '';
      const first = p.run.steps[0];
      if (first) {
        blocks = first.blocks.filter((b) => b.kind === 'prefix');
        for (const b of blocks) heights.set(b.id, b.tokens);
      }
      readColors();
    };

    const blockY = (G: ReturnType<typeof g>) => {
      // Bottom-up stacking: returns [block, y top, height in px].
      const p = live.current;
      const span = G.bottom - G.top;
      let y = G.bottom;
      const out: [Block, number, number][] = [];
      for (const b of blocks) {
        const h = ((heights.get(b.id) ?? 0) / p.window) * span;
        y -= h;
        out.push([b, y, h]);
      }
      return out;
    };

    const emit = (
      from: [number, number],
      to: [number, number],
      n: number,
      color: string,
      t: number,
      over: number,
      r = 2.6,
    ) => {
      for (let i = 0; i < n; i++) {
        dots.push({
          x1: from[0],
          y1: from[1],
          x2: to[0],
          y2: to[1],
          born: t + (n > 1 ? (i / n) * over : 0),
          dur: 0.55,
          color,
          bend: (Math.random() - 0.5) * 50,
          r,
        });
      }
    };

    /** Starts turn i: its dots, and the targets the blocks ease towards. */
    const beginTurn = (i: number, t: number) => {
      const p = live.current;
      const step = p.run.steps[i];
      if (!step) return;
      const G = g();
      const dt = SPEEDS[speedRef.current];
      const ids = new Set(step.blocks.map((b) => b.id));
      // Blocks that left (compaction) shrink to nothing; new ones start at zero and grow as their dots land.
      for (const b of blocks) if (!ids.has(b.id)) heights.set(b.id, heights.get(b.id) ?? 0);
      const keepGone = blocks.filter((b) => !ids.has(b.id));
      blocks = [
        ...step.blocks.filter((b) => b.kind === 'prefix'),
        ...keepGone.filter((b) => b.kind !== 'prefix'),
        ...step.blocks.filter((b) => b.kind !== 'prefix'),
      ];
      for (const b of step.blocks) if (!heights.has(b.id)) heights.set(b.id, step.added.includes(b.id) ? 0 : b.tokens);
      const glassTop = (): [number, number] => {
        const ys = blockY(G);
        const y = ys.length ? ys[ys.length - 1][1] : G.bottom;
        return [G.gx + G.gw / 2, Math.max(G.top + 6, y - 4)];
      };
      const gtop = glassTop();
      emit(G.you, gtop, 1, colors.message, t, 0, 3.2);
      // The request: the whole window goes to the model.
      const many = Math.max(3, Math.min(46, Math.round(step.input / 4000)));
      const cachedShare = step.input ? step.cached / step.input : 0;
      for (let j = 0; j < many; j++) {
        const y = G.bottom - ((G.bottom - G.top) * (step.input / p.window) * (j + 0.5)) / many;
        const c = j / many < cachedShare ? colors.cachedSent : colors.sent;
        dots.push({
          x1: G.gx + G.gw,
          y1: y,
          x2: G.model[0] - 34,
          y2: G.model[1],
          born: t + dt * 0.22 + (j / many) * dt * 0.3,
          dur: 0.5,
          color: c,
          bend: (Math.random() - 0.5) * 30,
          r: 2.2,
        });
      }
      emit([G.model[0] - 34, G.model[1]], gtop, 2, colors.message, t + dt * 0.55, dt * 0.15, 3);
      const added = step.blocks.filter((b) => step.added.includes(b.id) && b.kind !== 'message');
      for (const b of added) {
        if (b.kind === 'summary' && p.strategy === 'subagent') {
          emit(
            G.tools,
            G.sub,
            Math.max(2, Math.min(16, Math.round(((step.subInput || 0) - 2000) / 1000))),
            colors.result,
            t + dt * 0.7,
            dt * 0.2,
          );
          emit(G.sub, gtop, 1, colors.summary, t + dt * 0.95, 0, 3.2);
        } else if (b.kind === 'result') {
          emit(
            G.tools,
            gtop,
            Math.max(1, Math.min(16, Math.round(b.tokens / 1000))),
            colors.result,
            t + dt * 0.7,
            dt * 0.25,
          );
        }
      }
      if (step.event) {
        lastEvent = `Turn ${step.turn}: ${step.event}`;
        if (/compacted|cleared|fails/.test(step.event)) flash = t;
      }
      spent += step.cost;
      sent += step.input + step.subInput;
    };

    const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

    const writeMeter = (done: boolean) => {
      const el = meter.current;
      if (!el) return;
      const p = live.current;
      const step = p.run.steps[Math.max(0, turnIndex)];
      const used = blocks.reduce((s, b) => s + (heights.get(b.id) ?? 0), 0);
      const set = (sel: string, text: string) => {
        const node = el.querySelector(sel);
        if (node) node.textContent = text;
      };
      set('[data-m=turn]', `${turnIndex >= 0 && step ? step.turn : 0} of ${p.totalTurns}`);
      set('[data-m=used]', `${k(used)} of ${k(p.window)}`);
      set('[data-m=pct]', `${Math.min(100, Math.round((used / p.window) * 100))}%`);
      set('[data-m=sent]', k(sent));
      set('[data-m=cost]', p.priced ? usd(spent) : '—');
      set('[data-m=event]', lastEvent || 'Every request sends the whole window to the model.');
      const bar = el.querySelector<HTMLElement>('[data-m=bar]');
      if (bar) bar.style.width = `${Math.min(100, (used / p.window) * 100)}%`;
      el.classList.toggle('full', p.run.fullAt !== null && done);
      el.classList.toggle('done', done);
    };

    const draw = (t: number) => {
      const p = live.current;
      const G = g();
      ctx.clearRect(0, 0, W, H);
      const node = (at: [number, number], label: string, sub: string, w = 96) => {
        ctx.fillStyle = colors.surface;
        ctx.strokeStyle = colors.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(at[0] - w / 2, at[1] - 20, w, 40, 10);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = colors.ink;
        ctx.textAlign = 'center';
        ctx.font = '600 12px -apple-system, Segoe UI, sans-serif';
        ctx.fillText(label, at[0], at[1] - 2);
        ctx.fillStyle = colors.muted;
        ctx.font = '11px -apple-system, Segoe UI, sans-serif';
        ctx.fillText(sub, at[0], at[1] + 13);
      };
      node(G.you, 'You', 'a message a turn');
      if (p.hasTools) node(G.tools, 'Tools', 'files, tests, pages');
      if (p.hasTools && p.strategy === 'subagent') node(G.sub, 'Sub-agent', 'reads, then sums up', 110);

      // The model.
      ctx.save();
      const [mx, my] = G.model;
      const busy = dots.some((d) => d.color === colors.sent && t - d.born < d.dur && t >= d.born);
      const R = 34;
      const glow = ctx.createRadialGradient(mx, my, 6, mx, my, R * 1.9);
      glow.addColorStop(0, colors.sent + (busy ? '55' : '22'));
      glow.addColorStop(1, colors.sent + '00');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(mx, my, R * 1.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colors.surface;
      ctx.strokeStyle = colors.sent;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(mx, my, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = colors.ink;
      ctx.textAlign = 'center';
      ctx.font = '700 12px -apple-system, Segoe UI, sans-serif';
      ctx.fillText('Model', mx, my + 4);
      ctx.restore();

      // The glass.
      ctx.save();
      ctx.fillStyle = colors.soft;
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(G.gx, G.top, G.gw, G.bottom - G.top, 12);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.roundRect(G.gx, G.top, G.gw, G.bottom - G.top, 12);
      ctx.clip();
      for (const [b, y, h] of blockY(G)) {
        if (h <= 0.2) continue;
        ctx.fillStyle = colors[b.kind];
        ctx.globalAlpha = b.kind === 'cleared' ? 0.6 : 0.88;
        ctx.fillRect(G.gx, y, G.gw, h);
        if (h > 3) {
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = colors.surface;
          ctx.fillRect(G.gx, y, G.gw, 1);
        }
      }
      ctx.globalAlpha = 1;
      const since = t - flash;
      if (flash && since < 0.8) {
        ctx.fillStyle = colors.warn;
        ctx.globalAlpha = 0.35 * (1 - since / 0.8);
        ctx.fillRect(G.gx, G.top, G.gw, G.bottom - G.top);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      // Lines: the limit, and the strategy's trigger.
      const lineAt = (tokens: number, color: string, label: string, dash: number[]) => {
        const y = G.bottom - (G.bottom - G.top) * (tokens / p.window);
        if (y < G.top - 1) return;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.setLineDash(dash);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(G.gx - 10, y);
        ctx.lineTo(G.gx + G.gw + 10, y);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.font = '600 11px -apple-system, Segoe UI, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(label, G.gx - 14, y + 4);
        ctx.restore();
      };
      lineAt(p.window, colors.bad, `limit ${k(p.window)}`, []);
      if (p.trigger)
        lineAt(p.trigger, colors.warn, `${p.strategy === 'compact' ? 'compact' : 'clear'} at ${k(p.trigger)}`, [5, 4]);
      ctx.fillStyle = colors.muted;
      ctx.font = '11px -apple-system, Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('context window', G.gx + G.gw / 2, G.bottom + 16);

      // Dots, with a short trail.
      for (const d of dots) {
        const age = t - d.born;
        if (age < 0) continue;
        const kk = age / d.dur;
        if (kk >= 1) continue;
        for (let gi = 2; gi >= 0; gi--) {
          const e = ease(Math.max(0, kk - gi * 0.05));
          const mx2 = (d.x1 + d.x2) / 2;
          const my2 = (d.y1 + d.y2) / 2 + d.bend;
          const x = (1 - e) * (1 - e) * d.x1 + 2 * (1 - e) * e * mx2 + e * e * d.x2;
          const y = (1 - e) * (1 - e) * d.y1 + 2 * (1 - e) * e * my2 + e * e * d.y2;
          ctx.globalAlpha = (gi === 0 ? 1 : 0.3 / gi) * Math.min(1, kk * 6) * (kk > 0.9 ? (1 - kk) / 0.1 : 1);
          ctx.fillStyle = d.color;
          ctx.beginPath();
          ctx.arc(x, y, gi === 0 ? d.r : d.r * 0.8, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };

    const advanceHeights = (dtSec: number) => {
      // Ease each block towards its target: the current step's size, or nothing once it has left.
      const p = live.current;
      const step = p.run.steps[Math.max(0, turnIndex)];
      const target = new Map(step ? step.blocks.map((b) => [b.id, b.tokens]) : []);
      const rate = Math.min(1, dtSec * 7);
      for (const b of blocks) {
        const want = target.get(b.id) ?? 0;
        const now = heights.get(b.id) ?? 0;
        heights.set(b.id, now + (want - now) * rate);
      }
      blocks = blocks.filter((b) => target.has(b.id) || (heights.get(b.id) ?? 0) > 1);
    };

    const isDone = () => turnIndex >= live.current.run.steps.length - 1;
    restart();
    /** One running frame: begin the turns now due, ease the layers, draw, and play again when finished. */
    function advance(clock: number, frameDt: number, now: number) {
      const p = live.current;
      let t = clock;
      if (speedRef.current !== speedSeen) {
        // A new speed: keep the current turn and carry on from it at the new pace.
        speedSeen = speedRef.current;
        const to = (turnIndex + 1) * SPEEDS[speedSeen];
        const shift = to - t;
        stage.setClock(now, to);
        t = to;
        for (const d of dots) d.born += shift;
        if (flash) flash += shift;
      }
      const dt = SPEEDS[speedRef.current];
      const due = Math.floor(t / dt) - 1;
      while (turnIndex < Math.min(due, p.run.steps.length - 1)) {
        turnIndex++;
        beginTurn(turnIndex, t);
      }
      advanceHeights(frameDt);
      dots = dots.filter((d) => t - d.born < d.dur);
      draw(t);
      const done = isDone();
      writeMeter(done);
      if (done && dots.length === 0 && t > (p.run.steps.length + 1) * dt + 3.5) restart(); // play it again
    }

    if (reduce) {
      // No motion: show where the run ends.
      const showEnd = () => {
        restart();
        for (let i = 0; i < live.current.run.steps.length; i++) {
          turnIndex = i;
          beginTurn(i, STILL_TIME);
        }
        dots = [];
        const end = live.current.run.steps[live.current.run.steps.length - 1];
        blocks = end ? end.blocks : [];
        for (const b of blocks) heights.set(b.id, b.tokens);
        draw(STILL_TIME);
        writeMeter(true);
      };
      showEnd();
      const id = window.setInterval(
        () => (live.current.runKey !== key || restartRef.current !== restartSeen) && showEnd(),
        300,
      );
      return () => {
        window.clearInterval(id);
        stage.stop();
      };
    }
    stage.start();
    return stage.stop;
    // The loop reads the latest props through refs; it starts once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="cw-flow">
      <div className="cw-stage" ref={wrap}>
        <canvas
          ref={canvas}
          role="img"
          aria-label="Messages and tool results filling the context window turn by turn, with every request sending the whole window to the model"
        />
      </div>
      <div className="cw-meter" ref={meter}>
        <div className="cw-meter-top">
          <div>
            <span className="small muted">In the window</span>
            <b data-m="used">0</b>
            <span className="cw-pct" data-m="pct">
              0%
            </span>
          </div>
          <div>
            <span className="small muted">Turn</span>
            <b data-m="turn">0</b>
          </div>
          <div>
            <span className="small muted">Sent so far</span>
            <b data-m="sent">0</b>
          </div>
          <div>
            <span className="small muted">Cost so far</span>
            <b data-m="cost">$0</b>
          </div>
        </div>
        <div className="cw-fill">
          <span data-m="bar" />
        </div>
        <p className="small" data-m="event" aria-live="polite" />
        <div className="cw-buttons">
          <button type="button" className="btn small" onClick={() => setPaused((x) => !x)} aria-pressed={paused}>
            {paused ? 'Play' : 'Pause'}
          </button>
          <button type="button" className="btn small" onClick={() => setRestartTick((x) => x + 1)}>
            Restart
          </button>
          <select value={speed} onChange={(e) => setSpeed(e.target.value as Speed)} aria-label="Speed">
            <option value="slow">Slow</option>
            <option value="normal">Normal</option>
            <option value="fast">Fast</option>
          </select>
        </div>
      </div>
    </div>
  );
}
