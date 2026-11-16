/** Minimal in-memory stand-in for the Upstash Redis surface the app uses. */
export class FakeRedis {
  strings = new Map<string, string>();
  zsets = new Map<string, Map<string, number>>();

  async get<T>(key: string): Promise<T | null> {
    return (this.strings.get(key) ?? null) as T | null;
  }

  async set(
    key: string,
    value: string,
    opts?: { nx?: boolean; ex?: number },
  ): Promise<string | null> {
    if (opts?.nx && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key) || this.zsets.delete(key)) removed += 1;
    }
    return removed;
  }

  async incr(key: string): Promise<number> {
    const next = (Number(this.strings.get(key) ?? 0) || 0) + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async expire(): Promise<number> {
    return 1;
  }

  async zadd(
    key: string,
    ...args:
      | [{ score: number; member: string }]
      | [{ nx: true }, { score: number; member: string }]
  ): Promise<number | null> {
    const set = this.zsets.get(key) ?? new Map<string, number>();
    this.zsets.set(key, set);
    const nx = "nx" in args[0] && args[0].nx;
    const item = ("score" in args[0] ? args[0] : args[1])!;
    if (nx && set.has(item.member)) return 0;
    const added = set.has(item.member) ? 0 : 1;
    set.set(item.member, item.score);
    return added;
  }

  private sortedEntries(key: string): Array<[string, number]> {
    const set = this.zsets.get(key);
    if (!set) return [];
    return [...set.entries()].sort(
      (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
    );
  }

  async zrank(key: string, member: string): Promise<number | null> {
    const idx = this.sortedEntries(key).findIndex(([m]) => m === member);
    return idx === -1 ? null : idx;
  }

  async zrange(
    key: string,
    min: number,
    max: number,
    opts?: { byScore?: boolean },
  ): Promise<string[]> {
    const entries = this.sortedEntries(key);
    if (opts?.byScore) {
      return entries
        .filter(([, score]) => score >= min && score <= max)
        .map(([member]) => member);
    }
    return entries
      .slice(min, max === -1 ? undefined : max + 1)
      .map(([member]) => member);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const set = this.zsets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed += 1;
    }
    return removed;
  }

  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }

  pipeline() {
    const ops: Array<() => Promise<unknown>> = [];
    const pipe = {
      get: (key: string) => {
        ops.push(() => this.get(key));
        return pipe;
      },
      set: (key: string, value: string, opts?: { nx?: boolean; ex?: number }) => {
        ops.push(() => this.set(key, value, opts));
        return pipe;
      },
      del: (...keys: string[]) => {
        ops.push(() => this.del(...keys));
        return pipe;
      },
      exec: async () => {
        const results: unknown[] = [];
        for (const op of ops) results.push(await op());
        return results;
      },
    };
    return pipe;
  }
}
