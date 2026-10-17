import type {
  IncidentEventInput,
  IncidentEventRecord,
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
  readonly eventLog: IncidentEventRecord[] = [];
  private nextId = 1;
  private nextEventId = 1;
  constructor(private readonly now: () => Date = () => new Date()) {}

  async findOpen(service: string) {
    return this.incidents
      .filter((i) => i.service === service && i.status === 'open')
      .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())[0];
  }

  async get(id: string) {
    return this.incidents.find((i) => i.id === id);
  }

  async latest(filter: { service?: string; status?: 'open' | 'resolved' } = {}) {
    return this.incidents
      .filter(
        (i) =>
          (!filter.service || i.service === filter.service) &&
          (!filter.status || i.status === filter.status),
      )
      .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())[0];
  }

  async listOpen() {
    return this.incidents
      .filter((i) => i.status === 'open')
      .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
  }

  async open(input: {
    title: string;
    severity: string;
    service: string;
    primaryCause: string | null;
  }) {
    const record: IncidentRecord = {
      ...input,
      id: `incident-${this.nextId++}`,
      status: 'open',
      openedAt: this.now(),
      updatedAt: this.now(),
      resolvedAt: null,
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

  async resolve(id: string, at: Date) {
    const i = this.incidents.find((x) => x.id === id);
    if (!i) throw new Error(`no incident ${id}`);
    Object.assign(i, { status: 'resolved', resolvedAt: at, updatedAt: at });
    return i;
  }

  async appendEvent(incidentId: string, e: IncidentEventInput) {
    this.eventLog.push({
      ...e,
      id: `event-${this.nextEventId++}`,
      incidentId,
      createdAt: this.now(),
    });
  }

  async events(incidentId: string) {
    return this.eventLog.filter((e) => e.incidentId === incidentId);
  }
}
