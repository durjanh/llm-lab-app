import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STILL_TIME, createStage } from './canvasStage';

/** A hand-driven clock and frame loop, so the stage's timing can be checked without a browser. */
let clock = 0;
let frame: ((now: number) => void) | null = null;
let resize: (() => void) | null = null;
let reduced = false;

beforeEach(() => {
  clock = 1000;
  frame = null;
  resize = null;
  reduced = false;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: reduced }),
    devicePixelRatio: 1,
  });
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  vi.stubGlobal('requestAnimationFrame', (f: (now: number) => void) => {
    frame = f;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        resize = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function make(paused = { on: false }) {
  const steps: { t: number; dt: number }[] = [];
  const stills: number[] = [];
  const canvas = {
    getContext: () => ({ setTransform() {} }),
    style: {},
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;
  const box = { getBoundingClientRect: () => ({ width: 600 }) } as unknown as HTMLElement;
  const stage = createStage({
    canvas,
    box,
    minWidth: 300,
    heightFor: (w) => w / 2,
    onSize: () => {},
    paused: () => paused.on,
    step: (t, dt) => steps.push({ t, dt }),
    still: (t) => stills.push(t),
  });
  /** Runs one frame at the given time. */
  const tick = (now: number) => {
    clock = now;
    frame!(now);
  };
  return { stage, steps, stills, tick, paused };
}

describe('createStage', () => {
  it('never reports a negative gap when the first frame is stamped before start()', () => {
    const { stage, steps, tick } = make();
    clock = 1000;
    stage.start();
    tick(990);
    expect(steps[0].dt).toBe(0);
  });

  it('never reports a negative time when the first frame is stamped before the clock began', () => {
    const { stage, steps, tick } = make();
    clock = 1000;
    stage.start();
    tick(990);
    expect(steps[0].t).toBe(0);
  });

  it('does not count the time between making the stage and starting it', () => {
    const { stage, steps, tick } = make();
    clock = 1400; // setting up took 400 ms
    stage.start();
    tick(1500);
    expect(steps[0].t).toBeCloseTo(0.1);
  });

  it('freezes a resize while paused at one time, so the picture does not drift before the next frame', () => {
    const { stage, stills, paused } = make();
    stage.start();
    paused.on = true;
    clock = 2000;
    resize!();
    clock = 9000;
    resize!();
    expect(stills[1]).toBe(stills[0]);
    expect(stills[0]).toBeGreaterThanOrEqual(0);
  });

  it('holds the clock while paused and carries on from where it stopped', () => {
    const { stage, steps, tick, paused } = make();
    stage.start();
    tick(1100);
    tick(1200);
    expect(steps.at(-1)!.t).toBeCloseTo(0.2);
    paused.on = true;
    tick(1300);
    tick(5000); // a long pause
    paused.on = false;
    tick(5100);
    expect(steps.at(-1)!.t).toBeCloseTo(0.3, 1); // 0.2 before the pause, 0.1 after, none for the pause itself
  });

  it('does not rush through the time a hidden tab missed', () => {
    const { stage, steps, tick } = make();
    stage.start();
    tick(1100);
    tick(61100); // a minute with no frames
    expect(steps.at(-1)!.t).toBeLessThan(0.3);
    expect(steps.at(-1)!.dt).toBeLessThanOrEqual(0.1);
  });

  it('draws a still frame after a resize while paused, because resizing clears the canvas', () => {
    const { stage, stills, paused } = make();
    stage.start();
    paused.on = true;
    const before = stills.length;
    resize!();
    expect(stills.length).toBe(before + 1);
  });

  it('draws no still frame after a resize while running, because the next frame redraws', () => {
    const { stage, stills } = make();
    stage.start();
    resize!();
    expect(stills).toEqual([]);
  });

  it('draws reduced motion at time zero after a resize, however long the page has been open', () => {
    reduced = true;
    const { stage, stills } = make();
    expect(stage.reduce).toBe(true);
    clock = 90_000;
    resize!();
    expect(stills).toEqual([STILL_TIME]);
  });

  it('starts from zero after restartClock, even when paused', () => {
    const { stage, steps, tick, paused } = make();
    stage.start();
    tick(1100);
    paused.on = true;
    tick(1200);
    clock = 3000;
    stage.restartClock();
    paused.on = false;
    tick(3050);
    expect(steps.at(-1)!.t).toBeCloseTo(0.05);
  });

  it('setClock moves the clock to the time given', () => {
    const { stage, steps, tick } = make();
    stage.start();
    tick(1100);
    stage.setClock(1200, 2);
    tick(1300);
    expect(steps.at(-1)!.t).toBeCloseTo(2.1);
  });
});
