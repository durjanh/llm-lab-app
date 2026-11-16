import { useCallback, useEffect, useRef, useState } from 'react';
import {
  voiceAgentService,
  type HistoryEntry,
  type LatencyRow,
  type LatencyStats,
  type Plan,
  type VoiceEvent,
  type VoiceInfo,
  type VoiceInput,
  type VoiceSettings,
} from '@/services/voiceAgentService';
import { base64ToBuffer, Listener, Player } from './audio';

export interface TurnLine {
  id: number;
  event: string;
  turn: number;
  text: string;
  silence_ms: number;
  completeness: number;
  t: number;
}

export interface Reply {
  id: string;
  turn: number;
  speculative: boolean;
  plan: Plan | null;
  modelTag: string | null;
  sentences: { index: number; text: string; spokenAs?: string; ttsMs?: number; durationMs?: number }[];
  status: 'writing' | 'speaking' | 'done' | 'cancelled';
  reason?: string;
  error?: string;
}

export interface BargeIn {
  id: number;
  reply: string;
  playedMs: number | null;
  spoken: string;
  notSpoken: string;
  method: string;
  cut: boolean;
}

export type Mode = 'always' | 'hold';
export type Phase = 'off' | 'starting' | 'listening' | 'hearing' | 'thinking' | 'speaking';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Everything the page does: a conversation on the server, the microphone and recogniser, the event stream back and
 * playback. Input to the server goes through one promise chain, so events arrive in the order they happened.
 */
export function useVoiceAgent(info: VoiceInfo | null) {
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [phase, setPhase] = useState<Phase>('off');
  const [error, setError] = useState('');
  const [partial, setPartial] = useState('');
  const [lines, setLines] = useState<{ who: 'you' | 'agent'; text: string }[]>([]);
  const [turns, setTurns] = useState<TurnLine[]>([]);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [latency, setLatency] = useState<LatencyRow[]>([]);
  const [stats, setStats] = useState<LatencyStats>({ turns: 0, median_ms: null, p95_ms: null });
  const [bargeIns, setBargeIns] = useState<BargeIn[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [level, setLevel] = useState(0);
  const [mode, setMode] = useState<Mode>('always');

  const conv = useRef<string | null>(null);
  const opening = useRef<Promise<string> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const listener = useRef<Listener | null>(null);
  const player = useRef<Player | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const stopped = useRef(new Set<string>()); // replies already stopped here: their late audio is dropped
  const counter = useRef(0);
  const speaking = useRef(false);
  const modeRef = useRef<Mode>('always');
  modeRef.current = mode;

  const send = useCallback((event: VoiceInput) => {
    const id = conv.current;
    if (!id) return;
    chain.current = chain.current.then(() => voiceAgentService.input(id, event)).catch((e) => setError(message(e)));
  }, []);

  const refreshHistory = useCallback(async () => {
    if (conv.current) setHistory((await voiceAgentService.get(conv.current)).history);
  }, []);

  const stopPlayback = useCallback(
    (report: boolean) => {
      const p = player.current;
      if (!p) return;
      const { reply, playedMs } = p.stop();
      if (reply) {
        stopped.current.add(reply);
        if (report) send({ type: 'interrupt', reply_id: reply, played_ms: playedMs });
      }
    },
    [send],
  );

  const onEvent = useCallback(
    (e: VoiceEvent) => {
      switch (e.type) {
        case 'turn_event':
          setTurns((t) =>
            [
              ...t,
              {
                id: ++counter.current,
                event: e.event,
                turn: e.turn,
                text: e.text,
                silence_ms: e.silence_ms,
                completeness: e.completeness,
                t: e.t,
              },
            ].slice(-80),
          );
          if (e.event === 'EndOfTurn') {
            setPartial('');
            setPhase('thinking');
          }
          if (e.event === 'StartOfTurn') setPhase('hearing');
          break;
        case 'transcript':
          if (e.partial) setPartial(e.text);
          else {
            setPartial('');
            setLines((l) => [...l, { who: 'you', text: e.text }]);
          }
          break;
        case 'reply_start':
          setReplies((r) =>
            [
              ...r,
              {
                id: e.reply_id,
                turn: e.turn,
                speculative: e.speculative,
                plan: null,
                modelTag: null,
                sentences: [],
                status: 'writing' as const,
              },
            ].slice(-30),
          );
          break;
        case 'plan':
          setReplies((r) => r.map((x) => (x.id === e.reply_id ? { ...x, plan: e.plan, modelTag: e.model_tag } : x)));
          break;
        case 'sentence':
          setReplies((r) =>
            r.map((x) =>
              x.id === e.reply_id
                ? { ...x, speculative: false, sentences: [...x.sentences, { index: e.index, text: e.text }] }
                : x,
            ),
          );
          break;
        case 'audio':
          setReplies((r) =>
            r.map((x) =>
              x.id === e.reply_id
                ? {
                    ...x,
                    speculative: false,
                    status: 'speaking',
                    sentences: x.sentences.map((s) =>
                      s.index === e.index
                        ? { ...s, spokenAs: e.spoken_as, ttsMs: e.tts_ms, durationMs: e.duration_ms }
                        : s,
                    ),
                  }
                : x,
            ),
          );
          if (!stopped.current.has(e.reply_id) && player.current) {
            speaking.current = true;
            setPhase('speaking');
            void player.current.enqueue(e.reply_id, base64ToBuffer(e.audio)).then(() => {
              if (e.last) player.current?.markComplete(e.reply_id);
            });
          }
          break;
        case 'reply_cancelled':
          setReplies((r) => r.map((x) => (x.id === e.reply_id ? { ...x, status: 'cancelled', reason: e.reason } : x)));
          if (!e.speculative && !stopped.current.has(e.reply_id)) stopPlayback(true); // the server stopped it: say how much played
          break;
        case 'reply_done':
          setReplies((r) =>
            r.map((x) =>
              x.id === e.reply_id
                ? { ...x, status: x.status === 'cancelled' ? x.status : 'done', error: e.error ?? undefined }
                : x,
            ),
          );
          if (e.text) setLines((l) => [...l, { who: 'agent', text: e.text }]);
          player.current?.markComplete(e.reply_id);
          if (!player.current?.busy) setPhase((p) => (p === 'thinking' || p === 'speaking' ? 'listening' : p));
          break;
        case 'latency':
          setLatency((rows) =>
            [...rows.filter((r) => r.turn !== e.turn), e].sort((a, b) => a.turn - b.turn).slice(-30),
          );
          setStats(e.stats);
          break;
        case 'barge_in':
          setBargeIns((b) => [
            ...b,
            {
              id: ++counter.current,
              reply: e.reply_id,
              playedMs: e.played_ms,
              spoken: e.spoken,
              notSpoken: e.not_spoken,
              method: e.method,
              cut: e.generation_cut,
            },
          ]);
          void refreshHistory();
          break;
        case 'error':
          setError(e.message);
          break;
        default:
          break;
      }
    },
    [refreshHistory, stopPlayback],
  );

  const open = useCallback(async (): Promise<string> => {
    if (conv.current) return conv.current;
    // A second call while the first is still creating (Enter pressed twice, or Start then Send) waits for the same
    // conversation, so there is never a second one with an orphaned event stream.
    if (opening.current) return opening.current;
    opening.current = (async () => {
      const created = await voiceAgentService.create(settings ?? {});
      conv.current = created.id;
      setSettings(created.settings);
      abort.current = new AbortController();
      void voiceAgentService.events(created.id, onEvent, abort.current.signal).catch((e) => {
        if ((e as Error).name !== 'AbortError') setError(message(e));
      });
      return created.id;
    })();
    try {
      return await opening.current;
    } finally {
      opening.current = null;
    }
  }, [onEvent, settings]);

  const start = useCallback(async () => {
    setError('');
    setPhase('starting');
    try {
      const p = new Player();
      p.unlock(); // inside the click
      p.onStarted = (reply) => send({ type: 'playback', reply_id: reply, state: 'started' });
      p.onFinished = (reply) => {
        send({ type: 'playback', reply_id: reply, state: 'done' });
        speaking.current = false;
        setPhase('listening');
      };
      player.current = p;
      await open();
      const l = new Listener(
        {
          onSpeechStart: () => {
            // Speaking over the agent: stop at once, report what was played, then tell the server speech started.
            if (player.current?.busy) stopPlayback(true);
            send({ type: 'speech_start' });
          },
          onSpeechEnd: () => send({ type: 'speech_end' }),
          onLevel: (rms) => setLevel(Math.min(1, rms * 8)),
        },
        {
          onPartial: (text) => send({ type: 'partial', text }),
          onFinal: (text, audioMs) => send({ type: 'final', text, audio_ms: Math.round(audioMs) }),
          onError: (m) => setError(m),
        },
        500,
      );
      l.open = modeRef.current === 'always';
      listener.current = l;
      await l.start();
      setPhase('listening');
    } catch (e) {
      setError(message(e));
      listener.current?.stop();
      listener.current = null;
      setPhase('off');
    }
  }, [open, send, stopPlayback]);

  const stop = useCallback(async () => {
    listener.current?.stop();
    listener.current = null;
    player.current?.close();
    player.current = null;
    abort.current?.abort();
    abort.current = null;
    const id = conv.current;
    conv.current = null;
    setPhase('off');
    setPartial('');
    if (id) await voiceAgentService.close(id).catch(() => undefined);
  }, []);

  const typed = useCallback(
    async (text: string) => {
      setError('');
      try {
        if (!player.current) {
          const p = new Player();
          p.unlock();
          p.onStarted = (reply) => send({ type: 'playback', reply_id: reply, state: 'started' });
          p.onFinished = (reply) => send({ type: 'playback', reply_id: reply, state: 'done' });
          player.current = p;
        }
        const id = await open();
        await voiceAgentService.text(id, text);
      } catch (e) {
        setError(message(e));
      }
    },
    [open, send],
  );

  /** Push to talk: audio flows only while the button is held. */
  const hold = useCallback(
    (down: boolean) => {
      const l = listener.current;
      if (!l) return;
      if (down) {
        if (player.current?.busy) stopPlayback(true);
        l.open = true;
      } else {
        l.flushSilence();
        l.endSpeech();
        window.setTimeout(() => {
          if (modeRef.current === 'hold') l.open = false;
        }, 900);
      }
    },
    [stopPlayback],
  );

  const changeSettings = useCallback(async (patch: Partial<VoiceSettings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    if (conv.current) {
      try {
        setSettings(await voiceAgentService.settings(conv.current, patch));
      } catch (e) {
        setError(message(e));
      }
    }
  }, []);

  useEffect(() => {
    if (info && !settings) setSettings(info.defaults);
  }, [info, settings]);

  useEffect(() => {
    if (listener.current) listener.current.open = mode === 'always';
  }, [mode]);

  useEffect(() => () => void stop(), [stop]);

  return {
    settings,
    changeSettings,
    phase,
    error,
    partial,
    lines,
    turns,
    replies,
    latency,
    stats,
    bargeIns,
    history,
    level,
    mode,
    setMode,
    start,
    stop,
    typed,
    hold,
  };
}
