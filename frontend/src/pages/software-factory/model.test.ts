import { describe, expect, it } from 'vitest';
import type { Change, ChangeSummary, FactoryEvent } from '@/services/softwareFactoryService';
import { agentLine, board, diffLines, duration, EMPTY_LIVE, reduce, type Live } from './model';

const summary = (id: string, status: ChangeSummary['status'], created_at: string): ChangeSummary =>
  ({ id, status, created_at, ticket_id: 'T1', title: id }) as ChangeSummary;

describe('the board', () => {
  it('puts each change in its column, newest first, and waiting changes under a person', () => {
    const b = board([
      summary('a', 'merged', '2026-11-26T10:00:00'),
      summary('b', 'awaiting_diff', '2026-11-26T10:05:00'),
      summary('c', 'merged', '2026-11-26T10:10:00'),
      summary('d', 'blocked', '2026-11-26T10:01:00'),
      summary('e', 'awaiting_plan', '2026-11-26T10:02:00'),
    ]);
    expect(b.merged.map((c) => c.id)).toEqual(['c', 'a']);
    expect(b.person.map((c) => c.id)).toEqual(['b', 'e']);
    expect(b.ended.map((c) => c.id)).toEqual(['d']);
  });
});

describe('the live run', () => {
  const change = { id: 'x', status: 'planning' } as Change;
  const steps: FactoryEvent[] = [
    { type: 'run', run_id: 'r1' },
    { type: 'change', change, change_id: 'x', ts: 't' },
    {
      type: 'audit',
      entry: { at: 't', actor: 'policy', what: 'declared tier low', why: 'kind docs is low' },
      change_id: 'x',
      ts: 't',
    },
    {
      type: 'agent',
      role: 'implementer',
      event: { type: 'tool_use', name: 'bash', input: { command: 'python -m unittest' } },
      change_id: 'x',
      ts: 't',
    },
    { type: 'agent', role: 'implementer', event: { type: 'checkpoint' }, change_id: 'x', ts: 't' },
    { type: 'decision_needed', decision_id: 'd1', kind: 'diff', timeout_s: 900, diff: '+a', change_id: 'x', ts: 't' },
  ];

  it('tracks the change, the log and a waiting decision', () => {
    const live = steps.reduce<Live>(reduce, EMPTY_LIVE);
    expect(live.runId).toBe('r1');
    expect(live.change?.id).toBe('x');
    expect(live.log.map((l) => l.text)).toEqual(['declared tier low (kind docs is low)', 'bash: python -m unittest']);
    expect(live.pending?.decisionId).toBe('d1');
    const answered = reduce(live, {
      type: 'decision_done',
      decision_id: 'd1',
      decision: 'approve',
      change_id: 'x',
      ts: 't',
    });
    expect(answered.pending).toBeNull();
  });

  it('ignores a decision_done for another decision, unknown events and anything after done', () => {
    const live = steps.reduce<Live>(reduce, EMPTY_LIVE);
    expect(
      reduce(live, { type: 'decision_done', decision_id: 'zz', decision: 'approve', change_id: 'x', ts: 't' }).pending,
    ).not.toBeNull();
    expect(reduce(live, { type: 'mystery' } as unknown as FactoryEvent)).toBe(live);
    const done = reduce(live, { type: 'done', change: { ...change, status: 'merged' }, change_id: 'x', ts: 't' });
    expect(done.done && done.pending === null && done.change?.status === 'merged').toBe(true);
    expect(reduce(done, steps[2])).toBe(done);
  });

  it('shows an error and drops a waiting decision', () => {
    const live = reduce(steps.reduce<Live>(reduce, EMPTY_LIVE), { type: 'error', message: 'boom' });
    expect(live.error).toBe('boom');
    expect(live.pending).toBeNull();
  });
});

describe('labels', () => {
  it('summarises agent events and skips the noisy ones', () => {
    expect(agentLine('planner', { type: 'result', is_error: false })).toBeNull();
    expect(agentLine('planner', { type: 'result', is_error: true, content: 'Permission denied' })?.tone).toBe('bad');
    expect(agentLine('implementer', { type: 'stop_check', passed: true })?.tone).toBe('good');
  });

  it('formats durations and marks diff lines', () => {
    expect(duration(null)).toBe('—');
    expect(duration(45)).toBe('45 s');
    expect(duration(600)).toBe('10 min');
    expect(diffLines('diff --git a b\n@@ -1 +1 @@\n-old\n+new\n same').map((l) => l.kind)).toEqual([
      'file',
      'hunk',
      'del',
      'add',
      'ctx',
    ]);
  });
});
