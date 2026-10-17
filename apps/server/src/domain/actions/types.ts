import { z } from 'zod';

/**
 * The ONLY remediations Nightshift can perform (invariant 3). Nothing else,
 * ever: no shell, no Docker socket, no arbitrary URLs.
 */
export const ACTIONS = ['failover_provider', 'rollback_deploy', 'restart_service'] as const;
export type ActionName = (typeof ACTIONS)[number];

const name = z.string().min(1).max(64);
const version = z.string().regex(/^[\w.-]{1,64}$/, 'letters, digits, . _ -');

/**
 * Params as explain_incident suggests them and prepare_action accepts them
 * (same names, so a suggestion can be passed straight through).
 */
export const actionParamsSchemas = {
  failover_provider: z.object({ service: name, from: name.optional(), to: name }).strict(),
  rollback_deploy: z
    .object({ service: name, fromVersion: version.optional(), toVersion: version.optional() })
    .strict(),
  restart_service: z.object({ service: name }).strict(),
} as const satisfies Record<ActionName, z.ZodObject>;

export type ActionParams<A extends ActionName = ActionName> = z.infer<
  (typeof actionParamsSchemas)[A]
>;

/** A suggestion from explain_incident, e.g. {action: 'failover_provider', params: {...}}. */
export const suggestedActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('failover_provider'),
    params: actionParamsSchemas.failover_provider,
    requiresConfirmation: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('rollback_deploy'),
    params: actionParamsSchemas.rollback_deploy,
    requiresConfirmation: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('restart_service'),
    params: actionParamsSchemas.restart_service,
    requiresConfirmation: z.boolean().optional(),
  }),
]);

/** Fully resolved params: what an executor runs (every choice already made). */
export type ResolvedAction =
  | { action: 'failover_provider'; service: string; from: string; to: string }
  | { action: 'rollback_deploy'; service: string; fromVersion: string; toVersion: string }
  | { action: 'restart_service'; service: string };

export function isActionName(value: unknown): value is ActionName {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}
