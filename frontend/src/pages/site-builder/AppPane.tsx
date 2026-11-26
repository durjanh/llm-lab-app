import { useEffect, useRef, useState } from 'react';
import { modelName, modelNameStart } from '@/lib/models';
import { sitesService, type SiteFile, type SiteVersion } from '@/services/sitesService';
import { addReport, readReport, versionLabel, type PreviewError } from './model';
import type { LiveFile } from './useSiteChat';

type View = 'app' | 'code';
const DEVICES = {
  desktop: { width: '100%', label: 'Desktop' },
  tablet: { width: '768px', label: 'Tablet' },
  phone: { width: '390px', label: 'Phone' },
} as const;
type Device = keyof typeof DEVICES;

interface Props {
  siteId: string | null;
  title: string;
  files: SiteFile[];
  versions: SiteVersion[];
  live: LiveFile | null;
  drafts: Record<string, string>; // written in this response, saved when it ends
  reload: number;
  running: boolean;
  model: string;
  onRestore: (n: number) => void;
  onAskFix: (errors: PreviewError[]) => void;
  /** A version to show, asked for from the conversation; cleared with onShownVersion once shown. */
  showVersion?: number | null;
  onShownVersion?: () => void;
}

/**
 * The running app beside the conversation: a sandboxed frame with a slim toolbar (versions, width, reload, new tab,
 * full screen, download), the code as it is written, and the errors the app reports while it runs.
 */
export function AppPane({
  siteId,
  title,
  files,
  versions,
  live,
  drafts,
  reload,
  running,
  model,
  onRestore,
  onAskFix,
  showVersion,
  onShownVersion,
}: Props) {
  const [view, setView] = useState<View>('app');
  const [followCode, setFollowCode] = useState(true); // follow the model to the code while it writes, until you choose
  const [device, setDevice] = useState<Device>('desktop');
  const [viewing, setViewing] = useState<number | null>(null); // an older version shown read-only; null is the current site
  const [frameKey, setFrameKey] = useState(reload);
  const [errors, setErrors] = useState<PreviewError[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const codeBox = useRef<HTMLPreElement>(null);
  const current = versions.length ? versions[versions.length - 1].n : null;
  const hasIndex = files.some((f) => f.path === 'index.html');

  // A version chip in the conversation asks for its version.
  useEffect(() => {
    if (showVersion == null) return;
    setViewing(showVersion === current ? null : showVersion);
    setView('app');
    setFollowCode(false);
    onShownVersion?.();
  }, [showVersion, current, onShownVersion]);

  // A new site, or a turn starting, shows the current files again.
  useEffect(() => {
    setViewing(null);
    setErrors([]);
  }, [siteId]);
  useEffect(() => {
    if (running) {
      setViewing(null);
      setFollowCode(true);
    }
  }, [running]);

  // Follow the model: show each file while it is written, then the app once it is saved.
  useEffect(() => {
    if (!running || !followCode) return;
    if (live) {
      setView('code');
      if (live.path) setSelected(live.path);
    } else {
      const timer = window.setTimeout(() => setView('app'), 400);
      return () => window.clearTimeout(timer);
    }
  }, [running, followCode, live?.id, live?.path, live]);

  // Reload shortly after a save (several saves in a row reload once); a reload starts a fresh error list.
  useEffect(() => {
    const timer = window.setTimeout(() => setFrameKey(reload), 300);
    return () => window.clearTimeout(timer);
  }, [reload]);
  useEffect(() => setErrors([]), [frameKey, viewing]);

  // Errors from the app: only messages from this frame's window, in the reporter's shape, are read.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const report = readReport(e.data);
      if (report) setErrors((list) => addReport(list, report));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const showingLive = !!live && (live.path === selected || (!live.path && followCode));
  const draft = !showingLive && selected ? drafts[selected] : undefined;
  useEffect(() => {
    if (!siteId || !selected || showingLive || draft !== undefined || view !== 'code') return;
    let alive = true;
    sitesService
      .file(siteId, selected)
      .then((text) => alive && setCode(text))
      .catch(() => alive && setCode(''));
    return () => {
      alive = false;
    };
  }, [siteId, selected, reload, showingLive, draft, view]);
  useEffect(() => {
    if (showingLive && codeBox.current) codeBox.current.scrollTop = codeBox.current.scrollHeight;
  }, [showingLive, live?.text]);

  const choose = (next: View) => {
    setFollowCode(false);
    setView(next);
    if (next === 'code' && !selected && files[0]) setSelected(files[0].path);
  };
  const fullScreen = () => {
    const el = stage.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen?.().catch(() => undefined);
  };

  const unsaved = [...Object.keys(drafts), ...(live?.path ? [live.path] : [])].filter(
    (p) => !files.some((f) => f.path === p),
  );
  const fileList = [...files, ...[...new Set(unsaved)].map((path) => ({ path, size: 0 }))].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const shown = showingLive ? live.text : (draft ?? code);
  const src = siteId ? sitesService.previewUrl(siteId, frameKey, viewing) : '';

  return (
    <section className="sb-app" aria-label="The app">
      <div className="sb-appbar">
        <span className="sb-apptitle" title={title}>
          {title || 'Your app'}
        </span>
        {versions.length > 0 && (
          <select
            className="sb-versions"
            aria-label="Version"
            value={viewing ?? current ?? ''}
            disabled={running}
            onChange={(e) => {
              const n = Number(e.target.value);
              setViewing(n === current ? null : n);
              setView('app');
            }}
          >
            {[...versions].reverse().map((v) => (
              <option key={v.n} value={v.n}>
                {versionLabel(v, current)}
              </option>
            ))}
          </select>
        )}
        <div className="sb-seg" role="tablist" aria-label="Show">
          {(['app', 'code'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={view === v ? 'on' : ''}
              onClick={() => choose(v)}
            >
              {v === 'app' ? 'App' : 'Code'}
              {v === 'code' && live && <span className="sb-dot" title={`${modelNameStart(model)} is writing`} />}
            </button>
          ))}
        </div>
        {view === 'app' && (
          <div className="sb-seg" aria-label="Width">
            {(Object.keys(DEVICES) as Device[]).map((d) => (
              <button
                key={d}
                className={device === d ? 'on' : ''}
                aria-pressed={device === d}
                onClick={() => setDevice(d)}
                title={DEVICES[d].label}
              >
                {DEVICES[d].label}
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        {siteId && hasIndex && (
          <div className="sb-tools">
            <button
              className="sb-icon-btn"
              onClick={() => setFrameKey((k) => k + 1000)}
              title="Reload"
              aria-label="Reload"
            >
              ↻
            </button>
            <a
              className="sb-icon-btn"
              href={src}
              target="_blank"
              rel="noreferrer"
              title="Open in a new tab"
              aria-label="Open in a new tab"
            >
              ↗
            </a>
            <button className="sb-icon-btn" onClick={fullScreen} title="Full screen" aria-label="Full screen">
              ⤢
            </button>
            <button
              className="sb-icon-btn"
              onClick={() => void sitesService.zip(siteId, title)}
              title="Download as .zip"
              aria-label="Download as .zip"
            >
              ⤓
            </button>
          </div>
        )}
      </div>

      {viewing !== null && (
        <div className="sb-viewing" role="status">
          Showing version {viewing}, as it was. Messages change the current version.
          <span className="spacer" />
          <button
            className="btn small primary"
            onClick={() => {
              onRestore(viewing);
              setViewing(null);
            }}
          >
            Restore this version
          </button>
          <button className="btn small" onClick={() => setViewing(null)}>
            Back to current
          </button>
        </div>
      )}

      {view === 'app' ? (
        <div className={`sb-stage d-${device}`} ref={stage}>
          {siteId && hasIndex ? (
            <div className="sb-frame" style={{ width: DEVICES[device].width }}>
              <iframe
                ref={frame}
                key={`${frameKey}-${viewing ?? 'now'}`}
                title={`${title || 'App'} preview`}
                src={src}
                sandbox="allow-scripts allow-forms allow-modals allow-popups"
              />
            </div>
          ) : (
            <div className="sb-empty">
              {running ? (
                <>
                  <span className="spinner" aria-hidden="true" /> {modelNameStart(model)} is writing the first files.
                  The app appears here as soon as index.html is saved.
                </>
              ) : (
                <>
                  Your app appears here. {modelName(model)} writes it into a folder on this server, and it runs
                  sandboxed.
                </>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="sb-code">
          <ul className="sb-files">
            {fileList.map((f) => (
              <li key={f.path}>
                <button
                  className={f.path === selected ? 'on' : ''}
                  onClick={() => {
                    setFollowCode(false);
                    setSelected(f.path);
                  }}
                >
                  {f.path}
                  {live?.path === f.path && (
                    <span className="sb-dot" title={`${modelNameStart(model)} is writing this file`} />
                  )}
                </button>
              </li>
            ))}
            {!fileList.length && <li className="muted small">No files yet.</li>}
          </ul>
          <div className="sb-viewer">
            <div className="small muted sb-viewer-head">
              {selected ?? live?.path ?? 'Pick a file'}
              {showingLive &&
                ` · ${modelNameStart(model)} is ${live.tool === 'edit_file' ? 'writing an edit to' : 'writing'} this file…`}
              {draft !== undefined && ` · written; saved when ${modelName(model)} finishes this response`}
            </div>
            <pre ref={codeBox}>
              <code>{shown}</code>
            </pre>
          </div>
        </div>
      )}

      {view === 'app' && errors.length > 0 && (
        <div className="sb-errors" role="region" aria-label="Errors from the app">
          <div className="sb-errors-head">
            <b>
              {errors.length} error{errors.length === 1 ? '' : 's'} while the app ran
            </b>
            <span className="spacer" />
            {viewing === null && (
              <button className="btn small primary" disabled={running} onClick={() => onAskFix(errors)}>
                Ask to fix
              </button>
            )}
            <button className="btn small" onClick={() => setErrors([])}>
              Clear
            </button>
          </div>
          <ul>
            {errors.map((e) => (
              <li key={`${e.message}|${e.where}`}>
                <span className={`sb-ekind k-${e.kind}`}>
                  {e.kind === 'console' ? 'console' : e.kind === 'promise' ? 'promise' : 'error'}
                </span>
                <span className="sb-emsg">{e.message}</span>
                {e.where && <span className="muted"> {e.where}</span>}
                {e.count > 1 && <span className="muted"> ×{e.count}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
