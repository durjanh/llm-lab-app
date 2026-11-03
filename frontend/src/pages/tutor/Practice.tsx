import { useState } from 'react';
import type { PronunciationScores } from '@/services';
import type { Heard } from './speech';

/**
 * Say-it-again: the tutor says a sentence, the learner repeats it, and Azure scores each word
 * against it. Words are coloured by accuracy; left-out or extra words are marked.
 */
export function Practice({ sentence, practise, disabled }: { sentence: string; practise: (s: string) => Promise<Heard | null>; disabled: boolean }) {
  const [result, setResult] = useState<Heard | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setResult(await practise(sentence));
    setBusy(false);
  }

  return (
    <div className="tu-practice">
      <button className="btn small" disabled={disabled || busy} onClick={run} title="The tutor says it, then you repeat it">
        {busy ? 'Listen, then say it…' : result ? 'Try again' : '🎤 Say it again'}
      </button>
      {result && (result.text ? <Scores scores={result.pronunciation} heard={result.text} /> : <span className="small muted">Nothing was heard.</span>)}
    </div>
  );
}

export function Scores({ scores, heard }: { scores: PronunciationScores | null | undefined; heard?: string }) {
  if (!scores) return heard ? <div className="small muted">Heard: “{heard}”</div> : null;
  const parts = [
    ['Overall', scores.overall],
    ['Accuracy', scores.accuracy],
    ['Fluency', scores.fluency],
    ['Rhythm', scores.prosody],
    ['Complete', scores.completeness],
  ].filter(([, v]) => typeof v === 'number') as [string, number][];
  return (
    <div className="tu-scores">
      <div className="tu-words">
        {scores.words.map((w, i) => (
          <span
            key={i}
            className={`tu-word ${w.error === 'Omission' ? 'missed' : w.error === 'Insertion' ? 'extra' : band(w.accuracy)}`}
            title={`${w.word}: ${w.accuracy === null ? '–' : Math.round(w.accuracy)}${w.error && w.error !== 'None' ? ` · ${w.error}` : ''}`}
          >
            {w.word}
          </span>
        ))}
      </div>
      <div className="small muted">
        {parts.map(([name, v]) => `${name} ${Math.round(v)}`).join(' · ')}
        <span className="tu-key"> · green good, amber close, red practise this word</span>
      </div>
    </div>
  );
}

const band = (score: number | null) => (score === null ? '' : score >= 80 ? 'good' : score >= 60 ? 'fair' : 'poor');
