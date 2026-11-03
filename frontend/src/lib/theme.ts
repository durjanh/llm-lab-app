/** Colour theme: 'auto' follows the operating system; 'dark' or 'light' is remembered per browser. */
export type ThemeMode = 'auto' | 'dark' | 'light';
export const THEME_ORDER: ThemeMode[] = ['auto', 'dark', 'light'];

export function getTheme(): ThemeMode {
  try {
    const t = localStorage.getItem('theme');
    return t === 'dark' || t === 'light' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

export function setTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem('theme', mode);
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
  applyTheme(mode);
}

/** Sets data-theme on <html> and tells charts to redraw with the new colours. */
export function applyTheme(mode: ThemeMode = getTheme()): void {
  if (mode === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  document.dispatchEvent(new CustomEvent('themechange'));
}
