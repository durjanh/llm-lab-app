/**
 * Undo for an imperative page script. The ported simulations start timers and listen on
 * document and window; when you navigate away, `dispose()` stops all of it in one go.
 */
export interface Life {
  /** Like window.setTimeout, but cancelled on dispose. */
  setTimeout: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => number;
  /** Like window.setInterval, but cancelled on dispose. */
  setInterval: (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => number;
  /** Like window.requestAnimationFrame, but cancelled on dispose. */
  requestAnimationFrame: (fn: FrameRequestCallback) => number;
  /** addEventListener that is removed on dispose. */
  on: (
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => void;
  /** Like window.ResizeObserver, but disconnected on dispose. */
  ResizeObserver: typeof ResizeObserver;
  readonly signal: AbortSignal;
  readonly alive: boolean;
  dispose: () => void;
}

export function createLife(): Life {
  const controller = new AbortController();
  const timeouts = new Set<number>();
  const intervals = new Set<number>();
  const frames = new Set<number>();
  const observers = new Set<ResizeObserver>();
  let alive = true;

  class TrackedResizeObserver extends window.ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      observers.add(this);
    }
  }

  return {
    setTimeout(fn, ms, ...args) {
      if (!alive) return 0;
      const id = window.setTimeout(() => {
        timeouts.delete(id);
        fn(...args);
      }, ms);
      timeouts.add(id);
      return id;
    },
    setInterval(fn, ms, ...args) {
      if (!alive) return 0;
      const id = window.setInterval(fn, ms, ...args);
      intervals.add(id);
      return id;
    },
    requestAnimationFrame(fn) {
      if (!alive) return 0;
      const id = window.requestAnimationFrame((t) => {
        frames.delete(id);
        fn(t);
      });
      frames.add(id);
      return id;
    },
    on(target, type, handler, options) {
      const opts = typeof options === 'boolean' ? { capture: options } : { ...options };
      target.addEventListener(type, handler, { ...opts, signal: controller.signal });
    },
    ResizeObserver: TrackedResizeObserver,
    get signal() {
      return controller.signal;
    },
    get alive() {
      return alive;
    },
    dispose() {
      alive = false;
      controller.abort();
      timeouts.forEach((id) => window.clearTimeout(id));
      intervals.forEach((id) => window.clearInterval(id));
      frames.forEach((id) => window.cancelAnimationFrame(id));
      observers.forEach((o) => o.disconnect());
      observers.clear();
      timeouts.clear();
      intervals.clear();
      frames.clear();
    },
  };
}
