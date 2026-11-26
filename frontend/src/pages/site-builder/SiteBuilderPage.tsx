import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useSearchParams } from 'react-router';
import { isLocalModel, modelName, modelNameStart } from '@/lib/models';
import { useNavHeight } from '@/lib/useNavHeight';
import { statusService, type LiveStatus } from '@/services';
import { sitesService, type SiteSummary } from '@/services/sitesService';
import { AppPane } from './AppPane';
import { clampSplit, fixPrompt, type PreviewError } from './model';
import { SiteTurnView } from './SiteTurnView';
import { StartScreen } from './StartScreen';
import { useSiteChat } from './useSiteChat';
import './site-builder.css';

/**
 * The site builder: describe an app, and the model writes it into a folder on this server while it runs live beside
 * the conversation. Each message changes the same app; each change is a version you can view or restore.
 */
export default function SiteBuilderPage() {
  const navHeight = useNavHeight();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [model, setModel] = useState('');
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [screenshots, setScreenshots] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [split, setSplit] = useState(420); // the chat pane's width
  const [tab, setTab] = useState<'chat' | 'app'>('chat'); // on phones, one pane at a time
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const chat = useSiteChat(model);
  const log = useRef<HTMLDivElement>(null);
  const studio = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // keep the newest message in view, unless you scrolled up to read
  const showVersion = useRef<(n: number) => void>(() => undefined);

  const refreshSites = useCallback(() => {
    sitesService
      .list()
      .then((r) => {
        setSites(r.sites);
        setScreenshots(r.screenshots);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let alive = true;
    statusService.status().then((s) => {
      if (!alive) return;
      setStatus(s);
      setModel(s.default_model ?? '');
      if (s.available) refreshSites();
    });
    return () => {
      alive = false;
    };
  }, [refreshSites]);

  // The address says which site is open; a site created by the first message goes into the address.
  const wanted = params.get('site');
  const { open, siteId } = chat;
  const shown = useRef<string | null | undefined>(undefined);
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  useEffect(() => {
    if (wanted === shown.current) return;
    shown.current = wanted;
    void open(wanted);
  }, [wanted, open]);
  useEffect(() => {
    if (!siteId || siteId === shown.current) return;
    shown.current = siteId;
    setParamsRef.current({ site: siteId }, { replace: true });
  }, [siteId]);

  useEffect(() => {
    if (!chat.running) refreshSites();
  }, [chat.running, refreshSites]);

  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.turns]);

  const ready = !!(status?.available && status.has_credentials);
  const send = (text: string) => {
    const t = text.trim();
    if (!ready || chat.running || !t) return;
    stick.current = true;
    setPrompt('');
    void chat.send(t);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(prompt);
    }
  };
  const askFix = (errors: PreviewError[]) => {
    setTab('chat');
    send(fixPrompt(errors));
  };

  // The divider: dragging it sets the chat pane's width, within limits that keep both panes usable.
  const drag = useRef(false);
  const onDividerDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDividerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !studio.current) return;
    const box = studio.current.getBoundingClientRect();
    setSplit(clampSplit(e.clientX - box.left, box.width));
  };
  const onDividerKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const total = studio.current?.getBoundingClientRect().width ?? 1200;
    if (e.key === 'ArrowLeft') setSplit((s) => clampSplit(s - 40, total));
    if (e.key === 'ArrowRight') setSplit((s) => clampSplit(s + 40, total));
  };

  const note =
    status === null
      ? 'Checking the lab backend…'
      : !ready
        ? status.reason
        : (isLocalModel(model)
            ? 'Local model: runs on this machine at no cost.'
            : `Spends real credit: about $${(status.spent_usd ?? 0).toFixed(2)} of $${(status.budget_usd ?? 0).toFixed(2)} used.`) +
          (screenshots ? '' : ` No Chrome was found, so ${modelName(model)} will not see screenshots of its work.`);

  const modelPicker = (
    <select
      className="sb-model"
      aria-label="Model"
      value={model}
      onChange={(e) => setModel(e.target.value)}
      disabled={!ready || chat.running}
    >
      {status?.models?.length ? (
        status.models.map((m) => (
          <option key={m} value={m}>
            {modelNameStart(m)}
          </option>
        ))
      ) : (
        <option value="">{status === null ? 'Loading…' : 'No backend'}</option>
      )}
    </select>
  );

  const open_ = !!chat.siteId || chat.turns.length > 0;
  return (
    <main className="page-sites" style={{ '--nav-h': `${navHeight}px` } as CSSProperties}>
      {!open_ ? (
        <StartScreen
          sites={sites}
          ready={ready}
          note={
            <>
              {note}
              {chat.problem && <span className="sb-problem"> {chat.problem}</span>}
            </>
          }
          modelPicker={modelPicker}
          onStart={(text) => send(text)}
          onOpen={(id) => setParams({ site: id })}
          onRename={(id, title) => void sitesService.rename(id, title).then(refreshSites, () => undefined)}
          onDelete={(id) => void sitesService.delete(id).then(refreshSites, (err: Error) => window.alert(err.message))}
        />
      ) : (
        <div className={`sb-studio tab-${tab}`} ref={studio} style={{ '--split': `${split}px` } as CSSProperties}>
          <div className="sb-tabs-phone" role="tablist" aria-label="Pane">
            <button
              role="tab"
              aria-selected={tab === 'chat'}
              className={tab === 'chat' ? 'on' : ''}
              onClick={() => setTab('chat')}
            >
              Chat
            </button>
            <button
              role="tab"
              aria-selected={tab === 'app'}
              className={tab === 'app' ? 'on' : ''}
              onClick={() => setTab('app')}
            >
              App
            </button>
          </div>

          <section className="sb-chatpane" aria-label="Conversation">
            <header className="sb-chathead">
              <button
                className="sb-back"
                onClick={() => setParams({})}
                disabled={chat.running}
                title="All apps"
                aria-label="All apps"
              >
                ←
              </button>
              {titleDraft !== null ? (
                <form
                  className="sb-titleform"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void chat.rename(titleDraft);
                    setTitleDraft(null);
                  }}
                >
                  <input
                    aria-label="Title"
                    value={titleDraft}
                    maxLength={80}
                    autoFocus
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={() => setTitleDraft(null)}
                  />
                </form>
              ) : (
                <button
                  className="sb-title"
                  onClick={() => chat.siteId && setTitleDraft(chat.title)}
                  title="Rename"
                  disabled={!chat.siteId}
                >
                  {chat.title || 'New app'}
                </button>
              )}
            </header>

            <div
              ref={log}
              className="sb-log"
              onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
              }}
            >
              {chat.busyElsewhere && (
                <div className="sb-note-line">
                  This app is being changed in another tab. Its result appears when you reopen it.
                </div>
              )}
              {chat.turns.map((t) => (
                <SiteTurnView
                  key={t.id}
                  turn={t}
                  siteId={chat.siteId}
                  onShowVersion={
                    chat.running
                      ? undefined
                      : (n) => {
                          setTab('app');
                          showVersion.current(n);
                        }
                  }
                />
              ))}
            </div>

            <div className="sb-composer">
              {chat.problem && <div className="small sb-problem">{chat.problem}</div>}
              <label className="sr-only" htmlFor="sb-prompt">
                Ask for a change
              </label>
              <textarea
                id="sb-prompt"
                rows={2}
                value={prompt}
                placeholder="Ask for a change, such as “make the header sticky”"
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={onKey}
                disabled={!ready}
              />
              <div className="sb-composebar">
                {modelPicker}
                <span className="small muted sb-hint">Enter to send · Shift+Enter for a new line</span>
                <span className="spacer" />
                {chat.running ? (
                  <button className="sb-send stop" onClick={chat.stop} aria-label="Stop">
                    ■
                  </button>
                ) : (
                  <button
                    className="sb-send"
                    onClick={() => send(prompt)}
                    disabled={!ready || !prompt.trim() || chat.busyElsewhere}
                    aria-label="Send"
                  >
                    ↑
                  </button>
                )}
              </div>
            </div>
          </section>

          <div
            className="sb-divider"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the panes"
            aria-valuenow={split}
            tabIndex={0}
            onPointerDown={onDividerDown}
            onPointerMove={onDividerMove}
            onPointerUp={() => (drag.current = false)}
            onPointerCancel={() => (drag.current = false)}
            onKeyDown={onDividerKey}
          />

          <AppPaneWithVersion
            chat={chat}
            model={model}
            onAskFix={askFix}
            register={(fn) => (showVersion.current = fn)}
          />
        </div>
      )}
    </main>
  );
}

/** The app pane, with a hook so a version chip in the conversation can show that version. */
function AppPaneWithVersion({
  chat,
  model,
  onAskFix,
  register,
}: {
  chat: ReturnType<typeof useSiteChat>;
  model: string;
  onAskFix: (errors: PreviewError[]) => void;
  register: (fn: (n: number) => void) => void;
}) {
  const [want, setWant] = useState<number | null>(null);
  useEffect(() => register((n) => setWant(n)), [register]);
  return (
    <AppPane
      siteId={chat.siteId}
      title={chat.title}
      files={chat.files}
      versions={chat.versions}
      live={chat.live}
      drafts={chat.drafts}
      reload={chat.reload}
      running={chat.running}
      model={model}
      onRestore={(n) => void chat.restoreVersion(n)}
      onAskFix={onAskFix}
      showVersion={want}
      onShownVersion={() => setWant(null)}
    />
  );
}
