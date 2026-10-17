import type { IncidentRecord } from '../db/incidentStore.js';
import { UserFacingError } from '../lib/errors.js';
import { clarify, lookupService, type Clarification } from './common.js';
import type { ToolDeps, ToolOutput } from './types.js';

export type IncidentTarget =
  | { kind: 'incident'; incident: IncidentRecord }
  | { kind: 'clarify'; output: ToolOutput<Clarification> };

/**
 * Which incident the user means: an explicit id, a service's open (else latest)
 * incident, the only open incident, or, when `fallbackToLatest`, the most
 * recent one. Several open and no hint → ask.
 */
export async function findIncident(
  deps: ToolDeps,
  input: { incident_id?: string | undefined; service?: string | undefined },
  opts: { fallbackToLatest: boolean },
): Promise<IncidentTarget> {
  if (input.incident_id) {
    const incident = await deps.incidents.get(input.incident_id);
    if (!incident) throw new UserFacingError('unknown_incident', "I can't find that incident.");
    return { kind: 'incident', incident };
  }
  if (input.service) {
    const found = lookupService(input.service, deps.services);
    if (found.kind === 'clarify') return found;
    const incident =
      (await deps.incidents.findOpen(found.service.name)) ??
      (opts.fallbackToLatest
        ? await deps.incidents.latest({ service: found.service.name })
        : undefined);
    if (!incident) {
      throw new UserFacingError(
        'no_incident',
        `There's no ${opts.fallbackToLatest ? '' : 'open '}incident for ${found.service.displayName}.`,
      );
    }
    return { kind: 'incident', incident };
  }
  const open = await deps.incidents.listOpen();
  if (open.length === 1) return { kind: 'incident', incident: open[0]! };
  if (open.length > 1) {
    const name = (i: IncidentRecord) =>
      deps.services.find((s) => s.name === i.service)?.displayName ?? i.title;
    return {
      kind: 'clarify',
      output: clarify(
        `Which incident: ${open.slice(0, 3).map(name).join(' or ')}?`,
        open.slice(0, 5).map((i) => ({ id: i.id, label: name(i) })),
      ),
    };
  }
  const latest = opts.fallbackToLatest ? await deps.incidents.latest() : undefined;
  if (!latest) {
    throw new UserFacingError(
      'no_incident',
      opts.fallbackToLatest ? 'There are no incidents yet.' : "There's no open incident.",
    );
  }
  return { kind: 'incident', incident: latest };
}
