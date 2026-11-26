/* Pure helpers for the assistant page: grouping and searching chats, choosing how to show a file, reading CSV for the
   viewer, and checking the MCP server form before it is sent. Kept free of React so they are easy to test. */
import type { AssistantFile, ChatSummary, McpServer } from '@/services/assistantService';

export interface ChatGroup {
  label: 'Today' | 'Yesterday' | 'Previous 7 days' | 'Older';
  chats: ChatSummary[];
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * Splits chats into Today, Yesterday, Previous 7 days and Older by when they last changed, newest first within each.
 * Days are the reader's calendar days, so a chat from 23:50 yesterday is "Yesterday" at 00:10 today.
 */
export function groupChats(chats: ChatSummary[], now: Date = new Date()): ChatGroup[] {
  const today = dayStart(now);
  const day = 86_400_000;
  const groups: Record<ChatGroup['label'], ChatSummary[]> = {
    Today: [],
    Yesterday: [],
    'Previous 7 days': [],
    Older: [],
  };
  const sorted = [...chats].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  for (const c of sorted) {
    const t = Date.parse(c.updated_at);
    const d = Number.isFinite(t) ? dayStart(new Date(t)) : 0;
    if (d >= today) groups.Today.push(c);
    else if (d >= today - day) groups.Yesterday.push(c);
    else if (d >= today - 7 * day) groups['Previous 7 days'].push(c);
    else groups.Older.push(c);
  }
  return (Object.keys(groups) as ChatGroup['label'][])
    .filter((label) => groups[label].length > 0)
    .map((label) => ({ label, chats: groups[label] }));
}

/** Chats whose title contains every word of the query, in any order and any case. */
export function filterChats(chats: ChatSummary[], query: string): ChatSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return chats;
  return chats.filter((c) => {
    const title = c.title.toLowerCase();
    return words.every((w) => title.includes(w));
  });
}

export type ViewKind = 'image' | 'pages' | 'markdown' | 'csv' | 'text' | 'download';

const ext = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

const TEXT_EXT = new Set(['txt', 'json', 'py', 'js', 'ts', 'html', 'css', 'xml', 'yaml', 'yml', 'log', 'sql', 'sh']);
const PAGED_EXT = new Set(['pdf', 'pptx', 'docx', 'xlsx', 'ppt', 'doc', 'xls']);

/**
 * How the viewer shows a file: an image as itself; a document with page previews as its pages; Markdown, CSV and
 * plain text read and rendered safely; anything else as a download only.
 */
export function viewKind(f: Pick<AssistantFile, 'name' | 'media_type' | 'previews'>): ViewKind {
  const e = ext(f.name);
  const type = f.media_type.toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (PAGED_EXT.has(e) || type === 'application/pdf') return f.previews.length ? 'pages' : 'download';
  if (e === 'md' || e === 'markdown' || type === 'text/markdown') return 'markdown';
  if (e === 'csv' || type === 'text/csv') return 'csv';
  if (TEXT_EXT.has(e) || type.startsWith('text/') || type === 'application/json') return 'text';
  return 'download';
}

/** The most the viewer reads of a text file, so a huge log cannot freeze the page. */
export const MAX_TEXT_CHARS = 200_000;
export const MAX_CSV_ROWS = 300;

/** Parses CSV with quoted fields (doubled quotes inside quotes), up to `maxRows` rows. */
export function parseCsv(text: string, maxRows = MAX_CSV_ROWS): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if ((cell !== '' || row.length) && rows.length < maxRows) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export interface McpForm {
  name: string;
  url: string;
  token: string;
}

/**
 * Problems with the MCP server form, empty when it can be sent. The backend makes the real checks (it refuses
 * metadata and link-local addresses, and must reach the server); these catch typing mistakes before the round trip.
 */
export function checkMcpForm(form: McpForm, others: Pick<McpServer, 'name'>[] = []): string[] {
  const problems: string[] = [];
  const name = form.name.trim();
  if (!name) problems.push('Give the server a name.');
  else if (name.length > 60) problems.push('Keep the name to 60 characters or fewer.');
  else if (others.some((o) => o.name.trim().toLowerCase() === name.toLowerCase()))
    problems.push('Another server already has that name.');
  const url = form.url.trim();
  if (!url) problems.push('Enter the server’s URL.');
  else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      problems.push('That is not a valid URL.');
    }
    if (parsed && parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      problems.push('The URL must start with http:// or https://.');
    if (parsed && (parsed.username || parsed.password))
      problems.push('Put a token in the token field, not in the URL.');
  }
  if (/\s/.test(form.token.trim())) problems.push('The token cannot contain spaces.');
  return problems;
}

/**
 * The MCP servers a chat has chosen: its saved list (servers since deleted are dropped), or, for a chat that never
 * chose, every server switched on. A chosen server that is switched off globally stays in the list; it simply offers
 * no tools until it is switched back on.
 */
export function chatMcp(chosen: string[] | undefined, servers: Pick<McpServer, 'id' | 'enabled'>[]): string[] {
  if (chosen === undefined) return servers.filter((s) => s.enabled).map((s) => s.id);
  return chosen.filter((id) => servers.some((s) => s.id === id));
}

/** The chosen servers that will actually offer tools this turn: chosen and switched on. */
export function activeMcp(chosen: string[], servers: Pick<McpServer, 'id' | 'enabled'>[]): string[] {
  return chosen.filter((id) => servers.some((s) => s.id === id && s.enabled));
}

export const dollars = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`;

export function shortDate(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return d.getFullYear() === now.getFullYear()
    ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
