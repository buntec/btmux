/**
 * Runs keyed scans, at most `limit` at a time across overlapping rounds. A round
 * joins a scan already running for its key instead of repeating it.
 */
export class ScanPool {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly scan: (key: string) => Promise<void>,
    private readonly limit: number,
  ) {}

  /**
   * Resolves once every key has been scanned. Once `stopped`, the round starts
   * nothing more, while scans already running finish.
   */
  async run(keys: readonly string[], stopped: () => boolean): Promise<void> {
    const scans = new Set<Promise<void>>();
    let queue = keys;
    while (!stopped()) {
      queue = queue.filter((key) => {
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
    const scan = this.scan(key)
      .catch(() => {})
      .finally(() => this.running.delete(key));
    this.running.set(key, scan);
    return scan;
  }
}
