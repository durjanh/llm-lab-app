import { useLayoutEffect, useRef, type RefObject } from 'react';
import { createLife, type Life } from './lifecycle';
import { Site } from './site';

export type Mount = (root: HTMLElement | null, life: Life) => void;

interface Running {
  root: RefObject<HTMLElement | null> | null;
  mount: Mount;
  life: Life;
  bodyClass: string | null;
  released: boolean;
  stopped: boolean;
}

function stop(run: Running): void {
  run.stopped = true;
  run.life.dispose();
}

/**
 * Runs a page's imperative script once the page is on screen, and cleans up when it leaves.
 *
 * In development, React's StrictMode stops every effect and starts it again straight away, on the same elements. A
 * script cannot be run twice on the same elements (whatever it appended would appear twice), so the restart reclaims
 * the script already running instead: the stop only releases it, and it is disposed in a microtask unless the restart
 * has reclaimed it by then. The restart follows the stop synchronously, so a real unmount is the only one that
 * disposes. The script itself starts in a microtask, after the page's own layout effects have set its body class.
 * It is a layout effect so that the body class is put back before the next page sets its own.
 */
export function useEngine(root: RefObject<HTMLElement | null> | null, mount: Mount): void {
  const running = useRef<Running | null>(null);
  useLayoutEffect(() => {
    let run = running.current;
    if (run && !run.stopped && run.root === root && run.mount === mount) {
      run.released = false; // StrictMode's restart: keep the script that is already running
    } else {
      if (run && !run.stopped) stop(run); // a new script for this page (a hot reload): the old one stops first
      const fresh: Running = { root, mount, life: createLife(), bodyClass: null, released: false, stopped: false };
      running.current = run = fresh;
      queueMicrotask(() => {
        if (fresh.stopped || fresh.released) return; // the page left before the script started
        fresh.bodyClass = document.body.className; // the page's own class, set by PageView
        try {
          mount(root ? root.current : null, fresh.life);
        } catch (err) {
          console.error(err);
        }
      });
    }
    const mine = run;
    return () => {
      mine.released = true;
      Site.tip(null);
      if (mine.bodyClass !== null) document.body.className = mine.bodyClass; // undo classes the script added, such as presenter mode
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      queueMicrotask(() => {
        if (mine.released && !mine.stopped) stop(mine);
      });
    };
  }, [root, mount]);
}
