import { describe, expect, it } from 'vitest';
import type { CoreAnswer, CoreEvent, CoreStep } from '@/services/cognitiveCoreService';
import { cellKey, EMPTY, reduce, stepText, verdict } from './results';

const answer: CoreAnswer = {
  type: 'answer',
  question: 'q1',
  setup: 'core_tools',
  model: 'small',
  answer: '1912',
  correct: true,
  stopped: null,
  model_calls: 2,
  tool_calls: 1,
  input_tokens: 10,
  output_tokens: 3,
  seconds: 1.2,
  cost_usd: 0,
};
const step = (extra: Partial<CoreStep>): CoreStep => ({
  type: 'step',
  question: 'q1',
  setup: 'core_tools',
  kind: 'call',
  ...extra,
});

describe('a run’s state', () => {
  it('builds up from the stream and ends with the totals', () => {
    const events: CoreEvent[] = [
      { type: 'run', run_id: 'r1' },
      {
        type: 'started',
        questions: ['q1'],
        setups: ['core_tools'],
        core_model: 'small',
        big_model: 'big',
        budget_usd: 1,
      },
      step({ kind: 'call', calls: 1 }),
      step({ kind: 'tool', tool: 'search_library', input: { query: 'bridge' } }),
      answer,
      {
        type: 'done',
        spent_usd: 0.01,
        summary: [
          { setup: 'core_tools', answered: 1, correct: 1, tool_calls: 1, tokens: 13, seconds: 1.2, cost_usd: 0 },
        ],
      },
    ];
    const s = events.reduce(reduce, EMPTY);
    expect(s.coreModel).toBe('small');
    expect(s.bigModel).toBe('big');
    expect(s.steps[cellKey('q1', 'core_tools')]).toHaveLength(2);
    expect(s.answers[cellKey('q1', 'core_tools')].correct).toBe(true);
    expect(s.running).toBe(false);
    expect(s.spent).toBe(0.01);
    expect(reduce({ ...EMPTY, running: true }, { type: 'error', message: 'down' })).toMatchObject({
      running: false,
      error: 'down',
    });
  });

  it('says each step in one line', () => {
    expect(stepText(step({ kind: 'retrieved', titles: ['Kestle', 'Porth Vane'] }))).toBe(
      'Retrieved for it: Kestle, Porth Vane',
    );
    expect(stepText(step({ kind: 'retrieved', titles: [] }))).toBe('Retrieved for it: nothing');
    expect(stepText(step({ kind: 'retrieved' }))).toBe('Retrieved for it: nothing');
    expect(stepText(step({ kind: 'tool', tool: 'calculator', input: { expression: '1+1' } }))).toBe(
      'calculator({"expression":"1+1"})',
    );
    expect(stepText(step({ kind: 'tool', tool: 'calculator' }))).toBe('calculator({})');
    expect(stepText(step({ kind: 'observation', result: { results: [{ title: 'Kestle' }] } }))).toBe('→ Kestle');
    expect(stepText(step({ kind: 'observation', result: { results: [] } }))).toBe('→ nothing matched');
    expect(stepText(step({ kind: 'observation', result: { result: 2 } }))).toBe('→ {"result":2}');
    expect(stepText(step({ kind: 'observation' }))).toBe('→ {}');
    expect(stepText(step({ kind: 'call', calls: 3 }))).toBe('model call 3');
    expect(stepText(step({ kind: 'call' }))).toBe('model call');
  });

  it('names the setup that got most right, or nothing before a run ends', () => {
    expect(verdict([], {})).toBe('');
    const summary = [
      { setup: 'core_closed' as const, answered: 2, correct: 0, tool_calls: 0, tokens: 1, seconds: 1, cost_usd: 0 },
      { setup: 'big_tools' as const, answered: 2, correct: 2, tool_calls: 3, tokens: 1, seconds: 1, cost_usd: 0 },
    ];
    expect(verdict(summary, { core_closed: 'Small, closed', big_tools: 'Big, tools' })).toBe(
      'Small, closed: 0 of 2 · Big, tools: 2 of 2 — most right: Big, tools.',
    );
    expect(verdict(summary, {})).toContain('most right: big_tools');
  });
});
