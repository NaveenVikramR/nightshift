import type { AuditEntry, AuditLog } from '../../src/lib/audit.js';

export class InMemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];
  failNext = false;

  async record(entry: AuditEntry): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('audit store unavailable');
    }
    this.entries.push(entry);
  }
}
