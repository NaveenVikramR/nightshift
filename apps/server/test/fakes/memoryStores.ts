import type {
  IncidentEventInput,
  IncidentRecord,
  IncidentStore,
} from '../../src/db/incidentStore.js';
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

export class InMemoryIncidentStore implements IncidentStore {
  readonly incidents: IncidentRecord[] = [];
  readonly events: (IncidentEventInput & { incidentId: string; createdAt: Date })[] = [];
  private nextId = 1;
  constructor(private readonly now: () => Date = () => new Date()) {}

  async findOpen(service: string) {
    return this.incidents
      .filter((i) => i.service === service && i.status === 'open')
      .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())[0];
  }

  async open(input: {
    title: string;
    severity: string;
    service: string;
    primaryCause: string | null;
  }) {
    const record = {
      ...input,
      id: `incident-${this.nextId++}`,
      status: 'open',
      openedAt: this.now(),
      updatedAt: this.now(),
    };
    this.incidents.push(record);
    return record;
  }

  async update(
    id: string,
    patch: { title?: string; severity?: string; primaryCause?: string | null },
  ) {
    const i = this.incidents.find((x) => x.id === id);
    if (!i) throw new Error(`no incident ${id}`);
    Object.assign(i, patch, { updatedAt: this.now() });
    return i;
  }

  async appendEvent(incidentId: string, e: IncidentEventInput) {
    this.events.push({ ...e, incidentId, createdAt: this.now() });
  }
}
