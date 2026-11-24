/* The event streaming simulation: document changes arrive as events in three partitions, and one consumer per
   partition embeds each document and writes it to a vector index. The reader crashes the consumer, replays the
   stream, and switches on the defences: a partition key, an idempotent consumer and a dead-letter queue. */

export interface DocEvent {
  /** Event id, unique per event: what an idempotent consumer remembers. */
  id: string;
  doc: string;
  title: string;
  version: number;
  /** A corrupt file that fails every time it is processed. */
  poison?: boolean;
}

/** Twelve events in arrival order: three documents change more than once, and one file is corrupt. */
export const EVENTS: DocEvent[] = [
  { id: 'e1', doc: 'A', title: 'Leave policy', version: 1 },
  { id: 'e2', doc: 'B', title: 'Expenses', version: 1 },
  { id: 'e3', doc: 'C', title: 'Travel', version: 1 },
  { id: 'e4', doc: 'A', title: 'Leave policy', version: 2 },
  { id: 'e5', doc: 'D', title: 'Security', version: 1 },
  { id: 'e6', doc: 'B', title: 'Expenses', version: 2 },
  { id: 'e7', doc: 'E', title: 'scanned.pdf', version: 1, poison: true },
  { id: 'e8', doc: 'C', title: 'Travel', version: 2 },
  { id: 'e9', doc: 'A', title: 'Leave policy', version: 3 },
  { id: 'e10', doc: 'F', title: 'Onboarding', version: 1 },
  { id: 'e11', doc: 'D', title: 'Security', version: 2 },
  { id: 'e12', doc: 'B', title: 'Expenses', version: 3 },
];

export const PARTITIONS = 3;
/** With the document id as partition key, every change to one document lands in the same partition, in order. */
const KEYED: Record<string, number> = { A: 0, B: 1, C: 2, D: 0, E: 1, F: 2 };
/** Without a key, the producer fills one partition with a batch, then the next (as Kafka's sticky partitioner does),
    so one document's versions can land in different partitions. */
const SPREAD = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2];
/** Chunks one document version becomes in the index. */
export const CHUNKS_PER_DOC = 2;
/** Attempts before a poison event goes to the dead-letter queue. */
export const MAX_ATTEMPTS = 3;

export interface StreamOptions {
  keyed: boolean;
  idempotent: boolean;
  deadLetter: boolean;
  /** Commit the offset after this many events in a partition. */
  checkpointEvery: number;
}

export interface IndexEntry {
  version: number;
  chunks: number;
}

export interface StreamState {
  partitions: DocEvent[][];
  /** Next offset to read, per partition. Lost on a crash. */
  position: number[];
  /** Last committed offset, per partition: where a restarted consumer starts. */
  checkpoint: number[];
  sinceCheckpoint: number[];
  attempts: Record<string, number>;
  /** The vector index, by document. */
  index: Record<string, IndexEntry>;
  /** Event ids already applied; kept with the index, so it survives a crash. */
  applied: string[];
  deadLetters: DocEvent[];
  embedCalls: number;
  crashed: boolean;
  log: string[];
}

export function partitionEvents(keyed: boolean, events: DocEvent[] = EVENTS): DocEvent[][] {
  const parts: DocEvent[][] = Array.from({ length: PARTITIONS }, () => []);
  events.forEach((e, i) => parts[keyed ? KEYED[e.doc] : SPREAD[i % SPREAD.length]].push(e));
  return parts;
}

export function initStream(opts: StreamOptions): StreamState {
  return {
    partitions: partitionEvents(opts.keyed),
    position: Array(PARTITIONS).fill(0),
    checkpoint: Array(PARTITIONS).fill(0),
    sinceCheckpoint: Array(PARTITIONS).fill(0),
    attempts: {},
    index: {},
    applied: [],
    deadLetters: [],
    embedCalls: 0,
    crashed: false,
    log: [],
  };
}

const clone = (s: StreamState): StreamState => ({
  ...s,
  position: [...s.position],
  checkpoint: [...s.checkpoint],
  sinceCheckpoint: [...s.sinceCheckpoint],
  attempts: { ...s.attempts },
  index: Object.fromEntries(Object.entries(s.index).map(([k, v]) => [k, { ...v }])),
  applied: [...s.applied],
  deadLetters: [...s.deadLetters],
  log: [...s.log],
});

export const finished = (s: StreamState) => s.partitions.every((p, i) => s.position[i] >= p.length);

/** One tick: each partition's consumer handles its next event, in parallel. */
export function step(prev: StreamState, opts: StreamOptions): StreamState {
  if (prev.crashed) return prev;
  const s = clone(prev);
  s.partitions.forEach((events, p) => {
    const e = events[s.position[p]];
    if (!e) return;
    if (opts.idempotent && s.applied.includes(e.id)) {
      s.log.push(`P${p}: ${e.id} already applied, skipped (no embedding call)`);
    } else if (opts.deadLetter && s.deadLetters.some((d) => d.id === e.id)) {
      // A replay meets the poison event again; it is already parked for a person, so it is not parked twice.
      s.log.push(`P${p}: ${e.id} is already in the dead-letter queue, skipped`);
    } else if (e.poison) {
      const n = (s.attempts[e.id] ?? 0) + 1;
      s.attempts[e.id] = n;
      if (opts.deadLetter && n >= MAX_ATTEMPTS) {
        s.deadLetters.push(e);
        s.log.push(`P${p}: ${e.id} failed ${n} times, moved to the dead-letter queue`);
      } else {
        s.log.push(
          `P${p}: ${e.id} (${e.title}) failed, attempt ${n}${opts.deadLetter ? '' : ': the partition waits behind it'}`,
        );
        return;
      }
    } else {
      s.embedCalls++;
      const cur = s.index[e.doc];
      if (opts.idempotent) {
        s.index[e.doc] = { version: e.version, chunks: CHUNKS_PER_DOC };
        s.applied.push(e.id);
      } else {
        // A plain consumer inserts new chunks each time; old ones stay behind.
        s.index[e.doc] = { version: e.version, chunks: (cur?.chunks ?? 0) + CHUNKS_PER_DOC };
      }
      const stale = cur && cur.version > e.version ? `, overwriting newer v${cur.version}` : '';
      s.log.push(`P${p}: ${e.id} indexed ${e.doc} v${e.version}${stale}`);
    }
    s.position[p]++;
    s.sinceCheckpoint[p]++;
    if (s.sinceCheckpoint[p] >= opts.checkpointEvery) {
      s.checkpoint[p] = s.position[p];
      s.sinceCheckpoint[p] = 0;
    }
  });
  return s;
}

/** The consumer dies: what it read since its last checkpoint is forgotten. The index and its applied ids remain. */
export function crash(prev: StreamState): StreamState {
  const s = clone(prev);
  s.crashed = true;
  s.log.push('Consumer crashed before committing its offsets');
  return s;
}

/** A new consumer starts from the committed offsets, so events after them are delivered again. */
export function restart(prev: StreamState): StreamState {
  const s = clone(prev);
  const redelivered = s.position.reduce((n, pos, p) => n + (pos - s.checkpoint[p]), 0);
  s.position = [...s.checkpoint];
  s.sinceCheckpoint = Array(PARTITIONS).fill(0);
  s.crashed = false;
  s.log.push(`Restarted from offsets ${s.checkpoint.join(', ')}: ${redelivered} events will be delivered again`);
  return s;
}

/** Retention lets a new consumer group read from offset 0, for example to rebuild the index after a model change. */
export function replayAll(prev: StreamState): StreamState {
  const s = clone(prev);
  s.position = Array(PARTITIONS).fill(0);
  s.checkpoint = Array(PARTITIONS).fill(0);
  s.sinceCheckpoint = Array(PARTITIONS).fill(0);
  s.attempts = {};
  s.crashed = false;
  s.log.push('Replaying every partition from offset 0');
  return s;
}

export interface StreamReport {
  duplicateChunks: number;
  /** Documents whose indexed version is older than the newest one already processed. */
  stale: string[];
  blocked: boolean;
}

export function report(s: StreamState): StreamReport {
  const newest: Record<string, number> = {};
  s.partitions.forEach((events, p) =>
    events.slice(0, s.position[p]).forEach((e) => {
      if (!e.poison) newest[e.doc] = Math.max(newest[e.doc] ?? 0, e.version);
    }),
  );
  const docs = Object.entries(s.index);
  return {
    duplicateChunks: docs.reduce((n, [, v]) => n + Math.max(0, v.chunks - CHUNKS_PER_DOC), 0),
    stale: docs.filter(([d, v]) => v.version < (newest[d] ?? 0)).map(([d]) => d),
    blocked: s.partitions.some(
      (events, p) => events[s.position[p]]?.poison && (s.attempts[events[s.position[p]].id] ?? 0) > 0,
    ),
  };
}
