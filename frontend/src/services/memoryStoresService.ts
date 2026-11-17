import { api, type ApiClient } from './apiClient';

export interface MemoryStoreSummary {
  id: string;
  name: string;
  description: string;
  created_at: number;
  memories: number;
  bytes: number;
}

export interface MemoryEntry {
  id: string;
  path: string;
  size: number;
  updated_at: number;
  updated_by: string;
  versions: number;
}

export interface MemoryStore {
  id: string;
  name: string;
  description: string;
  created_at: number;
  memories: MemoryEntry[];
}

export interface MemoryVersion {
  id: string;
  operation: 'created' | 'modified' | 'deleted';
  at: number;
  by: string;
  size: number;
  redacted: boolean;
}

export interface MemoryDetail {
  id: string;
  path: string;
  size: number;
  updated_at: number;
  updated_by: string;
  content: string | null;
  versions: MemoryVersion[];
}

/** A memory store as a coding session mounts it: read-write, or read-only. */
export interface MemoryMount {
  store_id: string;
  access: 'read_write' | 'read_only';
}

const base = (id: string) => `/api/memory-stores/${encodeURIComponent(id)}`;

/** Memory stores: versioned folders of lessons that coding sessions read and write. Nothing here calls a model. */
export class MemoryStoresService {
  constructor(private readonly client: ApiClient = api) {}

  list(): Promise<MemoryStoreSummary[]> {
    return this.client.get('/api/memory-stores');
  }

  create(name: string, description: string): Promise<MemoryStore> {
    return this.client.post('/api/memory-stores', { name, description });
  }

  get(id: string): Promise<MemoryStore> {
    return this.client.get(base(id));
  }

  describe(id: string, description: string): Promise<MemoryStore> {
    return this.client.patch(base(id), { description });
  }

  remove(id: string): Promise<{ deleted: string }> {
    return this.client.delete(base(id));
  }

  memory(id: string, memoryId: string): Promise<MemoryDetail> {
    return this.client.get(`${base(id)}/memories/${encodeURIComponent(memoryId)}`);
  }

  add(id: string, path: string, content: string): Promise<MemoryDetail> {
    return this.client.post(`${base(id)}/memories`, { path, content });
  }

  update(id: string, memoryId: string, content: string): Promise<MemoryDetail> {
    return this.client.put(`${base(id)}/memories/${encodeURIComponent(memoryId)}`, { content });
  }

  deleteMemory(id: string, memoryId: string): Promise<{ deleted: string }> {
    return this.client.delete(`${base(id)}/memories/${encodeURIComponent(memoryId)}`);
  }

  version(id: string, versionId: string): Promise<MemoryVersion & { content: string | null; path: string }> {
    return this.client.get(`${base(id)}/versions/${encodeURIComponent(versionId)}`);
  }

  restore(id: string, versionId: string): Promise<MemoryDetail> {
    return this.client.post(`${base(id)}/versions/${encodeURIComponent(versionId)}/restore`, {});
  }

  redact(id: string, versionId: string): Promise<{ redacted: string }> {
    return this.client.post(`${base(id)}/versions/${encodeURIComponent(versionId)}/redact`, {});
  }
}

export const memoryStoresService = new MemoryStoresService(api);
