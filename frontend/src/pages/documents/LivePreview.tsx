import { useEffect, useRef, useState } from 'react';
import { documentsService, type Answers } from '@/services';

/**
 * The document as the answers stand, updated a moment after each change. It uses the same
 * assembly as the real document (no AI), so what you see is what you will get. Filled values are
 * highlighted, newly filled ones briefly, and empty fields show as [their question].
 */
export function LivePreview({ templateId, answers }: { templateId: string; answers: Answers }) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState('');
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const previous = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(() => {
      documentsService
        .preview(templateId, answers)
        .then((r) => {
          if (!alive) return;
          const values = new Set([...r.text.matchAll(/⟦([^?⟧][^⟧]*)⟧/g)].map((m) => m[1]));
          setFresh(new Set([...values].filter((v) => !previous.current.has(v))));
          previous.current = values;
          setText(r.text);
          setProblem('');
        })
        .catch((err: Error) => alive && setProblem(err.message));
    }, 350);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [templateId, answers]);

  const parts = text.split(/(⟦[^⟧]*⟧)/g);
  const empty = parts.filter((p) => p.startsWith('⟦?')).length;
  return (
    <aside className="dc-live">
      <div className="dc-live-head">
        <b>Live preview</b>
        <span className="small muted">{text ? (empty ? `${empty} gap${empty === 1 ? '' : 's'} to fill` : 'Every field is filled') : 'Loading…'}</span>
      </div>
      {problem && <div className="small dc-problem">{problem}</div>}
      <div className="dc-paper dc-live-paper">
        {parts.map((part, i) => {
          if (!part.startsWith('⟦')) return part;
          const inner = part.slice(1, -1);
          if (inner.startsWith('?')) {
            return (
              <span key={i} className="dc-gap" title="Not answered yet">
                [{inner.slice(1)}]
              </span>
            );
          }
          return (
            <mark key={`${i}-${inner}`} className={`dc-filled ${fresh.has(inner) ? 'fresh' : ''}`}>
              {inner}
            </mark>
          );
        })}
      </div>
    </aside>
  );
}
