import { api, type ApiClient } from './apiClient';

/** Sample data the backend serves to the pages. */
export class SampleService {
  private handbook: Promise<string> | null = null;

  constructor(private readonly client: ApiClient) {}

  /** The fictional company handbook from python/data.py. Fetched once. */
  getHandbook(): Promise<string> {
    return (this.handbook ??= this.client.get<{ text: string }>('/api/sample/handbook').then((r) => r.text));
  }
}

export const sampleService = new SampleService(api);
