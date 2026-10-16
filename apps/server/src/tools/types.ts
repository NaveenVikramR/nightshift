import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { AlertmanagerClient } from '../clients/alertmanager.js';
import type { DeployEventsClient } from '../clients/deploys.js';
import type { PrometheusClient } from '../clients/prometheus.js';
import type { AckStore, SilenceStore } from '../db/alertStores.js';
import type { AuditLog } from '../lib/audit.js';
import type { Principal } from '../lib/auth.js';
import type { Role } from '../lib/roles.js';
import type { ServiceDef } from '../serviceConfig.js';

/** Dependencies shared by every tool (all behind interfaces so tests use fakes). */
export interface ToolDeps {
  audit: AuditLog;
  prometheus: PrometheusClient;
  alertmanager: AlertmanagerClient;
  services: readonly ServiceDef[];
  acks: AckStore;
  silences: SilenceStore;
  deploys: DeployEventsClient;
  /** IANA zone for spoken clock times ("the 2:41 deploy"). */
  timeZone: string;
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
  /** Optional spoken explanation for the first validation issue (≤ 30 words). */
  describeInvalidInput?(issue: z.core.$ZodIssue): string | undefined;
}
