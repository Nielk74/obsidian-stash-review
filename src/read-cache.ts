/** Coalesces pending reads; only explicitly weighted immutable values are retained. */
export class ReadCache {
  private pending = new Map<string, Promise<unknown>>();
  private retained = new Map<string, {value: unknown; bytes: number}>();
  private bytes = 0;

  constructor(private maxBytes = 16 * 1024 * 1024, private maxEntries = 64) {}

  read<T>(key: string, provider: () => Promise<T>, weight?: (value: T) => number): Promise<T> {
    const saved = this.retained.get(key);
    if (saved) {
      this.retained.delete(key); this.retained.set(key, saved);
      return Promise.resolve(saved.value as T);
    }
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const promise = Promise.resolve().then(provider).then(value => {
      if (weight && this.pending.get(key) === promise) {
        const bytes = weight(value);
        if (Number.isFinite(bytes) && bytes >= 0 && bytes <= this.maxBytes && this.maxEntries > 0) {
          while (this.retained.size && (this.bytes + bytes > this.maxBytes || this.retained.size >= this.maxEntries)) {
            const oldest = this.retained.keys().next().value!;
            this.bytes -= this.retained.get(oldest)!.bytes; this.retained.delete(oldest);
          }
          this.retained.set(key, {value, bytes}); this.bytes += bytes;
        }
      }
      return value;
    }).finally(() => {if (this.pending.get(key) === promise) this.pending.delete(key);});
    this.pending.set(key, promise);
    return promise;
  }

  clear(): void {this.pending.clear(); this.retained.clear(); this.bytes = 0;}
}
