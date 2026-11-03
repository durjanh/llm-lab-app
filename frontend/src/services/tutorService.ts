import { api, type ApiClient } from './apiClient';

export type TutorLevel = 'auto' | 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
export type TutorScenario = 'chat' | 'interview' | 'restaurant' | 'travel' | 'ielts' | 'school';

export interface TutorConfig {
  speech: boolean; // Azure Speech is set up on the server
  region: string | null;
  levels: TutorLevel[];
  scenarios: Record<TutorScenario, string>;
  stages: Record<string, string>;
  subjects: Record<string, string>; // id -> name; any other subject can be named
}

export interface TutorImage {
  media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string; // base64
}

export interface SpeechToken {
  token: string;
  region: string;
  expires_in_s: number;
  fallback: boolean; // a token for the fallback (paid) resource
  has_fallback: boolean; // the server has a fallback resource to switch to
}

export interface WordScore {
  word: string;
  accuracy: number | null;
  error: string | null;
}

/** Azure's pronunciation assessment of something the learner said, out of 100. */
export interface PronunciationScores {
  accuracy: number | null;
  fluency: number | null;
  prosody: number | null;
  completeness: number | null;
  overall?: number | null;
  words: WordScore[];
}

export interface TutorFeedback {
  corrections: { original: string; better: string; why: string }[];
  vocabulary: { term: string; meaning: string; example: string }[];
  level: TutorLevel | 'unknown';
  tip: string;
  praise: string;
  better_answer: string; // how a confident speaker would give the learner's answer; empty for small talk
  add: string[]; // things the learner could add to make the answer stronger
}

export interface TutorTurnRequest {
  message: string;
  history: { role: 'user' | 'assistant'; text: string; images?: TutorImage[] }[];
  images?: TutorImage[];
  subject: string;
  subject_name?: string;
  stage?: string;
  style?: 'explain' | 'hints';
  level: TutorLevel;
  native_language: string;
  scenario: TutorScenario;
  spoken: boolean;
  pronunciation?: PronunciationScores | null;
  model?: string;
  tutor_name?: string; // the person the learner talks to: Sonia, Ava or Ryan
  coaching?: boolean; // English: the tutor says how to make each answer stronger
  interview_brief?: string; // the job interview scenario: the role and company
}

/**
 * One line of a tutor turn: the words to speak as they are written (text), a subject tutor's
 * written explanation (written), English feedback, and the cost.
 */
export type TutorEvent =
  | { type: 'run'; run_id: string }
  | { type: 'text'; text: string }
  | { type: 'written'; text: string }
  | { type: 'reply'; text: string; written?: string; stop_reason: string }
  | ({ type: 'feedback' } & TutorFeedback)
  | { type: 'feedback_error'; message: string }
  | { type: 'error'; message?: string; text?: string }
  | { type: 'done'; cost: number; spent_usd: number };

/** The tutor, for English or any subject. Claude teaches through the backend; the browser speaks and listens with Azure. */
export class TutorService {
  constructor(private readonly client: ApiClient) {}

  config(): Promise<TutorConfig> {
    return this.client.get('/api/tutor/config');
  }

  /** A short-lived Azure Speech token. The Azure key itself never leaves the server. */
  speechToken(fallback = false): Promise<SpeechToken> {
    return this.client.get('/api/tutor/speech-token', { params: fallback ? { fallback: true } : {} });
  }

  turn(req: TutorTurnRequest, onEvent: (event: TutorEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.client.stream('/api/tutor/turn', req, onEvent, signal);
  }
}

export const tutorService = new TutorService(api);
