import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSummary } from '@/services/assistantService';
import { filterChats, groupChats } from './helpers';
import { Icon, Mark } from './parts';

/* The left rail: a new chat, search, the Files view, and past chats grouped by day. Each chat has a small menu to
   rename it in place or delete it (a second click confirms). On phones it is a drawer over the page. */

function ChatRow({
  c,
  active,
  busy,
  onOpen,
  onRename,
  onDelete,
}: {
  c: ChatSummary;
  active: boolean;
  busy: boolean;
  onOpen: () => void;
  onRename: (title: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.title);
  const [confirm, setConfirm] = useState(false);
  const box = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) {
        setMenu(false);
        setConfirm(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const save = async () => {
    const t = draft.trim();
    setEditing(false);
    if (t && t !== c.title) await onRename(t.slice(0, 120));
  };

  return (
    <li ref={box} className={`as-row-chat${active ? ' on' : ''}${menu ? ' menu-open' : ''}`}>
      {editing ? (
        <input
          className="as-rename"
          value={draft}
          autoFocus
          aria-label="Chat title"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button type="button" className="as-chat-link" onClick={onOpen} aria-current={active ? 'page' : undefined}>
          {busy && <span className="as-live-dot" title="Working" aria-label="Working" />}
          <span className="as-chat-name">{c.title}</span>
        </button>
      )}
      {!editing && (
        <button
          type="button"
          className="as-chat-more"
          aria-label={`More for ${c.title}`}
          aria-expanded={menu}
          onClick={() => {
            setMenu((m) => !m);
            setConfirm(false);
          }}
        >
          <Icon name="more" />
        </button>
      )}
      {menu && (
        <div className="as-pop as-chat-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setDraft(c.title);
              setEditing(true);
              setMenu(false);
            }}
          >
            Rename
          </button>
          <span className="as-pop-meta">${c.cost_usd.toFixed(3)} spent</span>
          {confirm ? (
            <button
              type="button"
              role="menuitem"
              className="danger"
              disabled={busy}
              onClick={() => {
                setMenu(false);
                setConfirm(false);
                void onDelete();
              }}
            >
              Delete for good
            </button>
          ) : (
            <button type="button" role="menuitem" className="danger" disabled={busy} onClick={() => setConfirm(true)}>
              {busy ? 'Working: cannot delete' : 'Delete'}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function Sidebar({
  chats,
  current,
  running,
  filesOpen,
  onNew,
  onOpen,
  onFiles,
  onRename,
  onDelete,
  onHide,
}: {
  chats: ChatSummary[];
  current: string | null;
  /** Chats with a turn streaming in this tab. */
  running: ReadonlySet<string>;
  filesOpen: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onFiles: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onHide: () => void;
}) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupChats(filterChats(chats, query)), [chats, query]);

  return (
    <nav className="as-side" aria-label="Chats">
      <div className="as-side-head">
        <span className="as-brand">
          <Mark size={24} />
          <span>Assistant</span>
        </span>
        <button type="button" className="as-iconbtn" onClick={onHide} aria-label="Hide the sidebar">
          <Icon name="side" />
        </button>
      </div>
      <button type="button" className="as-side-new" onClick={onNew}>
        <Icon name="new" />
        <span>New chat</span>
      </button>
      <label className="as-search">
        <Icon name="search" />
        <span className="visually-hidden">Search chats</span>
        <input type="search" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <button
        type="button"
        className={`as-side-item${filesOpen ? ' on' : ''}`}
        onClick={onFiles}
        aria-pressed={filesOpen}
      >
        <Icon name="files" />
        <span>Files</span>
      </button>
      <div className="as-side-list">
        {chats.length === 0 && <p className="as-side-empty">Your chats will appear here.</p>}
        {chats.length > 0 && groups.length === 0 && <p className="as-side-empty">No chat titles match “{query}”.</p>}
        {groups.map((g) => (
          <section key={g.label} aria-label={g.label}>
            <h3 className="as-side-group">{g.label}</h3>
            <ul>
              {g.chats.map((c) => (
                <ChatRow
                  key={c.id}
                  c={c}
                  active={c.id === current && !filesOpen}
                  busy={running.has(c.id) || c.status === 'running'}
                  onOpen={() => onOpen(c.id)}
                  onRename={(t) => onRename(c.id, t)}
                  onDelete={() => onDelete(c.id)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}
