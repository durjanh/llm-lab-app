import { api, type ApiClient } from './apiClient';

export type SkillId = 'xlsx' | 'pptx' | 'docx' | 'pdf';

export interface SkillsRunRequest {
  skill: SkillId;
  upto: number;
  model?: string;
}

export interface SkillFile {
  id: string;
  name: string;
  size_bytes: number | null;
}

/** One line of a live skills run, as python/12_agent_skills.py emits it. */
export type SkillsEvent =
  | { type: 'run'; run_id: string }
  | { type: 'task'; task: string; model: string; skills: string[] }
  | { type: 'request'; turn: number; stop_reason: string; usage: string; cost: number }
  | { type: 'says'; text: string }
  | { type: 'step'; name: string; detail: string }
  | { type: 'output'; return_code: number; first_line: string }
  | { type: 'error'; text?: string; message?: string }
  | { type: 'paused'; text: string }
  | { type: 'files'; files: SkillFile[]; cost: number; spent_usd: number };

/** Live Agent Skills runs, and downloads of the files they make. */
export class SkillsService {
  constructor(private readonly client: ApiClient) {}

  run(body: SkillsRunRequest, onEvent: (event: SkillsEvent) => void, signal?: AbortSignal): Promise<void> {
    return this.client.stream('/api/skills/run', body, onEvent, signal);
  }

  /** Saves a file a skill made, in the browser. */
  download(file: Pick<SkillFile, 'id' | 'name'>): Promise<void> {
    return this.client.saveFile(`/api/skills/files/${encodeURIComponent(file.id)}`, file.name);
  }
}

export const skillsService = new SkillsService(api);
