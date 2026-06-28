// Minimal HTTP transport: Bearer auth, JSON, per-request timeout, and bounded
// retry with exponential backoff + jitter for transient failures. No runtime
// dependencies — uses the platform fetch resolved by env.ts.
import { LIB_NAME, VERSION } from "./version";

export interface TransportConfig {
  apiKey: string;
  host: string;
  fetchImpl: typeof fetch;
  maxRetries: number;
  timeoutMs: number;
  debug?: boolean;
}

export class PulseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "PulseApiError";
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 10_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const backoff = (attempt: number): number => {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  // Full jitter: spreads concurrent clients to avoid a thundering herd.
  return Math.random() * exp;
};

export class Transport {
  private readonly base: string;

  constructor(private readonly cfg: TransportConfig) {
    // Trim a trailing slash so `${base}${path}` never produces a double slash.
    this.base = cfg.host.replace(/\/+$/, "");
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.base}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
      try {
        const response = await this.cfg.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${this.cfg.apiKey}`,
            "content-type": "application/json",
            "x-pulse-lib": `${LIB_NAME}/${VERSION}`,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.ok) {
          if (response.status === 204) return undefined as T;
          const text = await response.text();
          return (text ? JSON.parse(text) : undefined) as T;
        }

        const errBody = await response.text().catch(() => "");
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.cfg.maxRetries) {
          this.log(`retryable ${response.status} on ${path}, attempt ${attempt}`);
          await sleep(backoff(attempt));
          continue;
        }
        throw new PulseApiError(
          `Pulse API ${response.status} on ${method} ${path}`,
          response.status,
          errBody,
        );
      } catch (error) {
        lastError = error;
        // A thrown PulseApiError is terminal (non-retryable status already filtered).
        if (error instanceof PulseApiError) throw error;
        // Network error / abort: retry if budget remains.
        if (attempt < this.cfg.maxRetries) {
          this.log(`network error on ${path}, attempt ${attempt}: ${String(error)}`);
          await sleep(backoff(attempt));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`pulse-js: request to ${path} failed`);
  }

  private log(message: string): void {
    if (this.cfg.debug) console.debug(`[pulse-js] ${message}`);
  }
}
