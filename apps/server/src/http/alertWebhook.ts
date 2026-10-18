import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { IncidentStore } from '../db/incidentStore.js';
import { toAlertView } from '../domain/alerts/alerts.js';
import { alertMessage, NotificationGate } from '../domain/alerts/notifications.js';
import { hashInput, type AuditLog, type AuditOutcome } from '../lib/audit.js';
import { log } from '../lib/log.js';
import type { Notifier } from '../notify/notifier.js';
import type { ServiceDef } from '../serviceConfig.js';

/**
 * Alertmanager webhook payload (version 4). Label and annotation values are
 * UNTRUSTED: they are sanitized by toAlertView and annotations are never sent.
 */
const text = z.string().max(1024);
export const alertmanagerWebhookSchema = z.object({
  version: z.literal('4'),
  status: z.enum(['firing', 'resolved']),
  receiver: z.string().max(200).optional(),
  alerts: z
    .array(
      z.object({
        status: z.enum(['firing', 'resolved']),
        labels: z.record(z.string().max(200), text),
        annotations: z.record(z.string().max(200), text).default({}),
        startsAt: z.string().max(64),
        endsAt: z.string().max(64).optional(),
        fingerprint: z.string().max(64),
      }),
    )
    .max(200),
});

export interface AlertWebhookDeps {
  /** Shared secret Alertmanager sends as a bearer token (http_config). Never a user token. */
  token: string | undefined;
  notifier: Notifier;
  gate: NotificationGate;
  services: readonly ServiceDef[];
  incidents: IncidentStore;
  audit: AuditLog;
  now: () => Date;
}

const digest = (v: string) => createHash('sha256').update(v, 'utf8').digest();

function authorized(header: string | undefined, token: string | undefined): boolean {
  if (!token) return false;
  const given = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return timingSafeEqual(digest(given), digest(token));
}

/**
 * POST /webhooks/alertmanager → Telegram (or another Notifier). Runs after the
 * Host / Origin / failed-auth guards. Dedupes and rate-limits per alert, and
 * records the notification on the service's open incident.
 */
export function alertWebhookHandler(deps: AlertWebhookDeps): RequestHandler {
  return (req, res) => {
    void (async () => {
      const body: unknown = req.body;
      const ok = authorized(req.header('authorization'), deps.token);
      const audit = (outcome: AuditOutcome) =>
        deps.audit.record({
          actor: ok ? 'alertmanager' : 'unknown',
          role: ok ? 'ingest' : 'unknown',
          tool: 'webhooks/alertmanager',
          inputHash: hashInput(body ?? {}),
          outcome,
        });
      if (!ok) {
        await audit('unauthenticated');
        res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
        return;
      }
      const parsed = alertmanagerWebhookSchema.safeParse(body);
      if (!parsed.success) {
        await audit('invalid_input');
        res.status(400).json({ error: 'invalid_input' });
        return;
      }

      let sent = 0;
      for (const a of parsed.data.alerts) {
        const view = toAlertView(
          {
            fingerprint: a.fingerprint,
            labels: a.labels,
            annotations: a.annotations,
            startsAt: new Date(a.startsAt),
            state: 'active',
            silencedBy: [],
            inhibitedBy: [],
          },
          deps.services,
        );
        const now = deps.now().getTime();
        if (!deps.gate.shouldSend(view.fingerprint, a.status, now)) continue;
        try {
          await deps.notifier.send(alertMessage(view, a.status));
        } catch (err) {
          log.warn('notification failed', {
            notifier: deps.notifier.name,
            error: err instanceof Error ? err.message : 'unknown',
          });
          continue;
        }
        deps.gate.record(view.fingerprint, a.status, now);
        sent++;
        const incident = view.service ? await deps.incidents.findOpen(view.service) : undefined;
        if (incident) {
          await deps.incidents.appendEvent(incident.id, {
            kind: 'notification',
            actor: null,
            message: `notified on-call: ${a.status} ${view.alertname}`,
            data: {
              status: a.status,
              alertname: view.alertname,
              severity: view.severity,
              via: deps.notifier.name,
            },
          });
        }
      }
      await audit('ok');
      res.status(200).json({ received: parsed.data.alerts.length, sent });
    })().catch((err: unknown) => {
      log.error('alert webhook failed', { error: err instanceof Error ? err.message : 'unknown' });
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
  };
}
