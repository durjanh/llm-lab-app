import type { CSSProperties } from 'react';
import { useNavHeight } from '@/lib/useNavHeight';
import { Chapter } from './Example';
import { CHAPTERS as A } from './book_01_06';
import { CHAPTERS as B } from './book_07_11';
import { CHAPTERS as C } from './book_12_14';
import { CHAPTERS as D } from './book_15_21';
import { Research, RESEARCH_SECTIONS } from './Research';
import type { BookChapter } from './types';
import './udl-book.css';

const CHAPTERS: BookChapter[] = [...A, ...B, ...C, ...D].sort((a, b) => a.n - b.n);

/**
 * What Simon Prince's "Understanding Deep Learning" offers, chapter by chapter: its worked examples (linked to the
 * notebook demos where those exist, with new demos where they don't), where each idea lives in an LLM, and a
 * research section on which changes make LLMs faster, cheaper or better, with the evidence for each.
 */
export default function UdlBookPage() {
  const navHeight = useNavHeight();
  const examples = CHAPTERS.flatMap((c) => c.examples);
  const demos = examples.filter((e) => e.Demo).length;
  return (
    <main className="page-udl-book" style={{ '--nav-h': `${navHeight}px` } as CSSProperties}>
      <div className="kicker">Lab 47 · Deep learning</div>
      <h1>Understanding Deep Learning: the book, and how LLMs get better</h1>
      <p className="lede">
        A guide to <i>Understanding Deep Learning</i> by Simon J. D. Prince (MIT Press, 2023). Part 1 goes through the
        book chapter by chapter: what each chapter offers, its {examples.length} worked examples ({demos} with a new
        demo here, the rest linked to the <a href="/deep-learning">notebook demos</a>), and where each idea lives inside
        a large language model. Part 2 asks the forward-looking question: which changes make an LLM faster, cheaper or
        better, by how much, and what each one costs. Every claim there names its source.
      </p>
      <p className="small muted">
        The book is free to read at{' '}
        <a href="https://udlbook.github.io/udlbook/" target="_blank" rel="noreferrer">
          udlbook.github.io
        </a>
        . Page numbers here are the book&apos;s printed ones, so you can read alongside. The explanations and demos are
        written for this lab; nothing is copied from the book.
      </p>
      <p className="small muted">
        To watch alongside:{' '}
        <a href="https://www.youtube.com/watch?v=sJXn4Cl4oww&t=346s" target="_blank" rel="noreferrer">
          This is why Deep Learning is really weird
        </a>{' '}
        (Machine Learning Street Talk, YouTube).
      </p>
      <div className="ub-layout">
        <nav className="ub-toc" aria-label="Contents">
          <b>Part 1 · The book</b>
          {CHAPTERS.map((c) => (
            <a key={c.n} href={`#ch-${c.n}`}>
              <span>{c.n}</span>
              {c.title}
            </a>
          ))}
          <b>Part 2 · Research</b>
          {RESEARCH_SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`}>
              {label}
            </a>
          ))}
        </nav>
        <div>
          <section className="ub-part">
            <h2 className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>
              Part 1 · The book, chapter by chapter
            </h2>
            {CHAPTERS.map((c) => (
              <Chapter key={c.n} ch={c} />
            ))}
          </section>
          <section className="ub-part" style={{ marginTop: 48 }}>
            <h2 className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.06em' }}>
              Part 2 · Research: making LLMs faster, cheaper and better
            </h2>
            <Research />
          </section>
        </div>
      </div>
    </main>
  );
}
