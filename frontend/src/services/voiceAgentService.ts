import { api, type ApiClient } from './apiClient';

export interface VoiceSettings {
  end_silence_ms: number;
  eager_threshold: number;
  expressiveness: number;
  voice: string;
  local_voice: string;
  tts: 'azure' | 'local';
  model: string;
}

export interface Plan {
  tag: string;
  rate: number;
  pitch: number;
  pause_ms: number;
  style: string | null;
  degree: number;
  source: string;
  reason: string;
}

export interface VoiceInfo {
  defaults: VoiceSettings;
  tags: string[];
  models: string[];
  claude_model: string;
  voices: { id: string; name: string; styles: string[] }[];
  local_voices: { id: string; name: string }[];
  tts: {
    azure: { available: boolean; reason: string };
    local: { installed: boolean; running: boolean; reason: string; engine: string };
  };
  limits: {
    text: number;
    speak: number;
    end_silence_ms: number[];
    eager_threshold: number[];
    expressiveness: number[];
  };
  prices: { tts_per_1m_chars: number; stt_per_hour: number };
}

export interface LatencyRow {
  turn: number;
  reply_id: string;
  speculative_used: boolean;
  speech_end: number;
  final: number | null;
  end_of_turn: number | null;
  first_token: number | null;
  first_sentence: number | null;
  audio_ready: number | null;
  first_audio_sent: number | null;
  first_audio_played: number | null;
}

export interface LatencyStats {
  turns: number;
  median_ms: number | null;
  p95_ms: number | null;
}

export interface HistoryEntry {
  role: 'user' | 'assistant';
  text: string;
  turn: number;
  reply_id?: string;
  spoken?: string;
  not_spoken?: string;
  interrupted?: boolean;
  heard_confirmed?: boolean;
  method?: string;
  plan?: Plan | null;
  error?: string | null;
}

interface Base {
  t: number;
}

export type VoiceEvent =
  | (Base & { type: 'ready'; settings: VoiceSettings; history: HistoryEntry[] })
  | (Base & {
      type: 'turn_event';
      event: 'StartOfTurn' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn';
      at_ms: number;
      text: string;
      silence_ms: number;
      completeness: number;
      turn: number;
    })
  | (Base & { type: 'transcript'; partial: boolean; text: string; transcribe_ms?: number })
  | (Base & { type: 'reply_start'; reply_id: string; turn: number; speculative: boolean; model: string })
  | (Base & {
      type: 'plan';
      reply_id: string;
      turn: number;
      plan: Plan;
      model_tag: string | null;
      voice: string;
      tts: string;
    })
  | (Base & { type: 'sentence'; reply_id: string; index: number; text: string })
  | (Base & {
      type: 'audio';
      reply_id: string;
      turn: number;
      index: number;
      text: string;
      spoken_as: string;
      duration_ms: number;
      tts_ms: number;
      audio: string;
      last: boolean;
    })
  | (Base & {
      type: 'reply_cancelled';
      reply_id: string;
      turn: number;
      speculative: boolean;
      reason: string;
      wasted_chars?: number;
    })
  | (Base & {
      type: 'reply_done';
      reply_id: string;
      turn: number;
      text: string;
      error: string | null;
      stop_reason: string | null;
    })
  | (Base & (LatencyRow & { type: 'latency'; stats: LatencyStats }))
  | (Base & {
      type: 'barge_in';
      reply_id: string;
      turn: number;
      reason: string;
      played_ms: number | null;
      spoken: string;
      not_spoken: string;
      method: string;
      generation_cut: boolean;
    })
  | (Base & { type: 'error'; message: string; reply_id?: string })
  | (Base & { type: 'closed' });

export type VoiceInput =
  | { type: 'speech_start' }
  | { type: 'speech_end' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string; audio_ms?: number }
  | { type: 'interrupt'; reply_id: string; played_ms: number }
  | { type: 'playback'; reply_id: string; state: 'started' | 'done' };

export interface NormaliseReport {
  before: string;
  after: string;
  segments: { kind: string; before: string; after: string }[];
}

export interface SpeakResult {
  text: string;
  spoken_as: string;
  plan: Plan;
  tts: string;
  tts_ms: number;
  duration_ms: number;
  audio: string;
}

/** The voice agent: conversations kept on the server, live input from the page, and an event stream back. */
export class VoiceAgentService {
  constructor(private readonly client: ApiClient = api) {}

  info(): Promise<VoiceInfo> {
    return this.client.get('/api/voice-agent/info');
  }

  create(settings: Partial<VoiceSettings> = {}): Promise<{ id: string; settings: VoiceSettings }> {
    return this.client.post('/api/voice-agent/conversations', settings);
  }

  get(id: string): Promise<{ id: string; settings: VoiceSettings; history: HistoryEntry[]; latency: LatencyStats }> {
    return this.client.get(`/api/voice-agent/conversations/${id}`);
  }

  settings(id: string, settings: Partial<VoiceSettings>): Promise<VoiceSettings> {
    return this.client.patch(`/api/voice-agent/conversations/${id}/settings`, settings);
  }

  close(id: string): Promise<{ ok: boolean }> {
    return this.client.delete(`/api/voice-agent/conversations/${id}`);
  }

  input(id: string, event: VoiceInput): Promise<{ ok: boolean }> {
    return this.client.post(`/api/voice-agent/conversations/${id}/input`, event);
  }

  text(id: string, text: string): Promise<{ ok: boolean }> {
    return this.client.post(`/api/voice-agent/conversations/${id}/text`, { text });
  }

  /** The conversation's events, until it is closed or the signal aborts. One listener at a time. */
  events(id: string, onEvent: (e: VoiceEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.client.stream(`/api/voice-agent/conversations/${id}/events`, {}, onEvent, signal);
  }

  normalise(text: string): Promise<NormaliseReport> {
    return this.client.post('/api/voice-agent/normalise', { text });
  }

  speak(
    text: string,
    tts: 'azure' | 'local',
    voice: string,
    localVoice: string,
    expressiveness: number,
  ): Promise<SpeakResult> {
    return this.client.post('/api/voice-agent/speak', {
      text,
      tts,
      voice,
      local_voice: localVoice,
      expressiveness,
    });
  }
}

export const voiceAgentService = new VoiceAgentService();
