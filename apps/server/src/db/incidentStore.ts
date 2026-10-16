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
}

export interface IncidentEventInput {
  kind: 'diagnosis' | 'alert' | 'ack' | 'silence' | 'note' | 'action' | 'deploy';
  actor: string | null;
  /** Server-authored text only; never untrusted text. */
  message: string;
  data?: unknown;
}

export interface IncidentStore {
  /** The open incident for this service, if any (most recent). */
  findOpen(service: string): Promise<IncidentRecord | undefined>;
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
  appendEvent(incidentId: string, event: IncidentEventInput): Promise<void>;
}

export class PrismaIncidentStore implements IncidentStore {
  constructor(private readonly db: Db) {}

  async findOpen(service: string) {
    const row = await this.db.incident.findFirst({
      where: { service, status: 'open' },
      orderBy: { openedAt: 'desc' },
    });
    return row ?? undefined;
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
}
