import { createHash } from 'node:crypto';
import type { Role } from './roles.js';

export type AuditOutcome = 'ok' | 'forbidden' | 'unauthenticated' | 'error';

export interface AuditEntry {
  actor: string;
  role: Role | 'unknown';
  tool: string;
  inputHash: string;
  outcome: AuditOutcome;
}

/** Audit sink (invariant 7). Prisma in production, in-memory fake in tests. */
export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

/** SHA-256 of the input as canonical JSON (object keys sorted), so equal inputs hash equally. */
export function hashInput(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
