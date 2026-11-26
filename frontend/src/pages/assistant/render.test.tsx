import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import AssistantPage from './AssistantPage';

describe('assistant page', () => {
  it('renders its frame before any data arrives, without throwing', () => {
    const html = renderToString(
      <MemoryRouter initialEntries={['/assistant']}>
        <AssistantPage />
      </MemoryRouter>,
    );
    expect(html).toMatch(/<main class="page-assistant[ "]/);
    expect(html).toContain('New chat');
    expect(html).toContain('Search chats');
    expect(html).not.toMatch(/NaN|undefined/);
  });
});
