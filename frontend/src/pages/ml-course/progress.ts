/* The learner's progress through the course, kept in this browser only. */

export interface Progress {
  /** Weeks marked as done. */
  done: number[];
  /** Best quiz score per week, as correct answers. */
  best: Record<number, number>;
}

export const EMPTY: Progress = { done: [], best: {} };

const KEY = 'ml-course-progress-v1';

/** Reads saved progress; storage can be missing or blocked, and old or damaged data is ignored. */
export function load(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Progress {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return EMPTY;
    const p = JSON.parse(raw) as Partial<Progress>;
    const done = Array.isArray(p.done) ? p.done.filter((n) => Number.isInteger(n) && n >= 0 && n <= 25) : [];
    const best: Record<number, number> = {};
    if (p.best && typeof p.best === 'object')
      for (const [k, v] of Object.entries(p.best)) if (typeof v === 'number' && v >= 0) best[Number(k)] = v;
    return { done: [...new Set(done)].sort((a, b) => a - b), best };
  } catch {
    return EMPTY;
  }
}

/** Saves progress if the browser allows it; the page works the same without. */
export function save(p: Progress, storage: Pick<Storage, 'setItem'> | null = safeStorage()) {
  try {
    storage?.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private window or blocked storage: progress lasts for this visit only */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Applies a change to the progress saved now, not to a copy read when the page opened, then saves it, so two tabs
 * on the course each keep the other's changes. When nothing can be read (blocked storage, or nothing saved yet),
 * the change applies to `current`, the page's own copy, so a private window still remembers this visit.
 */
export function commit(
  change: (p: Progress) => Progress,
  current: Progress,
  storage: (Pick<Storage, 'getItem'> & Pick<Storage, 'setItem'>) | null = safeStorage(),
): Progress {
  let saved: string | null = null;
  try {
    saved = storage?.getItem(KEY) ?? null;
  } catch {
    saved = null;
  }
  const next = change(saved ? load(storage) : current);
  save(next, storage);
  return next;
}

export function toggleDone(p: Progress, week: number): Progress {
  const done = p.done.includes(week) ? p.done.filter((n) => n !== week) : [...p.done, week].sort((a, b) => a - b);
  return { ...p, done };
}

/** Keeps the better of the saved and the new score, so a retake never lowers it. */
export function recordScore(p: Progress, week: number, score: number): Progress {
  return { ...p, best: { ...p.best, [week]: Math.max(p.best[week] ?? 0, score) } };
}

/** A week's quiz counts as passed at three quarters of the questions or more. */
export const passed = (score: number | undefined, total: number) =>
  total > 0 && score !== undefined && score >= Math.ceil(total * 0.75);
