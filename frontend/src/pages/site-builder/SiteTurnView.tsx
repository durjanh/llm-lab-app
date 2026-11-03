import { useEffect, useState } from 'react';
import { sitesService, type SiteShot } from '@/services';
import type { Turn } from './useSiteChat';

const ICON = { request: 'C', write: '✎', read: '⌕', check: '◉', error: '!' } as const;
const STATUS = {
  running: 'Claude is building. You can watch each file in Code, and the site in Preview.',
  done: 'Done.',
  stopped: 'Stopped. Files Claude had already saved are kept.',
  error: 'Something went wrong.',
} as const;

/** One message and Claude's work on it: its steps, what it says, and the screenshots it was shown. */
export function SiteTurnView({ turn, siteId, onRestore }: { turn: Turn; siteId: string | null; onRestore?: () => void }) {
  const writes = turn.steps.filter((s) => s.kind === 'write').length;
  return (
    <div className="sb-turn">
      <div className="sb-user">{turn.prompt}</div>
      {onRestore && (
        <button
          className="sb-restore small"
          title="Undo this message and everything after it"
          onClick={() => {
            if (window.confirm('Put the site back as it was before this message? This message and the ones after it are undone; the current files are kept in a backup folder on the server.')) onRestore();
          }}
        >
          Restore to before this
        </button>
      )}
      <div className={`sb-claude ${turn.state}`}>
        <div className="small sb-status">
          {turn.state === 'running' && <span className="spinner" aria-hidden="true" />} {turn.error ?? STATUS[turn.state]}
          {turn.cost !== undefined && <span className="muted"> About ${turn.cost.toFixed(4)}.</span>}
        </div>
        {turn.steps.length > 0 && (
          <details open={turn.state === 'running'}>
            <summary className="small">
              {turn.steps.length} steps{writes ? `, ${writes} file changes` : ''}
            </summary>
            <ol className="sb-steps">
              {turn.steps.map((s, i) => (
                <li key={i} className={`k-${s.kind}`}>
                  <span className="sb-icon">{ICON[s.kind]}</span>
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
        {(turn.draft || turn.reply) && <div className="sb-reply">{turn.state === 'running' && turn.draft ? turn.draft : turn.reply}</div>}
      </div>
    </div>
  );
}

/** Thumbnails of the screenshots Claude was shown. Click one to open it full size. */
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
          <a key={s.file} href={urls[s.file]} target="_blank" rel="noreferrer" title={s.name} className={s.name.split('-')[0]}>
            <img src={urls[s.file]} alt={`Screenshot ${s.name}`} />
          </a>
        ) : (
          <span key={s.file} className={`sb-shot-wait ${s.name.split('-')[0]}`} aria-hidden="true" />
        ),
      )}
    </div>
  );
}
