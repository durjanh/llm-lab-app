import { useEffect, useRef, useState } from 'react';
import { type Price, type Turn, n0, usd } from './workload';

/** One dot stands for this many tokens, whatever its kind, so the dots compare honestly. */
const PER_DOT = 100;
/** The longest a run is allowed to take on screen; longer runs are played faster, in proportion. */
const MAX_RUN_S = 16;

type Kind = 'input' | 'cached' | 'thinking' | 'call' | 'result' | 'answer';
type Node = 'req' | 'core' | 'tools' | 'out';

interface Emission {
  t: number;
  kind: Kind;
  from: Node;
  to: Node;
  dollars: number;
  tokens: number;
  /** For thinking dots: how long they swirl before fading. */
  life?: number;
  turn: number;
}

interface Dot extends Emission {
  born: number;
  dur: number;
  bend: number;
  angle: number;
  counted: boolean;
}

export interface FlowProps {
  turns: Turn[];
  price: Price | null;
  caching: boolean;
  writeMultiplier: number;
  modelName: string;
  modelSize: number;
  hideThinking: boolean;
  /** Changes whenever the run should start again from the beginning. */
  runKey: string;
}

/** The order in which the run happens, as dots to send at set times. Also returns the run's length in seconds. */
function schedule(
  turns: Turn[],
  price: Price | null,
  caching: boolean,
  wm: number,
): { list: Emission[]; length: number } {
  const p = price ?? { input: 0, output: 0, cache_read: 0 };
  const m = 1e-6;
  type Phase = {
    kind: Kind;
    from: Node;
    to: Node;
    tokens: number;
    dur: number;
    rate: number;
    turn: number;
    swirl?: boolean;
  };
  const phases: Phase[] = [];
  turns.forEach((t, i) => {
    const fresh = caching ? t.input - t.repeated : t.input;
    const hit = caching ? t.repeated : 0;
    const send = 0.9 + t.input / 30000;
    if (hit)
      phases.push({ kind: 'cached', from: 'req', to: 'core', tokens: hit, dur: send, rate: p.cache_read, turn: i });
    phases.push({
      kind: 'input',
      from: 'req',
      to: 'core',
      tokens: fresh,
      dur: send,
      rate: p.input * (caching ? wm : 1),
      turn: i,
    });
    phases.push({
      kind: 'thinking',
      from: 'core',
      to: 'core',
      tokens: t.thinking,
      dur: 0.35 + t.thinking / 800,
      rate: p.output,
      turn: i,
      swirl: true,
    });
    if (t.last) {
      phases.push({
        kind: 'answer',
        from: 'core',
        to: 'out',
        tokens: t.written,
        dur: 0.5 + t.written / 600,
        rate: p.output,
        turn: i,
      });
    } else {
      phases.push({ kind: 'call', from: 'core', to: 'tools', tokens: t.written, dur: 0.6, rate: p.output, turn: i });
      // The tool's result is not billed here: it is billed as input when the next request sends it.
      const result = turns[i + 1].input - t.input - t.written;
      phases.push({ kind: 'result', from: 'tools', to: 'req', tokens: result, dur: 0.8, rate: 0, turn: i });
    }
  });
  // Cached and fresh input travel together.
  let raw = 0;
  for (let i = 0; i < phases.length; i++) if (!(phases[i].kind === 'cached')) raw += phases[i].dur;
  const k = Math.min(1, MAX_RUN_S / raw);
  const list: Emission[] = [];
  let t = 0.3;
  for (const ph of phases) {
    const dur = ph.dur * k;
    const dots = Math.max(ph.tokens > 0 ? 1 : 0, Math.round(ph.tokens / PER_DOT));
    const dollars = ph.tokens * ph.rate * m;
    for (let d = 0; d < dots; d++) {
      list.push({
        t: t + (dots === 1 ? 0 : (d / dots) * dur * (ph.swirl ? 1 : 0.85)),
        kind: ph.kind,
        from: ph.from,
        to: ph.to,
        dollars: dollars / dots,
        tokens: ph.tokens / dots,
        life: ph.swirl ? Math.max(0.5, dur - (d / dots) * dur + 0.4) : undefined,
        turn: ph.turn,
      });
    }
    if (ph.kind !== 'cached') t += dur;
  }
  return { list, length: t + 0.6 };
}

const COLOR_VARS: Record<Kind, string> = {
  input: '--s1',
  cached: '--faint',
  thinking: '--brand',
  call: '--s4',
  result: '--s5',
  answer: '--s3',
};

/** A run of the model drawn as tokens on the move, with a meter that bills each dot as it lands. */
export function TokenFlow(props: FlowProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const meter = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const cv = canvas.current!;
    const box = wrap.current!;
    const ctx = cv.getContext('2d')!;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0;
    let H = 0;
    let frame = 0;
    let visible = true;
    const fit = () => {
      const r = box.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.max(280, r.width);
      H = W < 560 ? 300 : 340;
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      cv.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    };
    let redraw = () => {};
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    const io = new IntersectionObserver((e) => (visible = e[0]?.isIntersecting ?? true));
    io.observe(box);

    const SPOTS: Record<Node, [number, number]> = {
      req: [0.11, 0.58],
      core: [0.47, 0.54],
      tools: [0.82, 0.2],
      out: [0.86, 0.8],
    };
    const pos = (n: Node): [number, number] => [W * SPOTS[n][0], H * SPOTS[n][1]];

    let colors: Record<Kind, string> & { ink: string; muted: string; line: string; surface: string; soft: string } =
      {} as never;
    const readColors = () => {
      const cs = getComputedStyle(box);
      const v = (name: string) => cs.getPropertyValue(name).trim() || '#888';
      colors = {
        input: v(COLOR_VARS.input),
        cached: v(COLOR_VARS.cached),
        thinking: v(COLOR_VARS.thinking),
        call: v(COLOR_VARS.call),
        result: v(COLOR_VARS.result),
        answer: v(COLOR_VARS.answer),
        ink: v('--ink'),
        muted: v('--muted'),
        line: v('--line2'),
        surface: v('--surface'),
        soft: v('--soft'),
      };
    };

    let run = schedule(props.turns, props.price, props.caching, props.writeMultiplier);
    let key = props.runKey;
    let start = performance.now();
    let next = 0;
    let dots: Dot[] = [];
    let spent = 0;
    const counts: Record<Kind, number> = { input: 0, cached: 0, thinking: 0, call: 0, result: 0, answer: 0 };
    let context = live.current.turns[0]?.input ?? 0;
    let turn = 0;
    let pausedAt = 0;
    let drawn = false;

    const restart = () => {
      drawn = false;
      pausedAt = 0; // the paused branch notes the time again on the next frame
      const p = live.current;
      run = schedule(p.turns, p.price, p.caching, p.writeMultiplier);
      key = p.runKey;
      start = performance.now();
      next = 0;
      dots = [];
      spent = 0;
      (Object.keys(counts) as Kind[]).forEach((k) => (counts[k] = 0));
      context = p.turns[0]?.input ?? 0;
      turn = 0;
      readColors();
    };
    readColors();

    const writeMeter = (done: boolean) => {
      const el = meter.current;
      if (!el) return;
      const p = live.current;
      const set = (sel: string, text: string) => {
        const node = el.querySelector(sel);
        if (node) node.textContent = text;
      };
      set('[data-m=cost]', p.price ? usd(spent) : 'prices need the backend');
      set('[data-m=turn]', `${Math.min(turn + 1, p.turns.length)} of ${p.turns.length}`);
      set('[data-m=in]', n0(counts.input + counts.cached));
      set('[data-m=think]', n0(counts.thinking));
      set('[data-m=out]', n0(counts.call + counts.answer));
      el.classList.toggle('done', done);
      el.dataset.context = String(Math.round(context)); // the conversation size drawn, for checks
    };

    const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

    const drawNode = (n: Node, label: string, sub: string, active: boolean, extra?: number) => {
      const [x, y] = pos(n);
      const w = n === 'req' ? Math.min(118, W * 0.18) : Math.min(104, W * 0.17);
      const h = n === 'req' ? 42 + Math.min(70, (extra ?? 0) / 400) : 40;
      ctx.save();
      ctx.fillStyle = colors.surface;
      ctx.strokeStyle = active ? colors.ink : colors.line;
      ctx.lineWidth = active ? 2 : 1;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h / 2, w, h, 10);
      ctx.fill();
      ctx.stroke();
      if (n === 'req' && extra) {
        // The conversation, stacked: it grows by a tool call and its result on every turn of an agent.
        const fill = Math.min(1, extra / 40000);
        ctx.fillStyle = colors.input;
        ctx.globalAlpha = 0.16;
        ctx.fillRect(x - w / 2 + 3, y + h / 2 - 3 - (h - 6) * fill, w - 6, (h - 6) * fill);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = colors.ink;
      ctx.font = '600 12px -apple-system, Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, x, y - 2);
      ctx.fillStyle = colors.muted;
      ctx.font = '11px -apple-system, Segoe UI, sans-serif';
      ctx.fillText(sub, x, y + 13);
      ctx.restore();
    };

    const draw = (now: number) => {
      const p = live.current;
      const tSec = (now - start) / 1000;
      ctx.clearRect(0, 0, W, H);
      const [cx, cy] = pos('core');
      const R = 30 + 26 * p.modelSize;
      const agent = p.turns.length > 1;

      // Paths.
      ctx.save();
      ctx.strokeStyle = colors.line;
      ctx.setLineDash([4, 6]);
      ctx.lineWidth = 1;
      const path = (a: Node, b: Node, bend: number) => {
        const [x1, y1] = pos(a);
        const [x2, y2] = pos(b);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo((x1 + x2) / 2, (y1 + y2) / 2 + bend, x2, y2);
        ctx.stroke();
      };
      path('req', 'core', 0);
      path('core', 'out', 0);
      if (agent) {
        path('core', 'tools', -10);
        path('tools', 'req', -H * 0.28);
      }
      ctx.restore();

      const thinkingNow = dots.some((d) => d.kind === 'thinking' && tSec - d.born < (d.life ?? 0));
      // The model.
      ctx.save();
      const pulse = thinkingNow ? 1 + 0.05 * Math.sin(tSec * 9) : 1;
      const g = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.6 * pulse);
      g.addColorStop(0, colors.thinking + (thinkingNow ? '55' : '22'));
      g.addColorStop(1, colors.thinking + '00');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.6 * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = colors.surface;
      ctx.strokeStyle = colors.thinking;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (thinkingNow) {
        // A turning ring while the model thinks.
        ctx.setLineDash([10, 8]);
        ctx.lineDashOffset = -tSec * 40;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.arc(cx, cy, R + 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();

      drawNode(
        'req',
        'Conversation',
        agent ? `${n0(context)} tokens` : 'your request',
        false,
        agent ? context : undefined,
      );
      drawNode('out', 'Answer', 'what you read', false);
      if (agent) drawNode('tools', 'Tools', 'files, tests', false);

      // Dots, each with a short fading trail.
      const at = (d: Dot, age: number): [number, number, number] | null => {
        if (d.kind === 'thinking') {
          const life = d.life ?? 1;
          if (age > life || age < 0) return null;
          const a = d.angle + age * (1.6 + (d.bend % 1));
          const rr = R * (1.22 + 0.42 * Math.abs((d.bend * 7) % 1));
          const alpha = Math.min(1, age * 4) * Math.min(1, (life - age) * 3);
          return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.8, alpha];
        }
        const k = age / d.dur;
        if (k >= 1 || k < 0) return null;
        // Dots meet the model at its edge, so its name stays readable.
        const edge = (other: Node): [number, number] => {
          const [ox, oy] = pos(other);
          const a = Math.atan2(oy - cy, ox - cx);
          return [cx + Math.cos(a) * (R + 4), cy + Math.sin(a) * (R + 4)];
        };
        const [x1, y1] = d.from === 'core' ? edge(d.to) : pos(d.from);
        const [x2, y2] = d.to === 'core' ? edge(d.from) : pos(d.to);
        const e = ease(k);
        const bend = d.from === 'tools' ? -H * 0.28 : d.bend;
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2 + bend;
        return [
          (1 - e) * (1 - e) * x1 + 2 * (1 - e) * e * mx + e * e * x2,
          (1 - e) * (1 - e) * y1 + 2 * (1 - e) * e * my + e * e * y2,
          Math.min(1, k * 6) * (k > 0.9 ? (1 - k) / 0.1 : 1),
        ];
      };
      for (const d of dots) {
        const age = tSec - d.born;
        const hiddenThought = d.kind === 'thinking' && p.hideThinking;
        const r = d.kind === 'cached' ? 2.2 : d.kind === 'thinking' ? 2.8 : 3.2;
        ctx.fillStyle = hiddenThought ? colors.muted : colors[d.kind];
        for (let g = 3; g >= 0; g--) {
          const pt = at(d, age - g * 0.035);
          if (!pt) continue;
          const fade = g === 0 ? 1 : 0.32 / g;
          ctx.globalAlpha = pt[2] * fade * (d.kind === 'cached' ? 0.75 : 1) * (hiddenThought ? 0.25 : 1);
          ctx.beginPath();
          ctx.arc(pt[0], pt[1], g === 0 ? r : r * (1 - g * 0.15), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // The model's name and price, over its dots; hidden thinking is frosted but still swirls and still bills.
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = colors.ink;
      ctx.font = '700 13px -apple-system, Segoe UI, sans-serif';
      ctx.fillText(p.modelName, cx, cy - 3);
      ctx.fillStyle = colors.muted;
      ctx.font = '11px -apple-system, Segoe UI, sans-serif';
      ctx.fillText(p.price ? `$${p.price.input} in · $${p.price.output} out` : 'per million', cx, cy + 12);
      if (p.hideThinking) ctx.fillText('thinking hidden, still billed', cx, cy + R + 24);
      ctx.restore();
    };

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const p = live.current;
      if (p.runKey !== key) restart();
      if (pausedRef.current || !visible) {
        if (!pausedAt) pausedAt = now;
        if (!drawn) {
          draw(now); // a still picture until it scrolls into view
          writeMeter(false);
          drawn = true;
        }
        return;
      }
      drawn = true;
      if (pausedAt) {
        start += now - pausedAt; // resume where it stopped
        pausedAt = 0;
      }
      const tSec = (now - start) / 1000;
      while (next < run.list.length && run.list[next].t <= tSec) {
        const e = run.list[next++];
        const dot: Dot = {
          ...e,
          born: e.t,
          dur: e.kind === 'result' ? 1.1 : 0.95,
          bend: (Math.random() - 0.5) * 40,
          angle: Math.random() * Math.PI * 2,
          counted: false,
        };
        dots.push(dot);
        if (e.kind === 'thinking' || e.kind === 'call' || e.kind === 'answer') {
          // Output is billed as it is written.
          dot.counted = true;
          spent += e.dollars;
          counts[e.kind] += e.tokens;
          if (e.kind === 'call') context += e.tokens;
        }
        if (e.turn > turn) turn = e.turn;
      }
      for (const d of dots) {
        if (!d.counted && tSec - d.born >= d.dur) {
          d.counted = true;
          spent += d.dollars;
          counts[d.kind] += d.tokens;
          if (d.kind === 'result') context += d.tokens;
        }
      }
      dots = dots.filter((d) => tSec - d.born < (d.life ?? d.dur) + 0.05);
      draw(now);
      const done = next >= run.list.length && dots.length === 0;
      writeMeter(done);
      if (done && tSec > run.length + 2.2) restart(); // play it again
    };

    redraw = () => {
      if (reduce || pausedRef.current || !visible) draw(pausedAt || performance.now());
    };
    if (reduce) {
      // No motion: bill the whole run at once and draw it still.
      for (const e of run.list) {
        spent += e.dollars;
        counts[e.kind] += e.tokens;
        if (e.kind === 'call' || e.kind === 'result') context += e.tokens;
      }
      turn = props.turns.length - 1;
      draw(performance.now());
      writeMeter(true);
      const again = () => {
        restart();
        for (const e of run.list) {
          spent += e.dollars;
          counts[e.kind] += e.tokens;
          if (e.kind === 'call' || e.kind === 'result') context += e.tokens;
        }
        turn = live.current.turns.length - 1;
        draw(performance.now());
        writeMeter(true);
      };
      const id = window.setInterval(() => live.current.runKey !== key && again(), 300);
      return () => {
        window.clearInterval(id);
        ro.disconnect();
        io.disconnect();
      };
    }
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
    };
    // The loop reads the latest props through `live`; it starts once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="ec-flow" ref={wrap}>
      <canvas
        ref={canvas}
        role="img"
        aria-label="Tokens moving between the conversation, the model, its tools and the answer during one run"
      />
      <div className="ec-meter" ref={meter} aria-live="off">
        <div className="ec-meter-cost">
          <span className="small muted">This run so far</span>
          <b data-m="cost">$0</b>
        </div>
        <dl>
          <div>
            <dt>Model call</dt>
            <dd data-m="turn">1 of 1</dd>
          </div>
          <div>
            <dt>
              <i style={{ background: 'var(--s1)' }} /> Read
            </dt>
            <dd data-m="in">0</dd>
          </div>
          <div>
            <dt>
              <i style={{ background: 'var(--brand)' }} /> Thought
            </dt>
            <dd data-m="think">0</dd>
          </div>
          <div>
            <dt>
              <i style={{ background: 'var(--s3)' }} /> Wrote
            </dt>
            <dd data-m="out">0</dd>
          </div>
        </dl>
        <button type="button" className="btn small" onClick={() => setPaused((x) => !x)} aria-pressed={paused}>
          {paused ? 'Play' : 'Pause'}
        </button>
      </div>
    </div>
  );
}
