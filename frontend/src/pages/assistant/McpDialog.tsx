import { useEffect, useRef, useState } from 'react';
import { assistantService as svc, type McpServer, type McpServerPatch } from '@/services/assistantService';
import { checkMcpForm, type McpForm } from './helpers';
import { Icon } from './parts';

/* Managing the person's MCP servers: add one (the backend connects and lists its tools before keeping it), check it
   again, switch it on or off, ask before each call, edit it, or delete it. A token goes to the backend once and is
   never shown again; the page only learns whether one is set. */

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const BLANK: McpForm = { name: '', url: '', token: '' };

function ServerForm({
  initial,
  editing,
  others,
  onSave,
  onCancel,
}: {
  initial: McpForm & { ask: boolean; tokenSet?: boolean };
  editing: boolean;
  others: McpServer[];
  onSave: (form: McpForm, ask: boolean, clearToken: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<McpForm>({ name: initial.name, url: initial.url, token: '' });
  const [ask, setAsk] = useState(initial.ask);
  const [clear, setClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const problems = checkMcpForm(form, others);

  const save = async () => {
    setTouched(true);
    if (problems.length) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(form, ask, clear);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="as-mcp-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        <span>Name</span>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Team wiki"
          autoFocus
        />
      </label>
      <label>
        <span>URL (Streamable HTTP)</span>
        <input
          value={form.url}
          onChange={(e) => setForm({ ...form, url: e.target.value })}
          placeholder="https://example.com/mcp"
          inputMode="url"
        />
      </label>
      <label>
        <span>Bearer token {editing && initial.tokenSet ? '(one is set; leave empty to keep it)' : '(optional)'}</span>
        <input
          type="password"
          autoComplete="off"
          value={form.token}
          disabled={clear}
          onChange={(e) => setForm({ ...form, token: e.target.value })}
          placeholder={editing && initial.tokenSet ? '••••••••' : ''}
        />
      </label>
      {editing && initial.tokenSet && (
        <label className="as-inline-check">
          <input type="checkbox" checked={clear} onChange={(e) => setClear(e.target.checked)} /> Remove the stored token
        </label>
      )}
      <label className="as-inline-check">
        <input type="checkbox" checked={ask} onChange={(e) => setAsk(e.target.checked)} /> Ask me before each call to
        this server
      </label>
      <p className="as-mcp-hint">
        The token is kept on this machine and sent only to this server. The agent, the log and the sandbox never see it.
        Treat a server&apos;s tools like any other outside input: they can be wrong or try to steer the agent.
      </p>
      {touched && problems.length > 0 && (
        <ul className="as-problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && (
        <p className="as-problems" role="alert">
          {error}
        </p>
      )}
      <div className="as-mcp-actions">
        <button type="button" className="as-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="as-btn primary" disabled={busy}>
          {busy ? 'Connecting…' : editing ? 'Save' : 'Add server'}
        </button>
      </div>
    </form>
  );
}

function ServerRow({
  s,
  onUpdate,
  onEdit,
  onDelete,
}: {
  s: McpServer;
  onUpdate: (next: McpServer) => void;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const act = async (label: string, work: () => Promise<McpServer | void>) => {
    setBusy(label);
    setError(null);
    try {
      const next = await work();
      if (next) onUpdate(next);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  };
  const patch = (p: McpServerPatch) => act('saving', () => svc.updateMcpServer(s.id, p));

  return (
    <li className={`as-mcp-row${s.enabled ? '' : ' off'}`}>
      <div className="as-mcp-head">
        <span className={`as-dot-status ${s.status}`} title={s.status} aria-label={`Status: ${s.status}`} />
        <div className="as-mcp-name">
          <b>{s.name}</b>
          <span>{s.url}</span>
        </div>
        <label className="as-toggle compact" title="Use this server">
          <input
            type="checkbox"
            checked={s.enabled}
            disabled={!!busy}
            onChange={(e) => void patch({ enabled: e.target.checked })}
          />
          <span className="as-switch" aria-hidden="true" />
          <span className="visually-hidden">Enabled</span>
        </label>
      </div>
      {s.status === 'error' && s.message && <p className="as-mcp-err">{s.message}</p>}
      <div className="as-mcp-meta">
        <button type="button" className="as-ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {s.tools.length} tool{s.tools.length === 1 ? '' : 's'}
        </button>
        {s.token_set && <span>Token set</span>}
        <label className="as-inline-check">
          <input
            type="checkbox"
            checked={s.ask_before_call}
            disabled={!!busy}
            onChange={(e) => void patch({ ask_before_call: e.target.checked })}
          />{' '}
          Ask before each call
        </label>
        <span className="as-grow" />
        <button
          type="button"
          className="as-ghost"
          disabled={!!busy}
          onClick={() => void act('checking', () => svc.checkMcpServer(s.id))}
        >
          {busy === 'checking' ? 'Checking…' : 'Check'}
        </button>
        <button type="button" className="as-ghost" disabled={!!busy} onClick={onEdit}>
          Edit
        </button>
        {confirm ? (
          <button
            type="button"
            className="as-ghost danger"
            disabled={!!busy}
            onClick={() => void act('deleting', onDelete)}
          >
            Delete for good
          </button>
        ) : (
          <button type="button" className="as-ghost danger" disabled={!!busy} onClick={() => setConfirm(true)}>
            Delete
          </button>
        )}
      </div>
      {error && <p className="as-mcp-err">{error}</p>}
      {open && (
        <ul className="as-mcp-tools">
          {s.tools.length === 0 && <li>No tools listed.</li>}
          {s.tools.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>
              {t.description && <span>{t.description}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function McpDialog({
  servers,
  onServers,
  onClose,
}: {
  servers: McpServer[];
  onServers: (list: McpServer[]) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<{ kind: 'list' } | { kind: 'add' } | { kind: 'edit'; id: string }>(() =>
    servers.length ? { kind: 'list' } : { kind: 'add' },
  );
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    box.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const replace = (next: McpServer) => onServers(servers.map((s) => (s.id === next.id ? next : s)));
  const editing = mode.kind === 'edit' ? servers.find((s) => s.id === mode.id) : undefined;

  return (
    <div className="as-modal" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="as-dialog" role="dialog" aria-modal="true" aria-label="MCP servers" ref={box} tabIndex={-1}>
        <div className="as-dialog-head">
          <Icon name="plug" />
          <h2>MCP servers</h2>
          <span className="as-grow" />
          <button type="button" className="as-iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <p className="as-dialog-intro">
          Connect remote MCP servers (Streamable HTTP) to give the agent more tools. Choose which ones each chat uses
          from the + menu.
        </p>
        {mode.kind === 'list' && (
          <>
            <ul className="as-mcp-list">
              {servers.length === 0 && <li className="as-mcp-empty">No servers yet.</li>}
              {servers.map((s) => (
                <ServerRow
                  key={s.id}
                  s={s}
                  onUpdate={replace}
                  onEdit={() => setMode({ kind: 'edit', id: s.id })}
                  onDelete={async () => {
                    await svc.removeMcpServer(s.id);
                    onServers(servers.filter((x) => x.id !== s.id));
                  }}
                />
              ))}
            </ul>
            <button type="button" className="as-btn primary" onClick={() => setMode({ kind: 'add' })}>
              Add a server
            </button>
          </>
        )}
        {mode.kind === 'add' && (
          <ServerForm
            initial={{ ...BLANK, ask: false }}
            editing={false}
            others={servers}
            onCancel={() => (servers.length ? setMode({ kind: 'list' }) : onClose())}
            onSave={async (form, ask) => {
              const made = await svc.addMcpServer({
                name: form.name.trim(),
                url: form.url.trim(),
                ...(form.token.trim() ? { token: form.token.trim() } : {}),
                ask_before_call: ask,
              });
              onServers([...servers, made]);
              setMode({ kind: 'list' });
            }}
          />
        )}
        {mode.kind === 'edit' && editing && (
          <ServerForm
            initial={{
              name: editing.name,
              url: editing.url,
              token: '',
              ask: editing.ask_before_call,
              tokenSet: editing.token_set,
            }}
            editing
            others={servers.filter((s) => s.id !== editing.id)}
            onCancel={() => setMode({ kind: 'list' })}
            onSave={async (form, ask, clearToken) => {
              const p: McpServerPatch = { ask_before_call: ask };
              if (form.name.trim() !== editing.name) p.name = form.name.trim();
              if (form.url.trim() !== editing.url) p.url = form.url.trim();
              if (clearToken) p.token = '';
              else if (form.token.trim()) p.token = form.token.trim();
              replace(await svc.updateMcpServer(editing.id, p));
              setMode({ kind: 'list' });
            }}
          />
        )}
      </div>
    </div>
  );
}
