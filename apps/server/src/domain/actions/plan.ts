/**
 * Resolve a requested action against a snapshot of live state (pure).
 * Used by prepare_action, and again by confirm_action right before executing,
 * so "the situation changed" is detected with the same rules.
 */
import type { DeployEvent } from '../../clients/deploys.js';
import type { BlastRadius } from '../../db/pendingActionStore.js';
import { toSpokenWords } from '../../lib/untrusted.js';
import type { ServiceDef } from '../../serviceConfig.js';
import type { BreakerState } from '../health/health.js';
import { capitalize, spokenVersion } from '../spoken.js';
import type { TargetState } from './executors/types.js';
import type { ActionName, ActionParams, ResolvedAction } from './types.js';

export interface ActionSnapshot {
  service: ServiceDef;
  /** From the executor; null when it can't report state. */
  target: TargetState | null;
  /** Current breaker per dependency (Prometheus); empty when unknown. */
  breakers: { dependency: string; state: BreakerState }[];
  /** Current error ratio; null when unknown. */
  errorRate: number | null;
  /** Deploy history, newest first. */
  deploys: DeployEvent[];
}

export type Resolution =
  | { ok: true; action: ResolvedAction; summary: BlastRadius; question: string }
  | { ok: false; code: string; speak: string };

const say = (name: string) => capitalize(toSpokenWords(name) || name);
const ver = (v: string) => spokenVersion(v) ?? `the ${v} build`;
const refuse = (code: string, speak: string): Resolution => ({ ok: false, code, speak });

function failover(p: ActionParams<'failover_provider'>, s: ActionSnapshot): Resolution {
  const providers = s.service.actions.failover_provider?.providers ?? [];
  const svc = s.service.displayName;
  if (!providers.includes(p.to)) {
    return refuse(
      'unknown_provider',
      `I can only route ${svc} to ${providers.map(say).join(' or ')}.`,
    );
  }
  const active = s.target?.activeProvider ?? null;
  if (!active)
    return refuse(
      'state_unknown',
      `I can't tell which provider ${svc} uses right now, so I won't switch it.`,
    );
  if (p.to === active)
    return refuse('already_active', `${capitalize(svc)} already uses ${say(p.to)}. Nothing to do.`);
  const from = p.from ?? active;
  if (from !== active) {
    return refuse(
      'wrong_source',
      `${capitalize(svc)} uses ${say(active)}, not ${say(from)}. Nothing changed.`,
    );
  }
  const breaker = (dep: string) => s.breakers.find((b) => b.dependency === dep)?.state;
  if (breaker(p.to) === 'open' || breaker(p.to) === 'half_open') {
    return refuse(
      'target_unhealthy',
      `${say(p.to)} looks unhealthy too, so failing over won't help.`,
    );
  }
  const threshold = s.service.thresholds.errorRate;
  const fromUnhealthy =
    breaker(from) === 'open' || (s.errorRate !== null && s.errorRate > threshold);
  if (!fromUnhealthy) {
    return refuse('source_healthy', `${say(from)} looks healthy, so I won't fail over.`);
  }
  return {
    ok: true,
    action: { action: 'failover_provider', service: s.service.name, from, to: p.to },
    summary: {
      changes: `Route all ${svc} traffic from ${say(from)} to ${say(p.to)}.`,
      affected: `Every new ${svc} request; calls already in flight to ${say(from)} finish or fail.`,
      undo: `Fail back to ${say(from)} at any time.`,
      expectedEffect: `Errors caused by ${say(from)} should stop within about a minute.`,
    },
    question: `This will route all ${svc} traffic from ${say(from)} to ${say(p.to)}. You can switch back anytime. Shall I go ahead?`,
  };
}

function rollback(p: ActionParams<'rollback_deploy'>, s: ActionSnapshot): Resolution {
  const svc = s.service.displayName;
  const ok = s.deploys.filter((d) => d.status === 'success');
  const current = s.target?.version ?? ok[0]?.version ?? null;
  if (!current)
    return refuse(
      'state_unknown',
      `I can't tell which version of ${svc} is running, so I won't roll back.`,
    );
  if (p.fromVersion && p.fromVersion !== current) {
    return refuse(
      'wrong_source',
      `${capitalize(svc)} is running ${ver(current)}, not ${ver(p.fromVersion)}. Nothing changed.`,
    );
  }
  let to: string | undefined = p.toVersion;
  if (to) {
    if (to === current)
      return refuse('already_active', `${capitalize(svc)} already runs ${ver(to)}. Nothing to do.`);
    if (!ok.some((d) => d.version === to)) {
      return refuse(
        'unknown_version',
        `I don't have a successful deploy of ${ver(to)} in the history, so I won't roll back to it.`,
      );
    }
  } else {
    // The most recent successful deploy of a different version, before the current one went out.
    const currentSince = ok.find((d) => d.version === current)?.deployedAt;
    to = ok.find(
      (d) => d.version !== current && (!currentSince || d.deployedAt <= currentSince),
    )?.version;
    if (!to)
      return refuse(
        'no_previous_version',
        `I don't know a previous version of ${svc} to roll back to.`,
      );
  }
  return {
    ok: true,
    action: {
      action: 'rollback_deploy',
      service: s.service.name,
      fromVersion: current,
      toVersion: to,
    },
    summary: {
      changes: `Deploy ${to} over ${current} on ${svc}.`,
      affected: `All ${svc} traffic during the rollout.`,
      undo: `Redeploy ${current}.`,
      expectedEffect: `Problems introduced in ${current} should stop.`,
    },
    question: `This will roll ${svc} back from ${ver(current)} to ${ver(to)}. You can redeploy it later. Shall I go ahead?`,
  };
}

function restart(s: ActionSnapshot): Resolution {
  const svc = s.service.displayName;
  if (s.target?.restarting)
    return refuse('already_restarting', `${capitalize(svc)} is already restarting.`);
  return {
    ok: true,
    action: { action: 'restart_service', service: s.service.name },
    summary: {
      changes: `Restart ${svc}.`,
      affected: `${capitalize(svc)} requests fail for a few seconds while it comes back.`,
      undo: 'Nothing to undo.',
      expectedEffect: 'Clears stuck state; it does not fix bad config or a provider outage.',
    },
    question: `This will restart ${svc}; requests fail for a few seconds. Shall I go ahead?`,
  };
}

export function resolveAction(
  action: ActionName,
  params: ActionParams,
  snapshot: ActionSnapshot,
): Resolution {
  switch (action) {
    case 'failover_provider':
      return failover(params as ActionParams<'failover_provider'>, snapshot);
    case 'rollback_deploy':
      return rollback(params as ActionParams<'rollback_deploy'>, snapshot);
    case 'restart_service':
      return restart(snapshot);
  }
}

/** Params as the resolver accepts them again at confirm time (from the stored, resolved action). */
export function paramsOf(a: ResolvedAction): ActionParams {
  switch (a.action) {
    case 'failover_provider':
      return { service: a.service, from: a.from, to: a.to };
    case 'rollback_deploy':
      return { service: a.service, fromVersion: a.fromVersion, toVersion: a.toVersion };
    case 'restart_service':
      return { service: a.service };
  }
}
