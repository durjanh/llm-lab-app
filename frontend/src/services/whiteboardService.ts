import { api, type ApiClient } from './apiClient';

export type ShapeName =
  'cube' | 'cuboid' | 'square_pyramid' | 'tetrahedron' | 'triangular_prism' | 'cylinder' | 'cone' | 'sphere';

/** What the model says the sketch is, after the backend's checks. */
export interface BoardReading {
  kind: 'function' | 'solid' | 'unknown';
  read_as: string;
  title: string;
  functions: { expression: string; label: string }[];
  parameters: { name: string; value: number; min: number; max: number }[];
  x_range: [number, number];
  solid: { shape: ShapeName; width: number; depth: number; height: number };
  section: { enabled: boolean; normal: [number, number, number]; offset: number };
  explanation: string;
}

export interface ReadResult {
  board: BoardReading;
  tries: { attempt: number; problems: string[] }[];
  cost_usd: number;
  model: string;
}

/** The AI whiteboard: read a sketch, and ask about what the board shows. */
export class WhiteboardService {
  constructor(private readonly client: ApiClient) {}

  read(image: string, prompt: string, model?: string): Promise<ReadResult> {
    return this.client.post('/api/whiteboard/read', { image, prompt, model });
  }

  ask(question: string, board: BoardReading, model?: string): Promise<{ answer: string; cost_usd: number }> {
    return this.client.post('/api/whiteboard/ask', { question, board, model });
  }
}

export const whiteboardService = new WhiteboardService(api);
