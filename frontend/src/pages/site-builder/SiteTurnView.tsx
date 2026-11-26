import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { modelNameStart } from '@/lib/models';
import { sitesService, type SiteShot } from '@/services/sitesService';
import { changeSummary, type Turn } from './model';

const ICON = { request: '◆', write: '✎', read: '⌕', check: '◉', error: '!' } as const;
const STATUS = {
  running: '{who} is building…',
  done: '',
  stopped: 'Stopped. Files already saved are kept.',
  error: 'Something went wrong.',
} as const;

/** One message and the model's work on it: what it said, the files it changed, its steps and the screenshots it saw. */
export function SiteTurnView({
  turn,
  siteId,
  onShowVersion,
}: {
  turn: Turn;
  siteId: string | null;
  onShowVersion?: (n: number) => void;
}) {
  if (turn.kind === 'restore') {
    return (
      <div className="sb-note-line" role="note">
        <span>{turn.reply}</span>
        {turn.version !== null && <span className="sb-vchip">v{turn.version}</span>}
      </div>
    );
  }
  const writes = turn.steps.filter((s) => s.kind === 'write').length;
  const status = turn.error ?? STATUS[turn.state].replace('{who}', modelNameStart(turn.model));
  const text = turn.state === 'running' && turn.draft ? turn.draft : turn.reply;
  return (
    <article className="sb-turn">
      <div className="sb-user">{turn.prompt}</div>
      <div className={`sb-reply ${turn.state}`}>
        <div className="sb-avatar" aria-hidden="true" />
        <div className="sb-reply-body">
          {status && (
            <div className={`small sb-status ${turn.state}`}>
              {turn.state === 'running' && <span className="spinner" aria-hidden="true" />} {status}
            </div>
          )}
          {text && (
            <div className="sb-text" aria-live={turn.state === 'running' ? 'polite' : undefined}>
              <Reply text={text} />
            </div>
          )}
          {(turn.changed.length > 0 || turn.version !== null) && (
            <div className="sb-changed">
              <span className="sb-changed-sum">{changeSummary(turn.changed)}</span>
              {turn.version !== null && (
                <button
                  className="sb-vchip"
                  onClick={() => onShowVersion?.(turn.version as number)}
                  title="Show this version"
                  disabled={!onShowVersion}
                >
                  v{turn.version}
                </button>
              )}
              {turn.changed.length > 0 && (
                <ul className="sb-changed-list">
                  {turn.changed.map((c) => (
                    <li key={c.path} className={`c-${c.change}`}>
                      <span className="sb-ch">{c.change === 'added' ? '+' : c.change === 'deleted' ? '−' : '~'}</span>
                      {c.path}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {turn.snapshotError && <div className="small sb-problem">{turn.snapshotError}</div>}
          {turn.steps.length > 0 && (
            <details className="sb-work" open={turn.state === 'running'}>
              <summary className="small">
                Show work · {turn.steps.length} steps{writes ? `, ${writes} file saves` : ''}
                {turn.cost !== undefined && ` · about $${turn.cost.toFixed(4)}`}
              </summary>
              <ol className="sb-steps">
                {turn.steps.map((s, i) => (
                  <li key={i} className={`k-${s.kind}`}>
                    <span className="sb-icon" aria-hidden="true">
                      {ICON[s.kind]}
                    </span>
                    <span>
                      <b>{s.text}</b>
                      {s.detail && <div className="detail">{s.detail}</div>}
                      {siteId && s.shots && s.shots.length > 0 && <Shots siteId={siteId} shots={s.shots} />}
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          )}
          {turn.steps.length === 0 && turn.cost !== undefined && turn.state === 'done' && (
            <div className="small muted">About ${turn.cost.toFixed(4)}</div>
          )}
        </div>
      </div>
    </article>
  );
}

/** Thumbnails of the screenshots the model was shown. Click one to open it full size. */
function Shots({ siteId, shots }: { siteId: string; shots: SiteShot[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    for (const shot of shots) {
      sitesService
        .shot(siteId, shot.file)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          made.push(url);
          if (alive) setUrls((u) => ({ ...u, [shot.file]: url }));
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
      made.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [siteId, shots]);

  return (
    <div className="sb-shots">
      {shots.map((s) =>
        urls[s.file] ? (
          <a
            key={s.file}
            href={urls[s.file]}
            target="_blank"
            rel="noreferrer"
            title={s.name}
            className={s.name.split('-')[0]}
          >
            <img src={urls[s.file]} alt={`Screenshot ${s.name}`} />
          </a>
        ) : (
          <span key={s.file} className={`sb-shot-wait ${s.name.split('-')[0]}`} aria-hidden="true" />
        ),
      )}
    </div>
  );
}

/** The model's reply as Markdown. react-markdown builds React elements and ignores raw HTML, so the text cannot
    inject markup; links open in a new tab. */
function Reply({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
