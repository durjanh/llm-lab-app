import { api, type ApiClient } from './apiClient';

/** Whether an open embedding model is set up on this machine (LLM_LAB_LOCAL_EMBED_MODEL) and its server is running. */
export interface LocalEmbedStatus {
  configured: boolean;
  running?: boolean;
  has_model?: boolean;
  model?: string;
}

/** A stored passage, or a question to match against passages: some models embed the two differently. */
export type EmbedKind = 'document' | 'query';

/** Embeddings from the open model in Docker Model Runner. Free, and the text stays on this machine. */
export class EmbeddingService {
  constructor(private readonly client: ApiClient) {}

  localStatus(): Promise<LocalEmbedStatus> {
    return this.client.get('/api/embeddings/local');
  }

  /** One unit-length vector per text, in order. At most 128 texts a call. */
  embedLocal(texts: string[], kind: EmbedKind = 'document') {
    return this.client.post<{ model: string; dims: number; vectors: number[][] }>('/api/embeddings/local', {
      texts,
      kind,
    });
  }
}

export const embeddingService = new EmbeddingService(api);
