import { useLayoutEffect, useState } from 'react';

/**
 * The site nav's height, kept current as its links wrap. Pages that fill the window under the nav,
 * such as the deck and site builders, size themselves with it.
 */
export function useNavHeight(): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const nav = document.querySelector<HTMLElement>('.site-nav');
    if (!nav) return;
    const observer = new ResizeObserver(() => setHeight(nav.offsetHeight));
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);
  return height;
}
