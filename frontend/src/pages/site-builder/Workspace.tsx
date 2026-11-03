import { useEffect, useRef, useState } from 'react';
import { sitesService, type SiteFile } from '@/services';
import type { LiveFile } from './useSiteChat';

type Tab = 'preview' | 'code';
const DEVICES = { desktop: '100%', tablet: '768px', phone: '390px' } as const;

interface Props {
  siteId: string | null;
  title: string;
  files: SiteFile[];
  live: LiveFile | null;
  drafts: Record<string, string>; // written in this response, saved when it ends
  version: number;
  following: boolean; // switch tabs to follow Claude, until you pick one yourself
  onTakeOver: () => void;
}

/**
 * The right-hand side: the site in a sandboxed frame, and its code. While Claude works it follows
 * along: the code tab shows each file as it is written, and the preview returns once it is saved.
 */
export function Workspace({ siteId, title, files, live, drafts, version, following, onTakeOver }: Props) {
  const [tab, setTab] = useState<Tab>('preview');
  const [device, setDevice] = useState<keyof typeof DEVICES>('desktop');
  const [selected, setSelected] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [frameVersion, setFrameVersion] = useState(version);
  const codeBox = useRef<HTMLPreElement>(null);

  // Follow Claude: show a file while it is written, then the preview once it is saved.
  useEffect(() => {
    if (!following) return;
    if (live) {
      setTab('code');
      if (live.path) setSelected(live.path);
    } else {
      const timer = window.setTimeout(() => setTab('preview'), 400);
      return () => window.clearTimeout(timer);
    }
  }, [following, live?.id, live?.path, live]);

  // Reload the preview shortly after a file is saved; several saves in a row reload it once.
  useEffect(() => {
    const timer = window.setTimeout(() => setFrameVersion(version), 300);
    return () => window.clearTimeout(timer);
  }, [version]);

  const showingLive = !!live && (live.path === selected || (!live.path && following));
  const draft = !showingLive && selected ? drafts[selected] : undefined;

  // A saved file's text, fetched again whenever files change.
  useEffect(() => {
    if (!siteId || !selected || showingLive || draft !== undefined) return;
    let alive = true;
    sitesService
      .file(siteId, selected)
      .then((text) => alive && setCode(text))
      .catch(() => alive && setCode(''));
    return () => {
      alive = false;
    };
  }, [siteId, selected, version, showingLive, draft]);

  useEffect(() => {
    if (showingLive && codeBox.current) codeBox.current.scrollTop = codeBox.current.scrollHeight;
  }, [showingLive, live?.text]);

  const choose = (next: Tab) => {
    onTakeOver();
    setTab(next);
    if (next === 'code' && !selected && files[0]) setSelected(files[0].path);
  };

  const shown = showingLive ? live.text : (draft ?? code);
  const unsaved = [...Object.keys(drafts), ...(live?.path ? [live.path] : [])].filter((p) => !files.some((f) => f.path === p));
  const filesWithLive = [...files, ...[...new Set(unsaved)].map((path) => ({ path, size: 0 }))].sort((a, b) => a.path.localeCompare(b.path));

  return (
    <section className="sb-work card">
      <div className="sb-toolbar">
        <div className="sb-tabs" role="tablist">
          {(['preview', 'code'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => choose(t)}>
              {t === 'preview' ? 'Preview' : 'Code'}
              {t === 'code' && live && <span className="sb-dot" title="Claude is writing" />}
            </button>
          ))}
        </div>
        {tab === 'preview' && (
          <div className="sb-tabs small" aria-label="Width">
            {(Object.keys(DEVICES) as (keyof typeof DEVICES)[]).map((d) => (
              <button key={d} className={device === d ? 'on' : ''} onClick={() => setDevice(d)}>
                {d[0].toUpperCase() + d.slice(1)}
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        {siteId && files.length > 0 && (
          <>
            <button className="btn small" onClick={() => setFrameVersion((v) => v + 1000)} title="Reload the preview">
              Reload
            </button>
            <a className="btn small" href={sitesService.previewUrl(siteId)} target="_blank" rel="noreferrer">
              Open in a new tab
            </a>
            <button className="btn small" onClick={() => sitesService.zip(siteId, title)}>
              Download .zip
            </button>
          </>
        )}
      </div>

      {tab === 'preview' ? (
        <div className="sb-stage">
          {siteId && files.some((f) => f.path === 'index.html') ? (
            <iframe
              key={frameVersion}
              title="Site preview"
              src={sitesService.previewUrl(siteId, frameVersion)}
              sandbox="allow-scripts allow-forms allow-modals allow-popups"
              style={{ width: DEVICES[device] }}
            />
          ) : (
            <p className="muted sb-empty">Your site appears here as Claude writes it.</p>
          )}
        </div>
      ) : (
        <div className="sb-code">
          <ul className="sb-files">
            {filesWithLive.map((f) => (
              <li key={f.path}>
                <button
                  className={f.path === selected ? 'on' : ''}
                  onClick={() => {
                    onTakeOver();
                    setSelected(f.path);
                  }}
                >
                  {f.path}
                  {live?.path === f.path && <span className="sb-dot" title="Claude is writing this file" />}
                </button>
              </li>
            ))}
            {!filesWithLive.length && <li className="muted small">No files yet.</li>}
          </ul>
          <div className="sb-viewer">
            <div className="small muted sb-viewer-head">
              {selected ?? live?.path ?? 'Pick a file'}
              {showingLive && ` · Claude is ${live.tool === 'edit_file' ? 'writing an edit to' : 'writing'} this file…`}
              {draft !== undefined && ' · written, saved when Claude finishes this response'}
            </div>
            <pre ref={codeBox}>
              <code>{shown}</code>
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}
