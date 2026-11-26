import { describe, expect, it } from 'vitest';
import type { AssistantFile, ChatSummary, McpServer } from '@/services/assistantService';
import { activeMcp, chatMcp, checkMcpForm, filterChats, groupChats, parseCsv, viewKind } from './helpers';

const chat = (id: string, title: string, updated_at: string): ChatSummary => ({
  id,
  title,
  created_at: updated_at,
  updated_at,
  model: 'claude-haiku-5-5',
  status: 'idle',
  cost_usd: 0,
});

describe('grouping chats by day', () => {
  // 10:00 local time on 25 November 2026.
  const now = new Date(2026, 10, 25, 10, 0, 0);
  const at = (d: number, h = 9) => new Date(2026, 10, d, h, 0, 0).toISOString();

  it('splits by the reader’s calendar days, newest first, and leaves out empty groups', () => {
    const groups = groupChats(
      [
        chat('a', 'Old', at(1)),
        chat('b', 'Yesterday late', at(24, 23)),
        chat('c', 'This morning', at(25, 8)),
        chat('d', 'Monday', at(20)),
        chat('e', 'Earlier today', at(25, 7)),
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Previous 7 days', 'Older']);
    expect(groups[0].chats.map((c) => c.id)).toEqual(['c', 'e']);
    expect(groups[1].chats.map((c) => c.id)).toEqual(['b']);
    expect(groups[2].chats.map((c) => c.id)).toEqual(['d']);
    expect(groups[3].chats.map((c) => c.id)).toEqual(['a']);
  });

  it('puts a chat with an unreadable date in Older rather than failing', () => {
    expect(groupChats([chat('x', 'Odd', 'not a date')], now)).toEqual([
      { label: 'Older', chats: [chat('x', 'Odd', 'not a date')] },
    ]);
  });
});

describe('searching chats', () => {
  const list = [
    chat('1', 'Quarterly revenue chart', ''),
    chat('2', 'Deck for the board', ''),
    chat('3', 'Revenue PDF', ''),
  ];
  it('matches every word, in any order and case; an empty query keeps everything', () => {
    expect(filterChats(list, 'revenue').map((c) => c.id)).toEqual(['1', '3']);
    expect(filterChats(list, 'CHART quarterly').map((c) => c.id)).toEqual(['1']);
    expect(filterChats(list, 'revenue deck')).toEqual([]);
    expect(filterChats(list, '   ')).toHaveLength(3);
  });
});

describe('how the viewer shows a file', () => {
  const f = (name: string, media_type: string, previews: string[] = []): AssistantFile => ({
    id: name,
    name,
    size: 1,
    media_type,
    url: `/api/assistant/media/c/${name}`,
    previews,
  });
  it('routes each kind of file to the right view', () => {
    expect(viewKind(f('chart.png', 'image/png'))).toBe('image');
    expect(viewKind(f('report.pdf', 'application/pdf', ['p1']))).toBe('pages');
    expect(viewKind(f('deck.pptx', 'application/octet-stream', ['p1', 'p2']))).toBe('pages');
    expect(viewKind(f('deck.pptx', 'application/octet-stream'))).toBe('download');
    expect(viewKind(f('notes.md', 'text/markdown'))).toBe('markdown');
    expect(viewKind(f('data.csv', 'text/csv'))).toBe('csv');
    expect(viewKind(f('out.json', 'application/json'))).toBe('text');
    expect(viewKind(f('run.log', 'application/octet-stream'))).toBe('text');
    expect(viewKind(f('archive.zip', 'application/zip'))).toBe('download');
  });
});

describe('reading CSV for the viewer', () => {
  it('handles quotes, doubled quotes, commas and line breaks inside quotes, and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"two\nlines",3')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\nlines', '3'],
    ]);
  });
  it('stops at the row limit', () => {
    expect(parseCsv('1\n2\n3\n4\n', 2)).toEqual([['1'], ['2']]);
  });
});

describe('the MCP server form', () => {
  const ok = { name: 'Wiki', url: 'https://example.com/mcp', token: '' };
  it('accepts a sensible server, with or without a token', () => {
    expect(checkMcpForm(ok)).toEqual([]);
    expect(checkMcpForm({ ...ok, token: 'abc.def' })).toEqual([]);
    expect(checkMcpForm({ ...ok, url: 'http://localhost:8765/mcp' })).toEqual([]);
  });
  it('catches typing mistakes before the round trip', () => {
    expect(checkMcpForm({ ...ok, name: ' ' })).toContain('Give the server a name.');
    expect(checkMcpForm({ ...ok, url: '' })).toContain('Enter the server’s URL.');
    expect(checkMcpForm({ ...ok, url: 'example.com' })).toContain('That is not a valid URL.');
    expect(checkMcpForm({ ...ok, url: 'ftp://example.com' })).toContain('The URL must start with http:// or https://.');
    expect(checkMcpForm({ ...ok, url: 'https://me:secret@example.com' })).toContain(
      'Put a token in the token field, not in the URL.',
    );
    expect(checkMcpForm({ ...ok, token: 'has space' })).toContain('The token cannot contain spaces.');
    expect(checkMcpForm(ok, [{ name: 'wiki' }])).toContain('Another server already has that name.');
  });
});

describe('which MCP servers a chat uses', () => {
  const s = (id: string, enabled: boolean) => ({ id, enabled }) as Pick<McpServer, 'id' | 'enabled'>;
  const servers = [s('a', true), s('b', false), s('c', true)];
  it('gives a chat that never chose every server switched on', () => {
    expect(chatMcp(undefined, servers)).toEqual(['a', 'c']);
  });
  it('keeps a chat’s choice, including servers switched off globally, but drops deleted ones', () => {
    expect(chatMcp(['b', 'c', 'gone'], servers)).toEqual(['b', 'c']);
    expect(activeMcp(['b', 'c'], servers)).toEqual(['c']);
  });
});
