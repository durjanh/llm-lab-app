import { describe, expect, it } from 'vitest';
import type { ConsumerRow, DayRow } from '@/services/controlLayerService';
import {
  burn,
  chartConsumers,
  connectSnippets,
  emptyForm,
  formToPolicy,
  overProjected,
  policySummary,
  policyToForm,
  usd,
} from './logic';

const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];

const row = (over: Partial<ConsumerRow> = {}): ConsumerRow => ({
  id: 'tutor',
  label: 'tutor',
  kind: 'area',
  today_usd: 0,
  month_usd: 0,
  projected_month_usd: 0,
  calls_today: 0,
  saved_month_usd: 0,
  policy: null,
  ...over,
});

describe('money', () => {
  it('shows small amounts with enough places', () => {
    expect(usd(0)).toBe('$0');
    expect(usd(0.00042)).toBe('$0.00042');
    expect(usd(0.25)).toBe('$0.2500');
    expect(usd(12.5)).toBe('$12.50');
  });
});

describe('the policy form', () => {
  it('round-trips a full policy', () => {
    const policy = {
      allowed_models: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
      max_effort: 'medium' as const,
      daily_usd: 2,
      monthly_usd: 30,
      rpm: 20,
      downgrade_at: 0.8,
      downgrade_to: 'claude-haiku-5-5',
      refuse_secrets: true,
      mask_pii: true,
      note: 'Team budget',
    };
    const back = formToPolicy(policyToForm(policy, MODELS));
    expect(back).toEqual({ policy });
  });

  it('sends nothing for empty fields, so they do not apply', () => {
    expect(formToPolicy(emptyForm(MODELS))).toEqual({ policy: { refuse_secrets: true, mask_pii: false } });
  });

  it('says what is wrong instead of sending a bad policy', () => {
    const f = emptyForm(MODELS);
    expect(formToPolicy({ ...f, daily: '-3' })).toEqual({ error: expect.stringContaining('daily budget') });
    expect(formToPolicy({ ...f, rpm: '2.5' })).toEqual({ error: expect.stringContaining('whole number') });
    expect(formToPolicy({ ...f, restrictModels: true, allowed: [] })).toEqual({
      error: expect.stringContaining('at least one'),
    });
    expect(formToPolicy({ ...f, route: 'downgrade' })).toEqual({ error: expect.stringContaining('budget to measure') });
    expect(
      formToPolicy({ ...f, restrictModels: true, allowed: ['claude-sonnet-5-5'], route: 'send', routeTo: MODELS[0] }),
    ).toEqual({ error: expect.stringContaining('allowed') });
  });
});

describe('summaries and budgets', () => {
  it('summarises a policy in short phrases', () => {
    expect(policySummary(null)).toEqual(['No policy: counted only']);
    expect(
      policySummary({ daily_usd: 2, route_to: 'claude-haiku-5-5', refuse_secrets: true, mask_pii: false }),
    ).toEqual(['$2.00/day', '→ claude-haiku-5-5', 'secrets refused']);
  });

  it('reports the tighter of the two budgets', () => {
    expect(burn(row())).toBeNull();
    const b = burn(
      row({
        today_usd: 0.5,
        month_usd: 3,
        policy: { daily_usd: 1, monthly_usd: 30, refuse_secrets: false, mask_pii: false },
      }),
    );
    expect(b?.share).toBeCloseTo(0.5);
    expect(b?.label).toContain('today');
  });

  it('flags a month heading past its budget', () => {
    const p = { monthly_usd: 10, refuse_secrets: false, mask_pii: false };
    expect(overProjected(row({ projected_month_usd: 12, policy: p }))).toBe(true);
    expect(overProjected(row({ projected_month_usd: 8, policy: p }))).toBe(false);
  });

  it('picks the biggest spenders for the chart', () => {
    const days: DayRow[] = [
      { day: '2026-11-25', total_usd: 3, by_consumer: { a: 1, b: 2 } },
      { day: '2026-11-26', total_usd: 4, by_consumer: { a: 4 } },
    ];
    expect(chartConsumers(days)).toEqual(['a', 'b']);
    expect(chartConsumers(days, 1)).toEqual(['a']);
  });
});

describe('connecting a coding agent', () => {
  it('points the agent at the proxy with its key', () => {
    const s = connectSnippets('http://127.0.0.1:8000/', 'llmlab-abc');
    expect(s.env).toBe(
      'export ANTHROPIC_BASE_URL=http://127.0.0.1:8000/control\nexport ANTHROPIC_AUTH_TOKEN=llmlab-abc',
    );
    expect(s.curl).toContain('http://127.0.0.1:8000/control/v1/messages');
    expect(s.curl).toContain('x-api-key: llmlab-abc');
  });
});

describe('Auto routing card', () => {
  it('gives the share per tier and the saving against the baseline', async () => {
    const { autoRoutingSummary } = await import('./logic');
    const s = autoRoutingSummary({
      turns: 4,
      by_tier: { quick: 2, standard: 1, deep: 1 },
      share: { quick: 0.5, standard: 0.25, deep: 0.25 },
      escalations: 1,
      by_classifier: 2,
      actual_usd: 0.03,
      baseline_usd: 0.12,
      saved_usd: 0.09,
    });
    expect(s.tiers).toBe('quick 50% (2), standard 25% (1), deep 25% (1)');
    expect(s.saving).toContain('saved (75%)');
    expect(s.notes).toBe('1 escalation, 2 decided by the classifier');
    const dearer = autoRoutingSummary({
      turns: 1,
      by_tier: { quick: 0, standard: 0, deep: 1 },
      share: { quick: 0, standard: 0, deep: 1 },
      escalations: 0,
      by_classifier: 0,
      actual_usd: 0.2,
      baseline_usd: 0.1,
      saved_usd: -0.1,
    });
    expect(dearer.saving).toContain('more (100%)');
  });
});
