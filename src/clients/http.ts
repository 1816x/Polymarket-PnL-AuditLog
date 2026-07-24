/**
 * Shared HTTP + JSON-RPC transport.
 *
 * Responsibilities: fetching bytes with timeouts, exponential backoff + jitter on
 * 429/5xx/network errors (spec §2), a global request counter (so --dry-run and
 * reports can state real request volume), and Polygon RPC failover across
 * endpoints. This module does NO business logic and NO response validation —
 * callers (the typed clients) validate shapes.
 */

let requestsMade = 0;
export function getRequestCount(): number {
  return requestsMade;
}

const DEFAULT_HEADERS: Record<string, string> = {
  accept: "application/json",
  "user-agent": "polymarket-pnl-audit/0.1 (read-only research)",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Marker for errors worth retrying (429/5xx/network/timeout). */
class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  if (err instanceof Error) {
    if (err.name === "AbortError") return true; // timeout
    if (/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(err.message)) return true;
  }
  return false;
}

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  label?: string;
}

async function withRetry<T>(fn: () => Promise<T>, retries: number, label: string): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (!isRetryable(err) || attempt > retries) throw err;
      // 2^attempt * 500ms base (0.5s, 1s, 2s, 4s, 8s...), capped, plus up to 30% jitter.
      const base = Math.min(16_000, 2 ** attempt * 500);
      const delay = base + Math.random() * 0.3 * base;
      const msg = err instanceof Error ? err.message.slice(0, 140) : String(err);
      process.stderr.write(`  [retry ${attempt}/${retries}] ${label} in ${Math.round(delay)}ms — ${msg}\n`);
      await sleep(delay);
    }
  }
}

async function rawFetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  requestsMade++;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ac.signal });
    if (resp.status === 429 || resp.status >= 500) {
      throw new RetryableError(`HTTP ${resp.status} at ${url}`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} at ${url}: ${body.slice(0, 200)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/** GET a URL and parse JSON, with retry/backoff. Returns unvalidated `unknown`. */
export async function getJson(url: string, opts: FetchOptions = {}): Promise<unknown> {
  const { timeoutMs = 30_000, retries = 5, label = url } = opts;
  return withRetry(() => rawFetchJson(url, { method: "GET", headers: DEFAULT_HEADERS }, timeoutMs), retries, label);
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Call a JSON-RPC method against the given Polygon endpoints in order, failing
 * over to the next on error. Returns the `result`. Throws if all endpoints fail.
 */
export async function rpcCall(
  rpcUrls: string[],
  method: string,
  params: unknown[],
  opts: FetchOptions = {},
): Promise<unknown> {
  const { timeoutMs = 30_000, retries = 3 } = opts;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let lastErr: unknown;
  for (const url of rpcUrls) {
    try {
      const res = (await withRetry(
        () =>
          rawFetchJson(
            url,
            { method: "POST", headers: { ...DEFAULT_HEADERS, "content-type": "application/json" }, body },
            timeoutMs,
          ),
        retries,
        `${method} @ ${url}`,
      )) as JsonRpcResponse;
      if (res.error) throw new Error(`RPC ${method} error ${res.error.code}: ${res.error.message}`);
      return res.result;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message.slice(0, 120) : String(err);
      process.stderr.write(`  [rpc failover] ${method} @ ${url} failed — ${msg}\n`);
    }
  }
  throw new Error(`All ${rpcUrls.length} RPC endpoints failed for ${method}: ${String(lastErr)}`);
}
