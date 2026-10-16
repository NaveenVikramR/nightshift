/**
 * Deterministic speech for a Diagnosis (voice contract: ≤ 30 words, severity
 * first, then what, likely cause, next step). Every number, time and version
 * comes from the diagnosis; untrusted text (commit messages, annotations) is
 * never used here.
 */
import { countWords, MAX_SPEAK_WORDS } from '../../lib/speak.js';
import { toSpokenWords } from '../../lib/untrusted.js';
import {
  spokenClock,
  spokenDuration,
  spokenPercent,
  spokenSeconds,
  spokenVersion,
  capitalize,
} from '../spoken.js';
import type { OnsetResult } from './changeDetection.js';
import type { Cause, Diagnosis } from './rules.js';

export interface SpeakContext {
  now: Date;
  timeZone: string;
}

const SEVERITY_WORD = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Heads up',
  unknown: 'Alert',
} as const;

const dependencyName = (d: string) => capitalize(toSpokenWords(d) || d);

/** "for 3 minutes" since a spike's onset; '' when the onset is unknown. */
function forHowLong(o: OnsetResult | undefined, now: Date): string {
  if (o?.kind !== 'spike') return '';
  const minutes = Math.floor((now.getTime() - o.onset.time.getTime()) / 60_000);
  return minutes < 1 ? ' for under a minute' : ` for ${spokenDuration(minutes)}`;
}

const current = (o: OnsetResult | undefined) =>
  o && o.kind !== 'insufficient_data' ? o.last.value : undefined;

/** First variant that fits the word budget (variants go from most to least detailed). */
function fit(variants: readonly string[]): string {
  const clean = variants.map((v) => v.replace(/\s+/g, ' ').trim());
  return clean.find((v) => countWords(v) <= MAX_SPEAK_WORDS) ?? clean[clean.length - 1]!;
}

const cause = (d: Diagnosis, id: Cause['id']) => d.causes.find((c) => c.id === id);
const actionParam = (c: Cause | undefined, action: string, key: string) =>
  c?.suggestedActions.find((a) => a.action === action)?.params[key];

/** "Payments API errors at 45 percent for 3 minutes." (variants with/without duration) */
function errorHeadline(
  d: Diagnosis,
  ctx: SpeakContext,
): { full: string; short: string } | undefined {
  const o = d.facts.onsets.errorRate;
  const value = current(o);
  if (value === undefined || value <= d.facts.thresholds.errorRate) return undefined;
  const svc = capitalize(d.service.displayName);
  return {
    full: `${svc} errors at ${spokenPercent(value)}${forHowLong(o, ctx.now)}.`,
    short: `${svc} errors at ${spokenPercent(value)}.`,
  };
}

function unavailableNote(d: Diagnosis): string {
  const down = d.sources.filter((s) => s.status === 'unavailable').map((s) => s.source);
  if (down.length === 0) return '';
  if (down.includes('deploys')) return " I couldn't check recent deploys.";
  if (down.includes('alertmanager')) return " I couldn't check alerts.";
  return ' Some metrics were unavailable.';
}

function deployAndBreaker(d: Diagnosis, ctx: SpeakContext): string[] | undefined {
  const rel = d.relations[0];
  const provider = cause(d, 'provider_failure');
  const deploy = cause(d, 'recent_deploy');
  if (!rel || !provider || !deploy) return undefined;
  const sev = SEVERITY_WORD[d.severity];
  const head = errorHeadline(d, ctx);
  const clock = spokenClock(rel.deployedAt, ctx.timeZone);
  const version = spokenVersion(rel.version);
  const deployRef = version ? `the ${clock} deploy, ${version}` : `the ${clock} deploy`;
  const to = actionParam(provider, 'failover_provider', 'to');
  const offer = to
    ? `I can fail over to ${dependencyName(to)} or roll back.`
    : 'I can roll it back.';
  const what = `The ${dependencyName(rel.dependency)} breaker opened right after ${deployRef}.`;
  return [
    `${sev}. ${head?.full ?? ''} ${what} ${offer}`,
    `${sev}. ${head?.short ?? ''} ${what} ${offer}`,
    `${sev}. ${what} ${offer}`,
  ];
}

function providerOnly(d: Diagnosis, ctx: SpeakContext, c: Cause): string[] {
  const sev = SEVERITY_WORD[d.severity];
  const head = errorHeadline(d, ctx);
  const from = actionParam(c, 'failover_provider', 'from');
  const to = actionParam(c, 'failover_provider', 'to');
  if (from && to) {
    // Only claim "no recent deploy" when the deploy history actually answered.
    const deploysChecked = d.sources.some((s) => s.source === 'deploys' && s.status === 'ok');
    const noDeploy =
      deploysChecked && d.deploys.length === 0 && !cause(d, 'recent_deploy')
        ? ' No recent deploy.'
        : '';
    const what = `The ${dependencyName(from)} breaker is open.`;
    const offer = `I can fail over to ${dependencyName(to)}.`;
    return [
      `${sev}. ${head?.full ?? ''} ${what}${noDeploy} ${offer}${unavailableNote(d)}`,
      `${sev}. ${head?.full ?? ''} ${what}${noDeploy} ${offer}`,
      `${sev}. ${head?.short ?? ''} ${what} ${offer}`,
    ];
  }
  const open = d.facts.breakers
    .filter((b) => b.current === 'open')
    .map((b) => dependencyName(b.dependency));
  const what =
    open.length > 1
      ? `Every provider breaker is open, so there's nowhere to fail over.`
      : `The ${open[0] ?? 'provider'} breaker is open and there's no other provider.`;
  return [
    `${sev}. ${head?.full ?? ''} ${what} Check the providers.`,
    `${sev}. ${head?.short ?? ''} ${what}`,
  ];
}

function deployOnly(d: Diagnosis, ctx: SpeakContext, c: Cause): string[] {
  const sev = SEVERITY_WORD[d.severity];
  const deployItem = c.evidence.find((e) => e.kind === 'deploy');
  const deployed = d.deploys.find((x) => x.version === deployItem?.values['version']);
  const minutes = deployItem?.values['minutesBeforeOnset'];
  if (!deployed || typeof minutes !== 'number') return [];
  const clock = spokenClock(deployed.deployedAt, ctx.timeZone);
  const version = spokenVersion(deployed.version);
  const deployRef = version ? `the ${clock} deploy, ${version}` : `the ${clock} deploy`;
  const svc = capitalize(d.service.displayName);
  const head = errorHeadline(d, ctx);
  const latency = current(d.facts.onsets.latencyP95);
  const what =
    head?.short.replace(/\.$/, '') ??
    (latency !== undefined
      ? `${svc} p95 latency at ${spokenSeconds(latency)}`
      : `${svc} is degraded`);
  const when =
    minutes >= 0
      ? `starting ${spokenDuration(Math.max(1, Math.round(minutes)))} after ${deployRef}`
      : `just before ${deployRef}`;
  return [
    `${sev}. ${what}, ${when}. Rolling it back is the likely fix.`,
    `${sev}. ${what}, right after ${deployRef}. I can roll it back.`,
  ];
}

function saturation(d: Diagnosis, ctx: SpeakContext): string[] {
  const o = d.facts.onsets.latencyP95;
  const latency = current(o);
  const svc = capitalize(d.service.displayName);
  const lat = latency !== undefined ? ` at ${spokenSeconds(latency)}` : '';
  return [
    `${SEVERITY_WORD[d.severity]}. ${svc} p95 latency is${lat}${forHowLong(o, ctx.now)}, but errors are normal. Looks like saturation, maybe database connections. Worth investigating; I won't act on this.`,
    `${SEVERITY_WORD[d.severity]}. ${svc} p95 latency is${lat}, errors are normal. Looks like saturation. Worth investigating; I won't act on this.`,
  ];
}

function attack(d: Diagnosis, ctx: SpeakContext): string[] {
  const sev = SEVERITY_WORD[d.severity];
  const svc = d.service.displayName;
  const auth = d.facts.onsets.authFailures;
  const hook = d.facts.onsets.webhookFailures;
  const t = d.facts.thresholds;
  const since = (o: OnsetResult | undefined) =>
    o?.kind === 'spike' ? ` since ${spokenClock(o.onset.time, ctx.timeZone)}` : '';
  const rate = (v: number) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, ''));
  const authUp =
    auth && auth.kind !== 'insufficient_data' && auth.last.value > t.authFailuresPerSecond;
  if (authUp) {
    return [
      `${sev}. ${rate(auth.last.value)} failed logins per second on ${svc}${since(auth)}. Possible brute force. Investigate; I won't take automatic action.`,
      `${sev}. ${rate(auth.last.value)} failed logins per second on ${svc}. Possible brute force. I won't act automatically.`,
    ];
  }
  if (hook && hook.kind !== 'insufficient_data') {
    return [
      `${sev}. ${rate(hook.last.value)} webhooks per second are failing signature checks on ${svc}${since(hook)}. Possible spoofing. Investigate; I won't take automatic action.`,
      `${sev}. Webhooks are failing signature checks on ${svc}. Possible spoofing. I won't act automatically.`,
    ];
  }
  return [`${sev}. Possible attack on ${svc}. Investigate; I won't take automatic action.`];
}

function noClearCause(d: Diagnosis, ctx: SpeakContext): string[] {
  const sev = SEVERITY_WORD[d.severity];
  const head = errorHeadline(d, ctx);
  const top = d.alerts[0];
  const alert = top ? `${toSpokenWords(top.name)} on ${d.service.displayName}` : undefined;
  const metricsDown = d.sources.some(
    (s) => s.status === 'unavailable' && (s.source === 'errorRate' || s.source === 'latencyP95'),
  );
  if (metricsDown) {
    return [
      `${sev}. ${alert ? `${capitalize(alert)} is firing.` : ''} I couldn't check the metrics, so I have no clear cause yet. Try again in a minute.`,
      `${sev}. I couldn't check the metrics, so I have no clear cause yet.`,
    ];
  }
  const what =
    head?.full ??
    (alert
      ? `${capitalize(alert)} is firing.`
      : `${capitalize(d.service.displayName)} looks unhealthy.`);
  return [
    `${sev}. ${what} No clear cause: no deploy or breaker change around the onset.${alert && head ? ` Top alert: ${alert}.` : ''}`,
    `${sev}. ${what} No clear cause: no deploy or breaker change around the onset.`,
    `${sev}. ${head?.short ?? what} No clear cause found.`,
  ];
}

function allClear(d: Diagnosis): string {
  const svc = capitalize(d.service.displayName);
  const err = current(d.facts.onsets.errorRate);
  const lat = current(d.facts.onsets.latencyP95);
  const parts = [
    err !== undefined ? `errors at ${spokenPercent(err)}` : null,
    lat !== undefined ? `p95 ${spokenSeconds(lat)}` : null,
  ].filter(Boolean);
  return parts.length > 0
    ? `All clear. ${svc} looks healthy: ${parts.join(', ')}. No alerts are firing.`
    : `All clear. No alerts are firing for ${d.service.displayName}.`;
}

/** Every variant this diagnosis could be spoken as (most detailed first). */
export function speechVariants(d: Diagnosis, ctx: SpeakContext): string[] {
  if (d.status === 'all_clear') return [allClear(d)];
  const combined = deployAndBreaker(d, ctx);
  if (combined) return combined;
  const top = d.causes[0];
  switch (top?.id) {
    case 'provider_failure':
      return providerOnly(d, ctx, top);
    case 'recent_deploy': {
      const v = deployOnly(d, ctx, top);
      return v.length > 0 ? v : noClearCause(d, ctx);
    }
    case 'saturation':
      return saturation(d, ctx);
    case 'possible_attack':
      return attack(d, ctx);
    default:
      return noClearCause(d, ctx);
  }
}

/** The spoken diagnosis: the most detailed variant within 30 words. */
export function speakDiagnosis(d: Diagnosis, ctx: SpeakContext): string {
  return fit(speechVariants(d, ctx));
}
