/* The site builder's state, kept free of React so it can be tested: turns from the server or the stream, the
   errors the running app reports, and the sizes of the split view. */
import type { FileChange, SiteEvent, SiteShot, SiteVersion, StoredTurn } from '@/services/sitesService';

export interface Step {
  kind: 'request' | 'write' | 'read' | 'check' | 'error';
  text: string;
  detail?: string;
  shots?: SiteShot[];
}

export interface Turn {
  id: number;
  /** "restore" is a note that the person restored a version; it has no prompt and no steps. */
  kind: 'message' | 'restore';
  prompt: string;
  steps: Step[];
  draft: string; // what Claude is saying right now
  reply: string;
  state: 'running' | 'done' | 'stopped' | 'error';
  error?: string;
  cost?: number;
  changed: FileChange[];
  version: number | null;
  model: string;
  /** The files were saved but not kept as a version. */
  snapshotError?: string;
}

let nextId = 1;
const id = () => nextId++;

/** A new turn for a message the person has just sent. */
export function startTurn(prompt: string, model: string): Turn {
  return {
    id: id(),
    kind: 'message',
    prompt,
    steps: [],
    draft: '',
    reply: '',
    state: 'running',
    changed: [],
    version: null,
    model,
  };
}

/** The turns of a saved site, as the page shows them. */
export function fromStored(turns: StoredTurn[]): Turn[] {
  return turns.map((t) => ({
    id: id(),
    kind: t.kind === 'restore' ? 'restore' : 'message',
    prompt: t.prompt,
    steps: [],
    draft: '',
    reply: t.reply,
    state: 'done',
    cost: t.cost,
    changed: t.changed ?? [],
    version: t.version ?? null,
    model: t.model,
    snapshotError: t.snapshot_error,
  }));
}

const addStep = (t: Turn, step: Step): Turn => ({ ...t, steps: [...t.steps, step] });

/** How one streamed event changes the turn it belongs to. `who` names the model in the step text. */
export function applyEvent(t: Turn, ev: SiteEvent, who: string): Turn {
  switch (ev.type) {
    case 'text':
      return { ...t, draft: t.draft + ev.text };
    case 'request': {
      const said = t.draft.trim();
      return {
        ...addStep(t, { kind: 'request', text: `Request ${ev.turn} to ${who} · ${ev.stop_reason}`, detail: ev.usage }),
        draft: '',
        reply: said || t.reply,
      };
    }
    case 'tool':
      return addStep(t, {
        kind: !ev.ok ? 'error' : ev.files ? 'write' : 'read',
        text: ev.ok ? ev.detail.split('\n')[0] : `${ev.tool} ${ev.path ?? ''} failed`,
        detail: ev.ok ? (ev.tool === 'list_files' ? ev.detail : undefined) : ev.detail,
      });
    case 'check_start':
      return addStep(t, { kind: 'check', text: `Check ${ev.round}: screenshots at 1280 and 390 pixels wide…` });
    case 'check':
      return addStep(t, {
        kind: 'check',
        text: ev.shots.length
          ? `Check ${ev.round}: ${who} looked at ${ev.shots.length} screenshots`
          : `Check ${ev.round}: skipped`,
        detail: ev.text ?? (ev.errors?.length ? `Console errors:\n${ev.errors.join('\n')}` : 'No console errors.'),
        shots: ev.shots,
      });
    case 'error':
      return { ...t, state: 'error', error: ev.message ?? ev.text };
    case 'files':
      return {
        ...t,
        cost: ev.cost,
        reply: t.draft.trim() || t.reply,
        draft: '',
        changed: ev.changed ?? t.changed,
        version: ev.version ?? t.version,
        snapshotError: ev.snapshot_error ?? t.snapshotError,
      };
    default:
      return t;
  }
}

/** A short line for what a turn changed: "3 files: index.html, css/site.css and 1 more". */
export function changeSummary(changed: FileChange[]): string {
  if (!changed.length) return 'No files changed';
  const names = changed.map((c) => c.path);
  const shown = names.slice(0, 2).join(', ');
  const more = names.length > 2 ? ` and ${names.length - 2} more` : '';
  return `${changed.length} file${changed.length === 1 ? '' : 's'}: ${shown}${more}`;
}

/** An error the running app reported from inside its sandboxed frame. */
export interface PreviewError {
  kind: 'error' | 'promise' | 'console';
  message: string;
  where: string;
  count: number;
}

/**
 * Reads one message from the preview frame. Everything in it is untrusted text from a page the model wrote, so
 * only the known shape is accepted and every field is cut to size; anything else is ignored.
 */
export function readReport(data: unknown): Omit<PreviewError, 'count'> | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.labSiteError !== 1) return null;
  const kind = d.kind === 'promise' || d.kind === 'console' ? d.kind : d.kind === 'error' ? 'error' : null;
  if (!kind || typeof d.message !== 'string' || !d.message.trim()) return null;
  return { kind, message: d.message.slice(0, 500), where: typeof d.where === 'string' ? d.where.slice(0, 200) : '' };
}

/** Adds a report to the list, counting repeats of the same message instead of listing them again. At most 20. */
export function addReport(list: PreviewError[], report: Omit<PreviewError, 'count'>): PreviewError[] {
  const same = list.findIndex((e) => e.message === report.message && e.where === report.where);
  if (same >= 0) return list.map((e, i) => (i === same ? { ...e, count: e.count + 1 } : e));
  return list.length >= 20 ? list : [...list, { ...report, count: 1 }];
}

/** The message "Ask to fix" sends: the errors as the page saw them, and what to do. */
export function fixPrompt(errors: PreviewError[]): string {
  const lines = errors
    .slice(0, 10)
    .map((e) => `- ${e.message}${e.where ? ` (${e.where})` : ''}${e.count > 1 ? ` ×${e.count}` : ''}`);
  return `The preview reported these errors while the site ran:\n${lines.join('\n')}\nFind the cause and fix it.`;
}

/** A version's line in the version menu. */
export function versionLabel(v: SiteVersion, current: number | null): string {
  const time = new Date(v.time * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `v${v.n}${v.n === current ? ' (current)' : ''} · ${v.label.slice(0, 40)} · ${time}`;
}

/** The chat pane's width in pixels for a divider dragged to `x`, keeping both panes usable. */
export function clampSplit(x: number, total: number): number {
  const min = 300;
  const max = Math.max(min, total - 360);
  return Math.round(Math.min(max, Math.max(min, x)));
}

/** A colour for a site's tile when it has no screenshot yet, the same for the same id every time. */
export function tileHue(siteId: string): number {
  let h = 0;
  for (const ch of siteId) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
