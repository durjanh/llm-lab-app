import { describe, expect, it } from 'vitest';
import { checkUploads, extensionOf, sizeText } from './upload';
import { safeUrl } from './parts';

const limits = { max_files: 3, max_file_bytes: 1000, extensions: ['.pdf', 'csv', '.PNG'] };
const f = (name: string, size = 10) => new File([new Uint8Array(size)], name);

describe('checking attachments', () => {
  it('accepts allowed types, any case, with or without the dot in the list', () => {
    const r = checkUploads([f('a.pdf'), f('b.CSV'), f('c.png')], limits);
    expect(r.ok.map((x) => x.name)).toEqual(['a.pdf', 'b.CSV', 'c.png']);
    expect(r.problems).toEqual([]);
  });

  it('gives a reason for each refused file: type, empty, too big, too many', () => {
    const r = checkUploads(
      [f('x.exe'), f('noext'), f('empty.pdf', 0), f('big.pdf', 1001), f('1.pdf'), f('2.pdf')],
      limits,
      1,
    );
    expect(r.ok.map((x) => x.name)).toEqual(['1.pdf', '2.pdf']);
    expect(r.problems).toHaveLength(4);
    expect(r.problems[0]).toMatch(/x\.exe.*not accepted/);
    expect(r.problems[1]).toMatch(/no extension/);
    expect(r.problems[2]).toMatch(/empty/);
    expect(r.problems[3]).toMatch(/over the/);
  });

  it('counts files already attached to the message', () => {
    const r = checkUploads([f('a.pdf'), f('b.pdf')], limits, 2);
    expect(r.ok).toHaveLength(1);
    expect(r.problems[0]).toMatch(/at most 3 files/);
  });

  it('reads extensions and sizes', () => {
    expect(extensionOf('Report.Final.PDF')).toBe('.pdf');
    expect(extensionOf('.hidden')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
    expect(sizeText(500)).toBe('500 B');
    expect(sizeText(2048)).toBe('2 KB');
    expect(sizeText(3 * 2 ** 20)).toBe('3.0 MB');
  });
});

describe('links and images in replies', () => {
  it('keeps web, mail and this chat’s media links, and blanks the rest', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeUrl('mailto:a@example.com')).toBe('mailto:a@example.com');
    expect(safeUrl('/api/assistant/media/abc/def')).toBe('/api/assistant/media/abc/def');
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('data:text/html,hi')).toBe('');
    expect(safeUrl('/api/other')).toBe('');
  });
});

describe('the effort sent with a message', () => {
  it('is empty for a model that takes no effort, and kept for one that does', async () => {
    const { effortToSend } = await import('./Composer');
    const info = {
      models: [
        {
          id: 'claude-sonnet-5-5',
          name: 'Sonnet',
          provider: 'anthropic',
          context_window: 200000,
          efforts: ['low', 'medium', 'high'],
        },
        { id: 'local-model', name: 'Local', provider: 'local', context_window: 32768, efforts: [] },
      ],
    } as unknown as Parameters<typeof effortToSend>[0];
    expect(effortToSend(info, 'local-model', 'medium')).toBe('');
    expect(effortToSend(info, 'claude-sonnet-5-5', 'high')).toBe('high');
  });
});
