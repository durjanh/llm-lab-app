import type { CSSProperties } from 'react';
import { useNavHeight } from '@/lib/useNavHeight';
import type { ChapterDef } from './chapters';
import { CHAPTERS as A } from './ch01_04';
import { CHAPTERS as B } from './ch05_06';
import { CHAPTERS as C } from './ch07_11';
import { CHAPTERS as D } from './ch12_13';
import { CHAPTERS as E } from './ch10';
import { CHAPTERS as F } from './ch08_09';
import { NOTEBOOKS_13 } from './ch13_more';
import { CHAPTERS as G } from './ch15_17';
import { CHAPTERS as H } from './ch18_19';
import { CHAPTERS as I } from './ch20_21';
import './deep-learning.css';

// Chapters in book order, whichever file they live in.
const CHAPTERS: ChapterDef[] = [...A, ...B, ...C, ...D, ...E, ...F, ...G, ...H, ...I]
  .map((c) => (c.n === 13 ? { ...c, notebooks: [...c.notebooks, ...NOTEBOOKS_13] } : c))
  .sort((a, b) => a.n - b.n);

/**
 * The notebooks of Simon Prince's "Understanding Deep Learning" (udlbook.github.io), each rebuilt as a
 * small interactive demo that runs in the browser: no Python, no backend, no downloads.
 */
export default function DeepLearningPage() {
  const navHeight = useNavHeight();
  const all = CHAPTERS.flatMap((c) => c.notebooks);
  const extras = all.filter((nb) => nb.title.includes('lab extra')).length;
  return (
    <main className="page-deep-learning" style={{ '--nav-h': `${navHeight}px` } as CSSProperties}>
      <div className="kicker">Lab 23 · Deep learning</div>
      <h1>Deep learning, notebook by notebook</h1>
      <p className="lede">
        All {all.length - extras} notebooks that accompany <i>Understanding Deep Learning</i> by Simon J. D. Prince,
        rebuilt as interactive demos, plus {extras} of the lab&apos;s own. Drag the sliders and points and watch the maths respond: from a single line, through
        shallow and deep networks, losses and optimisers, backpropagation, regularisation, convolutions, residual networks, attention and graphs, to
        GANs, flows, VAEs, diffusion, reinforcement learning and fairness.
        Everything runs in your browser.
      </p>
      <p className="small muted">
        Read alongside the book, which is free online at{' '}
        <a href="https://udlbook.github.io/udlbook/" target="_blank" rel="noreferrer">
          udlbook.github.io
        </a>
        , where the original Python notebooks have exercises to complete. These demos are written for this lab and show
        the same ideas, with the answers worked in.
      </p>
      <div className="dl-layout">
        <nav className="dl-toc" aria-label="Notebooks">
          {CHAPTERS.map((c) => (
            <div key={c.n}>
              <b>
                {c.n}. {c.title}
              </b>
              {c.notebooks.map((nb) => (
                <a key={nb.id} href={`#nb-${nb.id}`}>
                  <span>{nb.id}</span>
                  {nb.title}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div>
          {CHAPTERS.map((c) => (
            <div key={c.n} className="dl-chapter">
              <h2>
                {c.n}. {c.title}
              </h2>
              <p className="muted">{c.blurb}</p>
              {c.notebooks.map(({ id, Component }) => (
                <Component key={id} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
