import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import ModelEvaluationPage from './ModelEvaluationPage';

describe('model-evaluation page', () => {
  it('renders every section without throwing', () => {
    const html = renderToString(
      <MemoryRouter>
        <ModelEvaluationPage />
      </MemoryRouter>,
    );
    for (const id of [
      'splits',
      'curves',
      'threshold',
      'rare',
      'cv',
      'nested',
      'imbalance',
      'time',
      'code',
      'quiz',
      'where',
    ])
      expect(html).toContain(`id="${id}"`);
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });
});
