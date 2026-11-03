import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavHeight } from '@/lib/useNavHeight';
import { statusService, type LiveStatus } from '@/services';
import { Composer } from './Composer';
import { TurnView } from './TurnView';
import { useDeckChat } from './useDeckChat';
import './decks.css';

const SUGGESTIONS = [
  'Make a six-slide deck that explains prime numbers to a general audience, with one chart.',
  'Turn the attached report into a five-slide executive summary: headline, three findings, next steps.',
  'Using the attached template, make a project kick-off deck: goals, scope, timeline, team, risks.',
];

export default function DecksPage() {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [model, setModel] = useState('');
  const [suggestion, setSuggestion] = useState(SUGGESTIONS[0]);
  const { turns, running, send, stop, reset } = useDeckChat(model);
  const navHeight = useNavHeight();
  const log = useRef<HTMLDivElement>(null);
  const following = useRef(true); // keep the newest step in view, unless you scrolled up to read

  useEffect(() => {
    let alive = true;
    statusService.status().then((s) => {
      if (!alive) return;
      setStatus(s);
      setModel(s.default_model ?? '');
    });
    return () => {
      alive = false;
    };
  }, []);

  // Once a conversation starts, the page fills the window under the site nav: the message box stays on
  // screen and only the conversation scrolls.
  useEffect(() => {
    const el = log.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const onScroll = () => {
    const el = log.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const onSend = useCallback(
    (prompt: string, files: File[], template: File | null) => {
      following.current = true;
      window.scrollTo({ top: 0 });
      return send(prompt, files, template);
    },
    [send],
  );

  const ready = !!(status?.available && status.has_credentials);
  const chatting = turns.length > 0;
  return (
    <main className={`page-decks ${chatting ? 'chatting' : ''}`} style={{ '--nav-h': `${navHeight}px` } as CSSProperties}>
      <div className="kicker">Lab 19 · Deck builder</div>
      <h1>Ask Claude for a PowerPoint deck</h1>
      <p className="lede" hidden={chatting}>
        Describe the deck you want, attach the files it should be built from, and add your own <code>.pptx</code>{' '}
        template if you have one. Claude builds the deck with Anthropic's pptx skill in a code-execution container, then
        looks at every rendered slide and fixes spacing, alignment and overflow before you download a real PowerPoint
        file. Ask for changes in the same conversation: Claude edits the deck it already made and saves a new version.
      </p>

      <div className="row dk-bar">
        <label>
          Model{' '}
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!ready || running}>
            {status?.models?.length ? (
              status.models.map((m) => <option key={m}>{m}</option>)
            ) : (
              <option value="">{status === null ? 'Loading…' : 'No backend'}</option>
            )}
          </select>
        </label>
        <span className="small muted">
          {status === null
            ? 'Checking the lab backend…'
            : ready
              ? `Live: spends real credit (about $${(status.spent_usd ?? 0).toFixed(2)} of $${(status.budget_usd ?? 0).toFixed(2)} used).`
              : status.reason}
        </span>
        <span className="spacer" />
        <button className="btn" disabled={!turns.length} onClick={reset}>
          New deck
        </button>
      </div>

      {turns.length === 0 && (
        <div className="dk-start">
          <p className="small muted">Start from an idea, or write your own:</p>
          <div className="chips">
            {SUGGESTIONS.map((s) => (
              <button key={s} className={`chip-btn ${s === suggestion ? 'on' : ''}`} onClick={() => setSuggestion(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The conversation scrolls on its own above the message box, so nothing slides underneath it. */}
      <section className="dk-chat">
        {chatting && (
          <div ref={log} className="dk-transcript" onScroll={onScroll}>
            {turns.map((t) => (
              <TurnView key={t.id} turn={t} />
            ))}
          </div>
        )}
        <Composer disabled={!ready} running={running} hasTurns={turns.length > 0} suggestion={turns.length ? '' : suggestion}
          onSend={onSend} onStop={stop} />
      </section>

      <p className="small muted dk-notes" hidden={chatting}>
        Your files are uploaded to Anthropic's Files API so Claude can read them in its container. They delete themselves
        after a day, or straight away when you press New deck. The backend keeps the conversation in memory, so
        restarting it starts a new deck. The same skill runs from the terminal with{' '}
        <code>python python/12_agent_skills.py --skill pptx</code>.
      </p>
    </main>
  );
}
