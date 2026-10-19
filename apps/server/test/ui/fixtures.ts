/**
 * Realistic tool results for the cards (render tests, screenshots, the test host).
 * Shapes are the real tool data types, so a data change breaks these at compile time.
 */
import type { ConfirmData } from '../../src/tools/confirm_action.js';
import type { ExplainData } from '../../src/tools/explain_incident.js';
import type { FindingsData } from '../../src/tools/get_security_findings.js';
import type { OpsBriefData } from '../../src/tools/get_ops_brief.js';
import type { PreparedData } from '../../src/tools/prepare_action.js';
import type { ScanData } from '../../src/tools/run_security_scan.js';

export interface Fixture {
  speak: string;
  data: unknown;
  isError?: boolean;
}

/** As a CallToolResult (what a host sends to the View). */
export function toCallToolResult(f: Fixture) {
  const structured = { speak: f.speak, data: f.data };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
    structuredContent: structured,
    ...(f.isError && { isError: true }),
  };
}

const iso = (t: number) => new Date(t).toISOString();
const MIN = 60_000;

/** Classic outage: low errors, then the Razorpay breaker opens 4 minutes ago. */
export function incident(now: number, inject = ''): Fixture {
  const start = now - 30 * MIN;
  const onset = now - 4 * MIN;
  const points: [string, number][] = [];
  for (let t = start; t <= now; t += 30_000) {
    const base = 0.008 + 0.004 * Math.sin(t / 90_000);
    const v = t < onset ? base : Math.min(0.48, 0.12 + ((t - onset) / (3 * MIN)) * 0.33);
    points.push([iso(t), Number(v.toFixed(4))]);
  }
  const data: ExplainData = {
    incidentId: 'inc_123',
    service: 'payments-api',
    displayName: 'Payments API',
    status: 'incident',
    severity: 'critical',
    causes: [
      {
        id: 'provider_failure',
        title: `Razorpay failing${inject}`,
        confidence: 0.86,
        security: false,
        evidence: [
          {
            kind: 'breaker_change',
            at: iso(onset),
            text: 'Razorpay circuit breaker opened 4 minutes ago.',
            values: { dependency: 'razorpay' },
          },
          {
            kind: 'metric_onset',
            at: iso(onset),
            text: 'Error rate rose from 1% to 45% at the same time.',
            values: { baseline: 0.01, peak: 0.45 },
          },
          {
            kind: 'alert',
            at: iso(onset + 30_000),
            text: 'Alert HighErrorRate is firing.',
            values: { alert: 'HighErrorRate' },
            quote: { untrusted: true, text: `payments-api 5xx error rate is 45%${inject}` },
          },
        ],
        suggestedActions: [
          {
            action: 'failover_provider',
            params: { service: 'payments-api', from: 'razorpay', to: 'stripe' },
            requiresConfirmation: true,
          },
        ],
      },
      {
        id: 'recent_deploy',
        title: 'Recent deploy v1.4.2',
        confidence: 0.42,
        security: false,
        evidence: [
          {
            kind: 'deploy',
            at: iso(now - 9 * MIN),
            text: 'Version 1.4.2 went out 5 minutes before errors started.',
            values: { version: 'v1.4.2' },
            quote: { untrusted: true, text: `tune payment retry config${inject}` },
          },
        ],
        suggestedActions: [
          {
            action: 'rollback_deploy',
            params: { service: 'payments-api', fromVersion: 'v1.4.2' },
            requiresConfirmation: true,
          },
        ],
      },
    ],
    relations: [],
    alerts: [
      {
        name: 'HighErrorRate',
        severity: 'critical',
        startsAt: iso(onset + 30_000),
        summary: { untrusted: true, text: 'payments-api 5xx error rate is 45%' },
      },
      {
        name: 'CircuitBreakerOpen',
        severity: 'critical',
        startsAt: iso(onset),
        summary: { untrusted: true, text: 'razorpay breaker open' },
      },
    ],
    series: {
      errorRate: {
        kind: 'spike',
        baseline: 0.01,
        onset: iso(onset),
        peak: { at: iso(now - 30_000), value: 0.45 },
        last: { at: iso(now), value: 0.45 },
        points,
        sampling: { rawPoints: points.length, keptEvery: 1 },
      },
    },
    thresholds: {
      errorRate: 0.05,
      latencyP95Seconds: 1.5,
      authFailuresPerSecond: 2,
      webhookFailuresPerSecond: 1,
    },
    breakers: [{ dependency: 'razorpay', current: 'open', openedAt: iso(onset) }],
    deploys: [
      { version: 'v1.4.2', deployedAt: iso(now - 9 * MIN), status: 'success', author: 'ci' },
    ],
    sources: [],
    window: { start: iso(start), end: iso(now), stepSeconds: 30 },
    narrator: { name: 'template' },
  };
  return {
    speak:
      'Critical. Payments API errors at 45 percent for 4 minutes. The Razorpay breaker is open. I can fail over to Stripe.',
    data,
  };
}

export function prepared(now: number, expiresInSeconds = 120): Fixture {
  const data: PreparedData = {
    confirmationId: 'cfm_9f3a1c7d2b',
    action: 'failover_provider',
    service: 'payments-api',
    params: {
      action: 'failover_provider',
      service: 'payments-api',
      from: 'razorpay',
      to: 'stripe',
    },
    summary: {
      changes: 'Route all Payments API traffic from Razorpay to Stripe',
      affected: 'New payments only; payments in flight finish on Razorpay',
      undo: 'Fail back to Razorpay any time',
      expectedEffect: 'Errors back under 5% within a minute',
    },
    expiresAt: iso(now + expiresInSeconds * 1000),
    expiresInSeconds,
    incidentId: 'inc_123',
  };
  return {
    speak:
      'This will route all payments API traffic from Razorpay to Stripe. You can switch back anytime. Shall I go ahead?',
    data,
  };
}

export function confirmed(now: number): Fixture {
  const data: ConfirmData = {
    confirmationId: 'cfm_9f3a1c7d2b',
    action: 'failover_provider',
    service: 'payments-api',
    params: {
      action: 'failover_provider',
      service: 'payments-api',
      from: 'razorpay',
      to: 'stripe',
    },
    status: 'succeeded',
    executedAt: iso(now - 20_000),
    verification: {
      outcome: 'recovered',
      before: 0.45,
      after: 0.005,
      threshold: 0.05,
      samples: [
        { at: iso(now - 15_000), errorRate: 0.21 },
        { at: iso(now - 5_000), errorRate: 0.005 },
      ],
    },
  };
  return { speak: 'Done. Payments API now uses Stripe. Recovered: errors at 0.5 percent.', data };
}

export const expired: Fixture = {
  speak: 'That confirmation expired. Ask me again.',
  data: { error: 'confirmation_expired' },
  isError: true,
};

export function scan(now: number, inject = ''): Fixture {
  const data: ScanData = {
    scanId: 'scan_2',
    grade: 'C',
    score: 72,
    previousGrade: 'A',
    change: 'down',
    counts: { critical: 0, high: 0, medium: 2, low: 2 },
    added: [],
    resolved: [
      {
        fingerprint: 'r1',
        check: 'tls_expiry',
        target: 'nightshift-demo.duckdns.org:443',
        severity: 'high',
        title: 'TLS certificate expires in 6 days',
        detail: { asset: 'payments API' },
      },
    ],
    open: [
      {
        fingerprint: 'f1',
        check: 'security_headers',
        target: 'https://payments.example/',
        severity: 'medium',
        title: `Missing Content-Security-Policy${inject}`,
        detail: {
          asset: 'payments API',
          header: 'content-security-policy',
          value: { untrusted: true, text: `default-src *${inject}` },
        },
      },
      {
        fingerprint: 'f2',
        check: 'security_headers',
        target: 'https://payments.example/',
        severity: 'medium',
        title: 'Missing Strict-Transport-Security',
        detail: { asset: 'payments API' },
      },
      {
        fingerprint: 'f3',
        check: 'security_headers',
        target: 'https://payments.example/',
        severity: 'low',
        title: 'Missing X-Content-Type-Options',
        detail: { asset: 'payments API' },
      },
      {
        fingerprint: 'f4',
        check: 'security_headers',
        target: 'https://payments.example/',
        severity: 'low',
        title: 'Server reveals X-Powered-By: Express',
        detail: { asset: 'payments API' },
      },
    ] as ScanData['open'],
    checks: [
      { check: 'tls_expiry', status: 'ok', findings: 0 },
      { check: 'security_headers', status: 'findings', findings: 4 },
      { check: 'dependabot', status: 'not_configured', findings: 0 },
      { check: 'secret_scanning', status: 'not_configured', findings: 0 },
      { check: 'auth_failure_spike', status: 'ok', findings: 0 },
      { check: 'webhook_signature_failures', status: 'ok', findings: 0 },
    ] as ScanData['checks'],
    scannedAt: iso(now - 20_000),
  };
  return {
    speak:
      'Security grade C, down from A. Four new issues: missing content security policy on payments API, and three more. Two of six checks didn’t run.',
    data,
  };
}

export function findingsNone(now: number): Fixture {
  const data: FindingsData = {
    scanned: true,
    grade: 'A',
    score: 100,
    scannedAt: iso(now - 3 * MIN),
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    findings: [],
    checks: [
      { check: 'tls_expiry', status: 'ok', findings: 0 },
      { check: 'security_headers', status: 'ok', findings: 0 },
      { check: 'dependabot', status: 'not_configured', findings: 0 },
      { check: 'secret_scanning', status: 'not_configured', findings: 0 },
      { check: 'auth_failure_spike', status: 'ok', findings: 0 },
      { check: 'webhook_signature_failures', status: 'ok', findings: 0 },
    ] as FindingsData['checks'],
  };
  return { speak: 'Security grade A. No open issues.', data };
}

export function brief(now: number, inject = ''): Fixture {
  const data: OpsBriefData = {
    services: [
      {
        service: 'payments-api',
        displayName: 'Payments API',
        status: 'critical',
        reasons: [`errors at 45%${inject}`],
        activeProvider: 'razorpay',
        available: true,
      },
      {
        service: 'webhook-receiver',
        displayName: 'Webhook receiver',
        status: 'healthy',
        reasons: [],
        activeProvider: null,
        available: true,
      },
    ],
    alerts: {
      ok: true,
      value: {
        firing: 2,
        worst: { name: 'HighErrorRate', service: 'payments-api', severity: 'critical' },
      },
    },
    incidents: {
      ok: true,
      value: {
        open: [
          {
            id: 'inc_123',
            title: `Payments API: Razorpay failing${inject}`,
            service: 'payments-api',
            severity: 'critical',
            openedAt: iso(now - 4 * MIN),
          },
        ],
      },
    },
    security: {
      ok: true,
      value: { grade: 'A', score: 100, scannedAt: iso(now - 50 * MIN), counts: {} },
    },
    deploys: { ok: true, value: { last24h: 1, byService: { 'payments-api': 1 } } },
    generatedAt: iso(now),
  };
  return {
    speak:
      'Critical: payments API errors at 45 percent, Razorpay breaker open. Two alerts firing. Security grade A. One deploy today.',
    data,
  };
}

/** Named scenarios for the test host and screenshots. */
export const SCENARIOS = {
  incident: { card: 'incident', fixture: incident },
  confirm: { card: 'confirm', fixture: (now: number) => prepared(now) },
  'confirm-verified': { card: 'confirm', fixture: confirmed },
  'confirm-expired': { card: 'confirm', fixture: () => expired },
  security: { card: 'security', fixture: scan },
  'security-clean': { card: 'security', fixture: findingsNone },
  brief: { card: 'brief', fixture: brief },
} as const;
