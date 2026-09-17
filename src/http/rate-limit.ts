/**
 * Token bucket per caller. Elicitation costs real money, so the endpoints that
 * can reach a model are capped per owner rather than trusted.
 */
export type RateLimitRule = { limit: number; windowMs: number };

export type RateLimitResult = { ok: boolean; remaining: number; retryAfterSeconds: number };

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly rule: RateLimitRule,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt and says whether it is allowed. */
  take(key: string): RateLimitResult {
    const now = this.now();
    const since = now - this.rule.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.rule.limit) {
      const oldest = recent[0]!;
      this.hits.set(key, recent);
      return {
        ok: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.rule.windowMs - now) / 1000)),
      };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { ok: true, remaining: this.rule.limit - recent.length, retryAfterSeconds: 0 };
  }

  /** Forgets a caller's history, e.g. when a request failed before spending anything. */
  refund(key: string): void {
    const recent = this.hits.get(key);
    if (recent?.length) recent.pop();
  }
}
