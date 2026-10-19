import { z } from 'zod';
import { ClientError } from '../clients/errors.js';
import type { PendingActionRecord } from '../db/pendingActionStore.js';
import { paramsOf, resolveAction } from '../domain/actions/plan.js';
import { loadSnapshot } from '../domain/actions/snapshot.js';
import type { ResolvedAction } from '../domain/actions/types.js';
import { speakVerification, verifyRecovery, type Verification } from '../domain/actions/verify.js';
import { capitalize, spokenVersion } from '../domain/spoken.js';
import { hashInput } from '../lib/audit.js';
import { UserFacingError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { Mutex } from '../lib/mutex.js';
import { toSpokenWords } from '../lib/untrusted.js';
import type { ServiceDef } from '../serviceConfig.js';
import { describeAction } from './prepare_action.js';
import type { ToolDefinition, ToolDeps, ToolOutput } from './types.js';

/** Invariant 8: at most this many executed actions per window, per team. */
export const RATE_LIMIT = { max: 3, windowMs: 10 * 60_000 } as const;

const inputSchema = z.object({
  confirmation_id: z
    .string()
    .min(8)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .describe('The confirmationId returned by prepare_action, after the user said yes.'),
});

export interface ConfirmData {
  confirmationId: string;
  action: ResolvedAction['action'];
  service: string;
  params: ResolvedAction;
  status: PendingActionRecord['status'];
  executedAt: string | null;
  executor?: Record<string, unknown>;
  verification?: Verification;
  /** true when this call replayed an earlier result (nothing ran again). */
  replayed?: boolean;
  reason?: string;
}

/** Serializes "rate-limit check + atomic claim" in this process (single instance). */
const confirmLock = new Mutex();

const NOT_FOUND = "I can't find that confirmation. Ask me to prepare the action again.";
const say = (name: string) => capitalize(toSpokenWords(name) || name);

function doneSpeak(a: ResolvedAction, svc: ServiceDef): string {
  switch (a.action) {
    case 'failover_provider':
      return `Done. ${capitalize(svc.displayName)} now uses ${say(a.to)}.`;
    case 'rollback_deploy':
      return `Done. ${capitalize(svc.displayName)} is back on ${spokenVersion(a.toVersion) ?? a.toVersion}.`;
    case 'restart_service':
      return `Done. ${capitalize(svc.displayName)} restarted.`;
  }
}

const VERB: Record<ResolvedAction['action'], string> = {
  failover_provider: 'fail over',
  rollback_deploy: 'roll back',
  restart_service: 'restart',
};

/** Executor failed: say why, never claim success. A timeout is honest about not knowing. */
function failureSpeak(a: ResolvedAction, err: unknown): string {
  const verb = VERB[a.action];
  if (err instanceof ClientError && err.kind === 'timeout') {
    return `I tried to ${verb}, but it timed out, so I can't tell whether it took effect. Check before trying again.`;
  }
  const why =
    err instanceof ClientError
      ? {
          unreachable: "couldn't be reached",
          rejected: 'refused it',
          bad_response: 'answered oddly',
          timeout: 'timed out',
        }[err.kind]
      : 'failed';
  return `I couldn't ${verb}: the target ${why}. As far as I can tell, nothing changed.`;
}

function replay(row: PendingActionRecord): ToolOutput<ConfirmData> {
  const base = (row.result?.data ?? {}) as Partial<ConfirmData>;
  const data: ConfirmData = {
    confirmationId: row.confirmationId,
    action: row.action,
    service: row.service,
    params: row.params,
    status: row.status,
    executedAt: row.executedAt?.toISOString() ?? null,
    ...base,
    replayed: true,
  };
  const speak =
    row.status === 'succeeded'
      ? "That's already done."
      : row.status === 'failed'
        ? 'That already ran and failed.'
        : row.status === 'refused'
          ? "That wasn't run because the situation changed. Ask me again if it's still needed."
          : "That's already in progress.";
  return { speak, data, isError: row.status === 'failed' || row.status === 'refused' };
}

async function record(
  deps: ToolDeps,
  row: PendingActionRecord,
  actor: string,
  stage: string,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  if (!row.incidentId) return;
  await deps.incidents
    .appendEvent(row.incidentId, { kind: 'action', actor, message, data: { stage, ...data } })
    .catch((err: unknown) =>
      log.warn('incident event failed', { error: err instanceof Error ? err.message : 'unknown' }),
    );
}

export const confirmAction: ToolDefinition<typeof inputSchema, ConfirmData> = {
  name: 'confirm_action',
  title: 'Confirm a prepared remediation',
  description:
    'Execute an action prepared by prepare_action, ONLY after the user clearly said yes. Runs it at most once, ' +
    're-checks the situation first, then reports whether metrics are recovering. A repeated id returns the original result.',
  inputSchema,
  minRole: 'responder',
  card: 'confirm',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true, // a reused confirmation never executes twice
    openWorldHint: true,
  },
  describeInvalidInput: () => NOT_FOUND,

  async handler(input, { deps, principal, sessionId }) {
    const id = input.confirmation_id;
    const row = await deps.pendingActions.find(id);
    const sameOwner =
      row !== undefined &&
      row.createdBy === principal.actor &&
      // Actor + paramsHash + expiry + single use always; the MCP session only in strict mode,
      // because voice clients may reconnect between "fail over" and "yes".
      (!deps.strictSessionBinding ||
        row.sessionId === null ||
        sessionId === undefined ||
        row.sessionId === sessionId);
    if (!row || !sameOwner) {
      if (row) log.warn('confirmation owner mismatch', { tool: 'confirm_action' });
      throw new UserFacingError('unknown_confirmation', NOT_FOUND);
    }
    if (row.status !== 'pending') return replay(row);
    const now = deps.now();
    if (row.expiresAt <= now) {
      throw new UserFacingError('confirmation_expired', 'That confirmation expired. Ask me again.');
    }

    // Rate limit + atomic claim, serialized so concurrent confirms can't both pass the count.
    const claim = await confirmLock.run(async () => {
      const recent = await deps.pendingActions.executedSince(
        new Date(now.getTime() - RATE_LIMIT.windowMs),
      );
      if (recent.length >= RATE_LIMIT.max) {
        const freeAt = recent[recent.length - RATE_LIMIT.max]!.getTime() + RATE_LIMIT.windowMs;
        return {
          kind: 'limited' as const,
          minutes: Math.max(1, Math.ceil((freeAt - now.getTime()) / 60_000)),
        };
      }
      return (await deps.pendingActions.claim(id, now))
        ? { kind: 'claimed' as const }
        : { kind: 'lost' as const };
    });
    if (claim.kind === 'limited') {
      throw new UserFacingError(
        'rate_limited',
        `I've already run ${RATE_LIMIT.max} actions in the last 10 minutes, the safety limit. Try again in ${claim.minutes} minute${claim.minutes === 1 ? '' : 's'}.`,
      );
    }
    if (claim.kind === 'lost') {
      const latest = await deps.pendingActions.find(id);
      return latest
        ? replay(latest)
        : { speak: NOT_FOUND, data: { confirmationId: id } as ConfirmData };
    }

    // From here we own this action: it runs at most once.
    const service = deps.services.find((s) => s.name === row.service);
    const action = row.params;
    const base: ConfirmData = {
      confirmationId: id,
      action: row.action,
      service: row.service,
      params: action,
      status: 'executing',
      executedAt: null,
    };
    const finish = async (
      status: 'succeeded' | 'failed' | 'refused',
      out: ToolOutput<ConfirmData>,
      extra: { executedAt?: Date | null; verification?: Verification } = {},
    ) => {
      await deps.pendingActions.finish(id, {
        status,
        result: { speak: out.speak, data: out.data as unknown as Record<string, unknown> },
        ...(extra.executedAt !== undefined && { executedAt: extra.executedAt }),
        ...(extra.verification && {
          verification: extra.verification as unknown as Record<string, unknown>,
        }),
      });
      return { ...out, isError: status !== 'succeeded' };
    };

    const executor = service && deps.executors.for(service, row.action);
    if (!service || !executor || hashInput(action) !== row.paramsHash) {
      const out = {
        speak: "I can't run that any more; the configuration changed. Nothing changed.",
        data: { ...base, status: 'refused' as const, reason: 'not_allowed' },
      };
      return finish('refused', out);
    }
    await record(deps, row, principal.actor, 'confirmed', `confirmed ${describeAction(action)}`);

    // Re-check against fresh state: if things changed, don't act.
    let snapshot;
    try {
      snapshot = await loadSnapshot(service, row.action, executor, deps, now);
    } catch (err) {
      const speak =
        err instanceof UserFacingError
          ? `I didn't act: ${err.speak}`
          : "I didn't act: I couldn't check the current state.";
      const out = {
        speak,
        data: { ...base, status: 'refused' as const, reason: 'state_unavailable' },
      };
      await record(deps, row, principal.actor, 'refused', 'not executed: state unavailable');
      return finish('refused', out);
    }
    const recheck = resolveAction(row.action, paramsOf(action), snapshot);
    if (!recheck.ok || hashInput(recheck.action) !== row.paramsHash) {
      const why = recheck.ok
        ? 'The plan would be different now; ask me to prepare it again.'
        : recheck.speak;
      const out = {
        speak: `I didn't act because things changed. ${why}`,
        data: {
          ...base,
          status: 'refused' as const,
          reason: recheck.ok ? 'plan_changed' : recheck.code,
        },
      };
      await record(deps, row, principal.actor, 'refused', `not executed: ${out.data.reason}`);
      return finish('refused', out);
    }

    // Before/after use the same short-window query, so they are comparable.
    const verifyQuery = service.queries.verifyErrorRate ?? service.queries.errorRate;
    const readErrorRate = async () =>
      (await deps.prometheus.instant(verifyQuery)).map((s) => s.value).find(Number.isFinite) ??
      null;
    const before = (await readErrorRate().catch(() => null)) ?? snapshot.errorRate;

    const executedAt = deps.now();
    let detail: Record<string, unknown>;
    try {
      detail = (await executor.execute(action)).detail;
    } catch (err) {
      log.warn('action failed', {
        action: row.action,
        error: err instanceof Error ? err.message : 'unknown',
      });
      const out = {
        speak: failureSpeak(action, err),
        data: {
          ...base,
          status: 'failed' as const,
          executedAt: executedAt.toISOString(),
          reason: err instanceof ClientError ? `${err.upstream}_${err.kind}` : 'error',
        },
      };
      await record(deps, row, principal.actor, 'failed', `failed ${describeAction(action)}`, {
        reason: out.data.reason,
        action,
      });
      return finish('failed', out, { executedAt });
    }
    await record(deps, row, principal.actor, 'executed', `executed ${describeAction(action)}`, {
      detail,
      action,
    });

    if (action.action === 'rollback_deploy' && executor.type === 'admin_api' && deps.deployLog) {
      await deps.deployLog
        .insertOnce({
          source: 'nightshift',
          externalId: id,
          service: service.name,
          environment: service.deploys?.environment ?? 'production',
          version: action.toVersion,
          commitSha: null,
          commitMessage: `rollback from ${action.fromVersion}`,
          author: principal.actor,
          status: 'success',
          deployedAt: executedAt,
        })
        .catch((err: unknown) =>
          log.warn('rollback deploy event failed', {
            error: err instanceof Error ? err.message : 'unknown',
          }),
        );
    }

    const verification = await verifyRecovery({
      before,
      threshold: service.thresholds.errorRate,
      read: readErrorRate,
      sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: deps.now,
    });
    await record(deps, row, principal.actor, 'verified', `verification: ${verification.outcome}`, {
      before: verification.before,
      after: verification.after,
      outcome: verification.outcome,
      action,
    });

    const out = {
      speak: `${doneSpeak(action, service)} ${speakVerification(verification)}`,
      data: {
        ...base,
        status: 'succeeded' as const,
        executedAt: executedAt.toISOString(),
        executor: detail,
        verification,
      },
    };
    return finish('succeeded', out, { executedAt, verification });
  },
};
