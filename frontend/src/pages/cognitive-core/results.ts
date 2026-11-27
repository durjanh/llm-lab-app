import type { CoreAnswer, CoreEvent, CoreStep, CoreSummary, SetupId } from '@/services/cognitiveCoreService';

/** What a run has shown so far: each cell's answer (question × setup), its live steps, and the totals at the end. */
export interface RunState {
  running: boolean;
  coreModel: string;
  bigModel: string;
  answers: Record<string, CoreAnswer>; // by cellKey
  steps: Record<string, CoreStep[]>; // by cellKey
  summary: CoreSummary[];
  spent: number;
  error: string;
}

export const EMPTY: RunState = {
  running: false,
  coreModel: '',
  bigModel: '',
  answers: {},
  steps: {},
  summary: [],
  spent: 0,
  error: '',
};

export const cellKey = (question: string, setup: SetupId) => `${question}|${setup}`;

/** The run's state after one more event from the stream. */
export function reduce(state: RunState, e: CoreEvent): RunState {
  switch (e.type) {
    case 'started':
      return { ...EMPTY, running: true, coreModel: e.core_model, bigModel: e.big_model };
    case 'step': {
      const key = cellKey(e.question, e.setup);
      return { ...state, steps: { ...state.steps, [key]: [...(state.steps[key] ?? []), e] } };
    }
    case 'answer':
      return { ...state, answers: { ...state.answers, [cellKey(e.question, e.setup)]: e } };
    case 'done':
      return { ...state, running: false, summary: e.summary, spent: e.spent_usd };
    case 'error':
      return { ...state, running: false, error: e.message };
    default:
      return state;
  }
}

/** One line for a step, as the cell's trace shows it. */
export function stepText(s: CoreStep): string {
  switch (s.kind) {
    case 'retrieved':
      return `Retrieved for it: ${(s.titles ?? []).join(', ') || 'nothing'}`;
    case 'tool':
      return `${s.tool}(${JSON.stringify(s.input ?? {})})`;
    case 'observation': {
      const r = s.result ?? {};
      if (Array.isArray(r.results)) {
        const titles = (r.results as { title: string }[]).map((x) => x.title);
        return titles.length ? `→ ${titles.join(', ')}` : '→ nothing matched';
      }
      return `→ ${JSON.stringify(r)}`;
    }
    default:
      return `model call ${s.calls ?? ''}`.trim();
  }
}

/** The headline for a finished run: which setups got how many right. */
export function verdict(summary: CoreSummary[], names: Record<string, string>): string {
  if (!summary.length) return '';
  const best = [...summary].sort((a, b) => b.correct - a.correct)[0];
  return (
    summary.map((s) => `${names[s.setup] ?? s.setup}: ${s.correct} of ${s.answered}`).join(' · ') +
    ` — most right: ${names[best.setup] ?? best.setup}.`
  );
}
