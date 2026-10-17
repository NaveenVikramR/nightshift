import { z } from 'zod';
import {
  buildTimeline,
  draftPostmortem,
  speakTimeline,
  type Postmortem,
  type TimelineEntry,
} from '../domain/incidents/timeline.js';
import type { Clarification } from './common.js';
import { findIncident } from './incidentTarget.js';
import type { ToolDefinition } from './types.js';

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
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },

    async handler(input, { deps }) {
      const target = await findIncident(deps, input, { fallbackToLatest: true });
      if (target.kind === 'clarify') return target.output;
      const incident = target.incident;
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
