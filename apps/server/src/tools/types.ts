import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { AuditLog } from '../lib/audit.js';
import type { Principal } from '../lib/auth.js';
import type { Role } from '../lib/roles.js';

/** Dependencies shared by every tool (all behind interfaces so tests use fakes). */
export interface ToolDeps {
  audit: AuditLog;
  now: () => Date;
  serverVersion: string;
  startedAt: Date;
}

export interface ToolContext {
  principal: Principal;
  deps: ToolDeps;
}

/** Voice-first output contract: speak ≤ 30 words, data for cards / follow-ups. */
export interface ToolOutput<D = unknown> {
  speak: string;
  data: D;
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject, D = unknown> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  minRole: Role;
  annotations: ToolAnnotations;
  handler(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutput<D>>;
}
