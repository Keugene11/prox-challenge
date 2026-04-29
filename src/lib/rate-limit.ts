/**
 * In-memory token-bucket rate limiter, keyed by client IP.
 *
 * Good enough for a single-region Vercel deployment: each function instance
 * has its own bucket so a malicious client gets throttled per-instance, and
 * Vercel typically routes the same IP to the same warm instance for a while.
 * For multi-region or stricter guarantees, swap this for @upstash/ratelimit
 * + Vercel KV.
 */
type Bucket = { tokens: number; lastRefill: number };
const buckets = new Map<string, Bucket>();

const DEFAULT_CAPACITY = 8;        // burst allowance
const DEFAULT_REFILL_PER_MIN = 12; // sustained rate
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

let lastSweep = Date.now();

function sweep(now: number) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (now - b.lastRefill > 30 * 60 * 1000) buckets.delete(k);
  }
}

export type RateResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSec: number; remaining: 0 };

export function rateLimit(
  key: string,
  opts: { capacity?: number; refillPerMin?: number } = {},
): RateResult {
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  const refillPerMin = opts.refillPerMin ?? DEFAULT_REFILL_PER_MIN;
  const refillPerMs = refillPerMin / 60_000;
  const now = Date.now();
  sweep(now);

  let b = buckets.get(key);
  if (!b) {
    b = { tokens: capacity, lastRefill: now };
    buckets.set(key, b);
  }

  // Refill since last seen.
  const elapsed = now - b.lastRefill;
  b.tokens = Math.min(capacity, b.tokens + elapsed * refillPerMs);
  b.lastRefill = now;

  if (b.tokens < 1) {
    const tokensNeeded = 1 - b.tokens;
    const retryAfterSec = Math.ceil(tokensNeeded / refillPerMs / 1000);
    return { ok: false, retryAfterSec, remaining: 0 };
  }
  b.tokens -= 1;
  return { ok: true, remaining: Math.floor(b.tokens) };
}

export function clientKey(req: Request): string {
  const h = req.headers;
  // Vercel sets x-forwarded-for; fallback chain for other hosts.
  const fwd = h.get("x-forwarded-for") || "";
  const ip = fwd.split(",")[0]?.trim() || h.get("x-real-ip") || "anonymous";
  return ip;
}
