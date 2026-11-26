import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type {
  AssistantInfo,
  ChatSettings,
  Effort,
  McpServer,
  Provider,
  UploadedFile,
} from '@/services/assistantService';
import { Chips, Icon } from './parts';
import { accept } from './upload';

/* Where a message is written: an auto-growing box, files to attach, and the settings the next turn runs with
   (model and effort in a pill; attachments, MCP servers, plan approval and the run budget behind "+"). */

const PROVIDER: Record<Provider, string> = {
  anthropic: 'Claude',
  'azure-openai': 'GPT on Azure',
  local: 'On this machine',
};

const EFFORT_LABEL: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export interface Uploading {
  name: string;
  progress: number;
}

export function effortsFor(info: AssistantInfo, model: string): Effort[] {
  return info.models.find((m) => m.id === model)?.efforts ?? [];
}

/** The effort to use for a model: the one asked for if the model accepts it, else medium, else its first. */
export function fitEffort(info: AssistantInfo, model: string, wanted: Effort): Effort {
  const list = effortsFor(info, model);
  if (!list.length || list.includes(wanted)) return wanted;
  return list.includes('medium') ? 'medium' : list[0];
}

/** The effort to send: none ('') for a model that takes no effort setting, such as the local model. */
export function effortToSend(info: AssistantInfo, model: string, effort: Effort): Effort | '' {
  return effortsFor(info, model).length ? effort : '';
}

/** A popover that closes on a click outside it or on Escape. */
function usePopover() {
  const [open, setOpen] = useState(false);
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

function Toggle({
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
    <label className="as-toggle">
      <span className="as-toggle-text">
        {label}
        {children}
      </span>
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="as-switch" aria-hidden="true" />
    </label>
  );
}

export function Composer({
  info,
  settings,
  onSettings,
  text,
  onText,
  attachments,
  uploading,
  problems,
  onPick,
  onRemove,
  onSend,
  onStop,
  running,
  blocked,
  mcp,
  mcpProblem,
  onManageMcp,
  hero = false,
}: {
  info: AssistantInfo;
  settings: ChatSettings;
  onSettings: (s: ChatSettings) => void;
  text: string;
  onText: (t: string) => void;
  attachments: UploadedFile[];
  uploading: Uploading[];
  problems: string[];
  onPick: (files: File[]) => void;
  onRemove: (id: string) => void;
  /** Resolves true when the message was accepted, so the box can clear. */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  running: boolean;
  /** Why sending is not possible right now, if it is not. */
  blocked: string | null;
  /** The person's MCP servers, and the ids enabled in this chat. */
  mcp: { servers: McpServer[]; enabled: string[] };
  /** Why MCP servers cannot be used here (for example, a backend without them). */
  mcpProblem: string | null;
  onManageMcp: () => void;
  /** The large version on the start screen. */
  hero?: boolean;
}) {
  const [drag, setDrag] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const plus = usePopover();
  const pill = usePopover();
  const efforts = effortsFor(info, settings.model);
  const model = info.models.find((m) => m.id === settings.model);
  const providers = [...new Set(info.models.map((m) => m.provider))];
  const canSend = !running && !blocked && text.trim().length > 0 && uploading.length === 0;
  // Servers switched on, plus any this chat chose that are switched off globally (shown as off).
  const liveServers = mcp.servers.filter((s) => s.enabled || mcp.enabled.includes(s.id));
  const usedServers = mcp.servers.filter((s) => s.enabled && mcp.enabled.includes(s.id));

  // The box grows with what is written, up to a limit, then scrolls.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, hero ? 320 : 260)}px`;
  }, [text, hero]);

  const send = async () => {
    if (!canSend) return;
    const t = text;
    if (await onSend(t)) onText('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (!running && e.dataTransfer.files.length) onPick([...e.dataTransfer.files]);
  };

  const toggleServer = (id: string, on: boolean) => {
    const now = mcp.enabled.filter((x) => x !== id);
    onSettings({ ...settings, mcp_servers: on ? [...now, id] : now });
  };

  return (
    <form
      className={`as-composer${hero ? ' hero' : ''}${drag ? ' drag' : ''}${running ? ' running' : ''}`}
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
        <div className="as-drop" aria-hidden="true">
          Drop to attach
        </div>
      )}
      {blocked && <p className="as-blocked">{blocked}</p>}
      {(attachments.length > 0 || uploading.length > 0) && (
        <div className="as-attach-row">
          <Chips files={attachments} onRemove={running ? undefined : onRemove} />
          {uploading.map((u) => (
            <div key={u.name} className="as-chip as-chip-up">
              <span className="as-chip-name">{u.name}</span>
              <span className="as-chip-bar" style={{ width: `${Math.round(u.progress * 100)}%` }} />
              <span className="visually-hidden">Uploading, {Math.round(u.progress * 100)}%</span>
            </div>
          ))}
        </div>
      )}
      {problems.length > 0 && (
        <ul className="as-problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <label className="visually-hidden" htmlFor={hero ? 'as-text-hero' : 'as-text'}>
        Message
      </label>
      <textarea
        id={hero ? 'as-text-hero' : 'as-text'}
        ref={area}
        className="as-text"
        rows={hero ? 3 : 1}
        value={text}
        placeholder={hero ? 'Describe a task, ask a question, or drop in files…' : 'Reply, or ask for something new…'}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="as-bar">
        <div className="as-pop-wrap" ref={plus.box}>
          <button
            type="button"
            className="as-iconbtn round"
            onClick={() => plus.setOpen((o) => !o)}
            aria-expanded={plus.open}
            aria-label="Attach files and settings"
          >
            <Icon name="plus" />
          </button>
          {plus.open && (
            <div className="as-pop as-plus-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                disabled={running}
                onClick={() => {
                  plus.setOpen(false);
                  picker.current?.click();
                }}
              >
                <Icon name="files" />
                Attach files
                <span className="as-pop-meta">up to {info.upload.max_files}</span>
              </button>
              <div className="as-pop-sep" />
              <div className="as-pop-title">
                <Icon name="plug" /> MCP servers
              </div>
              {mcpProblem ? (
                <p className="as-pop-note">{mcpProblem}</p>
              ) : liveServers.length === 0 ? (
                <p className="as-pop-note">No servers yet. Add one to give the agent more tools.</p>
              ) : (
                liveServers.map((s) => (
                  <Toggle
                    key={s.id}
                    on={mcp.enabled.includes(s.id)}
                    onChange={(v) => toggleServer(s.id, v)}
                    label={s.name}
                  >
                    <span className={`as-dot-status ${s.enabled ? s.status : ''}`} aria-hidden="true" />
                    <span className="as-pop-meta">{s.enabled ? `${s.tools.length} tools` : 'off'}</span>
                  </Toggle>
                ))
              )}
              {!mcpProblem && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    plus.setOpen(false);
                    onManageMcp();
                  }}
                >
                  Manage servers…
                </button>
              )}
              <div className="as-pop-sep" />
              <Toggle
                on={settings.approve_plans}
                onChange={(v) => onSettings({ ...settings, approve_plans: v })}
                label="Approve plans first"
              />
              <label className="as-budget-row">
                <span>Run budget</span>
                <span className="as-budget">
                  $
                  <input
                    type="number"
                    min={0.05}
                    max={20}
                    step={0.05}
                    value={settings.run_budget_usd}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v))
                        onSettings({ ...settings, run_budget_usd: Math.min(20, Math.max(0.05, v)) });
                    }}
                  />
                </span>
              </label>
              <p className="as-pop-note">The most one message may spend, its sub-agents included.</p>
            </div>
          )}
        </div>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept={accept(info.upload)}
          onChange={(e) => {
            if (e.target.files?.length) onPick([...e.target.files]);
            e.target.value = '';
          }}
        />
        {usedServers.length > 0 && (
          <span className="as-tag" title={usedServers.map((s) => s.name).join(', ')}>
            <Icon name="plug" />
            {usedServers.length}
          </span>
        )}
        {settings.approve_plans && <span className="as-tag">Approve plans</span>}
        <span className="as-grow" />
        <div className="as-pop-wrap" ref={pill.box}>
          <button
            type="button"
            className="as-pill"
            onClick={() => pill.setOpen((o) => !o)}
            aria-expanded={pill.open}
            aria-label="Model and effort"
          >
            <span>{model?.name ?? settings.model}</span>
            {efforts.length > 0 && <span className="as-pill-effort">{EFFORT_LABEL[settings.effort]}</span>}
            <Icon name="down" />
          </button>
          {pill.open && (
            <div className="as-pop as-model-menu" role="menu">
              {providers.map((p) => (
                <div key={p} role="group" aria-label={PROVIDER[p]}>
                  <div className="as-pop-title">{PROVIDER[p]}</div>
                  {info.models
                    .filter((m) => m.provider === p)
                    .map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={m.id === settings.model}
                        className={m.id === settings.model ? 'on' : undefined}
                        onClick={() =>
                          onSettings({ ...settings, model: m.id, effort: fitEffort(info, m.id, settings.effort) })
                        }
                      >
                        <span>{m.name}</span>
                        <span className="as-pop-meta">{Math.round(m.context_window / 1000)}k</span>
                        {m.id === settings.model && <span className="as-tick">✓</span>}
                      </button>
                    ))}
                </div>
              ))}
              {efforts.length > 0 && (
                <>
                  <div className="as-pop-sep" />
                  <div className="as-pop-title">Effort</div>
                  <div className="as-seg" role="radiogroup" aria-label="Effort">
                    {efforts.map((ef) => (
                      <button
                        key={ef}
                        type="button"
                        role="radio"
                        aria-checked={settings.effort === ef}
                        className={settings.effort === ef ? 'on' : undefined}
                        onClick={() => onSettings({ ...settings, effort: ef })}
                      >
                        {EFFORT_LABEL[ef]}
                      </button>
                    ))}
                  </div>
                  <p className="as-pop-note">More effort thinks longer: better on hard tasks, slower and dearer.</p>
                </>
              )}
            </div>
          )}
        </div>
        {running ? (
          <button type="button" className="as-send stop" onClick={onStop} aria-label="Stop">
            <Icon name="stop" />
          </button>
        ) : (
          <button type="submit" className="as-send" disabled={!canSend} aria-label="Send">
            <Icon name="send" />
          </button>
        )}
      </div>
    </form>
  );
}
