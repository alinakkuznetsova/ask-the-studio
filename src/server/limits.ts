// abuse and cost controls. in memory, which is right for one instance;
// with several instances these move to redis (see readme, production).

// sliding window per key (client ip)
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  // returns seconds until the next allowed request, or 0 if allowed now
  check(key: string, now = Date.now()): number {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return Math.ceil((recent[0]! + this.windowMs - now) / 1000);
    }
    recent.push(now);
    this.hits.set(key, recent);
    // keep memory bounded under a flood of unique ips
    if (this.hits.size > 10_000) this.prune(now);
    return 0;
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) {
      if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
  }
}

// global daily budget: a hard stop on spend even if many ips are used
export class DailyCap {
  private day = "";
  private count = 0;

  constructor(private cap: number) {}

  take(now = new Date()): boolean {
    const day = now.toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.count = 0;
    }
    if (this.count >= this.cap) return false;
    this.count++;
    return true;
  }

  get used() {
    return this.count;
  }
}

// limits concurrent model calls so a burst cannot exhaust memory or quota
export class Semaphore {
  private active = 0;
  constructor(private max: number) {}
  tryAcquire(): boolean {
    if (this.active >= this.max) return false;
    this.active++;
    return true;
  }
  release() {
    this.active = Math.max(0, this.active - 1);
  }
}

// short-lived store of recent answers so thumbs feedback can be linked to the
// question that caused it. bounded in size and age; content is redacted first.
export class TraceStore<T> {
  private items = new Map<string, { at: number; value: T }>();
  constructor(
    private max = 500,
    private ttlMs = 60 * 60 * 1000,
  ) {}
  set(id: string, value: T) {
    this.items.set(id, { at: Date.now(), value });
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value!);
  }
  get(id: string): T | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    if (Date.now() - item.at > this.ttlMs) {
      this.items.delete(id);
      return undefined;
    }
    return item.value;
  }
}
