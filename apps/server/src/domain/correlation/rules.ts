/**
 * Correlation rules (CLAUDE.md v1), deterministic and pure (invariant 5).
 *
 * Rules read ONLY numbers, timestamps, sanitized identifiers and versions.
 * Untrusted text (commit messages, alert summaries) is attached to evidence
 * items as `quote` so a human or narrator can see it, but no rule ever reads
 * it, so it cannot change causes or suggested actions (invariant 6).
 */
import type { UntrustedText } from '../../lib/untrusted.js';
import { sortAlerts, type Severity } from '../alerts/alerts.js';
import {
  detectOnset,
  detectStateChange,
  type OnsetResult,
  type Point,
  type StateChange,
} from './changeDetection.js';
import type { Evidence, SignalName, SourceStatus } from './evidence.js';

export const DEPLOY_WINDOW_MS = 10 * 60_000;
const BREAKER_NEAR_ONSET_MS = 2 * 60_000;
const BREAKER_OPEN = 1;

export type CauseId =
  'recent_deploy' | 'provider_failure' | 'saturation' | 'possible_attack' | 'no_clear_cause';

export interface EvidenceItem {
  kind: 'metric_onset' | 'metric_level' | 'breaker_change' | 'deploy' | 'alert' | 'source';
  /** ISO time the fact refers to, when there is one. */
  at: string | null;
  /** Server-authored, built only from the values below. */
  text: string;
  values: Record<string, string | number | boolean | null>;
  /** Untrusted text shown as evidence; never read by any rule. */
  quote?: UntrustedText;
}

export type ActionKind = 'rollback_deploy' | 'failover_provider' | 'investigate';

export interface SuggestedAction {
  action: ActionKind;
  params: Record<string, string>;
  /** Remediations go through prepare_action / confirm_action (invariant 1). */
  requiresConfirmation: boolean;
}

export interface Cause {
  id: CauseId;
  title: string;
  confidence: number;
  security: boolean;
  evidence: EvidenceItem[];
  suggestedActions: SuggestedAction[];
}

export interface BreakerRelation {
  kind: 'breaker_after_deploy';
  dependency: string;
  version: string;
  deployedAt: Date;
  openedAt: Date;
  minutesAfter: number;
}

export interface BreakerFact {
  dependency: string;
  change: StateChange;
  /** Last observed value: open, closed, half_open, or unknown. */
  current: 'open' | 'closed' | 'half_open' | 'unknown';
}

/** What was measured, per signal, for the incident card and the narrator. */
export interface Facts {
  thresholds: Evidence['service']['thresholds'];
  onsets: Partial<Record<SignalName, OnsetResult>>;
  breakers: BreakerFact[];
}

export interface Diagnosis {
  service: { name: string; displayName: string };
  status: 'incident' | 'all_clear';
  severity: Severity;
  /** Highest confidence first. Empty when all clear. */
  causes: Cause[];
  relations: BreakerRelation[];
  facts: Facts;
  sources: SourceStatus[];
  window: Evidence['window'];
  /** The deploys that were considered (newest first). */
  deploys: Evidence['deploys'];
  alerts: { name: string; severity: Severity; startsAt: string; summary: UntrustedText }[];
}

const iso = (d: Date) => d.toISOString();
const round = (v: number, digits = 4) => Number(v.toFixed(digits));
const pct = (ratio: number) => `${round(ratio * 100, 1)}%`;
const minutesBetween = (a: Date, b: Date) => round((b.getTime() - a.getTime()) / 60_000, 1);

const BREAKER_STATES: Record<number, BreakerFact['current']> = {
  0: 'closed',
  1: 'open',
  2: 'half_open',
};

/** True when the signal is up now: a detected rise (or already high) and its last value above the floor. */
function isUp(o: OnsetResult | undefined, floor: number): boolean {
  if (!o || o.kind === 'insufficient_data' || o.kind === 'flat') return false;
  return o.last.value > floor;
}

const onsetOf = (o: OnsetResult | undefined): Point | undefined =>
  o?.kind === 'spike' ? o.onset : undefined;

export function computeFacts(e: Evidence): Facts {
  const t = e.service.thresholds;
  const floors: Record<SignalName, number> = {
    errorRate: t.errorRate,
    latencyP95: t.latencyP95Seconds,
    authFailures: t.authFailuresPerSecond,
    webhookFailures: t.webhookFailuresPerSecond,
    throughput: Number.POSITIVE_INFINITY, // context only, never "up"
  };
  const onsets: Facts['onsets'] = {};
  for (const [name, points] of Object.entries(e.series) as [SignalName, Point[]][]) {
    if (name === 'throughput') continue;
    onsets[name] = detectOnset(points, { minAbsolute: floors[name] });
  }
  const breakers = e.breakers.map((b) => {
    const last = b.points[b.points.length - 1];
    return {
      dependency: b.dependency,
      change: detectStateChange(b.points, BREAKER_OPEN),
      current: last ? (BREAKER_STATES[last.value] ?? 'unknown') : 'unknown',
    };
  });
  return { thresholds: t, onsets, breakers };
}

// --- evidence items (server-authored text from values only) ------------------

function onsetItem(signal: SignalName, o: OnsetResult, unit: (v: number) => string): EvidenceItem {
  if (o.kind === 'spike') {
    return {
      kind: 'metric_onset',
      at: iso(o.onset.time),
      text: `${signal} rose from a baseline of ${unit(o.baseline.level)} to ${unit(o.peak.value)} starting ${iso(o.onset.time)}; now ${unit(o.last.value)}.`,
      values: {
        signal,
        baseline: round(o.baseline.level),
        peak: round(o.peak.value),
        current: round(o.last.value),
        onset: iso(o.onset.time),
      },
    };
  }
  if (o.kind === 'insufficient_data') {
    return {
      kind: 'metric_level',
      at: null,
      text: `${signal}: not enough data in the window.`,
      values: { signal, points: o.points },
    };
  }
  return {
    kind: 'metric_level',
    at: iso(o.last.time),
    text:
      o.kind === 'elevated_at_start'
        ? `${signal} was already at ${unit(o.baseline.level)} when the window started; now ${unit(o.last.value)}.`
        : `${signal} stayed flat around ${unit(o.baseline.level)}; now ${unit(o.last.value)}.`,
    values: {
      signal,
      level: o.kind,
      baseline: round(o.baseline.level),
      current: round(o.last.value),
    },
  };
}

const UNITS: Record<SignalName, (v: number) => string> = {
  errorRate: pct,
  latencyP95: (v) => `${round(v, 3)} s`,
  throughput: (v) => `${round(v, 2)} req/s`,
  authFailures: (v) => `${round(v, 2)} failed logins/s`,
  webhookFailures: (v) => `${round(v, 2)} bad webhook signatures/s`,
};

function signalItem(f: Facts, signal: SignalName): EvidenceItem | undefined {
  const o = f.onsets[signal];
  return o ? onsetItem(signal, o, UNITS[signal]) : undefined;
}

function breakerItem(b: BreakerFact): EvidenceItem {
  const at = b.change.kind === 'entered' ? iso(b.change.at) : null;
  const text =
    b.change.kind === 'entered'
      ? `${b.dependency} circuit breaker opened at ${at}${b.change.still ? ' and is still open' : ', since closed'}.`
      : b.change.kind === 'at_start'
        ? `${b.dependency} circuit breaker was already open when the window started.`
        : `${b.dependency} circuit breaker is ${b.current}.`;
  return {
    kind: 'breaker_change',
    at,
    text,
    values: { dependency: b.dependency, current: b.current, opened: at },
  };
}

function deployItem(d: Evidence['deploys'][number], anchor: Date | undefined): EvidenceItem {
  const minutes = anchor ? minutesBetween(d.deployedAt, anchor) : null;
  return {
    kind: 'deploy',
    at: iso(d.deployedAt),
    text:
      minutes === null
        ? `Deploy ${d.version} at ${iso(d.deployedAt)}.`
        : `Deploy ${d.version} at ${iso(d.deployedAt)}, ${Math.abs(minutes)} min ${minutes >= 0 ? 'before' : 'after'} the onset.`,
    values: {
      version: d.version,
      deployedAt: iso(d.deployedAt),
      status: d.status,
      author: d.author,
      minutesBeforeOnset: minutes,
    },
    ...(d.commitMessage && { quote: d.commitMessage }),
  };
}

const notChecked = (sources: readonly SourceStatus[]): EvidenceItem[] =>
  sources
    .filter((s) => s.status === 'unavailable')
    .map((s) => ({
      kind: 'source' as const,
      at: null,
      text: `Could not check ${s.source} (${s.reason ?? 'error'}).`,
      values: { source: s.source, status: s.status, reason: s.reason ?? null },
    }));

// --- rules ------------------------------------------------------------------

/** Deploy within ±10 min of the error onset (else the latency onset). */
/** The onset deploys are compared against: errors, else latency. */
function anchorOf(f: Facts): { signal: SignalName; time: Date } | undefined {
  for (const signal of ['errorRate', 'latencyP95'] as const) {
    const o = onsetOf(f.onsets[signal]);
    if (o) return { signal, time: o.time };
  }
  return undefined;
}

/**
 * Deploy within 10 min BEFORE the error (else latency) onset. A deploy after
 * the onset cannot have caused it: it is never a cause (see exoneratedDeploys).
 */
export function recentDeployRule(e: Evidence, f: Facts): Cause | undefined {
  const a = anchorOf(f);
  if (!a) return undefined;
  const { signal: anchorSignal, time: anchor } = a;

  // Only the version RUNNING at the onset can have caused it: the latest deploy at
  // or before it. Earlier deploys were superseded (see supersededDeploys).
  const running = runningAt(e, anchor);
  if (!running || isNoOpDeploy(e, running)) return undefined;
  const delta = anchor.getTime() - running.deployedAt.getTime();
  if (delta > DEPLOY_WINDOW_MS) return undefined;
  const best = { deploy: running, confidence: round(0.9 - 0.4 * (delta / DEPLOY_WINDOW_MS), 2) };
  const d = best.deploy;
  return {
    id: 'recent_deploy',
    title: `Recent deploy ${d.version}`,
    confidence: best.confidence,
    security: false,
    evidence: [deployItem(d, anchor), signalItem(f, anchorSignal)!],
    suggestedActions: [
      {
        action: 'rollback_deploy',
        params: { service: e.service.name, fromVersion: d.version },
        requiresConfirmation: true,
      },
    ],
  };
}

/** The latest deploy at or before `t` (the version running then). Deploys are newest first. */
function runningAt(e: Evidence, t: Date): Evidence['deploys'][number] | undefined {
  return e.deploys.find((d) => d.deployedAt.getTime() <= t.getTime());
}

/**
 * A redeploy of the version that was already running changed nothing (e.g. a
 * reset or a retry), so it is never a suspect.
 */
function isNoOpDeploy(e: Evidence, d: Evidence['deploys'][number]): boolean {
  const previous = e.deploys.find((x) => x.deployedAt.getTime() < d.deployedAt.getTime());
  return previous !== undefined && previous.version === d.version;
}

/**
 * Deploys in the window before the onset that a later deploy replaced before
 * it (e.g. a bad version already rolled back): not running, so not the cause.
 */
export function supersededDeploys(e: Evidence, f: Facts): EvidenceItem[] {
  const a = anchorOf(f);
  if (!a) return [];
  const running = runningAt(e, a.time);
  if (!running) return [];
  return e.deploys
    .filter(
      (d) =>
        d !== running &&
        d.deployedAt.getTime() < running.deployedAt.getTime() &&
        a.time.getTime() - d.deployedAt.getTime() <= DEPLOY_WINDOW_MS,
    )
    .map((d) => ({
      kind: 'deploy' as const,
      at: iso(d.deployedAt),
      text: `Deploy ${d.version} at ${iso(d.deployedAt)} was replaced by ${running.version} at ${iso(running.deployedAt)} before errors started, so it is not the cause.`,
      values: {
        version: d.version,
        deployedAt: iso(d.deployedAt),
        replacedBy: running.version,
        replacedAt: iso(running.deployedAt),
        exonerated: true,
      },
    }));
}

/** Deploys that landed AFTER the onset: evidence that they are not the cause. */
export function exoneratedDeploys(e: Evidence, f: Facts): EvidenceItem[] {
  const a = anchorOf(f);
  if (!a) return [];
  return e.deploys
    .filter((d) => d.deployedAt.getTime() > a.time.getTime())
    .map((d) => {
      const minutes = minutesBetween(a.time, d.deployedAt);
      return {
        kind: 'deploy' as const,
        at: iso(d.deployedAt),
        text: `Errors started ${minutes} min before deploy ${d.version} at ${iso(d.deployedAt)}, so it is not the cause.`,
        values: {
          version: d.version,
          deployedAt: iso(d.deployedAt),
          onset: iso(a.time),
          minutesAfterOnset: minutes,
          exonerated: true,
        },
      };
    });
}

/** Breaker open on one provider while the others are closed. */
export function providerFailureRule(e: Evidence, f: Facts): Cause | undefined {
  const open = f.breakers.filter((b) => b.current === 'open');
  if (open.length === 0) return undefined;
  const closed = f.breakers.filter((b) => b.current === 'closed');
  const errorOnset = onsetOf(f.onsets.errorRate);
  const errorItem = signalItem(f, 'errorRate');

  if (open.length === 1 && closed.length > 0) {
    const b = open[0]!;
    const near =
      b.change.kind === 'entered' &&
      errorOnset !== undefined &&
      Math.abs(errorOnset.time.getTime() - b.change.at.getTime()) <= BREAKER_NEAR_ONSET_MS;
    return {
      id: 'provider_failure',
      title: `${b.dependency} is failing`,
      confidence: near ? 0.9 : 0.85,
      security: false,
      evidence: [breakerItem(b), ...closed.map(breakerItem), ...(errorItem ? [errorItem] : [])],
      suggestedActions: [
        {
          action: 'failover_provider',
          params: { service: e.service.name, from: b.dependency, to: closed[0]!.dependency },
          requiresConfirmation: true,
        },
      ],
    };
  }
  // Everything open (or a single dependency): nowhere to fail over to.
  return {
    id: 'provider_failure',
    title:
      open.length > 1
        ? `All dependencies failing (${open.map((b) => b.dependency).join(', ')})`
        : `${open[0]!.dependency} is failing`,
    confidence: 0.6,
    security: false,
    evidence: [...open.map(breakerItem), ...(errorItem ? [errorItem] : [])],
    suggestedActions: [
      { action: 'investigate', params: { service: e.service.name }, requiresConfirmation: false },
    ],
  };
}

/** Latency up, errors flat, no breaker open → saturation (investigate, no action). */
export function saturationRule(e: Evidence, f: Facts): Cause | undefined {
  const t = f.thresholds;
  if (!isUp(f.onsets.latencyP95, t.latencyP95Seconds)) return undefined;
  if (isUp(f.onsets.errorRate, t.errorRate)) return undefined;
  if (f.breakers.some((b) => b.current === 'open')) return undefined;
  return {
    id: 'saturation',
    title: 'Saturation (latency up, errors flat)',
    confidence: 0.6,
    security: false,
    evidence: [signalItem(f, 'latencyP95'), signalItem(f, 'errorRate')].filter(
      (x): x is EvidenceItem => x !== undefined,
    ),
    suggestedActions: [
      {
        action: 'investigate',
        params: { service: e.service.name, check: 'database pool and connection saturation' },
        requiresConfirmation: false,
      },
    ],
  };
}

/** Auth-failure or webhook-signature spike → possible attack (investigate, never automated). */
export function possibleAttackRule(e: Evidence, f: Facts): Cause | undefined {
  const t = f.thresholds;
  const auth = isUp(f.onsets.authFailures, t.authFailuresPerSecond);
  const webhook = isUp(f.onsets.webhookFailures, t.webhookFailuresPerSecond);
  if (!auth && !webhook) return undefined;
  const kinds = [auth ? 'credential brute force' : null, webhook ? 'webhook spoofing' : null];
  return {
    id: 'possible_attack',
    title: `Possible ${kinds.filter(Boolean).join(' and ')}`,
    confidence: 0.7,
    security: true,
    evidence: [
      auth ? signalItem(f, 'authFailures') : undefined,
      webhook ? signalItem(f, 'webhookFailures') : undefined,
    ].filter((x): x is EvidenceItem => x !== undefined),
    suggestedActions: [
      {
        action: 'investigate',
        params: { service: e.service.name, kind: auth ? 'auth_failures' : 'webhook_signatures' },
        requiresConfirmation: false,
      },
    ],
  };
}

const RULES = [recentDeployRule, providerFailureRule, saturationRule, possibleAttackRule];

/** Is anything actually wrong? (alerts firing, or a signal up, or a breaker open) */
function somethingWrong(e: Evidence, f: Facts): boolean {
  const t = f.thresholds;
  return (
    e.alerts.some((a) => !a.silenced) ||
    isUp(f.onsets.errorRate, t.errorRate) ||
    isUp(f.onsets.latencyP95, t.latencyP95Seconds) ||
    f.breakers.some((b) => b.current === 'open')
  );
}

function noClearCause(e: Evidence, f: Facts, alerts: Diagnosis['alerts']): Cause {
  const anchor = onsetOf(f.onsets.errorRate)?.time ?? onsetOf(f.onsets.latencyP95)?.time;
  return {
    id: 'no_clear_cause',
    title: 'No clear cause found',
    confidence: 0,
    security: false,
    evidence: [
      ...alerts.slice(0, 3).map((a) => ({
        kind: 'alert' as const,
        at: a.startsAt,
        text: `${a.name} (${a.severity}) firing since ${a.startsAt}.`,
        values: { alertname: a.name, severity: a.severity },
        quote: a.summary,
      })),
      ...(['errorRate', 'latencyP95'] as const)
        .map((s) => signalItem(f, s))
        .filter((x): x is EvidenceItem => x !== undefined),
      {
        kind: 'deploy',
        at: null,
        text: anchor
          ? `No deploy within 10 minutes of the onset at ${iso(anchor)}.`
          : 'No onset found to compare deploys against.',
        values: { deploysConsidered: e.deploys.length },
      },
      ...(f.breakers.length > 0
        ? [
            {
              kind: 'breaker_change' as const,
              at: null,
              text: 'No circuit breaker is open.',
              values: { open: 0 },
            },
          ]
        : []),
      ...notChecked(e.sources),
    ],
    suggestedActions: [
      { action: 'investigate', params: { service: e.service.name }, requiresConfirmation: false },
    ],
  };
}

function breakerAfterDeploy(e: Evidence, f: Facts): BreakerRelation[] {
  const relations: BreakerRelation[] = [];
  const onset = anchorOf(f)?.time;
  for (const b of f.breakers) {
    if (b.change.kind !== 'entered') continue;
    const opened = b.change.at;
    // The version running when the breaker opened, if it went out within the window.
    const running = runningAt(e, opened);
    const deploy = running && !isNoOpDeploy(e, running) ? running : undefined;
    const after = deploy ? opened.getTime() - deploy.deployedAt.getTime() : Infinity;
    const errorsFirst =
      !!deploy && onset !== undefined && onset.getTime() < deploy.deployedAt.getTime();
    if (deploy && after <= DEPLOY_WINDOW_MS && !errorsFirst) {
      relations.push({
        kind: 'breaker_after_deploy',
        dependency: b.dependency,
        version: deploy.version,
        deployedAt: deploy.deployedAt,
        openedAt: opened,
        minutesAfter: minutesBetween(deploy.deployedAt, opened),
      });
    }
  }
  return relations;
}

function severityOf(e: Evidence, f: Facts, causes: readonly Cause[]): Severity {
  const firing = sortAlerts(e.alerts.filter((a) => !a.silenced));
  if (firing[0] && firing[0].severity !== 'unknown') return firing[0].severity;
  const t = f.thresholds;
  if (isUp(f.onsets.errorRate, t.errorRate) || f.breakers.some((b) => b.current === 'open')) {
    return 'critical';
  }
  if (causes.length > 0) return 'warning';
  return 'info';
}

/** Evidence → ranked causes. Pure and deterministic. */
export function diagnose(e: Evidence): Diagnosis {
  const facts = computeFacts(e);
  const alerts = sortAlerts(e.alerts.filter((a) => !a.silenced)).map((a) => ({
    name: a.alertname,
    severity: a.severity,
    startsAt: iso(a.startsAt),
    summary: a.summary,
  }));
  let causes = RULES.map((rule) => rule(e, facts)).filter((c): c is Cause => c !== undefined);
  const wrong = causes.length > 0 || somethingWrong(e, facts);
  if (causes.length === 0 && wrong) causes = [noClearCause(e, facts, alerts)];
  causes.sort((a, b) => b.confidence - a.confidence);
  const exonerated = [...exoneratedDeploys(e, facts), ...supersededDeploys(e, facts)];
  if (exonerated.length > 0) {
    causes = causes.map((c) => ({ ...c, evidence: [...c.evidence, ...exonerated] }));
  }

  return {
    service: { name: e.service.name, displayName: e.service.displayName },
    status: wrong ? 'incident' : 'all_clear',
    severity: wrong ? severityOf(e, facts, causes) : 'info',
    causes,
    relations: breakerAfterDeploy(e, facts),
    facts,
    sources: e.sources,
    window: e.window,
    deploys: e.deploys,
    alerts,
  };
}
