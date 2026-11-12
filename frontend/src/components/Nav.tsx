import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { GROUPS, MENU_COLUMNS, PAGES } from '@/pages/registry';
import { getTheme, setTheme, THEME_ORDER, type ThemeMode } from '@/lib/theme';

/** The bar at the top of every page: grouped menus on wide screens, a drop-down list on phones. */
export function Nav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
  const [theme, setThemeState] = useState<ThemeMode>(getTheme);
  const nav = useRef<HTMLElement>(null);

  useEffect(() => setOpen(null), [pathname]);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!nav.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const home = PAGES[0];
  // Pages that belong to no group (the Bible) sit beside Home rather than in a menu.
  const ungrouped = PAGES.filter((p) => p.group === null && p !== home);
  const nextTheme = () => {
    const m = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    setTheme(m);
    setThemeState(m);
  };
  // A long menu's pages under their column headings, in registry order; any page not in the map joins the last column.
  const columns = (g: (typeof GROUPS)[number], items: typeof PAGES): [string, typeof PAGES][] => {
    const map = MENU_COLUMNS[g] ?? {};
    const headings = Object.keys(map);
    const placed = new Set(Object.values(map).flat());
    return headings.map((h, i) => [
      h,
      items.filter((p) => map[h].includes(p.id) || (i === headings.length - 1 && !placed.has(p.id))),
    ]);
  };
  const link = (p: (typeof PAGES)[number]) => (
    <Link key={p.id} to={p.path} aria-current={p.path === pathname ? 'page' : undefined}>
      {p.label}
    </Link>
  );

  return (
    <nav className="site-nav" aria-label="Lab pages" ref={nav}>
      <Link className="site-brand" to="/">
        LLM Lab
      </Link>
      <div className="site-links">
        {link(home)}
        {ungrouped.map(link)}
        {GROUPS.map((g) => {
          const items = PAGES.filter((p) => p.group === g);
          return (
            <details
              key={g}
              className={`nav-menu${items.some((p) => p.path === pathname) ? ' current' : ''}`}
              open={open === g}
            >
              <summary
                onClick={(e) => {
                  e.preventDefault();
                  setOpen(open === g ? null : g);
                }}
              >
                {g}
              </summary>
              {MENU_COLUMNS[g] ? (
                <div className="menu mega" role="group" aria-label={g}>
                  {columns(g, items).map(([heading, pages]) => (
                    <div key={heading} className="mega-col">
                      <div className="mega-head">{heading}</div>
                      {pages.map(link)}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="menu" role="group" aria-label={g}>
                  {items.map(link)}
                </div>
              )}
            </details>
          );
        })}
      </div>
      <select
        className="site-select"
        aria-label="Go to page"
        value={pathname}
        onChange={(e) => navigate(e.target.value)}
      >
        <option value={home.path}>{home.label}</option>
        {ungrouped.map((p) => (
          <option key={p.id} value={p.path}>
            {p.label}
          </option>
        ))}
        {GROUPS.map((g) => (
          <optgroup key={g} label={g}>
            {PAGES.filter((p) => p.group === g).map((p) => (
              <option key={p.id} value={p.path}>
                {p.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button
        className="theme-toggle"
        type="button"
        onClick={nextTheme}
        title={`Colour theme: ${theme}. Click to change.`}
        aria-label={`Colour theme: ${theme}`}
      >
        ◐ {theme[0].toUpperCase() + theme.slice(1)}
      </button>
    </nav>
  );
}
