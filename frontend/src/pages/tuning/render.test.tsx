import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import TuningPage from './TuningPage';

describe('tuning page', () => {
  it('renders every section without throwing', () => {
    const html = renderToString(
      <MemoryRouter>
        <TuningPage />
      </MemoryRouter>,
    );
    for (const id of ['what', 'grid', 'halving', 'gp', 'acq', 'bo', 'practice', 'code', 'quiz', 'where'])
      expect(html).toContain(`id="${id}"`);
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });
});
