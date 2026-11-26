import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { filesFromClipboard, fitEffortFor, groupModels, type ComposerModel } from './composerLogic';
import './chat-composer.css';

/* The message box the lab's chat pages share: an auto-growing text box, files to attach (picked, dropped or pasted),
   a "+" menu the page can add to, a model-and-effort pill, and a round send button that becomes Stop. */

export type { ComposerModel } from './composerLogic';
export { filesFromClipboard, fitEffortFor } from './composerLogic';

const EFFORT_LABEL: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export interface ComposerFile {
  id: string;
  name: string;
  size?: number;
}

export interface Uploading {
  name: string;
  progress: number;
}

const extOf = (name: string) => (name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '');
function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 2 ** 20) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 2 ** 20).toFixed(1)} MB`;
}

/** A small icon drawn in strokes of the text colour, so it follows the theme. */
export function ComposerIcon({ name }: { name: 'plus' | 'send' | 'stop' | 'down' | 'files' }) {
  const paths: Record<string, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    send: <path d="M12 19V5M6 11l6-6 6 6" />,
    stop: <rect x="7" y="7" width="10" height="10" rx="2" className="fill" />,
    down: <path d="m6 9 6 6 6-6" />,
    files: (
      <>
        <path d="M7 3.5h7l4.5 4.5v12.5H7z" />
        <path d="M14 3.5V8h4.5" />
      </>
    ),
  };
  return (
    <svg className="cc-i" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      {paths[name]}
    </svg>
  );
}

/** A popover that closes on a click outside it or on Escape. */
function usePopover(initial = false) {
  const [open, setOpen] = useState(initial);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, box };
}

/* Building blocks for a page's own items in the "+" menu, styled with the menu. */

export const MenuTitle = ({ children }: { children: ReactNode }) => <div className="cc-pop-title">{children}</div>;
export const MenuSep = () => <div className="cc-pop-sep" />;
export const MenuNote = ({ children }: { children: ReactNode }) => <p className="cc-pop-note">{children}</p>;

export function MenuItem({
  children,
  onClick,
  checked,
  disabled,
  title,
  meta,
}: {
  children: ReactNode;
  onClick: () => void;
  /** Set for a choice among several (a radio item): shows a tick when chosen. */
  checked?: boolean;
  disabled?: boolean;
  title?: string;
  meta?: ReactNode;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      className={`cc-item${checked ? ' on' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      <span className="cc-item-text">{children}</span>
      {meta && <span className="cc-pop-meta">{meta}</span>}
      {checked && <span className="cc-tick">✓</span>}
    </button>
  );
}

export function MenuToggle({
  on,
  onChange,
  label,
  children,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  children?: ReactNode;
}) {
  return (
    <label className="cc-toggle">
      <span className="cc-toggle-text">
        {label}
        {children}
      </span>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="cc-switch" aria-hidden="true" />
    </label>
  );
}

export interface ChatComposerProps {
  text: string;
  onText: (t: string) => void;
  /** Resolves true when the message was accepted, so the box can clear. */
  onSend: (text: string) => Promise<boolean> | boolean;
  onStop: () => void;
  running: boolean;
  /** Why sending is not possible right now, if it is not. */
  blocked?: string | null;
  /** A warning shown above the box that does not stop sending, such as a model that may not read pictures. */
  notice?: string | null;
  attachments: ComposerFile[];
  uploading: Uploading[];
  problems: string[];
  onPick: (files: File[]) => void;
  onRemove: (id: string) => void;
  /** The file types the picker offers, as an accept attribute. */
  accept: string;
  maxFiles?: number;
  models: ComposerModel[];
  model: string;
  effort: string;
  onModel: (model: string, effort: string) => void;
  onEffort: (effort: string) => void;
  /** The page's own items in the "+" menu, after Attach files. `close` shuts the menu. */
  menu?: (close: () => void) => ReactNode;
  /** Small tags shown beside "+", such as the settings that are on. */
  tags?: ReactNode;
  placeholder?: string;
  /** The large version on a start screen; its menus open downwards. */
  hero?: boolean;
  /** A prefix for element ids, when a page shows two composers. */
  idBase?: string;
  /** Opens a menu when first shown (for tests and previews). */
  initialMenu?: 'plus' | 'model';
}

export function ChatComposer({
  text,
  onText,
  onSend,
  onStop,
  running,
  blocked = null,
  notice = null,
  attachments,
  uploading,
  problems,
  onPick,
  onRemove,
  accept,
  maxFiles,
  models,
  model,
  effort,
  onModel,
  onEffort,
  menu,
  tags,
  placeholder,
  hero = false,
  idBase = 'cc',
  initialMenu,
}: ChatComposerProps) {
  const [drag, setDrag] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const plus = usePopover(initialMenu === 'plus');
  const pill = usePopover(initialMenu === 'model');
  const sending = useRef(false); // a double press must not send twice while the first is being accepted
  const chosen = models.find((m) => m.id === model);
  const efforts = chosen?.efforts ?? [];
  const canSend = !running && !blocked && text.trim().length > 0 && uploading.length === 0;
  const textId = `${idBase}-text${hero ? '-hero' : ''}`;

  // The box grows with what is written, up to a limit, then scrolls.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, hero ? 320 : 260)}px`;
  }, [text, hero]);

  const send = async () => {
    if (!canSend || sending.current) return;
    sending.current = true;
    try {
      if (await onSend(text)) onText('');
    } finally {
      sending.current = false;
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  // A pasted screenshot or file becomes an attachment; pasted text goes into the box as usual.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (running) return;
    const files = filesFromClipboard(e.clipboardData);
    if (!files.length) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    onPick(files);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (!running && e.dataTransfer.files.length) onPick([...e.dataTransfer.files]);
  };

  return (
    <form
      className={`chat-composer${hero ? ' hero' : ''}${drag ? ' drag' : ''}${running ? ' running' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!running) setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
      }}
      onDrop={onDrop}
    >
      {drag && (
        <div className="cc-drop" aria-hidden="true">
          Drop to attach
        </div>
      )}
      {blocked && <p className="cc-blocked">{blocked}</p>}
      {notice && !blocked && <p className="cc-notice">{notice}</p>}
      {(attachments.length > 0 || uploading.length > 0) && (
        <ul className="cc-chips" aria-label="Attached files">
          {attachments.map((f) => (
            <li key={f.id} className="cc-chip">
              <span className="cc-chip-ext">{extOf(f.name) || 'file'}</span>
              <span className="cc-chip-name">{f.name}</span>
              {f.size !== undefined && <span className="cc-chip-size">{sizeText(f.size)}</span>}
              {!running && (
                <button
                  type="button"
                  className="cc-chip-x"
                  onClick={() => onRemove(f.id)}
                  aria-label={`Remove ${f.name}`}
                >
                  ×
                </button>
              )}
            </li>
          ))}
          {uploading.map((u) => (
            <li key={`up-${u.name}`} className="cc-chip cc-chip-up">
              <span className="cc-chip-name">{u.name}</span>
              <span className="cc-chip-bar" style={{ width: `${Math.round(u.progress * 100)}%` }} />
              <span className="cc-hidden">Uploading, {Math.round(u.progress * 100)}%</span>
            </li>
          ))}
        </ul>
      )}
      {problems.length > 0 && (
        <ul className="cc-problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <label className="cc-hidden" htmlFor={textId}>
        Message
      </label>
      <textarea
        id={textId}
        ref={area}
        className="cc-text"
        rows={hero ? 3 : 1}
        value={text}
        placeholder={
          placeholder ?? (hero ? 'Describe what you want, or drop in files…' : 'Reply, or ask for something new…')
        }
        onChange={(e) => onText(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
      />
      <div className="cc-bar">
        <div className="cc-pop-wrap" ref={plus.box}>
          <button
            type="button"
            className="cc-iconbtn"
            onClick={() => plus.setOpen((o) => !o)}
            aria-expanded={plus.open}
            aria-label="Attach files and settings"
          >
            <ComposerIcon name="plus" />
          </button>
          {plus.open && (
            <div className="cc-pop cc-plus-menu" role="menu">
              <MenuItem
                disabled={running}
                onClick={() => {
                  plus.setOpen(false);
                  picker.current?.click();
                }}
                meta={maxFiles ? `up to ${maxFiles}` : undefined}
              >
                <ComposerIcon name="files" />
                Attach files
              </MenuItem>
              <MenuNote>You can also drop files here, or paste a screenshot.</MenuNote>
              {menu?.(() => plus.setOpen(false))}
            </div>
          )}
        </div>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept={accept}
          onChange={(e) => {
            if (e.target.files?.length) onPick([...e.target.files]);
            e.target.value = '';
          }}
        />
        {tags}
        <span className="cc-grow" />
        <div className="cc-pop-wrap" ref={pill.box}>
          <button
            type="button"
            className="cc-pill"
            onClick={() => pill.setOpen((o) => !o)}
            aria-expanded={pill.open}
            aria-label="Model and effort"
            disabled={!models.length}
          >
            <span>{chosen?.name ?? (model || 'No model')}</span>
            {efforts.length > 0 && effort && <span className="cc-pill-effort">{EFFORT_LABEL[effort] ?? effort}</span>}
            <ComposerIcon name="down" />
          </button>
          {pill.open && (
            <div className="cc-pop cc-model-menu" role="menu">
              {groupModels(models).map(({ group, models: list }) => (
                <div key={group} role="group" aria-label={group}>
                  <MenuTitle>{group}</MenuTitle>
                  {list.map((m) => (
                    <MenuItem
                      key={m.id}
                      checked={m.id === model}
                      meta={m.meta}
                      onClick={() => onModel(m.id, fitEffortFor(m.efforts, effort || 'medium'))}
                    >
                      {m.name}
                    </MenuItem>
                  ))}
                </div>
              ))}
              {efforts.length > 0 && (
                <>
                  <MenuSep />
                  <MenuTitle>Effort</MenuTitle>
                  <div className="cc-seg" role="radiogroup" aria-label="Effort">
                    {efforts.map((ef) => (
                      <button
                        key={ef}
                        type="button"
                        role="radio"
                        aria-checked={effort === ef}
                        className={effort === ef ? 'on' : undefined}
                        onClick={() => onEffort(ef)}
                      >
                        {EFFORT_LABEL[ef] ?? ef}
                      </button>
                    ))}
                  </div>
                  <MenuNote>More effort thinks longer: better on hard tasks, slower and dearer.</MenuNote>
                </>
              )}
            </div>
          )}
        </div>
        {running ? (
          <button type="button" className="cc-send stop" onClick={onStop} aria-label="Stop">
            <ComposerIcon name="stop" />
          </button>
        ) : (
          <button type="submit" className="cc-send" disabled={!canSend} aria-label="Send">
            <ComposerIcon name="send" />
          </button>
        )}
      </div>
    </form>
  );
}
