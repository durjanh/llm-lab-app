import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router';
import { useNavHeight } from '@/lib/useNavHeight';
import { ApiError } from '@/services/apiClient';
import {
  assistantService as svc,
  type AssistantEvent,
  type AssistantFile,
  type AssistantInfo,
  type Chat,
  type ChatSettings,
  type ChatSummary,
  type McpServer,
  type PlanStep,
  type RecentFile,
  type UploadedFile,
} from '@/services/assistantService';
import { Activity } from './Activity';
import { Composer, effortToSend, fitEffort, type Uploading } from './Composer';
import { FileViewer } from './FileViewer';
import { chatMcp, dollars } from './helpers';
import { McpDialog } from './McpDialog';
import { Message } from './Message';
import { Icon } from './parts';
import { Sidebar } from './Sidebar';
import { answeredTool, endWithError, fromStored, reduceTurn, startTurn, type Lane, type TurnState } from './state';
import { checkUploads } from './upload';
import { FilesView, Welcome } from './Welcome';
import './assistant.css';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const aborted = (err: unknown) =>
  (err instanceof DOMException && err.name === 'AbortError') ||
  (err instanceof Error && /abort|cancel/i.test(err.name + err.message));
const narrow = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 860px)').matches;

function defaults(info: AssistantInfo): ChatSettings {
  return {
    model: info.default_model,
    effort: fitEffort(info, info.default_model, 'medium'),
    run_budget_usd: info.run_budget_usd,
    approve_plans: false,
  };
}

interface Work {
  lanes: Lane[];
  loading: boolean;
  error: string | null;
}

/**
 * A general assistant: each message is a turn in which the model plans, works in the lab's sandbox (commands,
 * files, MCP servers, sub-agents running in parallel) until it decides it is done, then answers. Chats are stored,
 * the model and effort can change on any message, files open beside the chat, and every step can be shown.
 */
export default function AssistantPage() {
  const navHeight = useNavHeight();
  const [params, setParams] = useSearchParams();
  const currentId = params.get('chat');
  const [info, setInfo] = useState<AssistantInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [cache, setCache] = useState<Record<string, Chat>>({});
  const [live, setLive] = useState<Record<string, TurnState>>({});
  const [settings, setSettings] = useState<Record<string, ChatSettings>>({});
  const [newSettings, setNewSettings] = useState<ChatSettings | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, UploadedFile[]>>({});
  const [uploading, setUploading] = useState<Uploading[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, Work>>({});
  const [side, setSide] = useState(() => !narrow());
  const [view, setView] = useState<'chat' | 'files'>('chat');
  const [viewer, setViewer] = useState<{ files: AssistantFile[]; active: string } | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [mcp, setMcp] = useState<McpServer[]>([]);
  const [mcpProblem, setMcpProblem] = useState<string | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [recentProblem, setRecentProblem] = useState<string | null>(null);
  const aborts = useRef(new Map<string, AbortController>());
  const sending = useRef(new Set<string>());
  /** Chats whose MCP choice the person changed here, so the next send carries it. */
  const mcpChanged = useRef(new Set<string>());
  const liveRef = useRef(live);
  liveRef.current = live;
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const open = useCallback(
    (id: string | null) => {
      setParams(id ? { chat: id } : {}, { replace: false });
      setView('chat');
      setNote(null);
      setProblems([]);
      setViewer(null);
      atBottom.current = true;
      if (narrow()) setSide(false);
    },
    [setParams],
  );

  const refreshChats = useCallback(async () => {
    try {
      setChats(await svc.chats());
    } catch (err) {
      setProblem(message(err));
    }
  }, []);

  const refreshRecent = useCallback(async () => {
    try {
      setRecent(await svc.recentFiles(24));
      setRecentProblem(null);
    } catch (err) {
      setRecent([]);
      setRecentProblem(
        err instanceof ApiError && err.status === 404
          ? 'Recent files are not available on this backend.'
          : message(err),
      );
    }
  }, []);

  const loadChat = useCallback(
    async (id: string) => {
      try {
        const c = await svc.chat(id);
        setCache((m) => ({ ...m, [id]: c }));
        return c;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setProblem('That chat no longer exists.');
          setParams({});
        } else setProblem(message(err));
        return null;
      }
    },
    [setParams],
  );

  useEffect(() => {
    svc.info().then(setInfo, (err) => setProblem(message(err)));
    void refreshChats();
    void refreshRecent();
    svc.mcpServers().then(
      (list) => {
        setMcp(list);
        setMcpProblem(null);
      },
      (err) =>
        setMcpProblem(
          err instanceof ApiError && err.status === 404
            ? 'MCP servers are not available on this backend.'
            : `MCP servers could not be loaded: ${message(err)}`,
        ),
    );
    const aborting = aborts.current;
    return () => aborting.forEach((a) => a.abort());
  }, [refreshChats, refreshRecent]);

  useEffect(() => {
    if (currentId) void loadChat(currentId);
  }, [currentId, loadChat]);

  const chat = currentId ? cache[currentId] : undefined;
  const liveTurn = currentId ? live[currentId] : undefined;
  const elsewhere = !!chat && chat.status === 'running' && !liveTurn;
  const runningHere = useMemo(() => new Set(Object.keys(live).filter((k) => live[k].stopped === null)), [live]);
  const runningNow = !!liveTurn && liveTurn.stopped === null;

  // A turn running in another tab or window: look again every few seconds until it ends.
  useEffect(() => {
    if (!elsewhere || !currentId) return;
    const id = window.setInterval(() => {
      void loadChat(currentId);
      void refreshChats();
    }, 4000);
    return () => window.clearInterval(id);
  }, [elsewhere, currentId, loadChat, refreshChats]);

  const current: ChatSettings | null = info
    ? currentId
      ? (settings[currentId] ??
        (chat
          ? { ...chat.settings, effort: fitEffort(info, chat.settings.model, chat.settings.effort) }
          : defaults(info)))
      : (newSettings ?? defaults(info))
    : null;

  const setCurrent = (s: ChatSettings) => {
    if (current && s.mcp_servers !== current.mcp_servers) mcpChanged.current.add(currentId ?? '');
    if (currentId) setSettings((m) => ({ ...m, [currentId]: s }));
    else setNewSettings(s);
  };

  const draftKey = currentId ?? '';
  const draft = drafts[draftKey] ?? '';
  const setDraft = (t: string) => setDrafts((m) => ({ ...m, [draftKey]: t }));

  /** The open chat's id, making the chat first if this is its first message or upload. */
  const ensureChat = async (): Promise<string> => {
    if (currentId) return currentId;
    const c = await svc.create();
    setChats((list) => [c, ...list.filter((x) => x.id !== c.id)]);
    if (newSettings) setSettings((m) => ({ ...m, [c.id]: newSettings }));
    if (mcpChanged.current.delete('')) mcpChanged.current.add(c.id);
    setNewSettings(null);
    setDrafts((m) => ({ ...m, [c.id]: m[''] ?? '', '': '' }));
    setPending((m) => ({ ...m, [c.id]: m[''] ?? [], '': [] }));
    setParams({ chat: c.id });
    return c.id;
  };

  const pick = async (files: File[]) => {
    if (!info) return;
    const checked = checkUploads(files, info.upload, (pending[currentId ?? ''] ?? []).length);
    setProblems(checked.problems);
    if (!checked.ok.length) return;
    let id: string;
    try {
      id = await ensureChat();
    } catch (err) {
      setProblems([message(err)]);
      return;
    }
    const names = checked.ok.map((f) => f.name);
    setUploading((u) => [...u, ...names.map((name) => ({ name, progress: 0 }))]);
    try {
      const made = await svc.upload(id, checked.ok, (p) =>
        setUploading((u) => u.map((x) => (names.includes(x.name) ? { ...x, progress: p } : x))),
      );
      setPending((m) => ({ ...m, [id]: [...(m[id] ?? []), ...made] }));
    } catch (err) {
      setProblems((p) => [...p, message(err)]);
    } finally {
      setUploading((u) => u.filter((x) => !names.includes(x.name)));
    }
  };

  const apply = (id: string, e: AssistantEvent) => {
    setLive((m) => (m[id] ? { ...m, [id]: reduceTurn(m[id], e) } : m));
    if (e.type === 'title') setChats((list) => list.map((c) => (c.id === id ? { ...c, title: e.title } : c)));
  };

  const send = async (text: string): Promise<boolean> => {
    if (!info || !current) return false;
    let id: string;
    try {
      id = await ensureChat();
    } catch (err) {
      setProblems([message(err)]);
      return false;
    }
    // A second click, or Enter pressed twice, while the first send is starting does nothing.
    const runningThere = liveRef.current[id];
    if (sending.current.has(id) || (runningThere && runningThere.stopped === null)) return false;
    sending.current.add(id);
    const attachments = pending[id] ?? pending[''] ?? [];
    const settingsNow = settings[id] ?? current;
    const turn = startTurn({ text, attachments: attachments.map((a) => ({ ...a, url: '', previews: [] })) });
    setLive((m) => ({ ...m, [id]: turn }));
    setPending((m) => ({ ...m, [id]: [], '': [] }));
    setDrafts((m) => ({ ...m, [id]: '', '': '' }));
    setProblems([]);
    atBottom.current = true;
    setChats((list) => list.map((c) => (c.id === id ? { ...c, status: 'running' } : c)));
    const abort = new AbortController();
    aborts.current.set(id, abort);
    void (async () => {
      try {
        await svc.send(
          id,
          {
            text,
            attachments: attachments.map((a) => a.id),
            model: settingsNow.model,
            effort: effortToSend(info, settingsNow.model, settingsNow.effort),
            run_budget_usd: settingsNow.run_budget_usd,
            approve_plans: settingsNow.approve_plans,
            // Sent only when the person changed the chat's servers; left out, the chat keeps its saved list.
            ...(mcpProblem || !mcpChanged.current.has(id)
              ? {}
              : { mcp_servers: chatMcp(settingsNow.mcp_servers, mcp) }),
          },
          (e) => apply(id, e),
          abort.signal,
        );
        setLive((m) =>
          m[id] ? { ...m, [id]: endWithError(m[id], 'The connection closed before the turn finished.') } : m,
        );
      } catch (err) {
        const stopped = aborted(err) || abort.signal.aborted;
        setLive((m) =>
          m[id]
            ? {
                ...m,
                [id]: stopped
                  ? reduceTurn(m[id], {
                      type: 'done',
                      ts: Date.now(),
                      stopped: 'stopped',
                      cost_usd: m[id].costUsd,
                      text: m[id].text,
                    })
                  : endWithError(m[id], message(err)),
              }
            : m,
        );
        // A refused send (no sandbox, already running, bad input) puts the attachments back for another try.
        if (err instanceof ApiError && (err.status === 400 || err.status === 409 || err.status === 429))
          setPending((m) => ({ ...m, [id]: [...attachments, ...(m[id] ?? [])] }));
      } finally {
        aborts.current.delete(id);
        sending.current.delete(id);
        await loadChat(id);
        await refreshChats();
        void refreshRecent();
        // The stored turn now holds the same content; keep a failed send visible only if nothing was stored.
        setLive((m) => {
          const t = m[id];
          if (!t) return m;
          const { [id]: _done, ...rest } = m;
          return t.turnId ? rest : m;
        });
      }
    })();
    return true;
  };

  const stop = () => {
    if (!currentId) return;
    const t = live[currentId];
    if (t?.runId) svc.stop(t.runId).catch(() => undefined);
    aborts.current.get(currentId)?.abort();
  };

  const approve = async (decision: 'approve' | 'reject', steps?: PlanStep[], noteText?: string) => {
    if (!currentId) return;
    const t = live[currentId];
    if (!t?.runId || !t.approval) return;
    try {
      await svc.approve({ run_id: t.runId, approval_id: t.approval.approvalId, decision, steps, note: noteText });
      setLive((m) => (m[currentId] ? { ...m, [currentId]: { ...m[currentId], approval: null } } : m));
    } catch (err) {
      setProblems([message(err)]);
    }
  };

  const answerTool = async (approvalId: string, decision: 'approve' | 'reject') => {
    if (!currentId) return;
    const t = live[currentId];
    if (!t?.runId) return;
    try {
      await svc.approve({ run_id: t.runId, approval_id: approvalId, decision });
      setLive((m) => (m[currentId] ? { ...m, [currentId]: answeredTool(m[currentId], approvalId) } : m));
    } catch (err) {
      setProblems([message(err)]);
    }
  };

  const compact = async () => {
    if (!currentId) return;
    setNote('Compacting the history…');
    try {
      const r = await svc.compact(currentId);
      setNote(
        r.compacted
          ? `Compacted: ${r.tokens_before.toLocaleString('en-GB')} to ${r.tokens_after.toLocaleString('en-GB')} tokens.`
          : 'Nothing to compact yet: the history is still short.',
      );
      await loadChat(currentId);
    } catch (err) {
      setNote(message(err));
    }
  };

  const rename = async (id: string, title: string) => {
    try {
      const c = await svc.rename(id, title);
      setChats((list) => list.map((x) => (x.id === id ? c : x)));
      setCache((m) => (m[id] ? { ...m, [id]: { ...m[id], title: c.title } } : m));
    } catch (err) {
      setProblem(message(err));
    }
  };

  const remove = async (id: string) => {
    try {
      await svc.remove(id);
      setChats((list) => list.filter((c) => c.id !== id));
      setCache(({ [id]: _gone, ...rest }) => rest);
      setRecent((list) => list.filter((r) => r.chat_id !== id));
      if (id === currentId) open(null);
    } catch (err) {
      setProblem(message(err));
    }
  };

  const openFile = (f: AssistantFile, all: AssistantFile[] = [f]) => {
    setViewer((v) => {
      const tabs = v ? [...v.files] : [];
      for (const x of [f, ...all.filter((a) => a.id !== f.id)].slice(0, 6))
        if (!tabs.some((t) => t.id === x.id || t.name === x.name)) tabs.push(x);
        else if (x.id === f.id)
          tabs.splice(
            tabs.findIndex((t) => t.name === x.name),
            1,
            x,
          );
      return { files: tabs.slice(-8), active: f.id };
    });
  };

  const openRecent = (r: RecentFile) => {
    open(r.chat_id);
    setViewer({ files: [r.file], active: r.file.id });
  };

  // The turns to show: the stored ones, then the live one unless it has already been stored.
  const turns: { key: string; t: TurnState; live: boolean }[] = useMemo(() => {
    const stored = (chat?.turns ?? [])
      .filter((s) => s.id !== liveTurn?.turnId)
      .map((s) => ({ key: s.id, t: fromStored(s), live: false }));
    return liveTurn ? [...stored, { key: liveTurn.turnId ?? 'live', t: liveTurn, live: true }] : stored;
  }, [chat, liveTurn]);

  /** Loads a stored turn's saved log, once, when its work is first shown. */
  const loadLog = useCallback(
    (turnKey: string) => {
      if (!currentId) return;
      const key = `${currentId}:${turnKey}`;
      const stored = chat?.turns.find((s) => s.id === turnKey);
      if (!stored || logs[key]) return;
      setLogs((m) => ({ ...m, [key]: { lanes: [], loading: true, error: null } }));
      svc.log(currentId, turnKey).then(
        (events) =>
          setLogs((m) => ({ ...m, [key]: { lanes: fromStored(stored, events).lanes, loading: false, error: null } })),
        (err) => setLogs((m) => ({ ...m, [key]: { lanes: [], loading: false, error: message(err) } })),
      );
    },
    [currentId, chat, logs],
  );

  const workFor = (key: string, t: TurnState, isLive: boolean): Work | undefined =>
    isLive ? { lanes: t.lanes, loading: false, error: null } : currentId ? logs[`${currentId}:${key}`] : undefined;

  const lastTurn = turns[turns.length - 1];
  useEffect(() => {
    if (drawer && lastTurn && !lastTurn.live) loadLog(lastTurn.key);
  }, [drawer, lastTurn, loadLog]);

  // Follows the reply as it streams while the reader is at the bottom; scrolling up to read stops the jump.
  const streamLength = liveTurn ? liveTurn.text.length + liveTurn.lanes.length + liveTurn.files.length : 0;
  useEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [streamLength, turns.length, currentId]);

  const sandboxDown = info && !info.sandbox.available ? info.sandbox.message || 'The sandbox is not running.' : null;
  const blocked = sandboxDown ?? (elsewhere ? 'This chat is working in another tab or window.' : null);
  const enabledMcp = current ? chatMcp(current.mcp_servers, mcp) : [];

  const composer =
    info && current ? (
      <Composer
        info={info}
        settings={current}
        onSettings={setCurrent}
        text={draft}
        onText={setDraft}
        attachments={pending[currentId ?? ''] ?? []}
        uploading={uploading}
        problems={problems}
        onPick={(f) => void pick(f)}
        onRemove={(fid) => setPending((m) => ({ ...m, [draftKey]: (m[draftKey] ?? []).filter((a) => a.id !== fid) }))}
        onSend={send}
        onStop={stop}
        running={runningNow}
        blocked={blocked}
        mcp={{ servers: mcp, enabled: enabledMcp }}
        mcpProblem={mcpProblem}
        onManageMcp={() => setMcpOpen(true)}
        hero={!currentId}
      />
    ) : null;

  const drawerWork: Work | undefined = lastTurn ? workFor(lastTurn.key, lastTurn.t, lastTurn.live) : undefined;
  const style = { '--nav-h': `${navHeight}px` } as CSSProperties;

  return (
    <main
      className={`page-assistant${side ? ' side-open' : ''}${viewer ? ' viewing' : ''}${drawer ? ' drawer-open' : ''}`}
      style={style}
    >
      {side && <div className="as-scrim" onClick={() => setSide(false)} aria-hidden="true" />}
      <Sidebar
        chats={chats}
        current={currentId}
        running={runningHere}
        filesOpen={view === 'files'}
        onNew={() => open(null)}
        onOpen={(id) => open(id)}
        onFiles={() => {
          setView('files');
          setViewer(null);
          void refreshRecent();
          if (narrow()) setSide(false);
        }}
        onRename={rename}
        onDelete={remove}
        onHide={() => setSide(false)}
      />

      <section className="as-main" aria-label={view === 'files' ? 'Files' : 'Conversation'}>
        <header className="as-head">
          {!side && (
            <button type="button" className="as-iconbtn" onClick={() => setSide(true)} aria-label="Show the sidebar">
              <Icon name="side" />
            </button>
          )}
          {!side && (
            <button type="button" className="as-iconbtn" onClick={() => open(null)} aria-label="New chat">
              <Icon name="new" />
            </button>
          )}
          <h2 className="as-head-title">{view === 'files' ? 'Files' : (chat?.title ?? '')}</h2>
          <span className="as-grow" />
          {view === 'chat' && chat && <span className="as-head-cost">{dollars(chat.cost_usd)}</span>}
          {view === 'chat' && currentId && (
            <button
              type="button"
              className="as-ghost"
              onClick={() => void compact()}
              disabled={runningNow || elsewhere}
              title="Summarise older turns now"
            >
              Compact
            </button>
          )}
          {view === 'chat' && turns.length > 0 && (
            <button
              type="button"
              className={`as-ghost${drawer ? ' on' : ''}`}
              onClick={() => setDrawer((d) => !d)}
              aria-expanded={drawer}
            >
              <Icon name="activity" />
              Activity
              {runningNow && <span className="as-live-dot" aria-label="running" />}
            </button>
          )}
        </header>

        {problem && (
          <p className="as-banner bad" role="alert">
            {problem}
            <button type="button" className="as-ghost" onClick={() => setProblem(null)}>
              Dismiss
            </button>
          </p>
        )}
        {sandboxDown && <p className="as-banner">{sandboxDown}</p>}
        {note && <p className="as-banner subtle">{note}</p>}

        {view === 'files' ? (
          <div className="as-scroll">
            <FilesView recent={recent} problem={recentProblem} onOpenRecent={openRecent} />
          </div>
        ) : !currentId ? (
          <div className="as-scroll center">
            {info && current ? (
              <Welcome
                composer={composer}
                recent={recent}
                onExample={(p) => {
                  setDraft(p);
                  window.setTimeout(() => document.getElementById('as-text-hero')?.focus(), 0);
                }}
                onOpenRecent={openRecent}
              />
            ) : (
              !problem && <p className="as-loading">Loading…</p>
            )}
          </div>
        ) : (
          <>
            <div
              className="as-scroll"
              ref={scroller}
              onScroll={() => {
                const el = scroller.current;
                if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
            >
              <div className="as-thread">
                {elsewhere && (
                  <p className="as-banner subtle">
                    This chat is working in another tab or window. This view updates every few seconds.
                  </p>
                )}
                {!chat && !liveTurn && <p className="as-loading">Loading the chat…</p>}
                {turns.map(({ key, t, live: isLive }) => (
                  <Message
                    key={key}
                    t={t}
                    live={isLive}
                    openFile={viewer?.active ?? null}
                    onOpenFile={openFile}
                    onApprove={approve}
                    onTool={answerTool}
                    work={workFor(key, t, isLive)}
                    onWork={(show) => {
                      if (show && !isLive) loadLog(key);
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="as-dock">{composer}</div>
          </>
        )}
      </section>

      {viewer && (
        <FileViewer
          files={viewer.files}
          active={viewer.active}
          onActivate={(id) => setViewer((v) => (v ? { ...v, active: id } : v))}
          onCloseTab={(id) =>
            setViewer((v) => {
              if (!v) return v;
              const files = v.files.filter((f) => f.id !== id);
              if (!files.length) return null;
              return { files, active: v.active === id ? files[files.length - 1].id : v.active };
            })
          }
          onClose={() => setViewer(null)}
        />
      )}

      {/* Always in the page so it can slide out as well as in; hidden from keyboard and screen readers when shut. */}
      {
        <aside className="as-drawer" aria-label="Activity" aria-hidden={!drawer}>
          <div className="as-drawer-head">
            <h2>Activity</h2>
            <span className="as-drawer-sub">{lastTurn?.live && runningNow ? 'Live' : 'Latest turn'}</span>
            <span className="as-grow" />
            <button type="button" className="as-iconbtn" onClick={() => setDrawer(false)} aria-label="Close activity">
              <Icon name="close" />
            </button>
          </div>
          <Activity
            lanes={drawerWork?.lanes ?? []}
            loading={drawerWork?.loading}
            error={drawerWork?.error}
            empty="Each step the agent takes appears here as it happens."
          />
        </aside>
      }

      {mcpOpen && <McpDialog servers={mcp} onServers={setMcp} onClose={() => setMcpOpen(false)} />}
    </main>
  );
}
