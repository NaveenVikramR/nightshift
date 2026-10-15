import type { AckRecord, AckStore, SilenceRecord, SilenceStore } from '../../src/db/alertStores.js';

export class InMemoryAckStore implements AckStore {
  readonly records: AckRecord[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}

  async findMany(keys: readonly { fingerprint: string; startsAt: Date }[]) {
    return this.records.filter((r) =>
      keys.some(
        (k) => k.fingerprint === r.fingerprint && k.startsAt.getTime() === r.startsAt.getTime(),
      ),
    );
  }

  async ackOnce(record: Omit<AckRecord, 'ackedAt'>) {
    const [existing] = await this.findMany([record]);
    if (existing) return { record: existing, created: false };
    const created = { ...record, ackedAt: this.now() };
    this.records.push(created);
    return { record: created, created: true };
  }
}

export class InMemorySilenceStore implements SilenceStore {
  readonly records: SilenceRecord[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}

  async findRecent(fingerprint: string, since: Date) {
    return this.records
      .filter((r) => r.fingerprint === fingerprint && r.createdAt >= since)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  }

  async create(record: Omit<SilenceRecord, 'createdAt'>) {
    const created = { ...record, createdAt: this.now() };
    this.records.push(created);
    return created;
  }
}
