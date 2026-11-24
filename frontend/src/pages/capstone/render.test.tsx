import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import CapstonePage from './CapstonePage';

describe('capstone page', () => {
  it('renders every section without throwing', () => {
    const html = renderToString(
      <MemoryRouter>
        <CapstonePage />
      </MemoryRouter>,
    );
    for (const id of ['brief', 'play', 'portfolio', 'python', 'quiz', 'where']) expect(html).toContain(`id="${id}"`);
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });
});
