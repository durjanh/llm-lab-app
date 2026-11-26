import { describe, expect, it } from 'vitest';
import type { AssistantEvent, AssistantFile, Plan, StopReason, Turn } from '@/services/assistantService';
import {
  describe as describeEvent,
  endWithError,
  fromStored,
  reduceTurn,
  startTurn,
  STOPPED_TEXT,
  type TurnState,
} from './state';

let clock = 1000;
const ev = (e: Record<string, unknown>) => ({ ts: clock++, ...e }) as AssistantEvent;
const run = (events: AssistantEvent[], s: TurnState = startTurn({ text: 'hi', attachments: [] })) =>
  events.reduce(reduceTurn, s);

const file = (id: string, name: string, media_type = 'application/pdf'): AssistantFile => ({
  id,
  name,
  size: 10,
  media_type,
  url: `/api/assistant/media/c/${id}`,
  previews: [],
});
const plan = (revision: number, ...steps: [string, 'todo' | 'doing' | 'done' | 'skipped'][]): Plan => ({
  revision,
  steps: steps.map(([text, status]) => ({ text, status })),
});

describe('a turn as it streams', () => {
  it('records the run and turn ids, the model, the reply and the cost', () => {
    const s = run([
      ev({ type: 'run', run_id: 'r1' }),
      ev({ type: 'turn', turn_id: 't1' }),
      ev({ type: 'model_call', agent: 'main', model: 'claude-haiku-5-5', effort: 'low', n: 1 }),
      ev({ type: 'text', agent: 'main', delta: 'Hello ' }),
      ev({ type: 'text', agent: 'main', delta: 'there.' }),
      ev({
        type: 'usage',
        agent: 'main',
        model: 'claude-haiku-5-5',
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cost_usd: 0.01,
        run_cost_usd: 0.01,
      }),
    ]);
    expect(s.runId).toBe('r1');
    expect(s.turnId).toBe('t1');
    expect(s.model).toBe('claude-haiku-5-5');
    expect(s.modelsUsed).toEqual(['claude-haiku-5-5']);
    expect(s.text).toBe('Hello there.');
    expect(s.costUsd).toBeCloseTo(0.01);
    expect(s.stopped).toBeNull();
  });

  it('joins consecutive text deltas into one log row', () => {
    const s = run([ev({ type: 'text', agent: 'main', delta: 'a' }), ev({ type: 'text', agent: 'main', delta: 'b' })]);
    const main = s.lanes.find((l) => l.agent === 'main')!;
    expect(main.events).toHaveLength(1);
    expect(main.events[0]).toMatchObject({ type: 'text', delta: 'ab' });
  });

  it('keeps sub-agents in their own lanes, in order, and their text out of the reply', () => {
    const s = run([
      ev({ type: 'agent_start', agent: 'sub-2', brief: 'Chart', expected_output: 'chart.png' }),
      ev({ type: 'agent_start', agent: 'sub-1', brief: 'Table', expected_output: 'table.csv' }),
      ev({ type: 'text', agent: 'sub-1', delta: 'sub text' }),
      ev({
        type: 'usage',
        agent: 'sub-1',
        model: 'm',
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cost_usd: 0.02,
        run_cost_usd: 0.05,
      }),
      ev({ type: 'agent_end', agent: 'sub-1', summary: 'done', cost_usd: 0.02, stopped: 'finished' }),
      ev({ type: 'tool_call', agent: 'main', id: 'x', name: 'delegate', input: {}, network: false }),
    ]);
    expect(s.lanes.map((l) => l.agent)).toEqual(['main', 'sub-1', 'sub-2']);
    expect(s.text).toBe('');
    const sub1 = s.lanes.find((l) => l.agent === 'sub-1')!;
    expect(sub1).toMatchObject({ brief: 'Table', status: 'done', stopped: 'finished', costUsd: 0.02 });
    expect(s.lanes.find((l) => l.agent === 'sub-2')!.status).toBe('running');
    expect(s.costUsd).toBeCloseTo(0.05);
  });

  it('shows the main agent’s plan and each revision with its reason; sub-agent plans stay in their lane', () => {
    const s = run([
      ev({ type: 'plan', agent: 'main', plan: plan(1, ['Read the file', 'todo'], ['Make a chart', 'todo']) }),
      ev({ type: 'plan', agent: 'sub-1', plan: plan(1, ['Sub step', 'doing']) }),
      ev({
        type: 'plan',
        agent: 'main',
        plan: plan(2, ['Read the file', 'done'], ['Use a bar chart', 'doing']),
        reason: 'Line chart failed',
      }),
    ]);
    expect(s.plan?.revision).toBe(2);
    expect(s.plan?.steps.map((x) => x.text)).toEqual(['Read the file', 'Use a bar chart']);
    expect(s.planReason).toBe('Line chart failed');
    expect(s.lanes.find((l) => l.agent === 'sub-1')!.events).toHaveLength(1);
  });

  it('holds a plan for approval until the turn ends', () => {
    const p = plan(1, ['Do it', 'todo']);
    const s = run([ev({ type: 'plan_approval', approval_id: 'a1', plan: p })]);
    expect(s.approval).toEqual({ approvalId: 'a1', plan: p });
    expect(s.plan).toEqual(p);
    const done = reduceTurn(s, ev({ type: 'done', stopped: 'stopped', cost_usd: 0, text: '' }));
    expect(done.approval).toBeNull();
  });

  it('adds new files and replaces a file that changed', () => {
    const s = run([
      ev({ type: 'file', agent: 'main', file: file('f1', 'report.pdf') }),
      ev({ type: 'file', agent: 'sub-1', file: file('f2', 'chart.png', 'image/png') }),
      ev({ type: 'file', agent: 'main', file: { ...file('f3', 'report.pdf'), size: 99 } }),
    ]);
    expect(s.files.map((f) => f.name)).toEqual(['report.pdf', 'chart.png']);
    expect(s.files[0].size).toBe(99);
  });

  it('logs tool calls, results, compaction, model switches, fallbacks and thinking in the right lane', () => {
    const s = run([
      ev({ type: 'model_switch', from: 'a', to: 'b' }),
      ev({
        type: 'compaction',
        covers_until: '000003-02',
        tokens_before: 90000,
        tokens_after: 4000,
        model: 'claude-haiku-5-5',
      }),
      ev({ type: 'thinking', agent: 'main', text: 'I should check the columns.' }),
      ev({
        type: 'tool_call',
        agent: 'main',
        id: 'c1',
        name: 'bash',
        input: { command: 'curl https://example.com' },
        network: true,
      }),
      ev({
        type: 'tool_result',
        agent: 'main',
        id: 'c1',
        ok: true,
        output: 'ok',
        exit_code: 0,
        duration_ms: 1200,
        truncated: false,
      }),
      ev({ type: 'fallback', agent: 'main', from: 'b', to: 'c', reason: '529' }),
    ]);
    const types = s.lanes.find((l) => l.agent === 'main')!.events.map((e) => e.type);
    expect(types).toEqual(['model_switch', 'compaction', 'thinking', 'tool_call', 'tool_result', 'fallback']);
  });

  it('takes the title, and records an error message', () => {
    const s = run([ev({ type: 'title', title: 'Sales report' }), ev({ type: 'error', message: 'Sandbox went away' })]);
    expect(s.title).toBe('Sales report');
    expect(s.error).toBe('Sandbox went away');
  });
});

describe('how a turn ends', () => {
  for (const stopped of ['finished', 'budget', 'time', 'stopped', 'refused', 'error'] as StopReason[]) {
    it(`records "${stopped}" with the final text and cost, and closes every lane`, () => {
      const s = run([
        ev({ type: 'agent_start', agent: 'sub-1', brief: 'x', expected_output: 'y' }),
        ev({ type: 'text', agent: 'main', delta: 'partial' }),
        ev({ type: 'done', stopped, cost_usd: 0.3, text: 'Final answer.' }),
      ]);
      expect(s.stopped).toBe(stopped);
      expect(s.costUsd).toBeCloseTo(0.3);
      expect(s.text).toBe('Final answer.');
      expect(s.lanes.every((l) => l.status === 'done')).toBe(true);
      expect(STOPPED_TEXT[stopped].length).toBeGreaterThan(0);
    });
  }

  it('keeps the streamed text when the final line has none', () => {
    const s = run([
      ev({ type: 'text', agent: 'main', delta: 'kept' }),
      ev({ type: 'done', stopped: 'stopped', cost_usd: 0, text: '' }),
    ]);
    expect(s.text).toBe('kept');
  });

  it('ignores anything that arrives after the turn has finished', () => {
    const done = run([ev({ type: 'done', stopped: 'finished', cost_usd: 0.1, text: 'x' })]);
    const after = run(
      [
        ev({ type: 'text', agent: 'main', delta: 'late' }),
        ev({ type: 'file', agent: 'main', file: file('f', 'late.pdf') }),
      ],
      done,
    );
    expect(after).toBe(done);
  });

  it('ignores unknown event types and malformed lines', () => {
    const s = startTurn({ text: '', attachments: [] });
    expect(reduceTurn(s, ev({ type: 'surprise', agent: 'main' }))).toBe(s);
    expect(reduceTurn(s, null as unknown as AssistantEvent)).toBe(s);
  });

  it('ends a broken stream as an error, once', () => {
    const s = run([ev({ type: 'text', agent: 'main', delta: 'half' })]);
    const e = endWithError(s, 'connection lost');
    expect(e.stopped).toBe('error');
    expect(e.error).toBe('connection lost');
    expect(e.text).toBe('half');
    expect(endWithError(e, 'again')).toBe(e);
  });
});

describe('a stored turn', () => {
  const turn: Turn = {
    id: 't9',
    created_at: '2026-11-25T10:00:00Z',
    user: { text: 'Make a deck', attachments: [] },
    assistant: {
      text: 'Here is the deck.',
      model: 'claude-sonnet-5-5',
      models_used: ['claude-sonnet-5-5'],
      plan: plan(1, ['Write slides', 'done']),
      files: [file('d1', 'deck.pptx')],
      cost_usd: 0.4,
      stopped: 'finished',
    },
    log_count: 3,
  };

  it('takes its content from the store and its lanes from the saved log', () => {
    const s = fromStored(turn, [
      ev({ type: 'tool_call', agent: 'main', id: 'c', name: 'bash', input: { command: 'ls' }, network: false }),
      ev({ type: 'agent_start', agent: 'sub-1', brief: 'b', expected_output: 'o' }),
    ]);
    expect(s.text).toBe('Here is the deck.');
    expect(s.files[0].name).toBe('deck.pptx');
    expect(s.stopped).toBe('finished');
    expect(s.lanes.map((l) => l.agent)).toEqual(['main', 'sub-1']);
    expect(s.lanes.every((l) => l.status === 'done')).toBe(true);
  });

  it('works with no log at all', () => {
    expect(fromStored(turn).lanes).toEqual([]);
  });
});

describe('activity rows', () => {
  it('flags network commands and failures, and describes every event type', () => {
    expect(
      describeEvent(
        ev({
          type: 'tool_call',
          agent: 'main',
          id: 'c',
          name: 'bash',
          input: { command: 'pip install x' },
          network: true,
        }),
      ).tone,
    ).toBe('network');
    expect(
      describeEvent(
        ev({
          type: 'tool_result',
          agent: 'main',
          id: 'c',
          ok: false,
          output: 'boom',
          exit_code: 1,
          duration_ms: 5,
          truncated: true,
        }),
      ),
    ).toMatchObject({
      tone: 'error',
      detail: 'boom',
    });
    const all: Record<string, unknown>[] = [
      { type: 'run', run_id: 'r' },
      { type: 'turn', turn_id: 't' },
      { type: 'model_call', agent: 'main', model: 'm', effort: null, n: 1 },
      { type: 'plan_approval', approval_id: 'a', plan: plan(1) },
      { type: 'file', agent: 'main', file: file('f', 'a.pdf') },
      { type: 'agent_end', agent: 'sub-1', summary: 's', cost_usd: 0, stopped: 'budget' },
      { type: 'title', title: 't' },
      { type: 'done', stopped: 'time', cost_usd: 0, text: '' },
      { type: 'error', message: 'm' },
    ];
    for (const e of all) expect(describeEvent(ev(e)).title.length).toBeGreaterThan(0);
  });
});

describe('MCP tools, notes and partial costs', () => {
  it('queues tool approvals once each, clears an answered one, and clears the rest when the turn ends', async () => {
    const { answeredTool } = await import('./state');
    const ask = (id: string) =>
      ev({ type: 'tool_approval', approval_id: id, agent: 'sub-1', server: 'Wiki', tool: 'search', input: { q: 'x' } });
    let s = run([ev({ type: 'run', run_id: 'r1' }), ask('a1'), ask('a1'), ask('a2')]);
    expect(s.toolApprovals.map((a) => [a.approvalId, a.agent, a.server, a.tool])).toEqual([
      ['a1', 'sub-1', 'Wiki', 'search'],
      ['a2', 'sub-1', 'Wiki', 'search'],
    ]);
    s = answeredTool(s, 'a1');
    expect(s.toolApprovals.map((a) => a.approvalId)).toEqual(['a2']);
    s = reduceTurn(s, ev({ type: 'done', stopped: 'finished', cost_usd: 0, text: 'ok' }));
    expect(s.toolApprovals).toEqual([]);
  });

  it('keeps the main agent’s notes for under the reply, and every note in its lane', () => {
    const s = run([
      ev({ type: 'note', agent: 'main', text: 'The plan still has 1 of 3 steps not done.' }),
      ev({ type: 'note', agent: 'sub-2', text: 'Some MCP tools were left out.' }),
    ]);
    expect(s.notes).toEqual(['The plan still has 1 of 3 steps not done.']);
    expect(s.lanes.find((l) => l.agent === 'sub-2')?.events.map((e) => e.type)).toEqual(['note']);
    expect(describeEvent(ev({ type: 'note', agent: 'main', text: 'Hello' })).title).toBe('Hello');
  });

  it('labels a partial, estimated charge, and shows an MCP call with the server’s description as plain text', () => {
    const usage = describeEvent(
      ev({
        type: 'usage',
        agent: 'main',
        model: 'm',
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 0,
        cost_usd: 0.001,
        run_cost_usd: 0.002,
        partial: true,
      }),
    );
    expect(usage.title).toContain('partial, estimated');
    const call = describeEvent(
      ev({
        type: 'tool_call',
        agent: 'main',
        id: 't1',
        name: 'mcp__wiki__search',
        input: { q: 'pay' },
        network: false,
        mcp: { server_id: 's1', server: 'Wiki', tool: 'search', description: '<b>Searches</b> the wiki' },
      }),
    );
    expect(call.title).toBe('Wiki › search');
    expect(call.detail).toContain('Described by the server: <b>Searches</b> the wiki');
    expect(call.detail).toContain('"q": "pay"');
    expect(
      describeEvent(
        ev({ type: 'tool_approval', approval_id: 'a', agent: 'main', server: 'Wiki', tool: 'search', input: {} }),
      ).title,
    ).toContain('Wiki › search');
  });

  it('shows a stored turn that is still running as such', () => {
    expect(STOPPED_TEXT.running).toBe('Still running.');
  });
});

describe('Auto routing events', () => {
  it('records the route, then the tier it moved up to, and describes both as route rows', async () => {
    const { describe: row, reduceTurn: reduce, startTurn: start } = await import('./state');
    const route = {
      type: 'route' as const,
      ts: 1,
      agent: 'main',
      model: 'claude-haiku-5-5',
      effort: 'low' as const,
      tier: 'quick' as const,
      reason: 'a short question',
      by: 'rules' as const,
      classifier_cost_usd: 0,
    };
    const escalate = {
      type: 'escalate' as const,
      ts: 2,
      agent: 'main',
      from: 'claude-haiku-5-5',
      to: 'claude-sonnet-5-5',
      effort: 'medium' as const,
      tier: 'standard' as const,
      reason: 'the model declined',
    };
    let s = reduce(start({ text: 'hi', attachments: [] }), route);
    expect(s.route).toMatchObject({ model: 'claude-haiku-5-5', tier: 'quick', escalated_to: null });
    s = reduce(s, escalate);
    expect(s.route?.escalated_to).toBe('claude-sonnet-5-5');
    expect(row(route)).toMatchObject({ tone: 'route', title: 'Auto chose claude-haiku-5-5, low effort (quick)' });
    expect(row(route).detail).toContain('a short question');
    expect(row(escalate)).toMatchObject({ tone: 'route', title: 'Moved up to claude-sonnet-5-5 (standard)' });
  });
});
