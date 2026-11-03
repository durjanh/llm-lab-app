import { api, type ApiClient } from './apiClient';

export type Sentiment = 'positive' | 'neutral' | 'negative' | 'mixed';
export type Scores = { positive: number; neutral?: number; negative: number };

export interface ProductReview {
  id: string;
  product: string;
  category: string;
  rating: number;
  verified: boolean;
  customer: string;
  date: string;
  text: string;
}

/** What Azure Language's four features returned for one review. */
export interface Analysis {
  language: { name: string; iso: string; confidence: number; script: string } | null;
  sent_as: string;
  sentiment: {
    label: Sentiment;
    scores: Scores;
    sentences: {
      text: string;
      label: Sentiment;
      scores: Scores;
      opinions: {
        target: string;
        sentiment: string;
        assessments: { text: string; sentiment: string; negated: boolean }[];
      }[];
    }[];
  } | null;
  key_phrases: string[];
  entities: { text: string; category: string; subcategory: string; confidence: number }[];
  problems: string[];
}

export interface ReviewsInfo {
  configured: boolean;
  retailer: string;
  categories: string[];
  reviews: ProductReview[];
  price_per_1k_records: number;
  limits: Record<string, number>;
  api_version: string;
  analysed: Record<string, Analysis>;
  spent_usd: number;
}

export interface AnalyzeResult {
  analyses: Record<string, Analysis>;
  analysed: number;
  reused: number;
  requests: Record<string, number>;
  model_versions: Record<string, string>;
  records: number;
  cost_usd: number;
  spent_usd: number;
}

/** Claude's reading of the same review, for comparison. */
export interface ClaudeReading {
  reading: {
    language: { name: string; iso: string };
    sentiment: Sentiment;
    key_phrases: string[];
    key_phrases_english: string[];
    entities: { text: string; category: 'Product' | 'Brand' | 'Location' | 'Other' }[];
    opinions: { target: string; assessment: string; sentiment: string }[];
    english: string;
  };
  model: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  reused: boolean;
  spent_usd: number;
}

/** The review dashboard: Azure Language in Foundry Tools reads multilingual reviews, with Claude beside it. */
export class ReviewsService {
  constructor(private readonly client: ApiClient) {}

  info(): Promise<ReviewsInfo> {
    return this.client.get('/api/reviews/info');
  }

  /** Every sample review when `ids` and `text` are both left out. */
  analyze(body: { ids?: string[]; text?: string } = {}): Promise<AnalyzeResult> {
    return this.client.post('/api/reviews/analyze', body);
  }

  compare(body: { id?: string; text?: string; model?: string }): Promise<ClaudeReading> {
    return this.client.post('/api/reviews/compare', body);
  }
}

export const reviewsService = new ReviewsService(api);
