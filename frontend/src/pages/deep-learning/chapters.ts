import type { ComponentType } from 'react';

/** One notebook: its number as in the book (e.g. "6.4"), its title, and the component that renders it inside a <Notebook>. */
export interface NotebookDef {
  id: string;
  title: string;
  Component: ComponentType;
}

export interface ChapterDef {
  n: number;
  title: string;
  blurb: string;
  notebooks: NotebookDef[];
}
