import { api, type ApiClient } from './apiClient';
import type { SkillFile, SkillsEvent } from './skillsService';

export interface DeckTurnRequest {
  /** Omit for the first message; pass the id from the "chat" event to continue the same deck. */
  chatId?: string | null;
  prompt: string;
  model?: string;
  files: File[];
  template?: File | null;
}

/**
 * One line of a deck builder turn: the skills run's own events, plus the conversation, the uploads,
 * and each visual check, where the backend shows Claude the slides that changed since it last checked them.
 */
export type DecksEvent =
  | SkillsEvent
  | { type: 'chat'; chat_id: string; turn: number; model: string }
  | { type: 'upload'; name: string; size_bytes: number; file_id: string }
  | { type: 'review'; round: number; deck: string; slides: SkillFile[]; total?: number; text?: string };

/** Accepted attachments, as the backend checks them. */
export const SOURCE_EXTENSIONS = ['.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.txt', '.md', '.json', '.png', '.jpg', '.jpeg'];
export const MAX_FILES = 6;
export const MAX_FILE_MB = 20;

/** The deck builder: a conversation with Claude that makes and revises a PowerPoint deck. */
export class DecksService {
  constructor(private readonly client: ApiClient) {}

  /** Sends one message, with its files, and streams Claude's work on the deck. */
  turn(req: DeckTurnRequest, onEvent: (event: DecksEvent) => void, signal?: AbortSignal): Promise<void> {
    const form = new FormData();
    form.append('prompt', req.prompt);
    if (req.chatId) form.append('chat_id', req.chatId);
    if (req.model) form.append('model', req.model);
    for (const file of req.files) form.append('files', file, file.name);
    if (req.template) form.append('template', req.template, req.template.name);
    return this.client.stream('/api/decks/turn', form, onEvent, signal);
  }

  /** Ends a conversation. The backend deletes the files you uploaded for it. */
  end(chatId: string): Promise<{ ok: boolean }> {
    return this.client.delete(`/api/decks/${encodeURIComponent(chatId)}`);
  }

  download(file: Pick<SkillFile, 'id' | 'name'>): Promise<void> {
    return this.client.saveFile(`/api/skills/files/${encodeURIComponent(file.id)}`, file.name);
  }

  /** A rendered slide image, for showing on the page. */
  image(file: Pick<SkillFile, 'id'>): Promise<Blob> {
    return this.client.blob(`/api/skills/files/${encodeURIComponent(file.id)}`);
  }
}

export const decksService = new DecksService(api);
