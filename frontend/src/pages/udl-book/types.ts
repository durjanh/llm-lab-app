import type { ComponentType, ReactNode } from 'react';

/** A worked example from the book's text: where it is, what it shows, and (when it adds something) a live demo. */
export interface BookExample {
  /** The book's section number, e.g. "5.3". Also the anchor: #ex-5.3. */
  id: string;
  title: string;
  /** The printed page in the book where the example starts, for reading alongside. */
  page: number;
  /** What the example shows, in the lab's own words. */
  shows: ReactNode;
  /** Notebook ids on /deep-learning that already make this example interactive, e.g. ["5.1"]. */
  notebooks?: string[];
  /** A demo written for this page; only where the notebooks don't already cover the example. */
  Demo?: ComponentType;
}

export type LeverTag = 'speed' | 'quality' | 'cost' | 'memory';

/** A published source behind a claim. */
export interface Source {
  title: string;
  /** First author et al., or the organisation. */
  who: string;
  year: number;
  url: string;
}

/** One change that research or practice uses to make LLMs faster, cheaper or better, with the evidence for it. */
export interface Lever {
  id: string;
  name: string;
  /** Where it acts. */
  stage: 'training' | 'architecture' | 'inference' | 'post-training' | 'system';
  tags: LeverTag[];
  /** How widely it is used: in production models today, emerging, or still research. */
  maturity: 'production' | 'emerging' | 'research';
  /** The book chapters whose ideas it builds on. */
  chapters: number[];
  /** What it does, in two or three plain sentences. */
  what: string;
  /** The measured effect, with numbers, as the source reports it. */
  gain: string;
  /** What it costs or risks. */
  tradeoff: string;
  sources: Source[];
  /** Lab pages that show it: [route, label]. */
  labs?: [string, string][];
}

/** A direction that is likely to matter for the next generation of models. */
export interface Frontier {
  name: string;
  why: string;
  evidence: string;
  sources: Source[];
}

/** One chapter of the book as this page presents it. */
export interface BookChapter {
  n: number;
  title: string;
  /** What the chapter offers a reader, in two or three sentences. */
  offers: ReactNode;
  examples: BookExample[];
  /** Where the chapter's ideas live inside a modern LLM. */
  inLlms: ReactNode;
  /** Ideas from the chapter that research is using to make LLMs better, each a short line. */
  next: ReactNode[];
  /** Lab pages that go deeper: [route, label]. */
  labs?: [string, string][];
}
