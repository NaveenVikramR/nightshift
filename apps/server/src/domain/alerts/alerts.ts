import type { AmAlert } from '../../clients/alertmanager.js';
import {
  quoteUntrusted,
  sanitizeLabel,
  toSpokenWords,
  type UntrustedText,
} from '../../lib/untrusted.js';
import { resolveService, type NamedService } from '../services/resolveService.js';
import { spokenList } from '../spoken.js';

export const SEVERITIES = ['critical', 'warning', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number] | 'unknown';

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2, unknown: 3 };

/**
 * Alert normalized for Nightshift. Identifiers are sanitized (safe to speak);
 * free text (summary/description) is quoted as untrusted and only goes in `data`.
 */
export interface AlertView {
  fingerprint: string;
  alertname: string;
  /** "high error rate" */
  spokenName: string;
  service: string | null;
  /** Catalog display name ("payments API"), else the spoken label, else null. */
  serviceDisplay: string | null;
  severity: Severity;
  startsAt: Date;
  silenced: boolean;
  /** Sanitized identifying labels (for silence matchers and cards). */
  labels: Record<string, string>;
  summary: UntrustedText;
  description: UntrustedText;
}

export function toAlertView(a: AmAlert, services: readonly NamedService[]): AlertView {
  const alertname = sanitizeLabel(a.labels['alertname']) || 'unnamed alert';
  const service = sanitizeLabel(a.labels['service']) || null;
  const known = service ? services.find((s) => s.name === service) : undefined;
  const sev = sanitizeLabel(a.labels['severity']).toLowerCase();
  const labels: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.labels).slice(0, 20)) {
    const key = sanitizeLabel(k);
    if (key) labels[key] = sanitizeLabel(v, 128);
  }
  return {
    fingerprint: sanitizeLabel(a.fingerprint),
    alertname,
    spokenName: toSpokenWords(alertname) || 'unnamed alert',
    service,
    serviceDisplay: known?.displayName ?? (service ? toSpokenWords(service) : null),
    severity: (SEVERITIES as readonly string[]).includes(sev) ? (sev as Severity) : 'unknown',
    startsAt: a.startsAt,
    silenced: a.state === 'suppressed' || a.silencedBy.length > 0,
    labels,
    summary: quoteUntrusted(a.annotations['summary']),
    description: quoteUntrusted(a.annotations['description']),
  };
}

/** Worst first: severity, then most recently started. */
export function sortAlerts<A extends Pick<AlertView, 'severity' | 'startsAt'>>(
  alerts: readonly A[],
): A[] {
  return [...alerts].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.startsAt.getTime() - a.startsAt.getTime(),
  );
}

/** "high error rate on payments API" */
export function describeAlert(a: Pick<AlertView, 'spokenName' | 'serviceDisplay'>): string {
  return a.serviceDisplay ? `${a.spokenName} on ${a.serviceDisplay}` : a.spokenName;
}

export type AlertResolution =
  | { kind: 'match'; alert: AlertView }
  | { kind: 'ambiguous'; candidates: AlertView[] }
  | { kind: 'none' };

const ALERT_STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'alert',
  'alerts',
  'alarm',
  'one',
  'that',
  'this',
  'on',
  'for',
  'about',
  'of',
  'service',
  'please',
  'it',
]);

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));

/**
 * Which alert does the user mean? Pure.
 * - no reference: the only candidate, else ambiguous (or none)
 * - exact fingerprint (from list_active_alerts data)
 * - otherwise best word overlap with alert name, service (and its aliases) and severity
 */
export function resolveAlert(
  ref: string | undefined,
  candidates: readonly AlertView[],
  services: readonly NamedService[],
): AlertResolution {
  const sorted = sortAlerts(candidates);
  if (ref === undefined || ref.trim() === '') {
    if (sorted.length === 0) return { kind: 'none' };
    return sorted.length === 1
      ? { kind: 'match', alert: sorted[0]! }
      : { kind: 'ambiguous', candidates: sorted };
  }

  const byFingerprint = sorted.find((a) => a.fingerprint === ref.trim());
  if (byFingerprint) return { kind: 'match', alert: byFingerprint };

  const query = new Set(words(ref).filter((w) => !ALERT_STOP_WORDS.has(w)));
  if (query.size === 0) return resolveAlert(undefined, sorted, services);
  // A service phrase ("payments", "checkout") also resolves through the catalog.
  const viaCatalog = resolveService(ref, services);

  const scored = sorted
    .map((a) => {
      const svc = a.service ? services.find((s) => s.name === a.service) : undefined;
      // Weights: alert-name word 2, service-name word 1, severity 1, service-alias-only word 0.5
      // (so "payments" prefers payments-api alerts over a "payment webhooks" alias).
      const nameWords = new Set(words(a.spokenName));
      const svcWords = new Set([a.service ?? '', a.serviceDisplay ?? ''].flatMap(words));
      const aliasWords = new Set((svc?.aliases ?? []).flatMap(words));
      let score = 0;
      for (const w of query) {
        if (nameWords.has(w)) score += 2;
        else if (svcWords.has(w)) score += 1;
        else if (w === a.severity) score += 1;
        else if (aliasWords.has(w)) score += 0.5;
      }
      if (score === 0 && viaCatalog.kind === 'match' && viaCatalog.service.name === a.service) {
        score = 1;
      }
      return { a, score };
    })
    .filter((x) => x.score > 0);

  if (scored.length === 0) return { kind: 'none' };
  const best = Math.max(...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best).map((x) => x.a);
  return top.length === 1
    ? { kind: 'match', alert: top[0]! }
    : { kind: 'ambiguous', candidates: top };
}

/** "Which alert: high error rate on payments API or circuit breaker open on payments API?" */
export function clarifyAlertQuestion(candidates: readonly AlertView[]): string {
  const names = candidates.slice(0, 3).map(describeAlert);
  const more = candidates.length > 3 ? `, or one of ${candidates.length - 3} others` : '';
  return `Which alert: ${spokenList(names, 'or')}${more}?`;
}
