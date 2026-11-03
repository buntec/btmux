/**
 * Runs keyed scans, at most `limit` at a time across overlapping rounds. A round
 * joins a scan already running for its key instead of repeating it.
 *
 * A scan past `timeoutMs` frees its slot and stops holding up rounds, but isn't
 * repeated until it settles, as the backend may still be working on it.
 */
export class ScanPool {
  private readonly running = new Map<string, Promise<void>>();
  private readonly overdue = new Set<string>();

  constructor(
    private readonly scan: (key: string) => Promise<void>,
    /** Called when a scan fails or passes `timeoutMs`. */
    private readonly onMissed: (key: string) => void,
    private readonly limit: number,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Resolves once every key has been scanned or is overdue. Once `stopped`, the
   * round starts nothing more, while scans already running finish.
   */
  async run(keys: readonly string[], stopped: () => boolean): Promise<void> {
    const scans = new Set<Promise<void>>();
    let queue = keys;
    while (!stopped()) {
      queue = queue.filter((key) => {
        if (this.overdue.has(key)) return false;
        const scan = this.running.get(key) ?? (this.running.size < this.limit ? this.start(key) : null);
        if (scan) scans.add(scan);
        return !scan;
      });
      if (queue.length === 0) {
        await Promise.all(scans);
        return;
      }
      await Promise.race(this.running.values());
    }
  }

  private start(key: string): Promise<void> {
    const slot = new Promise<void>((resolve) => {
      const free = () => {
        this.running.delete(key);
        resolve();
      };
      const timer = setTimeout(() => {
        this.overdue.add(key);
        free();
        this.onMissed(key);
      }, this.timeoutMs);
      this.scan(key)
        .catch(() => this.onMissed(key))
        .finally(() => {
          clearTimeout(timer);
          this.overdue.delete(key);
          free();
        });
    });
    this.running.set(key, slot);
    return slot;
  }
}
