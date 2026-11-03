/* Small helpers shared by the page scripts: DOM shortcuts, number formatting, the model
 * loading card, tooltips and copy buttons. The navigation and theme now live in React. */
import { applyTheme, getTheme, setTheme } from './theme';

const esc = (s: unknown): string =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
const $ = (s: string, r: ParentNode = document): any => r.querySelector(s);
const $$ = (s: string, r: ParentNode = document): any[] => [...r.querySelectorAll(s)];
const pct = (v: number, d = 1): string => (v * 100).toFixed(d) + '%';
const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-GB');

/** Deterministic random numbers, so demos look the same on every visit. */
function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Phase = 'download' | 'preparing' | 'init';
export interface ModelGateOptions {
  title: string;
  sizeMB: number;
  what: string;
  loader: (onProgress: (loaded: number, total: number, phase?: Phase) => void) => Promise<unknown>;
  autoKey: string; // set once the model has been downloaded, so the card can say it is cached
  /** True when the model is already in memory (loaded on another page this visit): shown at once, no download. */
  isReady?: () => boolean;
  onReady?: () => void;
}

/** A card that loads a browser model when asked. It never starts a download by itself: models are large. */
function modelGate(mount: HTMLElement, opts: ModelGateOptions): void {
  mount.classList.add('gate');
  mount.innerHTML = `
    <div class="gate-text"><b>${esc(opts.title)}</b> runs in your browser. ${opts.what}
    The first load downloads about ${opts.sizeMB} MB from Hugging Face; your browser caches it after that.</div>
    <div class="gate-actions"><button class="btn primary">Load ${esc(opts.title)}</button>
    <div class="progress" hidden><i></i></div><span class="spinner" hidden aria-hidden="true"></span><span class="gate-status muted" role="status" aria-live="polite"></span></div>`;
  const btn = $('button', mount) as HTMLButtonElement,
    bar = $('.progress', mount) as HTMLElement;
  const status = $('.gate-status', mount) as HTMLElement,
    spin = $('.spinner', mount) as HTMLElement;
  async function go() {
    btn.disabled = true;
    bar.hidden = false;
    spin.hidden = false;
    status.textContent = 'Starting…';
    status.classList.remove('err');
    try {
      await opts.loader((loaded, total, phase) => {
        $('i', bar).style.width = ((100 * loaded) / total).toFixed(1) + '%';
        status.textContent =
          phase === 'preparing' || phase === 'init'
            ? 'Downloaded. Now preparing the model in your browser. The first time this takes up to a minute, and the page may not respond until it finishes.'
            : total < 1e6
              ? 'Downloading…'
              : `Downloading: ${(loaded / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`;
      });
      if (!mount.isConnected) return; // the page was closed while loading
      mount.classList.add('ready');
      mount.innerHTML = `<span><span class="ok-dot"></span><b>${esc(opts.title)}</b> is loaded and running in your browser.</span>`;
      opts.onReady && opts.onReady();
    } catch (e) {
      console.error(e);
      btn.disabled = false;
      bar.hidden = true;
      spin.hidden = true;
      status.textContent =
        'Could not load the model. Check your connection and try again. ' + ((e as Error).message || '');
      status.classList.add('err');
    }
  }
  btn.addEventListener('click', go);
  // Already in memory, or asked for in the address (?autoload): no download to wait for, or one requested.
  if (opts.isReady?.() || new URLSearchParams(location.search).has('autoload')) return void go();
  let cached = false;
  try {
    cached = localStorage.getItem(opts.autoKey) === '1';
  } catch {
    /* storage unavailable */
  }
  if (cached) status.textContent = 'Downloaded before, so it should load from your browser’s cache.';
}

/* One floating tooltip, shared by every page. */
let tipEl: HTMLDivElement | null = null;
function tip(html: string | null, e?: MouseEvent): void {
  if (!html) {
    if (tipEl) tipEl.hidden = true;
    return;
  }
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    document.body.appendChild(tipEl);
  }
  if (!e) return;
  tipEl.innerHTML = html;
  tipEl.hidden = false;
  const w = tipEl.offsetWidth,
    h = tipEl.offsetHeight;
  let x = e.clientX + 14,
    y = e.clientY + 14;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  if (y + h > innerHeight - 8) y = e.clientY - h - 14;
  tipEl.style.left = Math.max(8, x) + 'px';
  tipEl.style.top = Math.max(8, y) + 'px';
}
function bindTips(root: HTMLElement, selector: string, fn: (el: Element) => string | null): void {
  root.addEventListener('mousemove', (e) => {
    const t = (e.target as Element).closest(selector);
    tip(t && root.contains(t) ? fn(t) : null, e);
  });
  root.addEventListener('mouseleave', () => tip(null));
}

/** Adds a Copy button to code blocks the scripts create. React's CodeBlock has its own. */
function codeBlocks(): void {
  $$('pre.code').forEach((pre: HTMLPreElement) => {
    if (pre.dataset.copy) return;
    pre.dataset.copy = '1';
    const b = document.createElement('button');
    b.className = 'copy';
    b.textContent = 'Copy';
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText((pre.querySelector('code') as HTMLElement).innerText);
        b.textContent = 'Copied';
      } catch {
        b.textContent = 'Select and copy';
      }
      setTimeout(() => (b.textContent = 'Copy'), 1500);
    });
    pre.appendChild(b);
  });
}

export const Site = {
  theme: getTheme,
  setTheme,
  applyTheme,
  modelGate,
  esc,
  $,
  $$,
  pct,
  fmtInt,
  mulberry32,
  tip,
  bindTips,
  codeBlocks,
};
