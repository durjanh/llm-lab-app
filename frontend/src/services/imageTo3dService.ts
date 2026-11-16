import { api, type ApiClient } from './apiClient';

export interface ImageTo3dSettings {
  mode: 'real' | 'synthetic';
  seed: number;
  steps: number;
  num_gaussians: number;
}

export interface ImageTo3dResult {
  id: string;
  created: number;
  settings: ImageTo3dSettings;
  source: string;
  device?: string;
  load_s?: number;
  generate_s?: number;
  total_s?: number;
  ply_bytes?: number;
}

export interface ImageTo3dInfo {
  ready: boolean;
  setup: string;
  busy: boolean;
  machine: string;
  gated: { repo: string; what: string }[];
  defaults: ImageTo3dSettings;
  limits: { gaussians: number[]; steps: [number, number]; image_bytes: number };
  timings: { where: string; setting: string; time: string }[];
  results: ImageTo3dResult[];
}

export type ImageTo3dEvent =
  | { type: 'run'; run_id: string }
  | { type: 'progress'; step: string; elapsed_s?: number }
  | { type: 'setup'; device: string; torch: string }
  | { type: 'done'; result: ImageTo3dResult }
  | { type: 'error'; message: string };

export type ImageTo3dFile = 'object.ply' | 'input.png' | 'camera.json';

/** Image to 3D with Idol on this machine: one photo in, Gaussian splats out. */
export class ImageTo3dService {
  constructor(private readonly client: ApiClient = api) {}

  info(): Promise<ImageTo3dInfo> {
    return this.client.get('/api/image-to-3d/info');
  }

  generate(
    image: File,
    settings: ImageTo3dSettings,
    onEvent: (e: ImageTo3dEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const form = new FormData();
    form.append('file', image);
    for (const [k, v] of Object.entries(settings)) form.append(k, String(v));
    return this.client.stream('/api/image-to-3d/generate', form, onEvent, signal);
  }

  cancel(): Promise<{ cancelled: boolean }> {
    return this.client.post('/api/image-to-3d/cancel', {});
  }

  /** A result's file. Fetched with the lab header, so the route stays guarded. */
  file(id: string, name: ImageTo3dFile): Promise<Blob> {
    return this.client.blob(`/api/image-to-3d/results/${encodeURIComponent(id)}/${name}`);
  }

  save(id: string, name: ImageTo3dFile, as: string): Promise<void> {
    return this.client.saveFile(`/api/image-to-3d/results/${encodeURIComponent(id)}/${name}`, as);
  }

  remove(id: string): Promise<{ deleted: string }> {
    return this.client.delete(`/api/image-to-3d/results/${encodeURIComponent(id)}`);
  }
}

export const imageTo3dService = new ImageTo3dService(api);
