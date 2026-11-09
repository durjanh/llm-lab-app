import { useState } from 'react';
import { modelNameStart, skillsPlace } from '@/lib/models';
import { decksService } from '@/services';
import { SlidePreviews } from './SlidePreviews';
import type { Turn } from './useDeckChat';

const ICON = { upload: '↑', request: 'C', step: 'W', output: 'T', says: 'M', review: '◉', error: '!' } as const;
const STATUS = {
  running: '{who} is working on the deck, then checks the rendered slides. This usually takes two to five minutes.',
  done: 'Done.',
  stopped: 'Stopped. Nothing from this message is kept, so you can send it again.',
  error: 'Something went wrong.',
} as const;

/** One message and the model's work on it: the steps where its code ran, its reply, and the decks to download. */
export function TurnView({ turn }: { turn: Turn }) {
  const [problem, setProblem] = useState('');

  async function download(id: string, name: string) {
    try {
      setProblem('');
      await decksService.download({ id, name });
    } catch (err) {
      setProblem(`Download failed: ${(err as Error).message}`);
    }
  }

  return (
    <div className="dk-turn">
      <div className="dk-user">
        <div>{turn.prompt}</div>
        {(turn.files.length > 0 || turn.template) && (
          <div className="chips">
            {turn.files.map((f) => (
              <span className="dk-chip" key={f}>
                {f}
              </span>
            ))}
            {turn.template && <span className="dk-chip template">Template: {turn.template}</span>}
          </div>
        )}
      </div>
      <div className={`dk-claude ${turn.state}`}>
        <div className="small dk-status">
          {turn.state === 'running' && <span className="spinner" aria-hidden="true" />} {turn.error ?? STATUS[turn.state].replace('{who}', modelNameStart(turn.model))}
          {turn.cost !== undefined && <span className="muted"> About ${turn.cost.toFixed(4)} in tokens{turn.model.startsWith('claude-') ? '; container time is billed separately' : ''}.</span>}
        </div>
        {turn.steps.length > 0 && (
          <details open={turn.state === 'running'}>
            <summary className="small">
              {turn.steps.length} steps in {skillsPlace(turn.model)}
            </summary>
            <ol className="dk-steps">
              {turn.steps.map((s, i) => (
                <li key={i} className={`k-${s.kind}`}>
                  <span className="dk-icon">{ICON[s.kind]}</span>
                  <span>
                    <b>{s.text}</b>
                    {s.detail && <div className="detail">{s.detail}</div>}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        )}
        {turn.reply && turn.state !== 'running' && <div className="dk-reply">{turn.reply}</div>}
        {turn.checked && <SlidePreviews deck={turn.checked.deck} slides={turn.checked.slides} />}
        {turn.decks.length > 0 && (
          <div className="row dk-files">
            {turn.decks.map((f) => (
              <button className="btn primary" key={f.id} onClick={() => download(f.id, f.name)}>
                Download {f.name}
                {f.size_bytes ? ` (${Math.max(1, Math.round(f.size_bytes / 1024))} KB)` : ''}
              </button>
            ))}
          </div>
        )}
        {problem && <div className="small dk-problem">{problem}</div>}
      </div>
    </div>
  );
}
