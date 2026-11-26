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

describe('the compact confirmation', () => {
  it('says what compacting does and offers Cancel and Compact', async () => {
    const { ConfirmDialog } = await import('./ConfirmDialog');
    const html = renderToString(
      <ConfirmDialog title="Compact this chat?" confirmLabel="Compact" onConfirm={() => {}} onCancel={() => {}}>
        <p>Nothing is deleted.</p>
      </ConfirmDialog>,
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('Compact this chat?');
    expect(html).toContain('Nothing is deleted.');
    expect(html).toContain('>Cancel<');
    expect(html).toContain('>Compact<');
  });
});
