import type { Prisma } from '../generated/prisma/client.js';
import type { Db } from './prisma.js';

export interface IncidentRecord {
  id: string;
  title: string;
  severity: string;
  status: string;
  service: string | null;
  primaryCause: string | null;
  openedAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
}

export type IncidentEventKind =
  'diagnosis' | 'alert' | 'ack' | 'silence' | 'note' | 'action' | 'deploy' | 'resolved';

export interface IncidentEventInput {
  kind: IncidentEventKind;
  actor: string | null;
  /** Server-authored text only; never untrusted text (notes go in data.note, quoted). */
  message: string;
  data?: unknown;
}

export interface IncidentEventRecord extends IncidentEventInput {
  id: string;
  incidentId: string;
  createdAt: Date;
}

export interface IncidentStore {
  /** The open incident for this service, if any (most recent). */
  findOpen(service: string): Promise<IncidentRecord | undefined>;
  get(id: string): Promise<IncidentRecord | undefined>;
  /** Most recent incident (optionally of a service / status). */
  latest(filter?: {
    service?: string;
    status?: 'open' | 'resolved';
  }): Promise<IncidentRecord | undefined>;
  listOpen(): Promise<IncidentRecord[]>;
  open(input: {
    title: string;
    severity: string;
    service: string;
    primaryCause: string | null;
  }): Promise<IncidentRecord>;
  update(
    id: string,
    patch: { title?: string; severity?: string; primaryCause?: string | null },
  ): Promise<IncidentRecord>;
  resolve(id: string, at: Date): Promise<IncidentRecord>;
  appendEvent(incidentId: string, event: IncidentEventInput): Promise<void>;
  /** Oldest first. */
  events(incidentId: string): Promise<IncidentEventRecord[]>;
}

type EventRow = NonNullable<Awaited<ReturnType<Db['incidentEvent']['findFirst']>>>;

const eventFromRow = (r: EventRow): IncidentEventRecord => ({
  id: r.id,
  incidentId: r.incidentId,
  kind: r.kind as IncidentEventKind,
  actor: r.actor,
  message: r.message,
  data: r.data ?? undefined,
  createdAt: r.createdAt,
});

export class PrismaIncidentStore implements IncidentStore {
  constructor(private readonly db: Db) {}

  async findOpen(service: string) {
    const row = await this.db.incident.findFirst({
      where: { service, status: 'open' },
      orderBy: { openedAt: 'desc' },
    });
    return row ?? undefined;
  }

  async get(id: string) {
    return (await this.db.incident.findUnique({ where: { id } })) ?? undefined;
  }

  async latest(filter: { service?: string; status?: 'open' | 'resolved' } = {}) {
    const row = await this.db.incident.findFirst({
      where: {
        ...(filter.service && { service: filter.service }),
        ...(filter.status && { status: filter.status }),
      },
      orderBy: { openedAt: 'desc' },
    });
    return row ?? undefined;
  }

  async listOpen() {
    return this.db.incident.findMany({ where: { status: 'open' }, orderBy: { openedAt: 'desc' } });
  }

  async open(input: {
    title: string;
    severity: string;
    service: string;
    primaryCause: string | null;
  }) {
    return this.db.incident.create({ data: { ...input, status: 'open' } });
  }

  async update(
    id: string,
    patch: { title?: string; severity?: string; primaryCause?: string | null },
  ) {
    return this.db.incident.update({ where: { id }, data: patch });
  }

  async resolve(id: string, at: Date) {
    return this.db.incident.update({ where: { id }, data: { status: 'resolved', resolvedAt: at } });
  }

  async appendEvent(incidentId: string, e: IncidentEventInput) {
    await this.db.incidentEvent.create({
      data: {
        incidentId,
        kind: e.kind,
        actor: e.actor,
        message: e.message,
        ...(e.data !== undefined && { data: e.data as Prisma.InputJsonValue }),
      },
    });
  }

  async events(incidentId: string) {
    const rows = await this.db.incidentEvent.findMany({
      where: { incidentId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(eventFromRow);
  }
}
