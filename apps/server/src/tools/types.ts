import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { AlertmanagerClient } from '../clients/alertmanager.js';
import type { DeployEventsClient } from '../clients/deploys.js';
import type { PrometheusClient } from '../clients/prometheus.js';
import type { AckStore, SilenceStore } from '../db/alertStores.js';
import type { DeployStore } from '../db/deployStore.js';
import type { IncidentStore } from '../db/incidentStore.js';
import type { PendingActionStore } from '../db/pendingActionStore.js';
import type { SecurityStore } from '../db/securityStore.js';
import type { PostureScanner } from '../domain/posture/index.js';
import type { ExecutorRegistry } from '../domain/actions/executors/registry.js';
import type { Narrator } from '../domain/correlation/narrator.js';
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
  incidents: IncidentStore;
  /** Allowlisted executors per service + action (nightshift.yaml). */
  executors: ExecutorRegistry;
  pendingActions: PendingActionStore;
  security: SecurityStore;
  /** The allowlisted security checks (nightshift.yaml security). */
  posture: PostureScanner;
  /** Where Nightshift records deploys it performs itself (rollbacks). */
  deployLog?: DeployStore;
  /** confirm_action requires the preparing MCP session too (STRICT_SESSION_BINDING). */
  strictSessionBinding?: boolean;
  /** Waits between verification polls (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
  /** Speaks a diagnosis; default is the deterministic template (an LLM narrator comes later). */
  narrator?: Narrator;
  /** IANA zone for spoken clock times ("the 2:41 deploy"). */
  timeZone: string;
  now: () => Date;
  serverVersion: string;
  startedAt: Date;
}

export interface ToolContext {
  principal: Principal;
  deps: ToolDeps;
  /** MCP session id when the transport has one (confirmations are bound to it). */
  sessionId?: string;
}

/** Voice-first output contract: speak ≤ 30 words, data for cards / follow-ups. */
export interface ToolOutput<D = unknown> {
  speak: string;
  data: D;
  /** A handled failure that still returns data (e.g. an action that failed): isError + audited as error. */
  isError?: boolean;
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
