import type { AuditEntry, AuditLog } from '../lib/audit.js';
import type { Db } from './prisma.js';

export class PrismaAuditLog implements AuditLog {
  constructor(private readonly db: Db) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db.auditLog.create({ data: entry });
  }
}
