import { useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AssistantFile, Plan, PlanStep } from '@/services/assistantService';
import { viewKind } from './helpers';
import { isImage } from './state';
import { sizeText } from './upload';

/* Small building blocks of the assistant page: the lab's mark, the reply as Markdown, the plan, file cards, chips. */

const MEDIA = '/api/assistant/media/';

/** The assistant's mark: three linked nodes in a rounded tile, the lab's own sign for "an agent at work". */
export function Mark({ size = 28, busy = false }: { size?: number; busy?: boolean }) {
  return (
    <svg
      className={`as-mark${busy ? ' busy' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="30" height="30" rx="9" className="as-mark-tile" />
      <path d="M10 21 16 10 22 21Z" className="as-mark-link" />
      <circle cx="16" cy="10" r="3.2" className="as-mark-node a" />
      <circle cx="10" cy="21" r="3.2" className="as-mark-node b" />
      <circle cx="22" cy="21" r="3.2" className="as-mark-node c" />
    </svg>
  );
}

/**
 * Links may point at the web, at an email address or at this chat's own files; anything else (javascript:, data:)
 * becomes an empty link. Images load only from the lab's media route, so a reply cannot make the browser fetch
 * an outside address, which could otherwise carry the chat's contents away in its URL.
 */
export function safeUrl(url: string): string {
  const u = url.trim();
  if (u.startsWith(MEDIA)) return u;
  if (/^(https?:|mailto:)/i.test(u)) return u;
  return '';
}

/** Copies text and briefly says so; falls back to a hint where the clipboard is not allowed. */
export function CopyButton({
  text,
  label = 'Copy',
  className,
}: {
  text: () => string;
  label?: string;
  className?: string;
}) {
  const [done, setDone] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text());
      setDone('Copied');
    } catch {
      setDone('Select and copy');
    }
    window.setTimeout(() => setDone(null), 1400);
  };
  return (
    <button type="button" className={className ?? 'as-ghost'} onClick={() => void copy()}>
      {done ?? label}
    </button>
  );
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const box = useRef<HTMLPreElement>(null);
  return (
    <div className="as-code">
      <CopyButton className="as-code-copy" text={() => box.current?.innerText ?? ''} />
      <pre ref={box}>{children}</pre>
    </div>
  );
}

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ src, alt }) =>
    typeof src === 'string' && src.startsWith(MEDIA) ? (
      <img src={src} alt={alt ?? ''} className="as-inline-img" loading="lazy" />
    ) : (
      <span className="as-blocked-img" title="Images from outside the chat are not loaded">
        [image{alt ? `: ${alt}` : ''}]
      </span>
    ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="as-table">
      <table>{children}</table>
    </div>
  ),
};

/** Model text as Markdown. react-markdown builds React elements and drops raw HTML, so the text cannot add markup. */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className={`as-md${streaming ? ' streaming' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

const MARK: Record<PlanStep['status'], string> = { todo: '', doing: '', done: '✓', skipped: '–' };

/** The plan as a compact card: "Plan · 3 of 5", open while the turn is working, folded once it has finished. */
export function PlanView({ plan, reason, working }: { plan: Plan; reason?: string | null; working: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const done = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const shown = open ?? working;
  const current = plan.steps.find((s) => s.status === 'doing');
  return (
    <section className={`as-plan${shown ? ' open' : ''}`} aria-label="Plan">
      <button type="button" className="as-plan-head" onClick={() => setOpen(!shown)} aria-expanded={shown}>
        <span
          className="as-plan-ring"
          style={{ ['--p' as string]: `${plan.steps.length ? done / plan.steps.length : 0}` }}
        />
        <b>Plan</b>
        <span className="as-plan-count">
          {done} of {plan.steps.length}
        </span>
        {!shown && current && <span className="as-plan-now">{current.text}</span>}
        {plan.revision > 1 && <span className="as-plan-rev">revised</span>}
        <span className="as-chev" aria-hidden="true" />
      </button>
      {shown && (
        <div className="as-plan-body">
          {reason && <p className="as-plan-why">Changed because: {reason}</p>}
          <ol>
            {plan.steps.map((s, i) => (
              <li key={i} className={`as-step ${s.status}`}>
                <span className="as-step-box" aria-hidden="true">
                  {MARK[s.status]}
                </span>
                <span>
                  {s.text}
                  <span className="visually-hidden"> ({s.status})</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

const KIND_LABEL: Record<string, string> = {
  pdf: 'PDF',
  pptx: 'Slides',
  docx: 'Document',
  xlsx: 'Spreadsheet',
  csv: 'CSV',
  md: 'Markdown',
  png: 'Image',
  jpg: 'Image',
  jpeg: 'Image',
  svg: 'Image',
};

export const extOf = (name: string) => (name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '');

/** One file the agent made: a thumbnail (the image itself or the first page) and its name; opens the viewer. */
export function FileCard({
  file,
  onOpen,
  active,
  subtitle,
}: {
  file: AssistantFile;
  onOpen: () => void;
  active?: boolean;
  subtitle?: string;
}) {
  const thumb = isImage(file) ? file.url : file.previews[0];
  const ext = extOf(file.name);
  return (
    <button
      type="button"
      className={`as-file${active ? ' on' : ''}${thumb ? '' : ' plain'}`}
      onClick={onOpen}
      title={`Open ${file.name}`}
    >
      <span className={`as-file-thumb kind-${viewKind(file)}`}>
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <span className="as-file-ext">{ext || 'file'}</span>}
      </span>
      <span className="as-file-text">
        <span className="as-file-name">{file.name}</span>
        <span className="as-file-sub">
          {subtitle ?? `${KIND_LABEL[ext] ?? ext.toUpperCase()} · ${sizeText(file.size)}`}
        </span>
      </span>
    </button>
  );
}

export function Chips({
  files,
  onRemove,
}: {
  files: { id: string; name: string; size?: number }[];
  onRemove?: (id: string) => void;
}) {
  if (!files.length) return null;
  return (
    <ul className="as-chips" aria-label="Attached files">
      {files.map((f) => (
        <li key={f.id} className="as-chip">
          <span className="as-chip-ext">{extOf(f.name) || 'file'}</span>
          <span className="as-chip-name">{f.name}</span>
          {f.size !== undefined && <span className="as-chip-size">{sizeText(f.size)}</span>}
          {onRemove && (
            <button type="button" className="as-chip-x" onClick={() => onRemove(f.id)} aria-label={`Remove ${f.name}`}>
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A small icon drawn in CSS-coloured strokes, so it follows the theme. */
export function Icon({
  name,
}: {
  name:
    | 'plus'
    | 'send'
    | 'stop'
    | 'side'
    | 'search'
    | 'files'
    | 'more'
    | 'close'
    | 'activity'
    | 'new'
    | 'plug'
    | 'down'
    | 'copy'
    | 'open';
}) {
  const paths: Record<string, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    send: <path d="M12 19V5M6 11l6-6 6 6" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="2" className="fill" />,
    side: (
      <>
        <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
        <path d="M9.5 4.5v15" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="6" />
        <path d="m20 20-4.2-4.2" />
      </>
    ),
    files: (
      <>
        <path d="M7 3.5h7l4.5 4.5v12.5H7z" />
        <path d="M14 3.5V8h4.5" />
      </>
    ),
    more: (
      <>
        <circle cx="6" cy="12" r="1.3" className="fill" />
        <circle cx="12" cy="12" r="1.3" className="fill" />
        <circle cx="18" cy="12" r="1.3" className="fill" />
      </>
    ),
    close: <path d="M6 6l12 12M18 6 6 18" />,
    activity: <path d="M3 12h4l2.5-6 5 12 2.5-6H21" />,
    new: (
      <>
        <path d="M12 20h8" />
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
      </>
    ),
    plug: (
      <>
        <path d="M9 3v5M15 3v5" />
        <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
        <path d="M12 17v4" />
      </>
    ),
    down: <path d="m6 9 6 6 6-6" />,
    copy: (
      <>
        <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
        <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
      </>
    ),
    open: (
      <>
        <path d="M14 4.5h5.5V10M19.5 4.5 11 13" />
        <path d="M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10" />
      </>
    ),
  };
  return (
    <svg className="as-i" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}
