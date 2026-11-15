/** Minimal in-memory stand-in for the Upstash Redis surface the app uses. */
export class FakeRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Record<string, string>>();
  lists = new Map<string, string[]>();

  async get<T>(key: string): Promise<T | null> {
    return (this.strings.get(key) ?? null) as T | null;
  }
  /** Supports `nx` (only set if absent); expiry options are ignored. */
  async set(key: string, value: string, opts?: { nx?: boolean }): Promise<string | null> {
    if (opts?.nx && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return "OK";
  }
  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      const existed =
        this.strings.delete(key) || this.hashes.delete(key) || this.lists.delete(key);
      if (existed) removed += 1;
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
  async hgetall<T>(key: string): Promise<T | null> {
    const hash = this.hashes.get(key);
    return hash ? ({ ...hash } as T) : null;
  }
  async hget<T>(key: string, field: string): Promise<T | null> {
    return ((this.hashes.get(key)?.[field] ?? null) as T | null);
  }
  async hset(key: string, obj: Record<string, string>): Promise<number> {
    this.hashes.set(key, { ...(this.hashes.get(key) ?? {}), ...obj });
    return 1;
  }
  async hincrby(key: string, field: string, by: number): Promise<number> {
    const hash = this.hashes.get(key) ?? {};
    const next = (Number(hash[field]) || 0) + by;
    this.hashes.set(key, { ...hash, [field]: String(next) });
    return next;
  }
  async rpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
    return list.length;
  }
  async llen(key: string): Promise<number> {
    return (this.lists.get(key) ?? []).length;
  }
  async lrange<T>(key: string, start: number, end: number): Promise<T[]> {
    const list = this.lists.get(key) ?? [];
    const slice = list.slice(start, end === -1 ? undefined : end + 1);
    return slice as T[];
  }

  pipeline() {
    const ops: Array<() => Promise<unknown>> = [];
    const pipe: Record<string, unknown> = {};
    const add = (
      name: string,
      fn: (...args: never[]) => Promise<unknown>,
    ) => {
      pipe[name] = (...args: unknown[]) => {
        ops.push(() => fn(...(args as never[])));
        return pipe;
      };
    };
    add("get", (key: string) => this.get(key));
    add("hget", (key: string, field: string) => this.hget(key, field));
    add("hgetall", (key: string) => this.hgetall(key));
    add("lrange", (key: string, start: number, end: number) => this.lrange(key, start, end));
    add("llen", (key: string) => this.llen(key));
    add("hset", (key: string, obj: Record<string, string>) => this.hset(key, obj));
    add("hincrby", (key: string, field: string, by: number) => this.hincrby(key, field, by));
    add("set", (key: string, value: string, opts?: { nx?: boolean }) =>
      this.set(key, value, opts),
    );
    add("del", (...keys: string[]) => this.del(...keys));
    add("rpush", (key: string, value: string) => this.rpush(key, value));
    add("expire", async () => 1);
    pipe.exec = async () => {
      const results: unknown[] = [];
      for (const op of ops) results.push(await op());
      return results;
    };
    return pipe;
  }
}

export function streamOf<T>(...chunks: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}
