/**
 * A deliberately slow, well-mannered HTTP client for public-sector sources.
 *
 * The catalogue sync reads thousands of pages from a government website that
 * exists to serve citizens, not us. So: one request at a time, a minimum gap
 * between requests, an identifying User-Agent, a timeout, and bounded retries
 * with exponential backoff that only fire for failures a retry can fix
 * (rate limiting, server errors, network faults) - never for a 4xx that says
 * the request itself is wrong.
 *
 * `fetch` and `sleep` are injected so tests run instantly and offline.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PoliteHttpOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Minimum milliseconds between the start of consecutive requests. */
  minIntervalMs?: number;
  timeoutMs?: number;
  /** Retries after the first attempt. */
  retries?: number;
  headers?: Record<string, string>;
}

export class SourceHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
  ) {
    super(message);
    this.name = "SourceHttpError";
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createPoliteHttp(options: PoliteHttpOptions = {}) {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? realSleep;
  const minIntervalMs = options.minIntervalMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retries = options.retries ?? 3;

  // Measured in "requests sent", not wall-clock time: the gap is enforced by
  // sleeping before every request after the first, which keeps this file free
  // of ambient clock reads and is exactly as polite.
  let sent = 0;

  async function attempt(url: string): Promise<Response> {
    if (sent > 0) await sleep(minIntervalMs);
    sent += 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, {
        headers: { Accept: "application/json", ...options.headers },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** GET a URL and parse JSON, retrying only failures a retry can fix. */
    async getJson(url: string): Promise<unknown> {
      let lastError: SourceHttpError | null = null;

      for (let i = 0; i <= retries; i += 1) {
        if (i > 0) await sleep(minIntervalMs * 2 ** i);

        let response: Response;
        try {
          response = await attempt(url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastError = new SourceHttpError(`Network error: ${message}`, null, url);
          continue;
        }

        if (response.ok) {
          try {
            return await response.json();
          } catch {
            throw new SourceHttpError("Response was not valid JSON.", response.status, url);
          }
        }

        lastError = new SourceHttpError(
          `HTTP ${response.status}`,
          response.status,
          url,
        );
        if (!RETRYABLE_STATUS.has(response.status)) throw lastError;
      }

      throw lastError ?? new SourceHttpError("Request failed.", null, url);
    },

    /** How many requests have been sent, for run statistics. */
    get requestCount() {
      return sent;
    },
  };
}

export type PoliteHttp = ReturnType<typeof createPoliteHttp>;
