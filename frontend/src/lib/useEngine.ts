import { useLayoutEffect, type RefObject } from 'react';
import { createLife, type Life } from './lifecycle';
import { Site } from './site';

export type Mount = (root: HTMLElement | null, life: Life) => void;

/**
 * Runs a page's imperative script once the page is on screen, and cleans up when it leaves.
 *
 * The script is started in a microtask so that React's development double-run of effects
 * (StrictMode) starts it only once: the first run is cancelled before its microtask fires.
 * It is a layout effect so that cleanup finishes before the next page sets its body class.
 */
export function useEngine(root: RefObject<HTMLElement | null> | null, mount: Mount): void {
  useLayoutEffect(() => {
    const life = createLife();
    let bodyClass: string | null = null;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      bodyClass = document.body.className; // the page's own class, set by PageView
      try {
        mount(root ? root.current : null, life);
      } catch (err) {
        console.error(err);
      }
    });
    return () => {
      cancelled = true;
      life.dispose();
      Site.tip(null);
      if (bodyClass !== null) document.body.className = bodyClass; // undo classes the script added, such as presenter mode
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, [root, mount]);
}
