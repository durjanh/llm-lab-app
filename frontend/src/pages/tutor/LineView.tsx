import type { TutorFeedback } from '@/services';
import { Markdown } from './Markdown';
import { Practice, Scores } from './Practice';
import type { Heard } from './speech';
import type { Line } from './useTutor';

interface Props {
  line: Line;
  practise: (sentence: string) => Promise<Heard | null>;
  hear: (text: string) => Promise<void>;
  canPractise: boolean;
  onSave: (word: TutorFeedback['vocabulary'][number]) => void;
}

// Say-it-again listens for one sentence at a time, so longer model answers can be heard but not scored.
const PRACTISE_MAX_WORDS = 35;

/** One message: the learner's, with its pronunciation and feedback, or the tutor's, spoken and written. */
export function LineView({ line, practise, hear, canPractise, onSave }: Props) {
  if (line.role === 'assistant') {
    const waiting = line.state === 'streaming' && !line.text && !line.written;
    return (
      <div className={`tu-tutor ${line.state ?? ''}`}>
        {waiting ? <span className="small muted">Thinking…</span> : line.text && <div className="tu-said">{line.text}</div>}
        {line.written && (
          <div className="tu-board">
            <Markdown text={line.written} />
          </div>
        )}
        {line.error && <div className="small tu-problem">{line.error}</div>}
        {line.state === 'stopped' && <div className="small muted">Stopped.</div>}
      </div>
    );
  }
  const f = line.feedback;
  return (
    <div className="tu-learner">
      <div className="tu-me">
        {line.images?.map((img, i) => (
          <a key={i} href={img.url} target="_blank" rel="noreferrer">
            <img src={img.url} alt="A picture you shared" />
          </a>
        ))}
        {line.text && <div>{line.spoken ? `🎤 ${line.text}` : line.text}</div>}
      </div>
      {line.spoken && line.pronunciation && (
        <details className="tu-card">
          <summary className="small">Pronunciation{line.pronunciation.overall != null && `: ${Math.round(line.pronunciation.overall)} / 100`}</summary>
          <Scores scores={line.pronunciation} />
        </details>
      )}
      {f && (f.better_answer || f.add?.length > 0) && (
        <div className="tu-card tu-better">
          {f.better_answer && (
            <>
              <div className="small muted">A stronger answer</div>
              <p>{f.better_answer}</p>
              <div className="row tu-better-actions">
                <button className="btn small" disabled={!canPractise} onClick={() => void hear(f.better_answer)}>
                  🔊 Hear it
                </button>
                {f.better_answer.split(/\s+/).length <= PRACTISE_MAX_WORDS && (
                  <Practice sentence={f.better_answer} practise={practise} disabled={!canPractise} />
                )}
              </div>
            </>
          )}
          {f.add?.length > 0 && (
            <>
              <div className="small muted">You could add</div>
              <ul>
                {f.add.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {f && (f.corrections.length > 0 || f.vocabulary.length > 0 || f.tip || f.praise) && (
        <div className="tu-card">
          {f.praise && <p className="tu-praise">👍 {f.praise}</p>}
          {f.corrections.map((c, i) => (
            <div key={i} className="tu-fix">
              <div>
                <s>{c.original}</s> → <b>{c.better}</b>
              </div>
              <div className="small muted">{c.why}</div>
              <Practice sentence={c.better} practise={practise} disabled={!canPractise} />
            </div>
          ))}
          {f.vocabulary.length > 0 && (
            <div className="tu-vocab">
              {f.vocabulary.map((v, i) => (
                <div key={i}>
                  <b>{v.term}</b>: {v.meaning} <i className="muted">“{v.example}”</i>{' '}
                  <button className="link-btn small" onClick={() => onSave(v)}>
                    Save
                  </button>
                </div>
              ))}
            </div>
          )}
          {f.tip && <p className="small">💡 {f.tip}</p>}
          {f.level !== 'unknown' && <p className="small muted">This sounds like level {f.level}.</p>}
        </div>
      )}
      {line.feedbackError && <div className="small muted">No feedback this time: {line.feedbackError}</div>}
    </div>
  );
}
