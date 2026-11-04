import { api, type ApiClient } from './apiClient';

export interface TranslateInfo {
  configured: boolean;
  model: string;
  samples: { label: string; text: string }[];
  targets: string[];
  glossary: Record<string, Record<string, string>>;
  price_per_m_chars: number;
}

export interface TranslatorResult {
  translations: { to: string; text: string; sentences: number }[];
  detected: { language: string; score: number } | null;
  glossary_used: string[];
  chars_billed: number;
  ms: number;
  cost_usd: number;
  spent_usd: number;
}

export interface LlmTranslation {
  to: string;
  text: string;
  ms: number;
  tokens: number;
  cost_usd: number;
  spent_usd: number;
}

export interface ComplaintEntry {
  entry: {
    summary_english: string;
    language: string;
    category: string;
    tone: string;
    vulnerability_signals: string[];
    redress_requested: string;
    deadline_days: number;
    entities: { text: string; kind: string }[];
  };
  ms: number;
  cost_usd: number;
}

export interface AudioAnswer {
  transcript: { speaker: string; start: number; text: string; confidence: number }[];
  summary: string;
  answer: string;
  seconds: number;
  cost_usd: number;
}

/** Translation, domain text analysis, and reasoning over audio. Speech runs in the browser with Azure Speech. */
export class TranslateService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<TranslateInfo> {
    return this.client.get('/api/translate/info');
  }
  translate(text: string, targets: string[], glossary: boolean, profanity: string): Promise<TranslatorResult> {
    return this.client.post('/api/translate/text', { text, targets, glossary, profanity });
  }
  llm(text: string, target: string, tone: string, glossary: boolean): Promise<LlmTranslation> {
    return this.client.post('/api/translate/llm', { text, target, tone, glossary });
  }
  transliterate(
    text: string,
    language: string,
    fromScript: string,
    toScript: string,
  ): Promise<{ text: string; script: string }> {
    return this.client.post('/api/translate/transliterate', {
      text,
      language,
      from_script: fromScript,
      to_script: toScript,
    });
  }
  dictionary(
    word: string,
    source: string,
    target: string,
  ): Promise<{ entries: { target: string; pos: string; confidence: number; back: string[] }[] }> {
    return this.client.post('/api/translate/dictionary', { word, source, target });
  }
  complaint(text: string): Promise<ComplaintEntry> {
    return this.client.post('/api/translate/complaint', { text });
  }
  audio(question: string): Promise<AudioAnswer> {
    return this.client.post('/api/translate/audio', { question });
  }
}

export const translateService = new TranslateService(api);
