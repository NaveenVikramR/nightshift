import type { ResolvedAction } from '../domain/actions/types.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { Db } from './prisma.js';

export type PendingStatus = 'pending' | 'executing' | 'succeeded' | 'failed' | 'refused';

export interface BlastRadius {
  changes: string;
  affected: string;
  undo: string;
  expectedEffect: string;
}

export interface PendingActionRecord {
  confirmationId: string;
  action: ResolvedAction['action'];
  service: string;
  params: ResolvedAction;
  paramsHash: string;
  summary: BlastRadius;
  createdBy: string;
  sessionId: string | null;
  incidentId: string | null;
  status: PendingStatus;
  expiresAt: Date;
  usedAt: Date | null;
  executedAt: Date | null;
  /** What confirm_action answered (replayed verbatim on a reused confirmation). */
  result: { speak: string; data: Record<string, unknown> } | null;
  verification: Record<string, unknown> | null;
  createdAt: Date;
}

export type NewPendingAction = Omit<
  PendingActionRecord,
  'status' | 'usedAt' | 'executedAt' | 'result' | 'verification' | 'createdAt'
>;

export interface PendingActionStore {
  create(action: NewPendingAction): Promise<PendingActionRecord>;
  find(confirmationId: string): Promise<PendingActionRecord | undefined>;
  /**
   * Atomic claim: pending and unexpired → executing. Returns true for exactly
   * one caller; every concurrent or later caller gets false (invariant 2).
   */
  claim(confirmationId: string, now: Date): Promise<boolean>;
  finish(
    confirmationId: string,
    patch: {
      status: Exclude<PendingStatus, 'pending' | 'executing'>;
      result: NonNullable<PendingActionRecord['result']>;
      executedAt?: Date | null;
      verification?: Record<string, unknown> | null;
    },
  ): Promise<void>;
  /** Actions that actually ran (succeeded or failed) since `since`, oldest first. */
  executedSince(since: Date): Promise<Date[]>;
}

type Row = Awaited<ReturnType<Db['pendingAction']['findUnique']>>;

function fromRow(row: NonNullable<Row>): PendingActionRecord {
  return {
    confirmationId: row.confirmationId,
    action: row.action as ResolvedAction['action'],
    service: row.service,
    params: row.params as unknown as ResolvedAction,
    paramsHash: row.paramsHash,
    summary: row.summary as unknown as BlastRadius,
    createdBy: row.createdBy,
    sessionId: row.sessionId,
    incidentId: row.incidentId,
    status: row.status as PendingStatus,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    executedAt: row.executedAt,
    result: row.result as PendingActionRecord['result'],
    verification: row.verification as PendingActionRecord['verification'],
    createdAt: row.createdAt,
  };
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

export class PrismaPendingActionStore implements PendingActionStore {
  constructor(private readonly db: Db) {}

  async create(a: NewPendingAction) {
    const row = await this.db.pendingAction.create({
      data: { ...a, params: json(a.params), summary: json(a.summary) },
    });
    return fromRow(row);
  }

  async find(confirmationId: string) {
    const row = await this.db.pendingAction.findUnique({ where: { confirmationId } });
    return row ? fromRow(row) : undefined;
  }

  async claim(confirmationId: string, now: Date) {
    // One conditional UPDATE: Postgres row locking makes exactly one caller see count 1.
    const { count } = await this.db.pendingAction.updateMany({
      where: { confirmationId, status: 'pending', expiresAt: { gt: now } },
      data: { status: 'executing', usedAt: now },
    });
    return count === 1;
  }

  async finish(
    confirmationId: string,
    patch: Parameters<PendingActionStore['finish']>[1],
  ): Promise<void> {
    await this.db.pendingAction.update({
      where: { confirmationId },
      data: {
        status: patch.status,
        result: json(patch.result),
        ...(patch.executedAt !== undefined && { executedAt: patch.executedAt }),
        ...(patch.verification !== undefined && { verification: json(patch.verification) }),
      },
    });
  }

  async executedSince(since: Date) {
    const rows = await this.db.pendingAction.findMany({
      where: { executedAt: { gte: since }, status: { in: ['succeeded', 'failed'] } },
      select: { executedAt: true },
      orderBy: { executedAt: 'asc' },
    });
    return rows.map((r) => r.executedAt!).filter(Boolean);
  }
}
