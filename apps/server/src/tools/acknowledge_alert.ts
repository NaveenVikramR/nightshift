import { z } from 'zod';
import {
  clarifyAlertQuestion,
  describeAlert,
  resolveAlert,
  type AlertView,
} from '../domain/alerts/alerts.js';
import { capitalize, spokenAgo } from '../domain/spoken.js';
import { UserFacingError } from '../lib/errors.js';
import { clarify, loadAlertViews, type Clarification } from './common.js';
import type { ToolDefinition } from './types.js';

const inputSchema = z.object({
  alert: z
    .string()
    .max(120)
    .optional()
    .describe(
      'Which alert, as the user said it ("the error rate alert", "payments breaker") or a fingerprint from list_active_alerts. Optional when only one alert is unacknowledged.',
    ),
});

export interface AckData {
  fingerprint: string;
  alertname: string;
  service: string | null;
  severity: AlertView['severity'];
  acknowledged: { by: string; at: string };
  alreadyAcknowledged: boolean;
}

const severityWord = (a: AlertView) =>
  a.severity === 'unknown' ? 'Alert' : capitalize(a.severity);

export const acknowledgeAlert: ToolDefinition<
  typeof inputSchema,
  AckData | Clarification | { allAcknowledged: true }
> = {
  name: 'acknowledge_alert',
  title: 'Acknowledge alert',
  description:
    'Mark a firing alert as acknowledged by the caller, so teammates know someone is on it. ' +
    'Use when the user says they are looking at or taking an alert. Does not silence or fix anything; ' +
    'use silence_alert to mute notifications. Repeating it is safe.',
  inputSchema,
  minRole: 'responder',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },

  async handler(input, { principal, deps }) {
    const views = await loadAlertViews(deps);
    if (views.length === 0) {
      throw new UserFacingError(
        'no_alerts',
        "No alerts are firing, so there's nothing to acknowledge.",
      );
    }
    const acks = await deps.acks.findMany(
      views.map((v) => ({ fingerprint: v.fingerprint, startsAt: v.startsAt })),
    );
    const isAcked = (v: AlertView) =>
      acks.some(
        (k) => k.fingerprint === v.fingerprint && k.startsAt.getTime() === v.startsAt.getTime(),
      );

    // Without a reference, only unacknowledged alerts are candidates.
    const candidates = input.alert ? views : views.filter((v) => !isAcked(v));
    if (candidates.length === 0) {
      return {
        speak: 'All firing alerts are already acknowledged.',
        data: { allAcknowledged: true },
      };
    }

    const r = resolveAlert(input.alert, candidates, deps.services);
    if (r.kind === 'none') {
      throw new UserFacingError(
        'alert_not_found',
        "I couldn't find a firing alert like that. Ask me what alerts are firing.",
      );
    }
    if (r.kind === 'ambiguous') {
      return clarify(
        clarifyAlertQuestion(r.candidates),
        r.candidates.map((a) => ({ id: a.fingerprint, label: describeAlert(a) })),
      );
    }

    const alert = r.alert;
    const { record, created } = await deps.acks.ackOnce({
      fingerprint: alert.fingerprint,
      startsAt: alert.startsAt,
      alertname: alert.alertname,
      service: alert.service,
      ackedBy: principal.actor,
    });
    const data: AckData = {
      fingerprint: alert.fingerprint,
      alertname: alert.alertname,
      service: alert.service,
      severity: alert.severity,
      acknowledged: { by: record.ackedBy, at: record.ackedAt.toISOString() },
      alreadyAcknowledged: !created,
    };

    const speak = created
      ? `${severityWord(alert)} alert acknowledged: ${describeAlert(alert)}. It keeps firing until the cause is fixed.`
      : `${severityWord(alert)}: ${describeAlert(alert)} was already acknowledged by ${record.ackedBy} ${spokenAgo(record.ackedAt, deps.now())}.`;
    return { speak, data };
  },
};
