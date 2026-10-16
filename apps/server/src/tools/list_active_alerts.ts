import { z } from 'zod';
import { describeAlert, SEVERITIES, sortAlerts, type AlertView } from '../domain/alerts/alerts.js';
import { capitalize, spokenAgo } from '../domain/spoken.js';
import type { UntrustedText } from '../lib/untrusted.js';
import { loadAlertViews, lookupService, type Clarification } from './common.js';
import type { ToolDefinition } from './types.js';

const inputSchema = z.object({
  service: z
    .string()
    .max(60)
    .optional()
    .describe('Optional service name as the user said it, e.g. "payments".'),
  severity: z.enum(SEVERITIES).optional().describe('Only alerts of this severity.'),
  include_silenced: z
    .boolean()
    .optional()
    .describe('Also list alerts that are currently silenced. Default false.'),
  limit: z.number().int().min(1).max(20).optional().describe('Max alerts returned (default 10).'),
});

export interface AlertItem {
  fingerprint: string;
  alertname: string;
  service: string | null;
  severity: AlertView['severity'];
  startsAt: string;
  silenced: boolean;
  acknowledged: { by: string; at: string } | null;
  summary: UntrustedText;
  description: UntrustedText;
}

export interface ListAlertsData {
  service: string | null;
  total: number;
  alerts: AlertItem[];
}

export const listActiveAlerts: ToolDefinition<typeof inputSchema, ListAlertsData | Clarification> =
  {
    name: 'list_active_alerts',
    title: 'List active alerts',
    description:
      'List alerts currently firing in Alertmanager, worst first, with who acknowledged them. ' +
      'Use when the user asks what is wrong, what is firing, or about alerts for a service. ' +
      'Read only; to diagnose causes use explain_incident, to check metrics use get_service_health.',
    inputSchema,
    minRole: 'viewer',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },

    async handler(input, { deps }) {
      let serviceName: string | null = null;
      let serviceDisplay: string | null = null;
      if (input.service !== undefined) {
        const found = lookupService(input.service, deps.services);
        if (found.kind === 'clarify') return found.output;
        serviceName = found.service.name;
        serviceDisplay = found.service.displayName;
      }

      const all = await loadAlertViews(deps);
      const matching = sortAlerts(
        all.filter(
          (a) =>
            (input.include_silenced || !a.silenced) &&
            (serviceName === null || a.service === serviceName) &&
            (input.severity === undefined || a.severity === input.severity),
        ),
      );
      const shown = matching.slice(0, input.limit ?? 10);
      const acks = await deps.acks.findMany(
        shown.map((a) => ({ fingerprint: a.fingerprint, startsAt: a.startsAt })),
      );
      const ackFor = (a: AlertView) =>
        acks.find(
          (k) => k.fingerprint === a.fingerprint && k.startsAt.getTime() === a.startsAt.getTime(),
        );

      const alerts: AlertItem[] = shown.map((a) => {
        const ack = ackFor(a);
        return {
          fingerprint: a.fingerprint,
          alertname: a.alertname,
          service: a.service,
          severity: a.severity,
          startsAt: a.startsAt.toISOString(),
          silenced: a.silenced,
          acknowledged: ack ? { by: ack.ackedBy, at: ack.ackedAt.toISOString() } : null,
          summary: a.summary,
          description: a.description,
        };
      });
      const data: ListAlertsData = { service: serviceName, total: matching.length, alerts };

      const scope = serviceDisplay ? ` for ${serviceDisplay}` : '';
      const worst = shown[0];
      if (!worst) {
        return { speak: `All clear. No alerts are firing${scope}.`, data };
      }

      const now = deps.now();
      const severity = worst.severity === 'unknown' ? 'Alert' : capitalize(worst.severity);
      const count = matching.length === 1 ? 'One alert is' : `${matching.length} alerts are`;
      const ack = ackFor(worst);
      const ackText = ack ? `acknowledged by ${ack.ackedBy}` : 'not acknowledged';
      const lead =
        matching.length === 1
          ? `${severity}: ${describeAlert(worst)}, started ${spokenAgo(worst.startsAt, now)}, ${ackText}.`
          : `${severity}: ${count} firing${scope}. Worst is ${describeAlert(worst)}, started ${spokenAgo(worst.startsAt, now)}, ${ackText}.`;
      const next = worst.service ? ' Ask me why.' : '';
      return { speak: `${lead}${next}`, data };
    },
  };
