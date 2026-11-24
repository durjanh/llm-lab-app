/* The store chooser: each access pattern points at the kind of store built for it, and some combinations point at two
   stores working together. Deterministic, so the tests pin the advice. */

export type Need = 'tx' | 'flex' | 'key' | 'wide' | 'similar' | 'graph' | 'text' | 'history';

export const NEEDS: { id: Need; label: string }[] = [
  { id: 'tx', label: 'Writes that must all succeed or all fail, and joins across several kinds of record' },
  { id: 'flex', label: 'Records whose shape varies, read and written whole by their id' },
  { id: 'key', label: 'Very many lookups a second by one key, small values, often with an expiry' },
  { id: 'wide', label: 'A huge, steady stream of time-ordered writes per device or user' },
  { id: 'similar', label: 'Find items by meaning: nearest neighbours of an embedding' },
  { id: 'graph', label: 'Questions that follow relationships several hops deep' },
  { id: 'text', label: 'Full-text search with filters, facets and ranking' },
  { id: 'history', label: 'Aggregations over years of history across many columns' },
];

export type StoreKind =
  'relational' | 'document' | 'keyvalue' | 'widecolumn' | 'vector' | 'graph' | 'search' | 'warehouse';

export interface Store {
  kind: StoreKind;
  name: string;
  examples: string;
  why: string;
  tradeoff: string;
}

export const STORES: Record<StoreKind, Store> = {
  relational: {
    kind: 'relational',
    name: 'Relational database',
    examples: 'PostgreSQL, Azure SQL, Cloud SQL, Amazon RDS or Aurora',
    why: 'Transactions, constraints and joins keep related records consistent. SQL is known by everyone.',
    tradeoff: 'Schema changes need migrations; one primary takes the writes, so very high write rates need sharding.',
  },
  document: {
    kind: 'document',
    name: 'Document database',
    examples: 'Azure Cosmos DB, MongoDB, Firestore, DynamoDB used for documents',
    why: 'Each record is one JSON document, so varied shapes need no migration and a read by id is one round trip.',
    tradeoff: 'Joins and multi-document transactions are limited or costly; the partition key decides cost and scale.',
  },
  keyvalue: {
    kind: 'keyvalue',
    name: 'Key-value store or cache',
    examples: 'Redis (Azure Managed Redis, Memorystore, ElastiCache), DynamoDB',
    why: 'Single-digit millisecond reads by key, expiry built in: sessions, rate limits, online features, caches.',
    tradeoff: 'No queries beyond the key. Treat a cache as losable; keep the source of truth elsewhere.',
  },
  widecolumn: {
    kind: 'widecolumn',
    name: 'Wide-column store',
    examples: 'Apache Cassandra, Bigtable, Cosmos DB for Apache Cassandra',
    why: 'Spreads writes across many nodes by partition key and keeps rows sorted by time inside each partition.',
    tradeoff: 'You design tables for the queries you know; a new kind of query often means a new table.',
  },
  vector: {
    kind: 'vector',
    name: 'Vector index',
    examples: 'pgvector, Azure AI Search, Qdrant, Pinecone, Vertex AI Vector Search, OpenSearch',
    why: 'Approximate nearest-neighbour search over embeddings: retrieval for RAG, similar items, deduplication.',
    tradeoff:
      'Approximate by design; recall depends on index settings. Embeddings must be redone when the model changes.',
  },
  graph: {
    kind: 'graph',
    name: 'Graph database',
    examples: 'Neo4j, Amazon Neptune, Cosmos DB for Apache Gremlin',
    why: 'Following relationships is a pointer hop, not a join, so "who is connected to whom through what" stays fast.',
    tradeoff:
      'A smaller skills pool and fewer managed options; most teams only need one when hops are many and varied.',
  },
  search: {
    kind: 'search',
    name: 'Search engine',
    examples: 'Azure AI Search, Elasticsearch, OpenSearch, Vertex AI Search',
    why: 'Keyword ranking (BM25), filters, facets and, in most engines now, vectors too: hybrid search in one query.',
    tradeoff: 'An index fed from a source of truth, not a database: it needs a pipeline to keep it in step.',
  },
  warehouse: {
    kind: 'warehouse',
    name: 'Warehouse or lakehouse',
    examples: 'Databricks, Microsoft Fabric, BigQuery, Snowflake, Amazon Redshift',
    why: 'Columnar storage and massive parallel scans make aggregations over billions of rows cheap.',
    tradeoff: 'Built for analysis, not for serving one row to an app in milliseconds. Fed in batches or by CDC.',
  },
};

const PRIMARY: Record<Need, StoreKind> = {
  tx: 'relational',
  flex: 'document',
  key: 'keyvalue',
  wide: 'widecolumn',
  similar: 'vector',
  graph: 'graph',
  text: 'search',
  history: 'warehouse',
};

export type VectorScale = 'small' | 'large';

export interface Advice {
  stores: Store[];
  /** Notes on stores that work together, or on one store doing two jobs. */
  combos: string[];
}

/** The stores to use for the chosen needs, and how they fit together. */
export function recommend(needs: Need[], vectors: VectorScale = 'small'): Advice {
  const has = (n: Need) => needs.includes(n);
  const kinds: StoreKind[] = [];
  const add = (k: StoreKind) => {
    if (!kinds.includes(k)) kinds.push(k);
  };
  const combos: string[] = [];

  for (const n of NEEDS.map((x) => x.id)) {
    if (!has(n)) continue;
    // Similarity alone goes to a vector index, but folds into a store already chosen where that store does it well.
    if (n === 'similar' && has('text')) continue;
    if (n === 'similar' && has('tx') && vectors === 'small') continue;
    add(PRIMARY[n]);
  }

  if (has('similar') && has('text'))
    combos.push(
      'Similarity and full text together: use one search engine with hybrid search (keyword and vector in one query, then a reranker) rather than two indexes you merge by hand.',
    );
  if (has('similar') && has('tx') && vectors === 'small')
    combos.push(
      'Similarity on top of relational data, at up to a few million vectors: add pgvector to the same PostgreSQL. One system, vectors filtered by ordinary WHERE clauses and joins, and the embedding written in the same transaction as the row.',
    );
  if (has('similar') && (has('tx') || has('flex')) && vectors === 'large')
    combos.push(
      'Tens of millions of vectors or more: keep the operational database as the source of truth and run a dedicated vector index beside it, kept in step by change data capture or an outbox, so each scales on its own.',
    );
  if (has('similar') && has('flex') && vectors === 'small')
    combos.push(
      'A document database with vector search built in (Cosmos DB and MongoDB Atlas both have one) can hold the record and its embedding together.',
    );
  if (has('history') && (has('tx') || has('flex') || has('key')))
    combos.push(
      'Analytics beside an operational store is the usual pair: never run year-long aggregations on the database serving the app. Copy changes to the lakehouse with CDC or scheduled loads.',
    );
  if (has('key') && (has('tx') || has('flex')))
    combos.push(
      'A cache in front of the database: the database stays the source of truth, the cache holds hot keys with an expiry, and a miss reads through.',
    );
  if (has('graph') && has('similar'))
    combos.push(
      'Relationships plus meaning is the GraphRAG shape: entities and links in a graph, chunks in a vector index, and retrieval that uses both.',
    );

  return { stores: kinds.map((k) => STORES[k]), combos };
}
