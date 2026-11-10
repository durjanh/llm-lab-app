import { useDeferredValue, useMemo, useState, type CSSProperties } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useNavHeight } from '@/lib/useNavHeight';
import essentials from './content/essentials.md?raw';
import foundations from './content/foundations.md?raw';
import building from './content/building.md?raw';
import azure from './content/azure.md?raw';
import quality from './content/quality.md?raw';
import './bible.css';

interface Section {
  id: string;
  title: string;
  /** The lab page this section is about, when it is about one. */
  route: string | null;
  body: string;
}

interface Part {
  id: string;
  title: string;
  blurb: string;
  sections: Section[];
}

const SOURCES: [string, string, string, string][] = [
  [
    'essentials',
    'The essentials',
    'The questions that come up whatever the page: sampling, saving tokens, production, running a model locally.',
    essentials,
  ],
  ['foundations', 'Foundations', 'How models are built, trained and run.', foundations],
  ['building', 'Building with LLMs', 'Prompts, retrieval, agents, harnesses and the tools built on them.', building],
  ['azure', 'Building on Azure', 'Foundry, Azure AI services and the agents that use them.', azure],
  ['quality', 'Quality, safety, cost and operations', 'Measuring, guarding and paying for it all.', quality],
];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Splits a Markdown file into its "## " sections, reading the page route from headings like "Title (`/route`)". */
function parse(id: string, text: string): Section[] {
  const out: Section[] = [];
  for (const chunk of text.split(/^## /m).slice(1)) {
    const nl = chunk.indexOf('\n');
    const heading = (nl < 0 ? chunk : chunk.slice(0, nl)).trim();
    const m = heading.match(/^(.*?)\s*\(`(\/[^`]*)`\)$/);
    const title = m ? m[1] : heading;
    out.push({ id: `${id}-${slug(title)}`, title, route: m ? m[2] : null, body: nl < 0 ? '' : chunk.slice(nl + 1) });
  }
  return out;
}

const PARTS: Part[] = SOURCES.map(([id, title, blurb, text]) => ({ id, title, blurb, sections: parse(id, text) }));
const PAGE_COUNT = PARTS.flatMap((p) => p.sections).filter((s) => s.route).length;

/**
 * The lab in questions and answers: for every page, the key terms and the questions people ask about them,
 * with short spoken answers, and a link to the page that shows each idea working.
 */
export default function BiblePage() {
  const navHeight = useNavHeight();
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim().toLowerCase());
  const parts = useMemo(
    () =>
      PARTS.map((p) => ({
        ...p,
        sections: q ? p.sections.filter((s) => `${s.title}\n${s.body}`.toLowerCase().includes(q)) : p.sections,
      })),
    [q],
  );
  const shown = parts.reduce((n, p) => n + p.sections.length, 0);

  return (
    <main className="page-bible" style={{ '--nav-h': `${navHeight}px` } as CSSProperties}>
      <div className="kicker">The lab in questions and answers</div>
      <h1>Bible</h1>
      <p className="lede">
        Every page of the lab, boiled down to what you should be able to explain: the key terms, the questions people
        ask about them, and short answers you could give out loud. It starts with the essentials that come up whatever
        the topic, such as temperature and top-p, how to save tokens, and how to run an AI system in production. Then it
        goes page by page through all {PAGE_COUNT} labs, each with a link to the page that shows the idea working.
      </p>
      <div className="bb-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search terms and questions, e.g. top-p, precision, prompt caching, PTU"
          aria-label="Search the Bible"
        />
        <span className="small muted">
          {q ? `${shown} section${shown === 1 ? '' : 's'} match` : `${shown} sections`}
        </span>
      </div>
      <div className="bb-layout">
        <nav className="bb-toc" aria-label="Contents">
          {parts.map(
            (p) =>
              p.sections.length > 0 && (
                <div key={p.id}>
                  <b>{p.title}</b>
                  {p.sections.map((s) => (
                    <a key={s.id} href={`#${s.id}`}>
                      {s.title}
                    </a>
                  ))}
                </div>
              ),
          )}
        </nav>
        <div>
          {shown === 0 && <p className="muted">Nothing matches “{query}”. Try a shorter word.</p>}
          {parts.map(
            (p) =>
              p.sections.length > 0 && (
                <section key={p.id} className="bb-part">
                  <h2>{p.title}</h2>
                  <p className="muted">{p.blurb}</p>
                  {p.sections.map((s) => (
                    <article key={s.id} id={s.id} className="bb-section card">
                      <div className="bb-head">
                        <h3>{s.title}</h3>
                        {s.route && (
                          <a className="bb-open" href={s.route}>
                            Open the page <span className="mono">{s.route}</span> →
                          </a>
                        )}
                      </div>
                      <div className="bb-md">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{s.body}</ReactMarkdown>
                      </div>
                    </article>
                  ))}
                </section>
              ),
          )}
        </div>
      </div>
    </main>
  );
}
