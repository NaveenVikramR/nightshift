import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { BlastRadius } from '../db/pendingActionStore.js';
import { resolveAction } from '../domain/actions/plan.js';
import { loadSnapshot } from '../domain/actions/snapshot.js';
import {
  ACTIONS,
  actionParamsSchemas,
  suggestedActionSchema,
  type ActionName,
  type ResolvedAction,
} from '../domain/actions/types.js';
import { hashInput } from '../lib/audit.js';
import { UserFacingError } from '../lib/errors.js';
import { lookupService, type Clarification } from './common.js';
import type { ToolDefinition } from './types.js';

export const CONFIRMATION_TTL_MS = 2 * 60_000;

const inputSchema = z
  .object({
    action: z
      .enum(ACTIONS)
      .optional()
      .describe('Which remediation. Omit when passing suggested_action.'),
    service: z
      .string()
      .max(60)
      .optional()
      .describe(
        'Service as the user said it, e.g. "payments". Optional when params or suggested_action name it.',
      ),
    params: z
      .record(z.string(), z.string().max(64))
      .optional()
      .describe(
        'failover_provider: {to, from?}; rollback_deploy: {toVersion?, fromVersion?}; restart_service: {}.',
      ),
    suggested_action: suggestedActionSchema
      .optional()
      .describe('A suggestedActions entry from explain_incident, passed through unchanged.'),
  })
  .refine((v) => v.action !== undefined || v.suggested_action !== undefined, {
    message: 'action or suggested_action is required',
    path: ['action'],
  });

export interface PreparedData {
  confirmationId: string;
  action: ActionName;
  service: string;
  params: ResolvedAction;
  summary: BlastRadius;
  expiresAt: string;
  expiresInSeconds: number;
  incidentId: string | null;
}

/** "rollback_deploy razorpay→stripe"-style server-authored note for the incident log. */
function describe(a: ResolvedAction): string {
  switch (a.action) {
    case 'failover_provider':
      return `failover_provider ${a.from} -> ${a.to}`;
    case 'rollback_deploy':
      return `rollback_deploy ${a.fromVersion} -> ${a.toVersion}`;
    case 'restart_service':
      return 'restart_service';
  }
}

export const prepareAction: ToolDefinition<typeof inputSchema, PreparedData | Clarification> = {
  name: 'prepare_action',
  title: 'Prepare a remediation',
  description:
    'Prepare one allowlisted fix (fail over a provider, roll back a deploy, restart a service) after checking live state. ' +
    'Changes nothing: returns what would change and a confirmation id valid for 2 minutes. ' +
    'Ask the user, and only after a clear yes call confirm_action.',
  inputSchema,
  minRole: 'responder',
  card: 'confirm',
  annotations: {
    readOnlyHint: false, // stores a pending confirmation; the target is untouched
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  describeInvalidInput: (issue) =>
    issue.path[0] === 'action'
      ? 'I can fail over a provider, roll back a deploy, or restart a service. Which one?'
      : undefined,

  async handler(input, { deps, principal, sessionId }) {
    const action = input.suggested_action?.action ?? input.action!;
    const raw: Record<string, unknown> = {
      ...(input.suggested_action?.params ?? input.params ?? {}),
    };

    const found = lookupService(
      typeof raw['service'] === 'string' ? raw['service'] : input.service,
      deps.services,
    );
    if (found.kind === 'clarify') return found.output;
    const service = found.service;
    raw['service'] = service.name;

    const parsed = actionParamsSchemas[action].safeParse(raw);
    if (!parsed.success) {
      throw new UserFacingError(
        'invalid_params',
        action === 'failover_provider'
          ? 'Which provider should I fail over to?'
          : "I couldn't use those details for that action. Please try again.",
      );
    }

    const executor = deps.executors.for(service, action);
    if (!executor) {
      throw new UserFacingError(
        'action_not_allowed',
        `I'm not set up to do that for ${service.displayName}. Nothing changed.`,
      );
    }

    const now = deps.now();
    const snapshot = await loadSnapshot(service, action, executor, deps, now);
    const plan = resolveAction(action, parsed.data, snapshot);
    if (!plan.ok) throw new UserFacingError(plan.code, plan.speak);

    const incident = await deps.incidents.findOpen(service.name);
    const confirmationId = randomBytes(16).toString('base64url');
    const expiresAt = new Date(now.getTime() + CONFIRMATION_TTL_MS);
    await deps.pendingActions.create({
      confirmationId,
      action,
      service: service.name,
      params: plan.action,
      paramsHash: hashInput(plan.action),
      summary: plan.summary,
      createdBy: principal.actor,
      sessionId: sessionId ?? null,
      incidentId: incident?.id ?? null,
      expiresAt,
    });
    if (incident) {
      await deps.incidents.appendEvent(incident.id, {
        kind: 'action',
        actor: principal.actor,
        message: `prepared ${describe(plan.action)} (expires in 2 min)`,
        data: { stage: 'prepared', action: plan.action, summary: plan.summary },
      });
    }

    return {
      speak: plan.question,
      data: {
        confirmationId,
        action,
        service: service.name,
        params: plan.action,
        summary: plan.summary,
        expiresAt: expiresAt.toISOString(),
        expiresInSeconds: CONFIRMATION_TTL_MS / 1000,
        incidentId: incident?.id ?? null,
      },
    };
  },
};

export { describe as describeAction };
