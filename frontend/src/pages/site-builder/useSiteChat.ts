import { useCallback, useEffect, useRef, useState } from 'react';
import { modelName } from '@/lib/models';
import { ApiError, sitesService, type SiteEvent, type SiteFile, type SiteShot } from '@/services';

export interface Step {
  kind: 'request' | 'write' | 'read' | 'check' | 'error';
  text: string;
  detail?: string;
  shots?: SiteShot[];
}

export interface Turn {
  id: number;
  prompt: string;
  steps: Step[];
  draft: string; // what Claude is saying right now
  reply: string;
  state: 'running' | 'done' | 'stopped' | 'error';
  error?: string;
  cost?: number;
}

/** The file Claude is writing at this moment, as far as it has got. */
export interface LiveFile {
  id: string;
  tool: 'write_file' | 'edit_file';
  path: string | null;
  text: string;
}

const addStep = (t: Turn, step: Step): Turn => ({ ...t, steps: [...t.steps, step] });

/** How one event changes the turn it belongs to. Files and the live code are kept outside the turns. */
function apply(t: Turn, ev: SiteEvent, model: string): Turn {
  switch (ev.type) {
    case 'text':
      return { ...t, draft: t.draft + ev.text };
    case 'request': {
      const said = t.draft.trim();
      return {
        ...addStep(t, { kind: 'request', text: `Request ${ev.turn} to ${modelName(model)} · stop_reason ${ev.stop_reason}`, detail: ev.usage }),
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
      return addStep(t, { kind: 'check', text: `Check ${ev.round}: taking screenshots at 1280 and 390 pixels wide…` });
    case 'check':
      return addStep(t, {
        kind: 'check',
        text: ev.shots.length ? `Check ${ev.round}: showed ${modelName(model)} ${ev.shots.length} screenshots` : `Check ${ev.round}: skipped`,
        detail: ev.text ?? (ev.errors?.length ? `Console errors:\n${ev.errors.join('\n')}` : 'No console errors.'),
        shots: ev.shots,
      });
    case 'error':
      return { ...t, state: 'error', error: ev.message ?? ev.text };
    case 'files':
      return { ...t, cost: ev.cost, reply: t.draft.trim() || t.reply, draft: '' };
    default:
      return t;
  }
}

/** One site's conversation: its turns, its files, the file being written, and the preview's version. */
export function useSiteChat(model: string) {
  const [siteId, setSiteId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [files, setFiles] = useState<SiteFile[]>([]);
  const [live, setLiveState] = useState<LiveFile | null>(null);
  const liveRef = useRef<LiveFile | null>(null);
  // Files Claude has finished writing in this response but that are not saved yet: tools run once it ends.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0); // goes up whenever a file is saved, so the preview reloads
  const [problem, setProblem] = useState('');
  const controller = useRef<AbortController | null>(null);
  const siteRef = useRef<string | null>(null);
  const nextId = useRef(1);

  useEffect(() => () => controller.current?.abort(), []); // leaving the page stops the run

  const setLive = useCallback((next: LiveFile | null) => {
    liveRef.current = next;
    setLiveState(next);
  }, []);

  const update = useCallback((id: number, change: (t: Turn) => Turn) => {
    setTurns((ts) => ts.map((t) => (t.id === id ? change(t) : t)));
  }, []);

  /** Opens a saved site, or clears the page for a new one when id is null. */
  const open = useCallback(async (id: string | null) => {
    controller.current?.abort();
    siteRef.current = id;
    setSiteId(id);
    setLive(null);
    setDrafts({});
    setProblem('');
    if (!id) {
      setTitle('');
      setTurns([]);
      setFiles([]);
      return;
    }
    try {
      const site = await sitesService.get(id);
      setTitle(site.title);
      setFiles(site.files);
      setTurns(site.turns.map((t) => ({ id: nextId.current++, prompt: t.prompt, steps: [], draft: '', reply: t.reply, state: 'done' })));
      setVersion((v) => v + 1);
    } catch (err) {
      siteRef.current = null;
      setSiteId(null);
      setProblem((err as Error).message);
    }
  }, [setLive]);

  const send = useCallback(
    async (prompt: string) => {
      const id = nextId.current++;
      const c = (controller.current = new AbortController());
      setProblem('');
      setTurns((ts) => [...ts, { id, prompt, steps: [], draft: '', reply: '', state: 'running' }]);
      try {
        await sitesService.turn({ siteId: siteRef.current, prompt, model }, (ev) => {
          if (ev.type === 'site') {
            siteRef.current = ev.site_id;
            setSiteId(ev.site_id);
            setTitle(ev.title);
          } else if (ev.type === 'file_start') {
            const done = liveRef.current;
            if (done?.path && done.tool === 'write_file') setDrafts((d) => ({ ...d, [done.path as string]: done.text }));
            setLive({ id: ev.id, tool: ev.tool, path: null, text: '' });
          } else if (ev.type === 'file_delta') {
            const l = liveRef.current;
            if (l && l.id === ev.id) setLive({ ...l, path: ev.path ?? l.path, text: l.text + ev.text });
          } else if (ev.type === 'tool') {
            if (liveRef.current?.id === ev.id) setLive(null);
            const saved = ev.path;
            if (saved) setDrafts(({ [saved]: _saved, ...rest }) => rest);
            if (ev.files) {
              setFiles(ev.files);
              setVersion((v) => v + 1);
            }
          } else if (ev.type === 'files') {
            setFiles(ev.files);
            setLive(null);
            setDrafts({});
          }
          update(id, (t) => apply(t, ev, model));
        }, c.signal);
        update(id, (t) => (t.state === 'running' ? { ...t, state: 'done' } : t));
      } catch (err) {
        const e = err as Error;
        update(id, (t) => (e.name === 'AbortError' ? { ...t, state: 'stopped' } : { ...t, state: 'error', error: e.message }));
        if (e instanceof ApiError && e.status === 404) siteRef.current = null; // the site was deleted
      } finally {
        setLive(null);
        setDrafts({});
      }
    },
    [model, update, setLive],
  );

  const stop = useCallback(() => controller.current?.abort(), []);

  /** Back to how the site was before turn `index`: that message and everything after it are undone. */
  const restore = useCallback(async (index: number) => {
    const id = siteRef.current;
    if (!id) return;
    try {
      const site = await sitesService.restore(id, index);
      setFiles(site.files);
      setTurns(site.turns.map((t) => ({ id: nextId.current++, prompt: t.prompt, steps: [], draft: '', reply: t.reply, state: 'done' })));
      setVersion((v) => v + 1);
      setProblem('');
    } catch (err) {
      setProblem((err as Error).message);
    }
  }, []);

  return { siteId, title, turns, files, live, drafts, version, problem, running: turns.some((t) => t.state === 'running'), open, send, stop, restore };
}
