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

export interface WhiteboardInfo {
  shapes: ShapeName[];
  guess_model: string;
  words: Record<'easy' | 'medium' | 'hard', string[]>;
  picture: boolean;
  picture_styles: string[];
  picture_why: string;
}

export interface GuessResult {
  guesses: { label: string; confidence: number }[];
  comment: string;
  /** The guess that code accepted as the word, or null. */
  matched: string | null;
  cost_usd: number;
  model: string;
}

/** One body for the physics engine, in board units (x right, y down). */
export interface SceneBody {
  kind: 'ball' | 'box' | 'line';
  label: string;
  moving: boolean;
  x: number;
  y: number;
  radius?: number;
  width?: number;
  height?: number;
  angle?: number;
  x2?: number;
  y2?: number;
}

export interface SceneResult {
  bodies: SceneBody[];
  comment: string;
  tries: { attempt: number; problems: string[] }[];
  cost_usd: number;
  model: string;
}

export interface PictureResult {
  id: string;
  url: string;
  prompt: string;
  cost_usd: number;
  seconds: number;
}

/** The AI whiteboard: read a sketch, and ask about what the board shows. */
export class WhiteboardService {
  constructor(private readonly client: ApiClient) {}

  read(image: string, prompt: string, model?: string): Promise<ReadResult> {
    return this.client.post('/api/whiteboard/read', { image, prompt, model });
  }

  info(): Promise<WhiteboardInfo> {
    return this.client.get('/api/whiteboard/info');
  }

  guess(image: string, word: string | null, model?: string): Promise<GuessResult> {
    return this.client.post('/api/whiteboard/guess', { image, word, model });
  }

  scene(
    image: string,
    hints: unknown[],
    size: { width: number; height: number },
    prompt: string,
    model?: string,
  ): Promise<SceneResult> {
    return this.client.post('/api/whiteboard/scene', { image, hints, ...size, prompt, model });
  }

  picture(image: string, style: string, subject: string): Promise<PictureResult> {
    return this.client.post('/api/whiteboard/picture', { image, style, subject });
  }

  ask(question: string, board: BoardReading, model?: string): Promise<{ answer: string; cost_usd: number }> {
    return this.client.post('/api/whiteboard/ask', { question, board, model });
  }
}

export const whiteboardService = new WhiteboardService(api);
