import { useEffect, useRef, useState } from 'react';
import { STILL_TIME, createStage } from '@/lib/canvasStage';
import {
  type Assumptions,
  type ModelSpec,
  GPU,
  big,
  energy,
  gpusFor,
  joulesForPrompt,
  joulesPerToken,
  opsPerToken,
} from './compute';

export interface Tok {
  id: number;
  text: string;
}

export interface ModelFlowProps {
  model: ModelSpec;
  question: Tok[];
  answer: Tok[];
  assumptions: Assumptions;
  /** Changes whenever the run should start again. */
  runKey: string;
  /** Called with each answer token as it comes out, so the page can show the answer growing. */
  onToken: (count: number) => void;
}

const SPEEDS = { slow: 1.6, normal: 1, fast: 0.45 } as const;
type Speed = keyof typeof SPEEDS;

/** How long one pass through the layers takes on screen: longer for bigger models, as it does for real. */
const passSeconds = (m: ModelSpec) => 0.4 + 0.42 * Math.max(0, Math.log10(m.active / 1e8));

/** Small repeatable pseudo-random numbers, so a token's vector looks the same each time it is drawn. */
const hash = (a: number, b: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** A question going into a model as numbers, through its layers, and an answer coming out one token at a time. */
export function ModelFlow(props: ModelFlowProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const meter = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const [paused, setPaused] = useState(false);
  const [still] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [speed, setSpeed] = useState<Speed>('normal');
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useEffect(() => {
    const box = wrap.current!;
    let W = 0;
    let H = 0;
    const stage = createStage({
      canvas: canvas.current!,
      box,
      minWidth: 300,
      heightFor: (w) => (w < 600 ? 330 : 380),
      onSize: (w, h) => {
        W = w;
        H = h;
      },
      paused: () => pausedRef.current,
      before: () => {
        if (live.current.runKey !== key) restart();
      },
      step: advance,
      still: (t) => {
        draw(t);
        writeMeter();
      },
    });
    const ctx = stage.ctx;
    const reduce = stage.reduce;

    let c = {} as Record<string, string>;
    const readColors = () => {
      const v = stage.css;
      c = {
        ink: v('--ink'),
        muted: v('--muted'),
        line: v('--line2'),
        surface: v('--surface'),
        soft: v('--soft'),
        brand: v('--brand'),
        s1: v('--s1'),
        s2: v('--s2'),
        s3: v('--s3'),
        s4: v('--s4'),
        s5: v('--s5'),
      };
    };
    readColors();

    // Phases: 0 reading the question (all at once), then one pass per answer token.
    let key = '';
    let phase = -1; // -1 before the question; 0 reading it; n = writing answer token n
    let phaseStart = 0;
    let ops = 0;
    let joules = 0;
    let speedSeen = speedRef.current;
    let done = false;

    const restart = () => {
      key = live.current.runKey;
      stage.restartClock();
      phase = -1;
      phaseStart = 0;
      ops = 0;
      joules = 0;
      done = false;
      live.current.onToken(0);
      readColors();
    };

    const layout = () => {
      const narrow = W < 600;
      return {
        inX: narrow ? 30 : 46,
        vecX: W * (narrow ? 0.19 : 0.17),
        l0: W * (narrow ? 0.27 : 0.25),
        l1: W * (narrow ? 0.78 : 0.76),
        outX: W * (narrow ? 0.9 : 0.89),
        top: 40,
        bottom: H - 36,
      };
    };

    const tokenBox = (x: number, y: number, t: Tok, color: string, alpha = 1, showText = true) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = '600 12px ui-monospace, Menlo, monospace';
      const label = String(t.id);
      const w = Math.max(42, ctx.measureText(label).width + 14);
      ctx.fillStyle = c.surface;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - 12, w, 24, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.fillText(label, x, y + 4);
      if (showText) {
        ctx.fillStyle = c.muted;
        ctx.font = '11px -apple-system, Segoe UI, sans-serif';
        ctx.fillText(t.text.trim() || '␣', x, y + 24);
      }
      ctx.restore();
    };

    const draw = (t: number) => {
      const p = live.current;
      const m = p.model;
      const L = layout();
      const pass = passSeconds(m) * SPEEDS[speedRef.current];
      const local = phase >= 0 ? (t - phaseStart) / (phase === 0 ? pass * 1.4 : pass) : 0;
      ctx.clearRect(0, 0, W, H);

      // Labels across the top.
      ctx.fillStyle = c.muted;
      ctx.font = '600 11px -apple-system, Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('numbers in', L.inX, 20);
      ctx.fillText(`${m.width.toLocaleString('en-GB')} numbers each`, L.vecX, 20);
      ctx.fillText(
        `${m.layers} layers · ${big(m.total)} parameters${m.total !== m.active ? ` (${big(m.active)} at work)` : ''}`,
        (L.l0 + L.l1) / 2,
        20,
      );
      ctx.fillText('next token', L.outX, 20);

      // The layers: slabs of weights, lit by the wave as a token passes through.
      const slabs = Math.min(m.layers, W < 600 ? 16 : 32);
      const per = m.layers / slabs;
      const gap = (L.l1 - L.l0) / slabs;
      const sw = Math.max(3, gap * 0.62);
      const density = Math.max(3, Math.min(14, Math.round(Math.log10(m.total) * 1.6 - 9)));
      const wave = phase >= 0 && local < 1 ? local * 1.15 : -1;
      const moe = m.total !== m.active;
      for (let i = 0; i < slabs; i++) {
        const x = L.l0 + i * gap;
        const lit = wave >= 0 ? Math.max(0, 1 - Math.abs(wave - (i + 0.5) / slabs) * 7) : 0;
        ctx.fillStyle = c.soft;
        ctx.strokeStyle = c.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, L.top, sw, L.bottom - L.top, 4);
        ctx.fill();
        ctx.stroke();
        // The weights, as a grid of dots; in a mixture of experts only a few blocks work on each token.
        const rows = density * 4;
        const cols = Math.max(1, Math.floor(sw / 5));
        const experts = 8;
        const chosen = moe
          ? [Math.floor(hash(phase + 3, i) * experts), Math.floor(hash(phase + 7, i * 3) * experts)]
          : [];
        for (let r = 0; r < rows; r++) {
          const e = Math.floor((r / rows) * experts);
          const on = !moe || chosen.includes(e);
          for (let col = 0; col < cols; col++) {
            const dx = x + (sw / (cols + 1)) * (col + 1);
            const dy = L.top + ((L.bottom - L.top) / (rows + 1)) * (r + 1);
            ctx.globalAlpha = (0.2 + 0.5 * hash(i * 31 + r, col)) * (on ? 1 : 0.35) + (on ? lit * 0.6 : 0);
            ctx.fillStyle = on && lit > 0.05 ? c.brand : c.muted;
            ctx.fillRect(dx - 1, dy - 1, 2, 2);
          }
        }
        if (lit > 0) {
          ctx.globalAlpha = lit * 0.45;
          ctx.fillStyle = c.brand;
          ctx.beginPath();
          ctx.roundRect(x - 2, L.top - 2, sw + 4, L.bottom - L.top + 4, 5);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      if (per > 1) {
        ctx.fillStyle = c.muted;
        ctx.font = '11px -apple-system, Segoe UI, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`each slab here is ${per.toFixed(per % 1 ? 1 : 0)} layers`, (L.l0 + L.l1) / 2, H - 12);
      }

      // The numbers going in: the question while it is read, then the newest token.
      const q = p.question;
      const ans = p.answer;
      const shown: { t: Tok; color: string }[] =
        phase <= 0
          ? q.slice(-6).map((x) => ({ t: x, color: c.s1 }))
          : [{ t: ans[phase - 1] ?? ans[ans.length - 1], color: c.s3 }];
      const midY = (L.top + L.bottom) / 2;
      shown.forEach((s, i) => {
        const y =
          shown.length === 1 ? midY : L.top + 10 + (i * (L.bottom - L.top - 20)) / Math.max(1, shown.length - 1);
        const a = phase === -1 && !pausedRef.current && !reduce ? Math.min(1, t * 2) : 1;
        tokenBox(L.inX, y, s.t, s.color, a, W >= 600);
      });
      // Each number becomes a vector: a column of coloured cells.
      if (phase >= 0) {
        const cells = 18;
        const vecs = phase === 0 ? Math.min(6, q.length) : 1;
        for (let v = 0; v < vecs; v++) {
          const tok = phase === 0 ? q[Math.max(0, q.length - vecs) + v] : (ans[phase - 1] ?? ans[0]);
          const x = L.vecX + (v - (vecs - 1) / 2) * 7;
          for (let k2 = 0; k2 < cells; k2++) {
            const h = hash(tok?.id ?? 0, k2);
            ctx.fillStyle = h > 0.5 ? c.s1 : c.s2;
            ctx.globalAlpha = 0.25 + Math.abs(h - 0.5) * 1.4;
            ctx.fillRect(
              x - 2.5,
              L.top + 6 + k2 * ((L.bottom - L.top - 12) / cells),
              5,
              (L.bottom - L.top - 12) / cells - 2,
            );
          }
        }
        ctx.globalAlpha = 1;
        // Arrows of flow.
        ctx.strokeStyle = c.line;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(L.inX + 26, midY);
        ctx.lineTo(L.vecX - 10, midY);
        ctx.moveTo(L.vecX + 26, midY);
        ctx.lineTo(L.l0 - 4, midY);
        ctx.moveTo(L.l1 + 4, midY);
        ctx.lineTo(L.outX - 30, midY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // The next token, then its trip back to the input: each answer token is fed back in.
      if (phase >= 1 && local > 0.85) {
        const tok = ans[phase - 1];
        if (tok) {
          const k3 = Math.min(1, (local - 0.85) / 0.15);
          tokenBox(L.outX, midY, tok, c.s3, k3, true);
        }
      }
      if (phase >= 1 && local < 0.25 && phase > 1) {
        // The previous answer token arcs back to the start.
        const tok = ans[phase - 2];
        if (tok) {
          const e = local / 0.25;
          const x = L.outX + (L.inX - L.outX) * e;
          const y = midY - Math.sin(e * Math.PI) * (midY - 14);
          tokenBox(x, y, tok, c.s3, 1 - e * 0.3, false);
        }
      }
      if (phase === 0 && q.length) {
        ctx.fillStyle = c.ink;
        ctx.font = '600 12px -apple-system, Segoe UI, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`reading all ${q.length} question tokens at once`, L.outX - 20, midY);
      }
    };

    const writeMeter = () => {
      const el = meter.current;
      if (!el) return;
      const p = live.current;
      const m = p.model;
      const per = joulesPerToken(m, p.assumptions);
      const g = gpusFor(m);
      const set = (sel: string, text: string) => {
        const n = el.querySelector(sel);
        if (n) n.textContent = text;
      };
      set(
        '[data-m=step]',
        phase <= 0
          ? phase === 0
            ? 'Reading your question'
            : 'Starting'
          : `Writing token ${phase} of ${p.answer.length}`,
      );
      set('[data-m=pertoken]', `${big(opsPerToken(m))} operations`);
      set('[data-m=ops]', big(ops));
      set('[data-m=gpus]', `${g} × ${GPU.name.split(' (')[0]} · ${((g * GPU.watts) / 1000).toFixed(1)} kW`);
      set('[data-m=energy]', energy(joules));
      set('[data-m=bulb]', `${(joules / 10).toFixed(joules / 10 < 10 ? 1 : 0)} s`);
      set(
        '[data-m=bound]',
        per.memoryBound
          ? 'Each step waits on memory: batching more people together would help.'
          : 'Each step is busy with arithmetic.',
      );
      el.classList.toggle('done', done);
    };

    /** One running frame: finish a pass if its time is up, then draw; play again after a pause on the answer. */
    function advance(clock: number) {
      const p = live.current;
      let t = clock;
      if (speedRef.current !== speedSeen && (done || phase < 0)) {
        speedSeen = speedRef.current; // nothing is in progress to rescale
      } else if (speedRef.current !== speedSeen) {
        // Keep the current phase, at its current share, at the new pace.
        const oldPass = passSeconds(p.model) * SPEEDS[speedSeen] * (phase === 0 ? 1.4 : 1);
        const share = phase >= 0 ? (t - phaseStart) / oldPass : 0;
        speedSeen = speedRef.current;
        const newPass = passSeconds(p.model) * SPEEDS[speedSeen] * (phase === 0 ? 1.4 : 1);
        phaseStart = t - share * newPass;
      }
      const pass = passSeconds(p.model) * SPEEDS[speedRef.current];
      const m = p.model;
      if (phase === -1 && t > 0.8 && p.question.length) {
        phase = 0;
        phaseStart = t;
      }
      const len = phase === 0 ? pass * 1.4 : pass;
      if (phase >= 0 && !done && t - phaseStart >= len) {
        // The pass is finished: count its work.
        if (phase === 0) {
          ops += opsPerToken(m) * p.question.length;
          joules += joulesForPrompt(m, p.question.length, p.assumptions);
        } else {
          ops += opsPerToken(m);
          joules += joulesPerToken(m, p.assumptions).joules;
          p.onToken(phase);
        }
        if (phase >= p.answer.length) {
          done = true;
          phaseStart = t;
        } else {
          phase += 1;
          phaseStart = t;
        }
      }
      if (done && t - phaseStart > 3) {
        restart(); // play it again, drawing from the start of the new clock
        t = 0;
      }
      draw(t);
      writeMeter();
    }

    const showEnd = () => {
      restart();
      const p = live.current;
      ops = opsPerToken(p.model) * (p.question.length + p.answer.length);
      joules =
        joulesForPrompt(p.model, p.question.length, p.assumptions) +
        p.answer.length * joulesPerToken(p.model, p.assumptions).joules;
      phase = p.answer.length;
      phaseStart = -10;
      done = true;
      p.onToken(p.answer.length);
      draw(STILL_TIME);
      writeMeter();
    };
    if (reduce) {
      showEnd();
      const id = window.setInterval(() => live.current.runKey !== key && showEnd(), 300);
      return () => {
        window.clearInterval(id);
        stage.stop();
      };
    }
    restart();
    stage.start();
    return stage.stop;
    // The loop reads the latest props through refs; it starts once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="ap-flow">
      <div className="ap-stage" ref={wrap}>
        <canvas
          ref={canvas}
          role="img"
          aria-label="Question tokens as numbers passing through the model's layers, and the answer coming out one token at a time"
        />
      </div>
      <div className="ap-meter" ref={meter}>
        <b className="ap-step" data-m="step">
          Starting
        </b>
        <dl>
          <div>
            <dt>Work for each token</dt>
            <dd data-m="pertoken">0</dd>
          </div>
          <div>
            <dt>Operations so far</dt>
            <dd data-m="ops">0</dd>
          </div>
          <div>
            <dt>GPUs to hold it</dt>
            <dd data-m="gpus">0</dd>
          </div>
          <div>
            <dt>Energy so far</dt>
            <dd data-m="energy">0 J</dd>
          </div>
          <div>
            <dt>A 10 W LED bulb, lit for</dt>
            <dd data-m="bulb">0 s</dd>
          </div>
        </dl>
        <p className="small muted" data-m="bound" />
        <div className="ap-buttons" hidden={still}>
          <button type="button" className="btn small" onClick={() => setPaused((x) => !x)} aria-pressed={paused}>
            {paused ? 'Play' : 'Pause'}
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
