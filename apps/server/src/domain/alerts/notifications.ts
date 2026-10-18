/**
 * Push notifications for Alertmanager alerts (pure). Text is server-authored
 * from sanitized identifiers only: no annotation text, no links, no ids.
 */
import { describeAlert, type AlertView } from './alerts.js';

export type NotifyStatus = 'firing' | 'resolved';

export function alertMessage(
  a: Pick<AlertView, 'spokenName' | 'serviceDisplay' | 'severity'>,
  status: NotifyStatus,
): string {
  const what = describeAlert(a);
  if (status === 'resolved') return `✅ Resolved: ${what}.`;
  const head =
    a.severity === 'critical'
      ? '🔴 Critical'
      : a.severity === 'warning'
        ? '🟠 Warning'
        : '🔵 Alert';
  return `${head}: ${what}. Ask Alexa: what's wrong?`;
}

/**
 * Dedupe + rate limit, in memory (single instance):
 * - the same alert in the same status as the last message → skip (Alertmanager repeats);
 * - at most one message per alert AND status per window → flapping can't spam,
 *   while firing → resolved always gets through.
 */
export class NotificationGate {
  private readonly last = new Map<string, NotifyStatus>();
  private readonly sentAt = new Map<string, number>();

  constructor(private readonly windowMs = 5 * 60_000) {}

  shouldSend(fingerprint: string, status: NotifyStatus, now: number): boolean {
    if (this.last.get(fingerprint) === status) return false;
    const at = this.sentAt.get(`${fingerprint}|${status}`);
    if (at !== undefined && now - at < this.windowMs) return false;
    return true;
  }

  record(fingerprint: string, status: NotifyStatus, now: number): void {
    this.last.set(fingerprint, status);
    this.sentAt.set(`${fingerprint}|${status}`, now);
  }
}
