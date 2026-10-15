import { toAlertView, type AlertView } from '../domain/alerts/alerts.js';
import { resolveService } from '../domain/services/resolveService.js';
import { spokenList } from '../domain/spoken.js';
import { UserFacingError } from '../lib/errors.js';
import type { ServiceDef } from '../serviceConfig.js';
import type { ToolDeps, ToolOutput } from './types.js';

/** A clarifying question instead of a guess (voice contract). Not an error. */
export interface Clarification {
  clarify: { question: string; options: { id: string; label: string }[] };
}

export function clarify(
  question: string,
  options: { id: string; label: string }[],
): ToolOutput<Clarification> {
  return { speak: question, data: { clarify: { question, options } } };
}

/** Every current alert from Alertmanager, normalized (untrusted text sanitized/quoted). */
export async function loadAlertViews(deps: ToolDeps): Promise<AlertView[]> {
  const alerts = await deps.alertmanager.listAlerts();
  return alerts.map((a) => toAlertView(a, deps.services));
}

export type ServiceLookup =
  { kind: 'service'; service: ServiceDef } | { kind: 'clarify'; output: ToolOutput<Clarification> };

/**
 * Resolve a spoken service reference. Omitted → the only service, or ask.
 * Unknown → UserFacingError listing what we do know.
 */
export function lookupService(
  ref: string | undefined,
  services: readonly ServiceDef[],
): ServiceLookup {
  const names = services.map((s) => s.displayName);
  const options = services.map((s) => ({ id: s.name, label: s.displayName }));
  if (ref === undefined || ref.trim() === '') {
    if (services.length === 1) return { kind: 'service', service: services[0]! };
    return {
      kind: 'clarify',
      output: clarify(`Which service: ${spokenList(names, 'or')}?`, options),
    };
  }
  const r = resolveService(ref, services);
  if (r.kind === 'match') return { kind: 'service', service: r.service };
  if (r.kind === 'ambiguous') {
    const amb = r.candidates.map((s) => s.displayName);
    return {
      kind: 'clarify',
      output: clarify(
        `Did you mean ${spokenList(amb, 'or')}?`,
        r.candidates.map((s) => ({ id: s.name, label: s.displayName })),
      ),
    };
  }
  throw new UserFacingError(
    'unknown_service',
    `I don't know that service. I can check ${spokenList(names.slice(0, 4), 'or')}.`,
  );
}
