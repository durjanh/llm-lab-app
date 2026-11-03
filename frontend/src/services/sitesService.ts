import { api, type ApiClient } from './apiClient';

export interface SiteFile {
  path: string;
  size: number;
}

export interface SiteSummary {
  id: string;
  title: string;
  updated: number;
  turns: number;
}

export interface SiteDetail {
  id: string;
  title: string;
  turns: { prompt: string; reply: string; model: string; time: number }[];
  files: SiteFile[];
}

export interface SiteShot {
  name: string; // desktop-1, phone-2 …
  file: string;
}

export interface SiteTurnRequest {
  /** Omit to start a new site. */
  siteId?: string | null;
  prompt: string;
  model?: string;
}

/** One line of a site builder turn. file_start and file_delta carry the code as Claude writes it. */
export type SiteEvent =
  | { type: 'run'; run_id: string }
  | { type: 'site'; site_id: string; title: string; turn: number; model: string }
  | { type: 'text'; text: string }
  | { type: 'file_start'; id: string; tool: 'write_file' | 'edit_file' }
  | { type: 'file_delta'; id: string; path: string | null; text: string }
  | { type: 'tool'; id: string; tool: string; path?: string; ok: boolean; detail: string; files?: SiteFile[] }
  | { type: 'request'; turn: number; stop_reason: string; usage: string; cost: number }
  | { type: 'check_start'; round: number }
  | { type: 'check'; round: number; shots: SiteShot[]; errors?: string[]; text?: string }
  | { type: 'error'; message?: string; text?: string }
  | { type: 'files'; files: SiteFile[]; cost: number; spent_usd: number };

/** The site builder: Claude writes a website into a folder on the backend, which serves it for the preview. */
export class SitesService {
  constructor(private readonly client: ApiClient) {}

  /** Your sites, most recently changed first, and whether the server can take screenshots. */
  list(): Promise<{ sites: SiteSummary[]; screenshots: boolean }> {
    return this.client.get('/api/sites');
  }

  get(id: string): Promise<SiteDetail> {
    return this.client.get(`/api/sites/${encodeURIComponent(id)}`);
  }

  /** Sends one message and streams Claude's work: its words, each file as it is written, and the checks. */
  turn(req: SiteTurnRequest, onEvent: (event: SiteEvent) => void, signal?: AbortSignal): Promise<void> {
    const body = { prompt: req.prompt, ...(req.siteId ? { site_id: req.siteId } : {}), ...(req.model ? { model: req.model } : {}) };
    return this.client.stream('/api/sites/turn', body, onEvent, signal);
  }

  file(id: string, path: string): Promise<string> {
    return this.client.get(`/api/sites/${encodeURIComponent(id)}/file`, { params: { path }, responseType: 'text' });
  }

  /** A screenshot from a check. Fetched with the lab header, so it cannot be a plain image link. */
  shot(id: string, file: string): Promise<Blob> {
    return this.client.blob(`/api/sites/${encodeURIComponent(id)}/shots/${encodeURIComponent(file)}`);
  }

  zip(id: string, title: string): Promise<void> {
    const name = title.toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'site';
    return this.client.saveFile(`/api/sites/${encodeURIComponent(id)}/zip`, `${name}.zip`);
  }

  /** Puts the site back as it was before message `keep` (0 is the first). Replaced files go to backups. */
  restore(id: string, keep: number): Promise<SiteDetail> {
    return this.client.post(`/api/sites/${encodeURIComponent(id)}/restore`, { keep });
  }

  delete(id: string): Promise<{ ok: boolean }> {
    return this.client.delete(`/api/sites/${encodeURIComponent(id)}`);
  }

  /** Where the site is served, sandboxed. The preview frame and "Open in a new tab" use it. */
  previewUrl(id: string, version = 0): string {
    return `/sites/${encodeURIComponent(id)}/index.html${version ? `?v=${version}` : ''}`;
  }
}

export const sitesService = new SitesService(api);
