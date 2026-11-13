import { useEffect, useRef } from 'react';
import Matter from 'matter-js';
import type { SceneBody } from '@/services/whiteboardService';

/* "Bring it to life": the bodies a model read from the sketch, run by matter-js, a 2D rigid-body engine, drawn over
   the board. The model only says what is where; gravity, collisions, bouncing, friction and throwing are the engine's.
   The board's edges are a floor and two walls, so nothing falls out of sight. */

const COLOURS = ['#38bdf8', '#fbbf24', '#f472b6', '#4ade80', '#a78bfa', '#fb923c', '#f87171'];
const STATIC = '#94a3b8';
const LINE_THICKNESS = 6;

/** The matter-js bodies for a scene: moving ones coloured in turn, fixed ones grey, plus the floor and walls. */
export function buildWorld(bodies: SceneBody[], width: number, height: number, bounce: number): Matter.Body[] {
  const { Bodies } = Matter;
  let colour = 0;
  const style = (moving: boolean) => ({ fillStyle: moving ? COLOURS[colour++ % COLOURS.length] : STATIC });
  const made: Matter.Body[] = [];
  for (const b of bodies) {
    const common = { restitution: bounce, friction: 0.08, frictionAir: 0.002, label: b.label || b.kind };
    if (b.kind === 'ball') {
      made.push(Bodies.circle(b.x, b.y, b.radius ?? 10, { ...common, isStatic: !b.moving, render: style(b.moving) }));
    } else if (b.kind === 'box') {
      made.push(
        Bodies.rectangle(b.x, b.y, b.width ?? 20, b.height ?? 20, {
          ...common,
          isStatic: !b.moving,
          angle: ((b.angle ?? 0) * Math.PI) / 180,
          render: style(b.moving),
        }),
      );
    } else {
      // A line is a thin fixed rectangle along the stroke.
      const [x2, y2] = [b.x2 ?? b.x, b.y2 ?? b.y];
      const length = Math.hypot(x2 - b.x, y2 - b.y);
      made.push(
        Bodies.rectangle((b.x + x2) / 2, (b.y + y2) / 2, length, LINE_THICKNESS, {
          ...common,
          isStatic: true,
          angle: Math.atan2(y2 - b.y, x2 - b.x),
          render: { fillStyle: STATIC },
        }),
      );
    }
  }
  const edge = { isStatic: true, label: 'edge', render: { fillStyle: 'transparent' } };
  made.push(
    Bodies.rectangle(width / 2, height + 25, width * 2, 50, edge),
    Bodies.rectangle(-25, height / 2, 50, height * 3, edge),
    Bodies.rectangle(width + 25, height / 2, 50, height * 3, edge),
  );
  return made;
}

interface Props {
  bodies: SceneBody[];
  width: number;
  height: number;
  running: boolean;
  gravity: number;
  bounce: number;
  /** Changing it puts every body back where the model placed it. */
  resetKey: number;
}

export function Physics({ bodies, width, height, running, gravity, bounce, resetKey }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Matter.Engine | null>(null);
  const live = useRef({ running, gravity });
  live.current = { running, gravity };

  // The world: built afresh for new bodies, a reset or a new bounciness.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const { Engine, Composite, Mouse, MouseConstraint } = Matter;
    const e = Engine.create({ enableSleeping: false });
    e.gravity.y = live.current.gravity;
    Composite.add(e.world, buildWorld(bodies, width, height, bounce));
    // Drag a moving body and let go to throw it.
    const dpr = window.devicePixelRatio || 1;
    (c as HTMLCanvasElement & { pixelRatio?: number }).pixelRatio = dpr; // matter-js reads it to map clicks to the world
    const mouse = Mouse.create(c);
    const drag = MouseConstraint.create(e, { mouse, constraint: { stiffness: 0.2, render: { visible: false } } });
    Composite.add(e.world, drag);
    engine.current = e;

    const ctx = c.getContext('2d');
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const dt = Math.min(32, now - last);
      last = now;
      e.gravity.y = live.current.gravity;
      if (live.current.running) Engine.update(e, dt);
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      for (const body of Composite.allBodies(e.world)) {
        if (body.label === 'edge') continue;
        ctx.beginPath();
        if (body.circleRadius) {
          ctx.arc(body.position.x, body.position.y, body.circleRadius, 0, 2 * Math.PI);
          // A spoke, so a rolling ball visibly turns.
          ctx.moveTo(body.position.x, body.position.y);
          ctx.lineTo(
            body.position.x + body.circleRadius * Math.cos(body.angle),
            body.position.y + body.circleRadius * Math.sin(body.angle),
          );
        } else {
          const v = body.vertices;
          ctx.moveTo(v[0].x, v[0].y);
          for (const p of v.slice(1)) ctx.lineTo(p.x, p.y);
          ctx.closePath();
        }
        ctx.fillStyle = body.render.fillStyle ?? STATIC;
        ctx.globalAlpha = body.isStatic ? 0.9 : 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      Composite.clear(e.world, false);
      Engine.clear(e);
      // matter-js's mouse listens on the canvas; a fresh canvas element is not made, so remove its listeners.
      const m = mouse as unknown as Record<string, EventListener>;
      for (const [name, key] of [
        ['mousemove', 'mousemove'],
        ['mousedown', 'mousedown'],
        ['mouseup', 'mouseup'],
        ['touchmove', 'mousemove'],
        ['touchstart', 'mousedown'],
        ['touchend', 'mouseup'],
        ['wheel', 'mousewheel'],
      ])
        c.removeEventListener(name, m[key]);
      engine.current = null;
    };
  }, [bodies, width, height, bounce, resetKey]);

  return <canvas ref={canvas} className="wb-physics" style={{ width, height }} aria-label="The scene, running" />;
}
