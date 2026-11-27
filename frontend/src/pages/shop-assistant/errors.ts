import { ApiError } from '@/services/apiClient';

/** A failure as one plain sentence for the page: the server's own message when it sent one. */
export function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return 'This part of the shop is not available on the server yet.';
    if (e.status === 503) return e.message || 'The shop database is not running.';
    return e.message || 'Something went wrong.';
  }
  if (e instanceof Error) return e.message || 'Something went wrong.';
  return 'Something went wrong.';
}

/** True when the server no longer knows this tab's session (it expired or the backend restarted). */
export const isExpired = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 403);
