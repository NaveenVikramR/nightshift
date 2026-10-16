import type { Db } from './prisma.js';

export type DeployStatus = 'success' | 'failure' | 'in_progress';

/** A deploy as stored (text already sanitized at ingest). */
export interface StoredDeploy {
  id: string;
  source: string;
  externalId: string;
  service: string;
  environment: string;
  version: string;
  commitSha: string | null;
  commitMessage: string | null;
  author: string | null;
  status: string;
  deployedAt: Date;
  createdAt: Date;
}

export type NewDeploy = Omit<StoredDeploy, 'id' | 'createdAt'>;

export interface DeployStore {
  /** Idempotent per (source, externalId): returns the existing row on a repeat. */
  insertOnce(deploy: NewDeploy): Promise<{ record: StoredDeploy; created: boolean }>;
  /** Newest first, deployedAt within [since, until]. */
  list(query: {
    service: string;
    environment: string;
    since: Date;
    until: Date;
    limit: number;
  }): Promise<StoredDeploy[]>;
}

const UNIQUE_VIOLATION = 'P2002';

export class PrismaDeployStore implements DeployStore {
  constructor(private readonly db: Db) {}

  async insertOnce(deploy: NewDeploy) {
    const key = { source: deploy.source, externalId: deploy.externalId };
    const existing = await this.db.deployEvent.findUnique({ where: { source_externalId: key } });
    if (existing) return { record: existing, created: false };
    try {
      return { record: await this.db.deployEvent.create({ data: deploy }), created: true };
    } catch (err) {
      // Concurrent retry of the same deploy: the unique constraint decides the winner.
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
      const winner = await this.db.deployEvent.findUniqueOrThrow({
        where: { source_externalId: key },
      });
      return { record: winner, created: false };
    }
  }

  async list(q: { service: string; environment: string; since: Date; until: Date; limit: number }) {
    return this.db.deployEvent.findMany({
      where: {
        service: q.service,
        environment: q.environment,
        deployedAt: { gte: q.since, lte: q.until },
      },
      orderBy: { deployedAt: 'desc' },
      take: q.limit,
    });
  }
}
