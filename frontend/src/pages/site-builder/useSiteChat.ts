import { useCallback, useEffect, useRef, useState } from 'react';
import { modelName } from '@/lib/models';
import { ApiError } from '@/services/apiClient';
import { sitesService, type SiteDetail, type SiteFile, type SiteVersion } from '@/services/sitesService';
import { applyEvent, fromStored, startTurn, type Turn } from './model';

/** The file Claude is writing at this moment, as far as it has got. */
export interface LiveFile {
  id: string;
  tool: 'write_file' | 'edit_file';
  path: string | null;
  text: string;
}

/** One site's conversation: its turns, files and versions, the file being written, and the preview's reload key. */
export function useSiteChat(model: string) {
  const [siteId, setSiteId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [files, setFiles] = useState<SiteFile[]>([]);
  const [versions, setVersions] = useState<SiteVersion[]>([]);
  const [live, setLiveState] = useState<LiveFile | null>(null);
  const liveRef = useRef<LiveFile | null>(null);
  // Files Claude has finished writing in this response but that are not saved yet: tools run once it ends.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reload, setReload] = useState(0); // goes up whenever a file is saved, so the preview reloads
  const [problem, setProblem] = useState('');
  const [busyElsewhere, setBusyElsewhere] = useState(false); // a turn running from another tab
  const controller = useRef<AbortController | null>(null);
  const siteRef = useRef<string | null>(null);
  const sending = useRef(false); // set at once on Send, so a double click cannot start two turns

  useEffect(() => () => controller.current?.abort(), []); // leaving the page stops the run

  const setLive = useCallback((next: LiveFile | null) => {
    liveRef.current = next;
    setLiveState(next);
  }, []);

  const update = useCallback((id: number, change: (t: Turn) => Turn) => {
    setTurns((ts) => ts.map((t) => (t.id === id ? change(t) : t)));
  }, []);

  const show = useCallback((site: SiteDetail) => {
    setTitle(site.title);
    setFiles(site.files);
    setVersions(site.versions);
    setTurns(fromStored(site.turns));
    setBusyElsewhere(site.running);
    setReload((v) => v + 1);
  }, []);

  /** Opens a saved site, or clears the page for a new one when id is null. */
  const open = useCallback(
    async (id: string | null) => {
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
        setVersions([]);
        setBusyElsewhere(false);
        return;
      }
      try {
        show(await sitesService.get(id));
      } catch (err) {
        siteRef.current = null;
        setSiteId(null);
        setProblem((err as Error).message);
      }
    },
    [setLive, show],
  );

  const send = useCallback(
    async (prompt: string) => {
      if (sending.current) return;
      sending.current = true;
      const turn = startTurn(prompt, model);
      const c = (controller.current = new AbortController());
      setProblem('');
      setTurns((ts) => [...ts, turn]);
      const who = modelName(model);
      try {
        await sitesService.turn(
          { siteId: siteRef.current, prompt, model },
          (ev) => {
            if (ev.type === 'site') {
              siteRef.current = ev.site_id;
              setSiteId(ev.site_id);
              setTitle(ev.title);
            } else if (ev.type === 'file_start') {
              const done = liveRef.current;
              if (done?.path && done.tool === 'write_file')
                setDrafts((d) => ({ ...d, [done.path as string]: done.text }));
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
                setReload((v) => v + 1);
              }
            } else if (ev.type === 'version') {
              setVersions((vs) => [...vs.filter((v) => v.n !== ev.version.n), ev.version].slice(-20));
            } else if (ev.type === 'files') {
              setFiles(ev.files);
              setLive(null);
              setDrafts({});
            }
            update(turn.id, (t) => applyEvent(t, ev, who));
          },
          c.signal,
        );
        update(turn.id, (t) => (t.state === 'running' ? { ...t, state: 'done' } : t));
      } catch (err) {
        const e = err as Error;
        update(turn.id, (t) =>
          e.name === 'AbortError' ? { ...t, state: 'stopped' } : { ...t, state: 'error', error: e.message },
        );
        if (e instanceof ApiError && e.status === 404) siteRef.current = null; // the site was deleted
      } finally {
        sending.current = false;
        setLive(null);
        setDrafts({});
        // What the server kept is the truth: the turn as stored, its version, and any later change.
        const id = siteRef.current;
        if (id && controller.current === c) {
          sitesService
            .get(id)
            .then((site) => {
              if (siteRef.current !== id) return;
              setVersions(site.versions);
              setFiles(site.files);
              setTitle(site.title);
            })
            .catch(() => undefined);
        }
      }
    },
    [model, update, setLive],
  );

  const stop = useCallback(() => controller.current?.abort(), []);

  const restoreVersion = useCallback(
    async (n: number) => {
      const id = siteRef.current;
      if (!id) return;
      try {
        show(await sitesService.restoreVersion(id, n));
        setProblem('');
      } catch (err) {
        setProblem((err as Error).message);
      }
    },
    [show],
  );

  const rename = useCallback(async (next: string) => {
    const id = siteRef.current;
    if (!id || !next.trim()) return;
    try {
      const site = await sitesService.rename(id, next);
      setTitle(site.title);
    } catch (err) {
      setProblem((err as Error).message);
    }
  }, []);

  const running = turns.some((t) => t.state === 'running');
  return {
    siteId,
    title,
    turns,
    files,
    versions,
    live,
    drafts,
    reload,
    problem,
    running,
    busyElsewhere: busyElsewhere && !running,
    open,
    send,
    stop,
    restoreVersion,
    rename,
  };
}
