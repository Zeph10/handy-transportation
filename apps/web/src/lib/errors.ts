/** Errors raised by our Postgres functions look like "CODE: message". */
export class AppError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const raw =
    typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) : String(e);
  const m = /^([A-Z_]+):\s*([\s\S]*)$/.exec(raw);
  if (m) return new AppError(m[1], m[2]);
  if (/JWT|session|not authenticated/i.test(raw)) return new AppError('AUTH', 'Your session expired. Please log in again.');
  if (/Failed to fetch|NetworkError|network/i.test(raw)) return new AppError('NETWORK', 'No connection. Check your internet and try again.');
  if (/permission denied/i.test(raw)) return new AppError('FORBIDDEN', 'You do not have access to that.');
  return new AppError('UNKNOWN', raw || 'Something went wrong. Please try again.');
}

/** Unwrap a supabase-js { data, error } result, throwing AppError on failure. */
export function unwrap<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw toAppError(res.error);
  return res.data as T;
}
