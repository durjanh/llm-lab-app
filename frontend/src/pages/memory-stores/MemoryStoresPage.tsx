import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  memoryStoresService as svc,
  type MemoryDetail,
  type MemoryStore,
  type MemoryStoreSummary,
  type MemoryVersion,
} from '@/services/memoryStoresService';
import './memory-stores.css';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const when = (t: number) => {
  const s = (Date.now() / 1000 - t) | 0;
  if (s < 60) return 'just now';
  if (s < 3600) return `${(s / 60) | 0} min ago`;
  if (s < 86400) return `${(s / 3600) | 0} h ago`;
  return new Date(t * 1000).toLocaleDateString();
};
const kb = (b: number) => (b < 1000 ? `${b} B` : `${(b / 1000).toFixed(1)} kB`);

/** Versioned folders of lessons that coding sessions read and write, as in Claude Managed Agents' memory stores. */
export default function MemoryStoresPage() {
  const [params, setParams] = useSearchParams();
  const [stores, setStores] = useState<MemoryStoreSummary[]>([]);
  const [store, setStore] = useState<MemoryStore | null>(null);
  const [memory, setMemory] = useState<MemoryDetail | null>(null);
  const [version, setVersion] = useState<(MemoryVersion & { content: string | null }) | null>(null);
  const [raw, setRaw] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ path: string; content: string } | null>(null);
  const [newStore, setNewStore] = useState({ name: '', description: '' });
  const [description, setDescription] = useState<string | null>(null);
  const [error, setError] = useState('');
  const storeId = params.get('store') ?? '';

  const act = async <T,>(f: () => Promise<T>): Promise<T | undefined> => {
    setError('');
    try {
      return await f();
    } catch (e) {
      setError(errorText(e));
      return undefined;
    }
  };

  const loadStores = () =>
    act(() => svc.list()).then((list) => {
      if (!list) return;
      setStores(list);
      if (!storeId && list[0]) setParams({ store: list[0].id }, { replace: true });
    });

  useEffect(() => {
    void loadStores();
  }, []);

  useEffect(() => {
    setMemory(null);
    setVersion(null);
    setEditing(null);
    setDescription(null);
    if (storeId) void act(() => svc.get(storeId)).then((s) => s && setStore(s));
    else setStore(null);
  }, [storeId]);

  const refreshStore = async () => {
    if (!storeId) return;
    const s = await act(() => svc.get(storeId));
    if (s) setStore(s);
    void loadStores();
  };

  const open = async (memoryId: string) => {
    setVersion(null);
    setEditing(null);
    const m = await act(() => svc.memory(storeId, memoryId));
    if (m) setMemory(m);
  };

  // Folders first, then files, as a tree one level deep per folder name.
  const tree = useMemo(() => {
    const groups = new Map<string, MemoryStore['memories']>();
    for (const m of store?.memories ?? []) {
      const folder = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : '';
      groups.set(folder, [...(groups.get(folder) ?? []), m]);
    }
    return [...groups.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [store]);

  const shown = version ?? (memory ? { content: memory.content } : null);

  return (
    <main className="page-memory-stores">
      <div className="kicker">Agents · Memory stores</div>
      <h1>Memory stores: what a coding agent learns, kept between sessions</h1>
      <p className="lede">
        A store is a folder of small text files. Mount it in a <Link to="/coding-agent">coding agent</Link> session and the
        agent reads it before it starts and writes what it learned before it finishes: one file per topic, each lesson
        as condition, action and why, and a note for the session. Every change is kept as a version saying which session
        made it, so you can see the history, restore an old version or redact one that should never have been written.
        The same design as Claude Managed Agents' memory stores, kept on this machine, and it works with every model the
        lab runs.
      </p>
      {error && <p className="ms-error">{error}</p>}

      <div className="ms-grid">
        <aside className="ms-stores">
          <h2>Stores</h2>
          <ul>
            {stores.map((s) => (
              <li key={s.id}>
                <button className={s.id === storeId ? 'on' : ''} onClick={() => setParams({ store: s.id })}>
                  <b>{s.name}</b>
                  <span className="small muted">
                    {s.memories} files · {kb(s.bytes)}
                  </span>
                </button>
              </li>
            ))}
            {stores.length === 0 && <li className="small muted">No stores yet.</li>}
          </ul>
          <form
            className="ms-new"
            onSubmit={async (e) => {
              e.preventDefault();
              const s = await act(() => svc.create(newStore.name.trim(), newStore.description.trim()));
              if (s) {
                setNewStore({ name: '', description: '' });
                await loadStores();
                setParams({ store: s.id });
              }
            }}
          >
            <input
              placeholder="new-store-name"
              value={newStore.name}
              onChange={(e) => setNewStore({ ...newStore, name: e.target.value.toLowerCase() })}
            />
            <textarea
              rows={3}
              placeholder="What it holds, written for the model (it reads this)"
              value={newStore.description}
              onChange={(e) => setNewStore({ ...newStore, description: e.target.value })}
            />
            <button className="btn" disabled={newStore.name.trim().length < 2}>
              Create store
            </button>
          </form>
        </aside>

        <section className="ms-contents">
          {store ? (
            <>
              <div className="ms-head">
                <h2>{store.name}</h2>
                <span className="mono small muted">{store.id}</span>
                <span className="small muted">created {when(store.created_at)}</span>
              </div>
              {description === null ? (
                <p className="small ms-desc" onClick={() => setDescription(store.description)} title="Click to edit">
                  {store.description || <span className="muted">Add a description (the model reads it)</span>}
                </p>
              ) : (
                <div className="ms-desc-edit">
                  <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
                  <button
                    className="btn small"
                    onClick={async () => {
                      const s = await act(() => svc.describe(store.id, description));
                      if (s) {
                        setStore(s);
                        setDescription(null);
                      }
                    }}
                  >
                    Save
                  </button>
                  <button className="btn ghost small" onClick={() => setDescription(null)}>
                    Cancel
                  </button>
                </div>
              )}
              <div className="ms-tree-head">
                <span className="small muted">Contents</span>
                <button className="btn small" onClick={() => setAdding({ path: '', content: '' })}>
                  + Add memory
                </button>
              </div>
              <ul className="ms-tree">
                {tree.map(([folder, items]) => (
                  <li key={folder || '/'}>
                    {folder && <div className="ms-folder small">▾ {folder}/</div>}
                    <ul>
                      {items.map((m) => (
                        <li key={m.id}>
                          <button className={memory?.id === m.id ? 'on' : ''} onClick={() => void open(m.id)}>
                            <span className="mono">{folder ? m.path.slice(folder.length + 1) : m.path}</span>
                            <span className="small muted">{kb(m.size)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              <button
                className="btn ghost small ms-delete-store"
                onClick={async () => {
                  if (!window.confirm(`Delete the store ${store.name} and every version in it?`)) return;
                  if (await act(() => svc.remove(store.id))) {
                    setParams({});
                    void loadStores();
                  }
                }}
              >
                Delete store
              </button>
            </>
          ) : (
            <p className="small muted">Create a store to start.</p>
          )}
        </section>

        <section className="ms-memory">
          {adding && store && (
            <div className="ms-add">
              <h3>Add a memory</h3>
              <input
                placeholder="topic.md or folder/topic.md"
                value={adding.path}
                onChange={(e) => setAdding({ ...adding, path: e.target.value })}
              />
              <textarea
                rows={12}
                placeholder={'**What it is about**\n- CONDITION: …\n- ACTION: …\n- WHY: …'}
                value={adding.content}
                onChange={(e) => setAdding({ ...adding, content: e.target.value })}
              />
              <div className="ms-buttons">
                <button
                  className="btn primary"
                  onClick={async () => {
                    const m = await act(() => svc.add(store.id, adding.path.trim(), adding.content));
                    if (m) {
                      setAdding(null);
                      setMemory(m);
                      void refreshStore();
                    }
                  }}
                >
                  Save
                </button>
                <button className="btn ghost" onClick={() => setAdding(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {!adding && memory && (
            <>
              <div className="ms-memory-head">
                <h3 className="mono">/{memory.path}</h3>
                <div className="ms-buttons">
                  {editing === null ? (
                    <>
                      <button className="btn small" onClick={() => setEditing(memory.content ?? '')}>
                        Edit
                      </button>
                      <button
                        className="btn ghost small"
                        onClick={async () => {
                          if (!window.confirm(`Delete ${memory.path}? Its history stays.`)) return;
                          if (await act(() => svc.deleteMemory(store!.id, memory.id))) {
                            setMemory(null);
                            void refreshStore();
                          }
                        }}
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
              <dl className="ms-meta small">
                <dt>ID</dt>
                <dd className="mono">{memory.id}</dd>
                <dt>Size</dt>
                <dd>{kb(memory.size)}</dd>
                <dt>Updated</dt>
                <dd>{when(memory.updated_at)}</dd>
                <dt>Updated by</dt>
                <dd className="mono">{memory.updated_by}</dd>
              </dl>
              {editing !== null ? (
                <div className="ms-edit">
                  <textarea rows={18} value={editing} onChange={(e) => setEditing(e.target.value)} />
                  <div className="ms-buttons">
                    <button
                      className="btn primary"
                      onClick={async () => {
                        const m = await act(() => svc.update(store!.id, memory.id, editing));
                        if (m) {
                          setMemory(m);
                          setEditing(null);
                          void refreshStore();
                        }
                      }}
                    >
                      Save as a new version
                    </button>
                    <button className="btn ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="ms-view-head">
                    {version ? (
                      <span className="small">
                        Version <span className="mono">{version.id}</span> ({version.operation}, {when(version.at)}, by{' '}
                        <span className="mono">{version.by}</span>){' '}
                        <button className="ms-link" onClick={() => setVersion(null)}>
                          back to current
                        </button>
                      </span>
                    ) : (
                      <span className="small muted">Current version</span>
                    )}
                    <span className="ms-toggle small">
                      <button className={!raw ? 'on' : ''} onClick={() => setRaw(false)}>
                        Rendered
                      </button>
                      <button className={raw ? 'on' : ''} onClick={() => setRaw(true)}>
                        Raw
                      </button>
                    </span>
                  </div>
                  <div className="ms-content">
                    {shown?.content == null ? (
                      <p className="small muted">
                        {version?.redacted ? 'Redacted: this text has been removed for good.' : 'No text (a deletion).'}
                      </p>
                    ) : raw ? (
                      <pre>{shown.content}</pre>
                    ) : (
                      // react-markdown builds React elements and ignores raw HTML, so a memory cannot add markup
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{shown.content}</ReactMarkdown>
                    )}
                  </div>
                </>
              )}
              <h4>History</h4>
              <div className="table-wrap">
                <table className="t small ms-versions">
                  <tbody>
                    {memory.versions.map((v, i) => (
                      <tr key={v.id} className={version?.id === v.id ? 'on' : ''}>
                        <td>
                          <button
                            className="ms-link mono"
                            onClick={async () => {
                              const full = await act(() => svc.version(store!.id, v.id));
                              if (full) setVersion(full);
                            }}
                          >
                            {v.id.slice(0, 14)}…
                          </button>
                        </td>
                        <td>{v.redacted ? 'redacted' : v.operation}</td>
                        <td>{when(v.at)}</td>
                        <td className="mono">{v.by}</td>
                        <td>{kb(v.size)}</td>
                        <td className="ms-version-actions">
                          {i > 0 && !v.redacted && v.operation !== 'deleted' && (
                            <button
                              className="ms-link"
                              onClick={async () => {
                                const m = await act(() => svc.restore(store!.id, v.id));
                                if (m) {
                                  setMemory(m);
                                  setVersion(null);
                                  void refreshStore();
                                }
                              }}
                            >
                              restore
                            </button>
                          )}
                          {i > 0 && !v.redacted && v.operation !== 'deleted' && (
                            <button
                              className="ms-link danger"
                              onClick={async () => {
                                if (
                                  !window.confirm(
                                    'Remove this version’s text for good? The record that it existed stays.',
                                  )
                                )
                                  return;
                                if (await act(() => svc.redact(store!.id, v.id))) void open(memory.id);
                              }}
                            >
                              redact
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {!adding && !memory && store && (
            <p className="small muted">Choose a file to see it, its history and who changed it.</p>
          )}
        </section>
      </div>

      <section className="card ms-how">
        <h2>How it works</h2>
        <ol>
          <li>
            <b>Mount.</b> On the <Link to="/coding-agent">coding agent</Link> page, tick stores under Memory before the first
            request. Each is copied into the project as <code>.memory/&lt;store&gt;/</code>, read-write or read-only,
            and the agent's instructions name each one with its description.
          </li>
          <li>
            <b>Use.</b> The agent reads the files with its ordinary tools. In a read-write store it writes lessons
            before it finishes: one file per topic, each as condition, action and why, and a note at{' '}
            <code>sessions/&lt;session&gt;.md</code>.
          </li>
          <li>
            <b>Keep.</b> When each run ends, what changed comes back here as versions signed by the session. A change to
            a read-only store, or one holding a key or token, is refused and the file is put back.
          </li>
          <li>
            <b>Look after it.</b> Edit or delete a memory, restore an old version, or redact one: its text is removed
            for good and the record stays.
          </li>
        </ol>
        <h3>Here and in Managed Agents</h3>
        <div className="table-wrap">
          <table className="t small">
            <thead>
              <tr>
                <th />
                <th>This lab</th>
                <th>Claude Managed Agents</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Where it lives</td>
                <td>generated/memory-stores/ on this machine</td>
                <td>Anthropic, in your workspace</td>
              </tr>
              <tr>
                <td>How the agent sees it</td>
                <td>a copy in the project, saved back after each run</td>
                <td>a live mount at /mnt/memory/&lt;store&gt;/</td>
              </tr>
              <tr>
                <td>Models</td>
                <td>the local model, Claude or GPT</td>
                <td>Claude</td>
              </tr>
              <tr>
                <td>Versions, restore, redact</td>
                <td>yes</td>
                <td>yes (memver_ objects)</td>
              </tr>
              <tr>
                <td>Two sessions at once</td>
                <td>each sees the store as it began; the later save wins, the earlier text stays in history</td>
                <td>both write to the live mount</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
