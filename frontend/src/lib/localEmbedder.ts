import { embeddingService, type EmbedKind, type LocalEmbedStatus } from '@/services/embeddingService';

/* Sentence embeddings from the open model in Docker Model Runner, through the backend. It has the same shape as the
   in-browser Embedder (lib/embedder.js), so a page can use either. Vectors are cached per text and kind. */

const BATCH = 64;
const cache = new Map<string, number[]>();
let status: LocalEmbedStatus | null = null;
let dims = 0;

/** Asks the backend once whether a local embedding model is set up and running. */
async function info(): Promise<LocalEmbedStatus> {
  status ??= await embeddingService.localStatus().catch(() => ({ configured: false }));
  return status;
}

async function embed(texts: string[], kind: EmbedKind = 'document'): Promise<number[][]> {
  const key = (t: string) => `${kind}\n${t}`;
  const todo = [...new Set(texts.filter((t) => !cache.has(key(t))))];
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const reply = await embeddingService.embedLocal(batch, kind);
    dims = reply.dims;
    reply.vectors.forEach((v, j) => cache.set(key(batch[j]), v));
  }
  return texts.map((t) => cache.get(key(t)) as number[]);
}

// The backend returns unit-length vectors, so the dot product is the cosine similarity.
const cosine = (a: number[], b: number[]) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export const LocalEmbedder = {
  info,
  embed,
  cosine,
  isReady: () => !!status?.configured && !!status.running && !!status.has_model,
  /** Numbers per text; known after the first embedding. */
  get dims() {
    return dims;
  },
  get model() {
    return status?.model ?? '';
  },
};
