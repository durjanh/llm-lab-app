import type { ReactNode } from 'react';
import type { RecentFile } from '@/services/assistantService';
import { shortDate } from './helpers';
import { FileCard, Mark } from './parts';

/* The start screen and the Files view. The greeting and examples are the lab's own wording. */

export const EXAMPLES: { title: string; prompt: string }[] = [
  {
    title: 'Chart and a one-page PDF from a CSV',
    prompt:
      'Turn the attached CSV into a clear chart and a one-page PDF summary with three findings. Tell me which files you made.',
  },
  {
    title: 'A short deck from my notes',
    prompt: 'Make a five-slide deck from these notes: a title slide, three content slides and a next-steps slide.',
  },
  {
    title: 'Compare two documents',
    prompt:
      'Compare the two attached documents and list every difference that matters, as a table with page references.',
  },
  {
    title: 'Research and a brief',
    prompt:
      'Research the topic below on the web, cite your sources, and write a one-page brief as a Word document.\n\nTopic: ',
  },
];

function greeting(now: Date = new Date()): string {
  const h = now.getHours();
  if (h < 5) return 'Working late?';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function Welcome({
  composer,
  recent,
  onExample,
  onOpenRecent,
}: {
  composer: ReactNode;
  recent: RecentFile[];
  onExample: (prompt: string) => void;
  onOpenRecent: (r: RecentFile) => void;
}) {
  return (
    <div className="as-welcome">
      <div className="as-hello">
        <Mark size={44} />
        <h1>
          {greeting()}. <span>What shall we make?</span>
        </h1>
        <p>
          Ask a question, hand over a task, or drop in files. It plans first, works in a sandbox, and shows each step.
        </p>
      </div>
      {composer}
      <div className="as-examples" role="list" aria-label="Examples">
        {EXAMPLES.map((e) => (
          <button
            key={e.title}
            type="button"
            role="listitem"
            className="as-example"
            onClick={() => onExample(e.prompt)}
          >
            {e.title}
          </button>
        ))}
      </div>
      {recent.length > 0 && (
        <section className="as-recent" aria-label="Recent files">
          <h2>Recent files</h2>
          <div className="as-recent-row">
            {recent.slice(0, 6).map((r) => (
              <FileCard
                key={`${r.chat_id}:${r.file.id}`}
                file={r.file}
                subtitle={`${r.chat_title} · ${shortDate(r.created_at)}`}
                onOpen={() => onOpenRecent(r)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function FilesView({
  recent,
  problem,
  onOpenRecent,
}: {
  recent: RecentFile[];
  problem: string | null;
  onOpenRecent: (r: RecentFile) => void;
}) {
  return (
    <div className="as-filesview">
      <h1>Files</h1>
      <p className="as-sub">Everything the assistant has made, newest first. Open one to see it beside its chat.</p>
      {problem && <p className="as-note">{problem}</p>}
      {!problem && recent.length === 0 && <p className="as-note">No files yet. Ask for a chart, a PDF or a deck.</p>}
      <div className="as-filegrid">
        {recent.map((r) => (
          <FileCard
            key={`${r.chat_id}:${r.file.id}`}
            file={r.file}
            subtitle={`${r.chat_title} · ${shortDate(r.created_at)}`}
            onOpen={() => onOpenRecent(r)}
          />
        ))}
      </div>
    </div>
  );
}
