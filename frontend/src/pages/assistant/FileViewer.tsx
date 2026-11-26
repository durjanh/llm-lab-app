import { useEffect, useState } from 'react';
import type { AssistantFile } from '@/services/assistantService';
import { MAX_TEXT_CHARS, parseCsv, viewKind } from './helpers';
import { Icon, Markdown } from './parts';
import { sizeText } from './upload';

/* The right-hand viewer: files open in tabs beside the chat. Images can be zoomed, documents show their page
   previews, and Markdown, CSV and text are read from the media route and rendered as React elements (never as HTML). */

type Loaded = { state: 'loading' } | { state: 'ok'; text: string; cut: boolean } | { state: 'error'; message: string };

/** Reads a text file from the media route, at most MAX_TEXT_CHARS of it. The media route needs no lab header. */
function useText(url: string, wanted: boolean): Loaded | null {
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  useEffect(() => {
    if (!wanted || loaded[url]) return;
    let gone = false;
    setLoaded((m) => ({ ...m, [url]: { state: 'loading' } }));
    fetch(url, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`The file could not be read (HTTP ${r.status}).`);
        const t = await r.text();
        if (!gone)
          setLoaded((m) => ({
            ...m,
            [url]: { state: 'ok', text: t.slice(0, MAX_TEXT_CHARS), cut: t.length > MAX_TEXT_CHARS },
          }));
      })
      .catch((err: unknown) => {
        if (!gone)
          setLoaded((m) => ({
            ...m,
            [url]: { state: 'error', message: err instanceof Error ? err.message : String(err) },
          }));
      });
    return () => {
      gone = true;
    };
  }, [url, wanted, loaded]);
  return wanted ? (loaded[url] ?? { state: 'loading' }) : null;
}

function Body({ file }: { file: AssistantFile }) {
  const kind = viewKind(file);
  const [zoom, setZoom] = useState(false);
  const text = useText(file.url, kind === 'markdown' || kind === 'csv' || kind === 'text');

  if (kind === 'image')
    return (
      <div className={`as-v-image${zoom ? ' zoom' : ''}`}>
        <button
          type="button"
          onClick={() => setZoom((z) => !z)}
          aria-label={zoom ? 'Fit to the panel' : 'Show full size'}
        >
          <img src={file.url} alt={file.name} />
        </button>
      </div>
    );
  if (kind === 'pages')
    return (
      <div className="as-v-pages">
        {file.previews.map((p, i) => (
          <figure key={p}>
            <img src={p} alt={`${file.name}, page ${i + 1}`} loading="lazy" />
            <figcaption>
              {i + 1} / {file.previews.length}
            </figcaption>
          </figure>
        ))}
      </div>
    );
  if (kind === 'download')
    return (
      <div className="as-v-none">
        <p>
          {/\.(pdf|pptx|docx|xlsx)$/i.test(file.name)
            ? 'The page previews are still being made, or could not be made for this file.'
            : 'This kind of file cannot be shown here.'}
        </p>
        <a className="as-btn primary" href={file.url} download={file.name}>
          Download {file.name}
        </a>
      </div>
    );
  if (!text || text.state === 'loading') return <p className="as-v-msg">Reading the file…</p>;
  if (text.state === 'error') return <p className="as-v-msg bad">{text.message}</p>;
  const cut = text.cut && <p className="as-v-msg">Only the start of this file is shown. Download it for the rest.</p>;
  if (kind === 'markdown')
    return (
      <div className="as-v-doc">
        <Markdown text={text.text} />
        {cut}
      </div>
    );
  if (kind === 'csv') {
    const rows = parseCsv(text.text);
    const [head, ...body] = rows;
    return (
      <div className="as-v-csv">
        <div className="as-table">
          <table>
            {head && (
              <thead>
                <tr>
                  {head.map((h, i) => (
                    <th key={i}>{h}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="as-v-msg">
          {body.length} row{body.length === 1 ? '' : 's'} shown
          {text.cut || rows.length >= 300 ? ', the first part only' : ''}.
        </p>
      </div>
    );
  }
  return (
    <div className="as-v-text">
      <pre>{text.text}</pre>
      {cut}
    </div>
  );
}

export function FileViewer({
  files,
  active,
  onActivate,
  onCloseTab,
  onClose,
}: {
  files: AssistantFile[];
  active: string;
  onActivate: (id: string) => void;
  onCloseTab: (id: string) => void;
  onClose: () => void;
}) {
  const file = files.find((f) => f.id === active) ?? files[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === 'Escape' && !typing) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!file) return null;
  return (
    <aside className="as-viewer" aria-label={`File: ${file.name}`}>
      <div className="as-v-tabs" role="tablist" aria-label="Open files">
        {files.map((f) => (
          <div key={f.id} className={`as-v-tab${f.id === file.id ? ' on' : ''}`}>
            <button type="button" role="tab" aria-selected={f.id === file.id} onClick={() => onActivate(f.id)}>
              {f.name}
            </button>
            <button type="button" className="as-v-x" onClick={() => onCloseTab(f.id)} aria-label={`Close ${f.name}`}>
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
      <div className="as-v-bar">
        <div className="as-v-title">
          <b>{file.name}</b>
          <span>
            {sizeText(file.size)}
            {file.previews.length > 1 ? ` · ${file.previews.length} pages` : ''}
          </span>
        </div>
        <a
          className="as-iconbtn"
          href={file.url}
          download={file.name}
          aria-label={`Download ${file.name}`}
          title="Download"
        >
          <Icon name="down" />
        </a>
        <a
          className="as-iconbtn"
          href={file.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${file.name} in a new tab`}
          title="Open in a new tab"
        >
          <Icon name="open" />
        </a>
        <button type="button" className="as-iconbtn" onClick={onClose} aria-label="Close the viewer" title="Close">
          <Icon name="close" />
        </button>
      </div>
      <div className="as-v-body" key={file.id}>
        <Body file={file} />
      </div>
    </aside>
  );
}
