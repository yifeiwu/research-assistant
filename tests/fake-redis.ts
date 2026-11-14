/** Minimal in-memory stand-in for the Upstash Redis surface chat-stream uses. */
export class FakeRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Record<string, string>>();
  lists = new Map<string, string[]>();

  async get<T>(key: string): Promise<T | null> {
    return (this.strings.get(key) ?? null) as T | null;
  }
  async set(key: string, value: string): Promise<string> {
    this.strings.set(key, value);
    return "OK";
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
    add("get", async (key: string) => this.strings.get(key) ?? null);
    add("hget", async (key: string, field: string) => this.hashes.get(key)?.[field] ?? null);
    add("hgetall", async (key: string) => {
      const hash = this.hashes.get(key);
      return hash ? { ...hash } : null;
    });
    add("lrange", async (key: string, start: number, end: number) => {
      const list = this.lists.get(key) ?? [];
      return list.slice(start, end === -1 ? undefined : end + 1);
    });
    add("llen", async (key: string) => (this.lists.get(key) ?? []).length);
    add("hset", async (key: string, obj: Record<string, string>) => {
      this.hashes.set(key, { ...(this.hashes.get(key) ?? {}), ...obj });
      return 1;
    });
    add("set", async (key: string, value: string) => {
      this.strings.set(key, value);
      return "OK";
    });
    add("del", async (key: string) => {
      this.strings.delete(key);
      this.hashes.delete(key);
      this.lists.delete(key);
      return 1;
    });
    add("rpush", async (key: string, value: string) => {
      const list = this.lists.get(key) ?? [];
      list.push(value);
      this.lists.set(key, list);
      return list.length;
    });
    add("expire", async () => 1);
    pipe.exec = async () => {
      const results: unknown[] = [];
      for (const op of ops) results.push(await op());
      return results;
    };
    return pipe;
  }
}

export function streamOf(...chunks: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}
