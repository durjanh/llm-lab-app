import type { Change, ChangeStatus, ChangeSummary, FactoryEvent, Tier } from '@/services/softwareFactoryService';

/* The software factory page's pure logic: board columns, a live run's state from its events, and labels. */

export const COLUMNS: { id: string; label: string; statuses: ChangeStatus[] }[] = [
  { id: 'queued', label: 'Queued', statuses: ['queued'] },
  { id: 'planning', label: 'Planning', statuses: ['planning'] },
  { id: 'building', label: 'Building', statuses: ['building'] },
  { id: 'checking', label: 'Checking', statuses: ['checking'] },
  { id: 'person', label: 'Awaiting a person', statuses: ['awaiting_plan', 'awaiting_diff'] },
  { id: 'merged', label: 'Merged', statuses: ['merged'] },
  { id: 'reverted', label: 'Reverted', statuses: ['reverted'] },
  {
    id: 'ended',
    label: 'Ended without merging',
    statuses: ['rejected', 'blocked', 'taken_over', 'stopped', 'expired', 'failed'],
  },
];

export const STATUS_LABEL: Record<ChangeStatus, string> = {
  queued: 'Queued',
  planning: 'Planning',
  awaiting_plan: 'Waiting for a person to approve the plan',
  building: 'Building',
  checking: 'Checking',
  awaiting_diff: 'Waiting for a person to approve the diff',
  merged: 'Merged',
  reverted: 'Reverted (an escaped defect)',
  rejected: 'Rejected by a person',
  blocked: 'Blocked by a gate',
  taken_over: 'Taken over by a person',
  stopped: 'Stopped',
  expired: 'Expired: nobody answered in time',
  failed: 'Failed',
};

export const TIER_LABEL: Record<Tier, string> = { low: 'Low', medium: 'Medium', high: 'High' };

/** Changes grouped by board column, newest first in each. */
export function board(changes: ChangeSummary[]): Record<string, ChangeSummary[]> {
  const out: Record<string, ChangeSummary[]> = Object.fromEntries(COLUMNS.map((c) => [c.id, []]));
  for (const c of [...changes].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const col = COLUMNS.find((k) => k.statuses.includes(c.status));
    if (col) out[col.id].push(c);
  }
  return out;
}

export interface PendingDecision {
  decisionId: string;
  kind: 'plan' | 'diff';
  timeoutS: number;
  plan?: string;
  diff?: string;
  since: string;
}

export interface LogLine {
  ts: string;
  who: string;
  text: string;
  tone: 'info' | 'good' | 'bad' | 'person';
}

/** What the page knows about the running change, built only from its stream. */
export interface Live {
  runId: string | null;
  change: Change | null;
  pending: PendingDecision | null;
  log: LogLine[];
  error: string | null;
  done: boolean;
}

export const EMPTY_LIVE: Live = { runId: null, change: null, pending: null, log: [], error: null, done: false };
const MAX_LOG = 400;

const short = (v: unknown, n = 140): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** One line for an agent's own event (from the coding agent), or null for those too noisy to list. */
export function agentLine(role: string, e: Record<string, unknown>): LogLine | null {
  const ts = '';
  switch (e.type) {
    case 'tool_use': {
      const input = (e.input ?? {}) as Record<string, unknown>;
      return { ts, who: role, tone: 'info', text: `${e.name}: ${short(input.command ?? input.path ?? input)}` };
    }
    case 'result':
      return e.is_error ? { ts, who: role, tone: 'bad', text: `refused or failed: ${short(e.content)}` } : null;
    case 'text':
      return { ts, who: role, tone: 'info', text: short(e.text, 220) };
    case 'stop_check':
      return {
        ts,
        who: role,
        tone: e.passed ? 'good' : 'bad',
        text: e.passed ? 'stop check: no new failures' : 'stop check: tests still fail, carrying on',
      };
    case 'turn':
      return {
        ts,
        who: role,
        tone: 'info',
        text: `model call: ${e.input_tokens ?? 0} in, ${e.output_tokens ?? 0} out, $${Number(e.cost ?? 0).toFixed(4)}`,
      };
    default:
      return null;
  }
}

/** Folds one stream event into the live state. Unknown events and anything after `done` change nothing. */
export function reduce(live: Live, e: FactoryEvent): Live {
  if (live.done && e.type !== 'run') return live;
  const add = (line: LogLine) => [...live.log, line].slice(-MAX_LOG);
  switch (e.type) {
    case 'run':
      return { ...EMPTY_LIVE, runId: e.run_id };
    case 'change':
      return { ...live, change: e.change };
    case 'audit':
      return {
        ...live,
        log: add({
          ts: e.ts,
          who: e.entry.actor,
          tone: e.entry.actor === 'person' ? 'person' : /failed|ended/.test(e.entry.what) ? 'bad' : 'good',
          text: e.entry.why ? `${e.entry.what} (${short(e.entry.why, 180)})` : e.entry.what,
        }),
      };
    case 'agent': {
      const line = agentLine(e.role, e.event);
      return line ? { ...live, log: add({ ...line, ts: e.ts }) } : live;
    }
    case 'decision_needed':
      return {
        ...live,
        pending: {
          decisionId: e.decision_id,
          kind: e.kind,
          timeoutS: e.timeout_s,
          plan: e.plan,
          diff: e.diff,
          since: e.ts,
        },
      };
    case 'decision_done':
      return live.pending?.decisionId === e.decision_id ? { ...live, pending: null } : live;
    case 'done':
      return { ...live, change: e.change, pending: null, done: true };
    case 'error':
      return { ...live, error: e.message, pending: null };
    default:
      return live;
  }
}

export function duration(s: number | null | undefined): string {
  if (s === null || s === undefined) return '—';
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export const dollars = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

/** The lines of a unified diff, each marked as added, removed, a file header or context, for colouring. */
export function diffLines(diff: string): { kind: 'add' | 'del' | 'file' | 'hunk' | 'ctx'; text: string }[] {
  return diff.split('\n').map((text) => ({
    text,
    kind:
      text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff --git')
        ? 'file'
        : text.startsWith('@@')
          ? 'hunk'
          : text.startsWith('+')
            ? 'add'
            : text.startsWith('-')
              ? 'del'
              : 'ctx',
  }));
}
