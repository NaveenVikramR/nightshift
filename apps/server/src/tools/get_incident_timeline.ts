import { z } from 'zod';
import {
  buildTimeline,
  draftPostmortem,
  speakTimeline,
  type Postmortem,
  type TimelineEntry,
} from '../domain/incidents/timeline.js';
import type { IncidentRecord } from '../db/incidentStore.js';
import type { ResolvedAction } from '../domain/actions/types.js';
import { checkHealth } from '../domain/health/checkHealth.js';
import type { Clarification } from './common.js';
import { findIncident } from './incidentTarget.js';
import type { ToolDefinition, ToolDeps } from './types.js';

/**
 * If the incident's last failover sent traffic away from a provider and that
 * provider is active again now, the fail-back happened outside Nightshift:
 * record it once, so the timeline and postmortem stay built from records.
 */
async function recordFailBack(deps: ToolDeps, incident: IncidentRecord): Promise<void> {
  const events = await deps.incidents.events(incident.id);
  const failover = [...events].reverse().find((e) => {
    const d = e.data as { stage?: string; action?: ResolvedAction } | undefined;
    return (
      e.kind === 'action' && d?.stage === 'executed' && d.action?.action === 'failover_provider'
    );
  });
  const action = (failover?.data as { action?: ResolvedAction } | undefined)?.action;
  if (!failover || action?.action !== 'failover_provider') return;
  const alreadyRecorded = events.some(
    (e) =>
      e.kind === 'routing' &&
      e.createdAt >= failover.createdAt &&
      (e.data as { activeProvider?: string } | undefined)?.activeProvider === action.from,
  );
  const svc = deps.services.find((s) => s.name === incident.service);
  if (alreadyRecorded || !svc) return;
  const health = await checkHealth(svc, deps.prometheus).catch(() => null);
  if (health?.activeProvider !== action.from) return;
  await deps.incidents.appendEvent(incident.id, {
    kind: 'routing',
    actor: null,
    message: 'provider routing changed outside Nightshift',
    data: { activeProvider: action.from, previouslyRoutedTo: action.to },
  });
}

const inputSchema = z.object({
  incident_id: z
    .string()
    .max(64)
    .regex(/^[\w-]+$/)
    .optional()
    .describe('A specific incident id. Optional.'),
  service: z
    .string()
    .max(60)
    .optional()
    .describe('Service as the user said it; its open (else latest) incident.'),
});

export interface TimelineData {
  incident: {
    id: string;
    title: string;
    service: string | null;
    severity: string;
    status: string;
    openedAt: string;
    resolvedAt: string | null;
  };
  timeline: TimelineEntry[];
  /** Draft built only from recorded events; notes are quoted, untrusted. */
  postmortem: Postmortem;
}

export const getIncidentTimeline: ToolDefinition<typeof inputSchema, TimelineData | Clarification> =
  {
    name: 'get_incident_timeline',
    title: 'Get the incident timeline',
    description:
      'The story of an incident: when alerts fired, the diagnosis, actions prepared, confirmed and executed, verification, ' +
      'notes and resolution, in order, plus a postmortem draft from those records. Defaults to the open incident, else the latest.',
    inputSchema,
    minRole: 'viewer',
    annotations: {
      readOnlyHint: false, // may record one detected routing change; never touches the target
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },

    async handler(input, { deps }) {
      const target = await findIncident(deps, input, { fallbackToLatest: true });
      if (target.kind === 'clarify') return target.output;
      const incident = target.incident;
      await recordFailBack(deps, incident);
      const timeline = buildTimeline(incident, await deps.incidents.events(incident.id));
      const postmortem = draftPostmortem(incident, timeline);
      const serviceName =
        deps.services.find((s) => s.name === incident.service)?.displayName ??
        incident.service ??
        'an unknown service';
      return {
        speak: speakTimeline(incident, postmortem, {
          now: deps.now(),
          timeZone: deps.timeZone,
          serviceName,
        }),
        data: {
          incident: {
            id: incident.id,
            title: incident.title,
            service: incident.service,
            severity: incident.severity,
            status: incident.status,
            openedAt: incident.openedAt.toISOString(),
            resolvedAt: incident.resolvedAt?.toISOString() ?? null,
          },
          timeline,
          postmortem,
        },
      };
    },
  };
