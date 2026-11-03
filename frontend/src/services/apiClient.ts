import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';

/** A failed call to the lab backend, carrying the server's own message. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly type?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error?: { message?: string; type?: string };
}

/**
 * Every call from the pages to the lab backend goes through this class. It sends the header
 * that marks a call as coming from the lab pages (the backend refuses calls without it), and
 * turns every failure into an ApiError with the server's message.
 */
export class ApiClient {
  private readonly http: AxiosInstance;

  constructor(baseURL = '') {
    this.http = axios.create({ baseURL, headers: { 'x-llm-lab': '1' } });
  }

  async get<T>(path: string, config?: AxiosRequestConfig): Promise<T> {
    try {
      return (await this.http.get<T>(path, config)).data;
    } catch (err) {
      throw await toError(err);
    }
  }

  async post<T>(path: string, body: unknown, config?: AxiosRequestConfig): Promise<T> {
    try {
      return (await this.http.post<T>(path, body, { ...config, headers: { ...bodyHeaders(body), ...config?.headers } })).data;
    } catch (err) {
      throw await toError(err);
    }
  }

  async delete<T>(path: string): Promise<T> {
    try {
      return (await this.http.delete<T>(path)).data;
    } catch (err) {
      throw await toError(err);
    }
  }

  /** Fetches a file as a Blob. The fetch adapter returns a real Blob in every environment. */
  blob(path: string): Promise<Blob> {
    return this.get<Blob>(path, { adapter: 'fetch', responseType: 'blob' });
  }

  /** Fetches a file and saves it in the browser. A plain link could not send the lab header. */
  async saveFile(path: string, name: string): Promise<void> {
    const url = URL.createObjectURL(await this.blob(path));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * POSTs and reads the newline-delimited JSON the backend streams back, calling onLine for
   * each object as it arrives. Empty lines are the server's heartbeat and are skipped.
   * Aborting the signal stops reading, and the backend then stops its work too.
   */
  async stream<T>(path: string, body: unknown, onLine: (line: T) => void, signal?: AbortSignal): Promise<void> {
    let data: ReadableStream<Uint8Array>;
    try {
      data = (await this.http.post(path, body, { adapter: 'fetch', responseType: 'stream', signal, headers: bodyHeaders(body) })).data;
    } catch (err) {
      throw await toError(err);
    }
    const reader = data.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw await toError(err); // an abort mid-stream ends up here
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) onLine(JSON.parse(line) as T);
      }
    }
  }
}

/**
 * For a FormData body, leave Content-Type unset so fetch writes the multipart header with its boundary.
 * Without this, axios's fetch adapter labels FormData as a urlencoded form outside the browser.
 */
function bodyHeaders(body: unknown): Record<string, null> {
  return body instanceof FormData ? { 'Content-Type': null } : {};
}

/** The server's error message when there is one; an AbortError when the caller cancelled. */
async function toError(err: unknown): Promise<Error> {
  if (axios.isCancel(err)) return Object.assign(new Error('The request was cancelled.'), { name: 'AbortError' });
  if (!axios.isAxiosError(err)) return err instanceof Error ? err : new Error(String(err));
  if (!err.response) return new ApiError('Could not reach the lab backend.');
  let body: unknown = err.response.data;
  if (body instanceof ReadableStream || body instanceof Blob) body = await new Response(body).json().catch(() => ({}));
  const error = (body as ErrorBody | undefined)?.error;
  return new ApiError(error?.message || `HTTP ${err.response.status}`, err.response.status, error?.type);
}

/** The one client every service uses. */
export const api = new ApiClient();
