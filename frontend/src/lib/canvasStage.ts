/**
 * The plumbing every animated canvas on the lab shares: sizing for the screen's pixel density, knowing when the
 * canvas is on screen, a clock that survives pausing and a hidden tab, and tidy-up when the page is left.
 *
 * A page gives it two things: `step`, which advances its simulation to the clock's time and draws it, and `still`,
 * which draws one frame when the animation is not running (paused, off screen, resized, or reduced motion). It keeps
 * its own state, layout, drawing and meter.
 *
 * While the tab is hidden the clock waits, so a run carries on from where it stopped instead of jumping ahead.
 */

export interface StageOptions {
  canvas: HTMLCanvasElement;
  /** The element the canvas fills: its width sets the canvas width, and it is watched for resizes and visibility. */
  box: HTMLElement;
  minWidth: number;
  /** The canvas height for a given width. */
  heightFor: (width: number) => number;
  /** Called with the canvas size at the start and after every resize, so a page can keep its own copy. */
  onSize: (width: number, height: number) => void;
  /** True while the person has paused it. */
  paused: () => boolean;
  /** Runs first on every frame, so a page can restart when its inputs have changed. */
  before?: () => void;
  /** One running frame: `t` is seconds on the clock, `dt` seconds since the last frame, `now` the frame's time. */
  step: (t: number, dt: number, now: number) => void;
  /** One still frame, at the time on the clock where it stopped. */
  still: (t: number) => void;
}

export interface Stage {
  ctx: CanvasRenderingContext2D;
  /** Whether the person asks for less motion. Read once, when the stage is made. */
  reduce: boolean;
  /** The value of a CSS custom property on the box, such as a theme colour. */
  css: (name: string) => string;
  /** Starts the clock again from zero, and shows a still frame first if it is paused or off screen. */
  restartClock: () => void;
  /** Makes the clock read `t` seconds at frame time `now`. */
  setClock: (now: number, t: number) => void;
  /** Starts the frame loop. Not for reduced motion, which draws stills. */
  start: () => void;
  /** Stops the loop and the observers. */
  stop: () => void;
}

/** The clock time every page draws its still frame at under reduced motion: the start. */
export const STILL_TIME = 0;

/** The longest gap between frames that counts as time passing: past it, the tab was hidden and the clock waits. */
const HIDDEN_GAP_MS = 500;

export function createStage(o: StageOptions): Stage {
  const ctx = o.canvas.getContext('2d')!;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0;
  let H = 0;
  let visible = true;
  let frame = 0;
  let begun = performance.now();
  let pausedAt = 0;
  let last = begun;
  let drawn = false;

  // Reduced motion never runs the clock, so its still frame is always at STILL_TIME. Otherwise the time freezes at
  // the first still frame, so a resize between a pause and the next frame cannot show a time that keeps growing.
  const draw = () => {
    if (!reduce && !pausedAt) pausedAt = performance.now();
    o.still(reduce ? STILL_TIME : Math.max(0, (pausedAt - begun) / 1000));
  };
  const fit = () => {
    const r = o.box.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(o.minWidth, r.width);
    H = o.heightFor(W);
    o.canvas.width = Math.round(W * dpr);
    o.canvas.height = Math.round(H * dpr);
    o.canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.onSize(W, H);
  };
  fit();
  // Setting the canvas size clears it, so a canvas that is not redrawing every frame must be drawn again.
  // The observer's first call comes after the page has finished setting up, so `still` is safe to call by then.
  const ro = new ResizeObserver(() => {
    fit();
    if (reduce || o.paused() || !visible) draw();
  });
  ro.observe(o.box);
  const io = new IntersectionObserver((e) => (visible = e[0]?.isIntersecting ?? true));
  io.observe(o.box);

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    o.before?.();
    if (o.paused() || !visible) {
      if (!pausedAt) pausedAt = now;
      if (!drawn) {
        draw(); // a still picture until it scrolls into view or is played
        drawn = true;
      }
      last = now;
      return;
    }
    drawn = true;
    if (pausedAt) {
      begun += now - pausedAt; // resume where it stopped
      pausedAt = 0;
    } else if (now - last > HIDDEN_GAP_MS) {
      begun += now - last; // the tab was hidden: carry on from where it stopped, not rushing through what was missed
    }
    // The first frame's timestamp can be earlier than `start()` was called, so the gap is never below zero.
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    o.step(Math.max(0, (now - begun) / 1000), dt, now); // a frame stamped before the clock began is at time zero
  };

  return {
    ctx,
    reduce,
    css: (name) => getComputedStyle(o.box).getPropertyValue(name).trim() || '#888',
    restartClock: () => {
      begun = performance.now();
      last = begun; // frames before this restart are not a gap in the new run
      pausedAt = 0;
      drawn = false;
    },
    setClock: (now, t) => {
      begun = now - t * 1000;
    },
    start: () => {
      begun = last = performance.now(); // setting up before the first frame is not time spent in the run
      frame = requestAnimationFrame(tick);
    },
    stop: () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
    },
  };
}
