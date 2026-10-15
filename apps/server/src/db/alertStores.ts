import type { Db } from './prisma.js';

export interface AckRecord {
  fingerprint: string;
  startsAt: Date;
  alertname: string;
  service: string | null;
  ackedBy: string;
  ackedAt: Date;
}

export interface AckStore {
  /** Acks for these firing instances (fingerprint + startsAt). */
  findMany(keys: readonly { fingerprint: string; startsAt: Date }[]): Promise<AckRecord[]>;
  /** Idempotent: returns the existing ack if this instance is already acknowledged. */
  ackOnce(record: Omit<AckRecord, 'ackedAt'>): Promise<{ record: AckRecord; created: boolean }>;
}

export interface SilenceRecord {
  fingerprint: string;
  alertname: string;
  silenceId: string;
  durationMinutes: number;
  createdBy: string;
  endsAt: Date;
  createdAt: Date;
}

export interface SilenceStore {
  /** Most recent Nightshift silence for this alert created at or after `since`. */
  findRecent(fingerprint: string, since: Date): Promise<SilenceRecord | undefined>;
  create(record: Omit<SilenceRecord, 'createdAt'>): Promise<SilenceRecord>;
}

const UNIQUE_VIOLATION = 'P2002';

export class PrismaAckStore implements AckStore {
  constructor(private readonly db: Db) {}

  async findMany(keys: readonly { fingerprint: string; startsAt: Date }[]): Promise<AckRecord[]> {
    if (keys.length === 0) return [];
    return this.db.alertAck.findMany({
      where: { OR: keys.map((k) => ({ fingerprint: k.fingerprint, startsAt: k.startsAt })) },
    });
  }

  async ackOnce(record: Omit<AckRecord, 'ackedAt'>) {
    const key = { fingerprint: record.fingerprint, startsAt: record.startsAt };
    const existing = await this.db.alertAck.findUnique({ where: { fingerprint_startsAt: key } });
    if (existing) return { record: existing, created: false };
    try {
      return { record: await this.db.alertAck.create({ data: record }), created: true };
    } catch (err) {
      // Concurrent ack of the same instance: the unique constraint decides the winner.
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
      const winner = await this.db.alertAck.findUniqueOrThrow({
        where: { fingerprint_startsAt: key },
      });
      return { record: winner, created: false };
    }
  }
}

export class PrismaSilenceStore implements SilenceStore {
  constructor(private readonly db: Db) {}

  async findRecent(fingerprint: string, since: Date): Promise<SilenceRecord | undefined> {
    const row = await this.db.alertSilence.findFirst({
      where: { fingerprint, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    });
    return row ?? undefined;
  }

  async create(record: Omit<SilenceRecord, 'createdAt'>): Promise<SilenceRecord> {
    return this.db.alertSilence.create({ data: record });
  }
}
