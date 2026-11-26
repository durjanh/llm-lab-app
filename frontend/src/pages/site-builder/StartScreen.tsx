import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { sitesService, type SiteSummary } from '@/services/sitesService';
import { tileHue } from './model';

export const IDEAS = [
  'A tide-times page for a small harbour town, with a week of high and low tides as a chart',
  'A recipe box: add recipes, tag them, search by ingredient, and scale the servings',
  'A pomodoro timer with a task list and a weekly summary of focused time',
  'A bakery landing page with a menu, opening hours and an order form',
];

/** The first screen: one prompt box, a few ideas, and the sites made before, newest first. */
export function StartScreen({
  sites,
  ready,
  note,
  modelPicker,
  onStart,
  onOpen,
  onRename,
  onDelete,
}: {
  sites: SiteSummary[];
  ready: boolean;
  note: ReactNode;
  modelPicker: ReactNode;
  onStart: (prompt: string) => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const go = () => {
    const text = prompt.trim();
    if (ready && text) onStart(text);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      go();
    }
  };
  return (
    <div className="sb-start">
      <div className="sb-hero">
        <div className="sb-mark" aria-hidden="true" />
        <h1>What shall we build?</h1>
        <p className="muted">
          Describe an app or a website. It is written into a folder here, runs beside the conversation, and changes as
          you ask.
        </p>
      </div>
      <div className="sb-startbox">
        <label className="sr-only" htmlFor="sb-start-prompt">
          Describe your app
        </label>
        <textarea
          id="sb-start-prompt"
          rows={3}
          value={prompt}
          placeholder="A page that…"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKey}
          disabled={!ready}
        />
        <div className="sb-startbar">
          {modelPicker}
          <span className="spacer" />
          <button className="sb-send" onClick={go} disabled={!ready || !prompt.trim()} aria-label="Start building">
            ↑
          </button>
        </div>
      </div>
      <div className="small muted sb-startnote">{note}</div>
      <div className="sb-ideas" aria-label="Ideas">
        {IDEAS.map((idea) => (
          <button key={idea} className="sb-idea" onClick={() => setPrompt(idea)}>
            {idea}
          </button>
        ))}
      </div>
      {sites.length > 0 && (
        <section className="sb-gallery" aria-label="Your sites">
          <h2>Your apps</h2>
          <div className="sb-grid">
            {sites.map((s) => (
              <SiteTile key={s.id} site={s} onOpen={onOpen} onRename={onRename} onDelete={onDelete} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SiteTile({
  site,
  onOpen,
  onRename,
  onDelete,
}: {
  site: SiteSummary;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(site.title);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!site.thumb) return;
    let url = '';
    let alive = true;
    sitesService
      .shot(site.id, site.thumb)
      .then((blob) => {
        url = URL.createObjectURL(blob);
        if (alive) setThumb(url);
        else URL.revokeObjectURL(url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [site.id, site.thumb]);

  const date = new Date(site.updated * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return (
    <div className="sb-tile">
      <button className="sb-thumb" onClick={() => onOpen(site.id)} aria-label={`Open ${site.title}`}>
        {thumb ? (
          <img src={thumb} alt="" />
        ) : (
          <span className="sb-thumb-empty" style={{ background: `hsl(${tileHue(site.id)} 55% 45%)` }}>
            {site.title.slice(0, 1).toUpperCase()}
          </span>
        )}
        {site.running && <span className="sb-running">Building…</span>}
      </button>
      <div className="sb-tile-foot">
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) onRename(site.id, name.trim());
              setEditing(false);
            }}
          >
            <input
              aria-label="Title"
              value={name}
              maxLength={80}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setEditing(false)}
            />
          </form>
        ) : (
          <span className="sb-tile-title" title={site.title}>
            {site.title}
          </span>
        )}
        <span className="small muted">
          {date}
          {site.versions > 0 && ` · ${site.versions} version${site.versions === 1 ? '' : 's'}`}
        </span>
        <div className="sb-tile-actions">
          <button
            className="sb-link"
            onClick={() => {
              setName(site.title);
              setEditing(true);
            }}
          >
            Rename
          </button>
          <button
            className={`sb-link${confirm ? ' danger' : ''}`}
            onClick={() => {
              if (confirm) onDelete(site.id);
              else {
                setConfirm(true);
                window.setTimeout(() => setConfirm(false), 3000);
              }
            }}
            disabled={site.running}
          >
            {confirm ? 'Delete for good?' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
