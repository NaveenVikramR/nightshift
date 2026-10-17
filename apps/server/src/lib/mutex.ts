/**
 * A minimal async mutex. Single instance only (like sessions and the auth
 * limiter): it serializes work inside this process, not across replicas.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
