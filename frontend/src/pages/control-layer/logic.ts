/* The control layer page's arithmetic and wording: money, policy summaries, the policy form, budget burn and the
   lines for pointing a coding agent at the lab. No React here, so all of it is tested directly. */
import type { ConsumerRow, DayRow, Effort, Policy } from '@/services/controlLayerService';

export const usd = (v: number): string =>
  v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(5)}` : v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;

export type RouteKind = 'none' | 'send' | 'downgrade';

/** The policy form as the page edits it: strings for number fields, so a half-typed number is not lost. */
export interface PolicyForm {
  restrictModels: boolean;
  allowed: string[];
  maxEffort: '' | Effort;
  daily: string;
  monthly: string;
  rpm: string;
  route: RouteKind;
  routeTo: string;
  downgradeAt: string; // a percentage, 10 to 100
  downgradeTo: string;
  refuseSecrets: boolean;
  maskPii: boolean;
  note: string;
}

export function emptyForm(models: string[]): PolicyForm {
  return {
    restrictModels: false,
    allowed: [...models],
    maxEffort: '',
    daily: '',
    monthly: '',
    rpm: '',
    route: 'none',
    routeTo: models[0] ?? '',
    downgradeAt: '80',
    downgradeTo: models[0] ?? '',
    refuseSecrets: true,
    maskPii: false,
    note: '',
  };
}

export function policyToForm(p: Policy | null, models: string[]): PolicyForm {
  const f = emptyForm(models);
  if (!p) return f;
  return {
    ...f,
    restrictModels: !!p.allowed_models,
    allowed: p.allowed_models ?? [...models],
    maxEffort: p.max_effort ?? '',
    daily: p.daily_usd?.toString() ?? '',
    monthly: p.monthly_usd?.toString() ?? '',
    rpm: p.rpm?.toString() ?? '',
    route: p.route_to ? 'send' : p.downgrade_to ? 'downgrade' : 'none',
    routeTo: p.route_to ?? f.routeTo,
    downgradeAt: p.downgrade_at ? String(Math.round(p.downgrade_at * 100)) : f.downgradeAt,
    downgradeTo: p.downgrade_to ?? f.downgradeTo,
    refuseSecrets: p.refuse_secrets,
    maskPii: p.mask_pii,
    note: p.note ?? '',
  };
}

/** The policy to send, or the first thing wrong with the form, in words. */
export function formToPolicy(f: PolicyForm): { policy: Policy } | { error: string } {
  const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
  const p: Policy = { refuse_secrets: f.refuseSecrets, mask_pii: f.maskPii };
  if (f.restrictModels) {
    if (!f.allowed.length) return { error: 'Choose at least one allowed model, or allow them all.' };
    p.allowed_models = f.allowed;
  }
  if (f.maxEffort) p.max_effort = f.maxEffort;
  for (const [key, value, label] of [
    ['daily_usd', f.daily, 'The daily budget'],
    ['monthly_usd', f.monthly, 'The monthly budget'],
  ] as const) {
    const v = num(value);
    if (v === undefined) continue;
    if (!Number.isFinite(v) || v <= 0) return { error: `${label} must be a number of dollars above 0.` };
    p[key] = v;
  }
  const rpm = num(f.rpm);
  if (rpm !== undefined) {
    if (!Number.isInteger(rpm) || rpm < 1) return { error: 'Requests per minute must be a whole number from 1.' };
    p.rpm = rpm;
  }
  if (f.route === 'send') {
    if (f.restrictModels && !f.allowed.includes(f.routeTo)) return { error: 'Route to a model that is allowed.' };
    p.route_to = f.routeTo;
  } else if (f.route === 'downgrade') {
    const at = num(f.downgradeAt);
    if (at === undefined || !Number.isFinite(at) || at < 10 || at > 100)
      return { error: 'Move to the cheaper model at a share from 10% to 100% of the budget.' };
    if (p.daily_usd === undefined && p.monthly_usd === undefined)
      return { error: 'A downgrade needs a daily or monthly budget to measure against.' };
    if (f.restrictModels && !f.allowed.includes(f.downgradeTo)) return { error: 'Move to a model that is allowed.' };
    p.downgrade_at = at / 100;
    p.downgrade_to = f.downgradeTo;
  }
  if (f.note.trim()) p.note = f.note.trim().slice(0, 200);
  return { policy: p };
}

/** A policy in a few short phrases, for the table. */
export function policySummary(p: Policy | null): string[] {
  if (!p) return ['No policy: counted only'];
  const out: string[] = [];
  if (p.allowed_models) out.push(`${p.allowed_models.length} model${p.allowed_models.length === 1 ? '' : 's'}`);
  if (p.max_effort) out.push(`effort ≤ ${p.max_effort}`);
  if (p.daily_usd) out.push(`${usd(p.daily_usd)}/day`);
  if (p.monthly_usd) out.push(`${usd(p.monthly_usd)}/month`);
  if (p.rpm) out.push(`${p.rpm}/min`);
  if (p.route_to) out.push(`→ ${p.route_to}`);
  if (p.downgrade_to) out.push(`→ ${p.downgrade_to} after ${Math.round((p.downgrade_at ?? 0) * 100)}%`);
  if (p.refuse_secrets) out.push('secrets refused');
  if (p.mask_pii) out.push('contact details masked');
  return out.length ? out : ['Policy with no limits'];
}

/** How much of a budget is spent: the tighter of the daily and monthly, as a share and a sentence. */
export function burn(row: ConsumerRow): { share: number; label: string } | null {
  const p = row.policy;
  const parts: { share: number; label: string }[] = [];
  if (p?.daily_usd)
    parts.push({ share: row.today_usd / p.daily_usd, label: `${usd(row.today_usd)} of ${usd(p.daily_usd)} today` });
  if (p?.monthly_usd)
    parts.push({
      share: row.month_usd / p.monthly_usd,
      label: `${usd(row.month_usd)} of ${usd(p.monthly_usd)} this month`,
    });
  if (!parts.length) return null;
  return parts.reduce((a, b) => (b.share > a.share ? b : a));
}

/** Whether this month's projection runs past the monthly budget. */
export const overProjected = (row: ConsumerRow): boolean =>
  !!row.policy?.monthly_usd && row.projected_month_usd > row.policy.monthly_usd;

/** The consumers that spent anything in the days shown, most first, for the chart's colours and legend. */
export function chartConsumers(days: DayRow[], limit = 6): string[] {
  const totals = new Map<string, number>();
  for (const d of days) for (const [c, v] of Object.entries(d.by_consumer)) totals.set(c, (totals.get(c) ?? 0) + v);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([c]) => c);
}

/** The environment lines and a test request for pointing a coding agent at this lab's proxy. */
export function connectSnippets(origin: string, key: string): { env: string; curl: string } {
  const base = `${origin.replace(/\/$/, '')}/control`;
  return {
    env: `export ANTHROPIC_BASE_URL=${base}\nexport ANTHROPIC_AUTH_TOKEN=${key}`,
    curl:
      `curl -s ${base}/v1/messages \\\n  -H "x-api-key: ${key}" -H "content-type: application/json" \\\n` +
      `  -d '{"model": "claude-haiku-5-5", "max_tokens": 50, "messages": [{"role": "user", "content": "Say hello"}]}'`,
  };
}

/** The Auto routing card's figures in words: the share per tier, and what routing saved against the baseline. */
export function autoRoutingSummary(a: {
  turns: number;
  by_tier: Record<'quick' | 'standard' | 'deep', number>;
  share: Record<'quick' | 'standard' | 'deep', number>;
  escalations: number;
  by_classifier: number;
  actual_usd: number;
  baseline_usd: number;
  saved_usd: number;
}): { tiers: string; saving: string; notes: string } {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const tiers = (['quick', 'standard', 'deep'] as const)
    .map((t) => `${t} ${pct(a.share[t])} (${a.by_tier[t]})`)
    .join(', ');
  const share = a.baseline_usd > 0 ? a.saved_usd / a.baseline_usd : 0;
  const saving =
    a.saved_usd >= 0
      ? `${usd(a.saved_usd)} saved (${pct(share)}): ${usd(a.actual_usd)} against ${usd(a.baseline_usd)}`
      : `${usd(-a.saved_usd)} more (${pct(-share)}): ${usd(a.actual_usd)} against ${usd(a.baseline_usd)}`;
  const notes = `${a.escalations} escalation${a.escalations === 1 ? '' : 's'}, ${a.by_classifier} decided by the classifier`;
  return { tiers, saving, notes };
}
