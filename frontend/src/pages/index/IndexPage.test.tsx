import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import IndexPage from './IndexPage';

describe('the home page', () => {
  it('has a card for the cognitive core, with what it helps you decide and what it needs', () => {
    const html = renderToString(<IndexPage />);
    expect(html).toContain('href="/cognitive-core"');
    expect(html).toContain('Lab 59');
    expect(html).toContain('when a small local model with retrieval is enough');
    expect(html).toContain('Needs the backend and the small local model');
  });
});
