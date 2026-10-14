/* Shared site chrome: navigation, model loading cards, small helpers. */
(function () {
  const GROUPS = [
    ['Foundations', [['transformer.html', 'Transformer'], ['training.html', 'Training'], ['tokens.html', 'Tokens'], ['sampling.html', 'Sampling']]],
    ['Building', [['prompting.html', 'Prompting'], ['embeddings.html', 'Embeddings & RAG'], ['agents.html', 'Agents & tools']]],
    ['Quality and safety', [['evals.html', 'Evals'], ['confidence.html', 'Confidence'], ['injection.html', 'Prompt injection']]],
    ['Cost and operations', [['context.html', 'Context & cost'], ['routing.html', 'Routing'], ['live.html', 'Live Claude']]]
  ];
  const PAGES = [['index.html', 'Home']].concat(...GROUPS.map(g => g[1]));
  function nav() {
    const here = (location.pathname.split('/').pop() || 'index.html');
    const el = document.createElement('nav');
    el.className = 'site-nav';
    el.setAttribute('aria-label', 'Lab pages');
    const link = ([href, label]) => `<a href="${href}"${href === here ? ' aria-current="page"' : ''}>${label}</a>`;
    el.innerHTML = `<a class="site-brand" href="index.html">LLM Lab</a>
      <div class="site-links">${link(PAGES[0])}${GROUPS.map(([g, items]) => `<span class="site-group" role="group" aria-label="${g}">${items.map(link).join('')}</span>`).join('')}</div>
      <select class="site-select" aria-label="Go to page">${PAGES.map(([href, label]) => `<option value="${href}"${href === here ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
    el.querySelector('.site-select').addEventListener('change', e => { location.href = e.target.value; });
    const t = document.createElement('button');
    t.className = 'theme-toggle'; t.type = 'button';
    const label = () => { const m = theme(); t.textContent = '◐ ' + m[0].toUpperCase() + m.slice(1); t.title = 'Colour theme: ' + m + '. Click to change.'; t.setAttribute('aria-label', 'Colour theme: ' + m); };
    t.addEventListener('click', () => { const order = ['auto', 'dark', 'light']; setTheme(order[(order.indexOf(theme()) + 1) % 3]); label(); });
    label(); el.appendChild(t);
    document.body.prepend(el);
  }

  /* Theme: 'auto' follows the OS; 'dark' or 'light' is stored per browser. */
  function theme() { try { return localStorage.getItem('theme') || 'auto'; } catch (e) { return 'auto'; } }
  function setTheme(m) {
    try { localStorage.setItem('theme', m); } catch (e) { /* storage unavailable */ }
    applyTheme();
  }
  function applyTheme() {
    const m = theme();
    if (m === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = m;
    document.dispatchEvent(new CustomEvent('themechange'));
  }
  applyTheme();

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const pct = (v, d = 1) => (v * 100).toFixed(d) + '%';
  const fmtInt = n => Math.round(n).toLocaleString('en-GB');
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* A card that loads a browser model on request (or automatically when it was
   * loaded before and is therefore cached). opts: { title, sizeMB, what, loader, autoKey, onReady } */
  function modelGate(mount, opts) {
    mount.classList.add('gate');
    mount.innerHTML = `
      <div class="gate-text"><b>${esc(opts.title)}</b> runs in your browser. ${opts.what}
      The first load downloads about ${opts.sizeMB} MB from Hugging Face; your browser caches it after that.</div>
      <div class="gate-actions"><button class="btn primary">Load ${esc(opts.title)}</button>
      <div class="progress" hidden><i></i></div><span class="gate-status muted"></span></div>`;
    const btn = $('button', mount), bar = $('.progress', mount), status = $('.gate-status', mount);
    async function go() {
      btn.disabled = true; bar.hidden = false; status.textContent = 'Starting…'; status.classList.remove('err');
      try {
        await opts.loader((loaded, total) => {
          $('i', bar).style.width = (100 * loaded / total).toFixed(1) + '%';
          status.textContent = `${(loaded / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB`;
        });
        mount.classList.add('ready');
        mount.innerHTML = `<span><span class="ok-dot"></span><b>${esc(opts.title)}</b> is loaded and running in your browser.</span>`;
        opts.onReady && opts.onReady();
      } catch (e) {
        console.error(e);
        btn.disabled = false; bar.hidden = true;
        status.textContent = 'Could not load the model. Check your connection and try again. ' + (e.message || '');
        status.classList.add('err');
      }
    }
    btn.addEventListener('click', go);
    let auto = false;
    try { auto = localStorage.getItem(opts.autoKey) === '1'; } catch (e) { /* storage unavailable */ }
    if (auto || new URLSearchParams(location.search).has('autoload')) go();
  }

  /* Floating tooltip shared by pages. */
  let tipEl;
  function tip(html, e) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tooltip'; document.body.appendChild(tipEl); }
    if (!html) { tipEl.hidden = true; return; }
    tipEl.innerHTML = html; tipEl.hidden = false;
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > innerHeight - 8) y = e.clientY - h - 14;
    tipEl.style.left = Math.max(8, x) + 'px'; tipEl.style.top = Math.max(8, y) + 'px';
  }
  function bindTips(root, selector, fn) {
    root.addEventListener('mousemove', e => { const t = e.target.closest(selector); tip(t && root.contains(t) ? fn(t) : null, e); });
    root.addEventListener('mouseleave', () => tip(null));
  }

  /* Copy buttons on code blocks. */
  function codeBlocks() {
    $$('pre.code').forEach(pre => {
      if (pre.dataset.copy) return; pre.dataset.copy = '1';
      const b = document.createElement('button'); b.className = 'copy'; b.textContent = 'Copy';
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(pre.querySelector('code').innerText); b.textContent = 'Copied'; }
        catch (e) { b.textContent = 'Select and copy'; }
        setTimeout(() => (b.textContent = 'Copy'), 1500);
      });
      pre.appendChild(b);
    });
  }

  window.Site = { nav, theme, setTheme, modelGate, esc, $, $$, pct, fmtInt, mulberry32, tip, bindTips, codeBlocks };
  document.addEventListener('DOMContentLoaded', () => { nav(); codeBlocks(); });
})();
