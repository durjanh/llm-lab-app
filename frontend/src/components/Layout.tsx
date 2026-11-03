import { Suspense, useEffect, useLayoutEffect, useMemo } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { Nav } from './Nav';
import type { PageDef } from '@/pages/registry';

/** The nav, then the current page. Also makes plain links behave like router links. */
export function Layout() {
  const navigate = useNavigate();
  const { pathname, hash } = useLocation();

  // Links written as <a href="/agents">, including those the page scripts generate, navigate
  // inside the app instead of reloading it.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if ((a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || /^\/(api|models)\//.test(url.pathname)) return;
      if (url.pathname === location.pathname && url.search === location.search) return; // same page: let the browser jump
      e.preventDefault();
      navigate(url.pathname + url.search + url.hash);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [navigate]);

  // New page: start at the top, or at the #section the link names once the page has loaded.
  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1));
    if (!id) {
      window.scrollTo(0, 0);
      return;
    }
    let tries = 0,
      timer = 0;
    const find = () => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView();
      else if (++tries < 40) timer = window.setTimeout(find, 50);
    };
    find();
    return () => window.clearTimeout(timer);
    // only when the page changes; hash changes within a page are the page's own business
  }, [pathname]);

  return (
    <>
      <Nav />
      <Outlet />
    </>
  );
}

/** One page: sets the tab title and body class before the page's script starts. */
export function PageView({ page }: { page: PageDef }) {
  useLayoutEffect(() => {
    document.title = page.title;
    document.body.className = page.bodyClass;
  }, [page]);
  // The page itself never re-renders, so React never touches what its script has drawn.
  const content = useMemo(() => <page.Component />, [page]);
  return (
    <Suspense
      fallback={
        <main className="page-loading">
          <span className="spinner" aria-hidden="true" /> Loading…
        </main>
      }
    >
      {content}
    </Suspense>
  );
}

export function NotFound() {
  useLayoutEffect(() => {
    document.title = 'Page not found';
    document.body.className = 'lab';
  }, []);
  return (
    <main>
      <h1>Page not found</h1>
      <p>
        <a href="/">Back to the LLM Lab home page</a>
      </p>
    </main>
  );
}
