import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import DataIntegrationPage from './DataIntegrationPage';

describe('data integration page', () => {
  it('renders every section without throwing', () => {
    const html = renderToString(
      <MemoryRouter>
        <DataIntegrationPage />
      </MemoryRouter>,
    );
    for (const id of ['lakehouse', 'stores', 'gateway', 'streaming', 'messaging', 'patterns'])
      expect(html).toContain(`id="${id}"`);
    expect(html).not.toMatch(/NaN|undefined/);
  });
});
