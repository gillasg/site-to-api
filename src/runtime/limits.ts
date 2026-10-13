// Politeness for the site and protection for the user's account: a per-site rate limit, a
// concurrency cap, and retries that back off on 429 and 5xx (honouring Retry-After).

export class RateLimiter {
  private next = 0;
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly perSecond = 5,
    private readonly concurrency = 4,
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency)
      await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      const wait = this.next - Date.now();
      this.next = Math.max(Date.now(), this.next) + 1000 / this.perSecond;
      if (wait > 0) await sleep(wait);
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function retryDelay(attempt: number, retryAfter?: string): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
  }
  return Math.min(500 * 2 ** attempt + Math.random() * 250, 30_000);
}

export const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
