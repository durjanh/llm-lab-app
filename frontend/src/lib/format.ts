/** Dollars per million tokens, as the backend's status reports them (python/common.py is the one price list). */
export interface Price {
  input: number;
  output: number;
  cache_read: number;
}

/** A whole number with thousands separators, in British style. */
export const n0 = (x: number) => Math.round(x).toLocaleString('en-GB');
