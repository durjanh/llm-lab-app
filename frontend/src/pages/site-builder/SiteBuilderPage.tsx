import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useNavHeight } from '@/lib/useNavHeight';
import { sitesService, statusService, type LiveStatus, type SiteSummary } from '@/services';
import { SiteTurnView } from './SiteTurnView';
import { useSiteChat } from './useSiteChat';
import { Workspace } from './Workspace';
import './site-builder.css';

const SUGGESTIONS = [
  'A landing page for a small bakery: hero, menu with prices, opening hours and a contact form.',
  'A dashboard for a helpdesk team: ticket counts by month as a chart, and a filterable table of open tickets.',
  'A portfolio for a photographer, with a gallery that opens each photo larger, and an about page.',
];

export default function SiteBuilderPage() {
  const navHeight = useNavHeight();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [model, setModel] = useState('');
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [screenshots, setScreenshots] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [following, setFollowing] = useState(true);
  const chat = useSiteChat(model);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // keep the newest step in view, unless you scrolled up to read

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

  // The address says which site is open: changing it (the picker, New site, Back) opens that site, or a
  // blank one. A site created by sending a message goes into the address. `shown` records the last of
  // either, so neither effect undoes the other.
  const wanted = params.get('site');
  const { open, siteId } = chat;
  const shown = useRef<string | null | undefined>(undefined); // undefined: nothing opened yet
  // setParams changes identity with every address change; reading it from a ref keeps the effect
  // below to changes of the site itself, so it cannot put back a site the address just left.
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
  const text = prompt.trim() || (chat.turns.length ? '' : SUGGESTIONS[0]);

  function send() {
    if (!ready || chat.running || !text) return;
    stick.current = true;
    setFollowing(true);
    setPrompt('');
    void chat.send(text);
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
  };

  return (
    <main className="page-sites" style={{ '--nav-h': `${navHeight}px` } as CSSProperties}>
      <section className="sb-chat">
        <div className="kicker">Lab 20 · Site builder</div>
        <h1>{chat.title || 'Ask Claude for a website'}</h1>
        <div className="row sb-bar">
          <select
            aria-label="Site"
            value={chat.siteId ?? ''}
            disabled={chat.running}
            onChange={(e) => setParams(e.target.value ? { site: e.target.value } : {})}
          >
            <option value="">New site</option>
            {chat.siteId && !sites.some((s) => s.id === chat.siteId) && <option value={chat.siteId}>{chat.title.slice(0, 48)}</option>}
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title.slice(0, 48)}
              </option>
            ))}
          </select>
          <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} disabled={!ready || chat.running}>
            {status?.models?.length ? (
              status.models.map((m) => <option key={m}>{m}</option>)
            ) : (
              <option value="">{status === null ? 'Loading…' : 'No backend'}</option>
            )}
          </select>
          <button className="btn small" disabled={chat.running || !chat.siteId} onClick={() => setParams({})}>
            New site
          </button>
        </div>
        <p className="small muted sb-note">
          {status === null
            ? 'Checking the lab backend…'
            : !ready
              ? status.reason
              : `Live: spends real credit (about $${(status.spent_usd ?? 0).toFixed(2)} of $${(status.budget_usd ?? 0).toFixed(2)} used).` +
                (screenshots ? '' : ' No Chrome was found, so Claude will not see screenshots.')}
          {chat.problem && <span className="sb-problem"> {chat.problem}</span>}
        </p>

        <div
          ref={log}
          className="sb-log"
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {chat.turns.length === 0 ? (
            <div className="sb-intro">
              <p className="small">
                Describe a website. Claude writes its HTML, CSS, JavaScript and data files into a folder on your server, and
                you watch each file being written and the site appear on the right. When it has finished, the server screenshots
                the site at desktop and phone widths and Claude fixes what it sees. Then ask for changes.
              </p>
              <p className="small muted">Start from an idea, or write your own:</p>
              <div className="chips">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="chip-btn" onClick={() => setPrompt(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            chat.turns.map((t, i) => (
              <SiteTurnView key={t.id} turn={t} siteId={chat.siteId} onRestore={chat.running || !chat.siteId ? undefined : () => void chat.restore(i)} />
            ))
          )}
        </div>

        <div className="sb-composer card">
          <textarea
            rows={3}
            value={prompt}
            placeholder={chat.turns.length ? 'Ask for a change, such as "Make the header sticky"' : SUGGESTIONS[0]}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKey}
            disabled={!ready}
          />
          <div className="row">
            <span className="small muted">Ctrl or ⌘ + Enter to send</span>
            <span className="spacer" />
            {chat.running ? (
              <button className="btn" onClick={chat.stop}>
                Stop
              </button>
            ) : (
              <button className="btn primary" disabled={!ready || !text} onClick={send}>
                Send
              </button>
            )}
          </div>
        </div>
      </section>

      <Workspace
        siteId={chat.siteId}
        title={chat.title}
        files={chat.files}
        live={chat.live}
        drafts={chat.drafts}
        version={chat.version}
        following={following && chat.running}
        onTakeOver={() => setFollowing(false)}
      />
    </main>
  );
}
