import { api, type ApiClient } from './apiClient';

export interface VideoLanguage {
  code: string;
  name: string;
  voice: string;
}

export interface VideoInfo {
  languages: VideoLanguage[];
  max_mb: number;
  max_seconds: number;
  max_rate: number;
  ready: boolean;
  missing: string[];
}

export interface VideoUpload {
  id: string;
  name: string;
  bytes: number;
  duration_s: number;
}

/** One phrase: when it is said, what was said, and its translation; with speech, the spoken file and its speed. */
export interface VideoSegment {
  start: number;
  end: number;
  source_text: string;
  text: string;
  audio?: string;
  audio_s?: number;
  rate?: number;
}

export interface VideoResult {
  id: string;
  detected: { code: string; name: string; locale: string };
  language: { code: string; name: string };
  segments: VideoSegment[];
  voice: boolean;
  duration_s: number;
  cost_usd: number;
  note?: string;
}

/** One line of a translation run: each step as it happens, then the result. */
export type VideoEvent =
  | { type: 'run'; run_id: string }
  | {
      type: 'step';
      step: 'extracting' | 'transcribing' | 'translating' | 'voicing';
      text: string;
      done?: number;
      total?: number;
    }
  | { type: 'transcript'; detected: VideoResult['detected']; segments: number }
  | ({ type: 'done' } & VideoResult)
  | { type: 'error'; message: string };

/** Video translation: upload a video, then subtitles and speech in a chosen language. */
export class VideoTranslateService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<VideoInfo> {
    return this.client.get('/api/video-translate/info');
  }

  upload(file: File): Promise<VideoUpload> {
    const form = new FormData();
    form.append('file', file);
    return this.client.post('/api/video-translate/uploads', form);
  }

  translate(
    id: string,
    language: string,
    voice: boolean,
    onEvent: (e: VideoEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.client.stream(`/api/video-translate/uploads/${id}/translate`, { language, voice }, onEvent, signal);
  }

  /** The uploaded video, for a <video> tag. */
  sourceUrl(id: string): string {
    return `/api/video-translate/media/${id}/source`;
  }
}

export const videoTranslateService = new VideoTranslateService(api);
