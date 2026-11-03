import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, decksService, type DecksEvent, type SkillFile } from '@/services';

export interface Step {
  kind: 'upload' | 'request' | 'step' | 'output' | 'says' | 'review' | 'error';
  text: string;
  detail?: string;
}

export interface Turn {
  id: number;
  prompt: string;
  files: string[];
  template: string | null;
  steps: Step[];
  reply: string;
  decks: SkillFile[];
  /** The rendered slides Claude was last shown, so you can see what it checked. */
  checked: { deck: string; slides: SkillFile[] } | null;
  state: 'running' | 'done' | 'stopped' | 'error';
  error?: string;
  cost?: number;
}

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('en-GB')} KB`;
/** "all 8 slides", or "2 changed slides out of 8". */
const changed = (shown: number, total = shown) =>
  shown === total ? `all ${total} slides` : `${shown} changed slide${shown === 1 ? '' : 's'} out of ${total}`;
const addStep = (t: Turn, step: Step): Turn => ({ ...t, steps: [...t.steps, step] });

/** How one event from the server changes the turn it belongs to. */
function apply(t: Turn, ev: DecksEvent): Turn {
  switch (ev.type) {
    case 'upload':
      return addStep(t, { kind: 'upload', text: `Uploaded ${ev.name} into Claude's container`, detail: kb(ev.size_bytes) });
    case 'request':
      return addStep(t, {
        kind: 'request',
        text: `Request ${ev.turn} to Claude · stop_reason ${ev.stop_reason}`,
        detail: ev.stop_reason === 'pause_turn' ? `A long run paused, so the backend sends it back to continue. ${ev.usage}` : ev.usage,
      });
    case 'step':
      return addStep(t, { kind: 'step', text: `In the container: ${ev.name}`, detail: ev.detail });
    case 'output':
      return addStep(t, { kind: 'output', text: `Exit code ${ev.return_code}`, detail: ev.first_line });
    case 'says':
      return { ...addStep(t, { kind: 'says', text: 'Claude', detail: ev.text }), reply: ev.text };
    case 'review':
      return {
        ...addStep(t, {
          kind: 'review',
          text: `Visual check ${ev.round}: ${ev.slides.length ? `showed Claude ${changed(ev.slides.length, ev.total)} of ${ev.deck}` : ev.deck}`,
          detail: ev.text ?? 'Claude checks spacing, alignment, overflow and overlap, and fixes what it finds.',
        }),
        checked: ev.slides.length ? { deck: ev.deck, slides: ev.slides } : t.checked,
      };
    case 'paused':
      return addStep(t, { kind: 'error', text: 'Still paused', detail: ev.text });
    case 'error':
      return { ...t, state: 'error', error: ev.message ?? ev.text };
    case 'files':
      return { ...t, decks: ev.files, cost: ev.cost };
    default:
      return t;
  }
}

/** The deck builder conversation: its turns, and sending, stopping and starting over. */
export function useDeckChat(model: string) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const chatId = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const nextId = useRef(1);

  useEffect(() => () => controller.current?.abort(), []); // leaving the page stops the run

  const update = useCallback((id: number, change: (t: Turn) => Turn) => {
    setTurns((ts) => ts.map((t) => (t.id === id ? change(t) : t)));
  }, []);

  const send = useCallback(
    async (prompt: string, files: File[], template: File | null) => {
      const id = nextId.current++;
      const c = (controller.current = new AbortController());
      setTurns((ts) => [...ts, { id, prompt, files: files.map((f) => f.name), template: template?.name ?? null, steps: [], reply: '', decks: [], checked: null, state: 'running' }]);
      try {
        await decksService.turn({ chatId: chatId.current, prompt, model, files, template }, (ev) => {
          if (ev.type === 'chat') chatId.current = ev.chat_id;
          update(id, (t) => apply(t, ev));
        }, c.signal);
        update(id, (t) => (t.state === 'running' ? { ...t, state: 'done' } : t));
      } catch (err) {
        const e = err as Error;
        if (e instanceof ApiError && e.status === 404) chatId.current = null; // the conversation expired; the next message starts a new one
        update(id, (t) => (e.name === 'AbortError' ? { ...t, state: 'stopped' } : { ...t, state: 'error', error: e.message }));
      }
    },
    [model, update],
  );

  const stop = useCallback(() => controller.current?.abort(), []);

  const reset = useCallback(async () => {
    controller.current?.abort();
    const id = chatId.current;
    chatId.current = null;
    setTurns([]);
    if (id) await decksService.end(id).catch(() => undefined); // deletes your uploads now instead of in a day
  }, []);

  return { turns, running: turns.some((t) => t.state === 'running'), send, stop, reset };
}
