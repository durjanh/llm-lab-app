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
  /** How many versions are kept. */
  versions: number;
  /** The newest desktop screenshot's file name, for a thumbnail; null before the first check. */
  thumb: string | null;
  running: boolean;
}

/** What a turn did to one file. */
export interface FileChange {
  path: string;
  change: 'added' | 'changed' | 'deleted';
}

/** A snapshot of the site's files after a turn that changed them. The newest is the current site. */
export interface SiteVersion {
  n: number;
  label: string;
  time: number;
  files: number;
}

export interface StoredTurn {
  /** "restore" marks a version the person restored between messages; it has no prompt. */
  kind?: 'restore';
  prompt: string;
  reply: string;
  model: string;
  time: number;
  changed?: FileChange[];
  version?: number | null;
  cost?: number;
  /** Set when the turn's files were saved but could not be kept as a version. */
  snapshot_error?: string;
}

export interface SiteDetail {
  id: string;
  title: string;
  turns: StoredTurn[];
  files: SiteFile[];
  versions: SiteVersion[];
  running: boolean;
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
  | { type: 'version'; version: SiteVersion }
  | {
      type: 'files';
      files: SiteFile[];
      cost: number;
      spent_usd: number;
      changed?: FileChange[];
      version?: number | null;
      snapshot_error?: string;
    };

const enc = encodeURIComponent;

/** The site builder: Claude writes a website into a folder on the backend, which serves it for the preview. */
export class SitesService {
  constructor(private readonly client: ApiClient) {}

  /** Your sites, most recently changed first, and whether the server can take screenshots. */
  list(): Promise<{ sites: SiteSummary[]; screenshots: boolean }> {
    return this.client.get('/api/sites');
  }

  get(id: string): Promise<SiteDetail> {
    return this.client.get(`/api/sites/${enc(id)}`);
  }

  /** Sends one message and streams Claude's work: its words, each file as it is written, and the checks. */
  turn(req: SiteTurnRequest, onEvent: (event: SiteEvent) => void, signal?: AbortSignal): Promise<void> {
    const body = {
      prompt: req.prompt,
      ...(req.siteId ? { site_id: req.siteId } : {}),
      ...(req.model ? { model: req.model } : {}),
    };
    return this.client.stream('/api/sites/turn', body, onEvent, signal);
  }

  file(id: string, path: string): Promise<string> {
    return this.client.get(`/api/sites/${enc(id)}/file`, { params: { path }, responseType: 'text' });
  }

  /** A screenshot from a check. Fetched with the lab header, so it cannot be a plain image link. */
  shot(id: string, file: string): Promise<Blob> {
    return this.client.blob(`/api/sites/${enc(id)}/shots/${enc(file)}`);
  }

  zip(id: string, title: string): Promise<void> {
    const name =
      title
        .toLowerCase()
        .replace(/[^\w-]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'site';
    return this.client.saveFile(`/api/sites/${enc(id)}/zip`, `${name}.zip`);
  }

  rename(id: string, title: string): Promise<SiteDetail> {
    return this.client.patch(`/api/sites/${enc(id)}`, { title });
  }

  /** Puts the files back as they were in version `n`. That becomes a new version, so nothing is lost. */
  restoreVersion(id: string, n: number): Promise<SiteDetail> {
    return this.client.post(`/api/sites/${enc(id)}/versions/${n}/restore`, {});
  }

  delete(id: string): Promise<{ ok: boolean }> {
    return this.client.delete(`/api/sites/${enc(id)}`);
  }

  /**
   * Where the site is served, sandboxed. `version` picks a kept version; without it, the current files.
   * `bust` changes the address so the frame reloads after a save.
   */
  previewUrl(id: string, bust = 0, version?: number | null): string {
    const base = version ? `/site-versions/${enc(id)}/${version}/index.html` : `/sites/${enc(id)}/index.html`;
    return bust ? `${base}?v=${bust}` : base;
  }
}

export const sitesService = new SitesService(api);
