/**
 * Incident timeline and postmortem draft (pure). Built ONLY from the recorded
 * incident and its events: nothing is looked up live, nothing is inferred
 * beyond what the events say. Notes are untrusted text and stay quoted.
 */
import type { IncidentEventRecord, IncidentRecord } from '../../db/incidentStore.js';
import { countWords, MAX_SPEAK_WORDS } from '../../lib/speak.js';
import { toSpokenWords, type UntrustedText } from '../../lib/untrusted.js';
import type { ResolvedAction } from '../actions/types.js';
import { capitalize, spokenClock, spokenDuration, spokenVersion } from '../spoken.js';

export type TimelineKind =
  | 'opened'
  | 'alert'
  | 'diagnosis'
  | 'prepared'
  | 'confirmed'
  | 'executed'
  | 'failed'
  | 'refused'
  | 'verified'
  | 'note'
  | 'resolved';

export interface TimelineEntry {
  at: string;
  kind: TimelineKind;
  actor: string | null;
  /** Server-authored. */
  text: string;
  note?: UntrustedText;
  data?: Record<string, unknown>;
}

interface DiagnosisData {
  causes?: {
    id: string;
    confidence: number;
    actions?: { action: string; params: Record<string, string> }[];
  }[];
  alerts?: { name: string; severity: string; startsAt: string }[];
}
interface ActionData {
  stage?: string;
  action?: ResolvedAction;
  outcome?: string;
  reason?: string;
  note?: UntrustedText;
}

const STAGES = new Set(['prepared', 'confirmed', 'executed', 'failed', 'refused', 'verified']);

export function buildTimeline(
  incident: IncidentRecord,
  events: readonly IncidentEventRecord[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    {
      at: incident.openedAt.toISOString(),
      kind: 'opened',
      actor: null,
      text: `incident opened: ${incident.title}`,
    },
  ];
  const seenAlerts = new Set<string>();
  for (const e of events) {
    const at = e.createdAt.toISOString();
    if (e.kind === 'diagnosis') {
      const d = (e.data ?? {}) as DiagnosisData;
      for (const a of d.alerts ?? []) {
        const key = `${a.name}|${a.startsAt}`;
        if (seenAlerts.has(key)) continue;
        seenAlerts.add(key);
        entries.push({
          at: a.startsAt,
          kind: 'alert',
          actor: null,
          text: `${a.name} (${a.severity}) fired`,
          data: { name: a.name, severity: a.severity },
        });
      }
      entries.push({
        at,
        kind: 'diagnosis',
        actor: e.actor,
        text: `diagnosis ${e.message}`,
        data: { causes: d.causes ?? [] },
      });
    } else if (e.kind === 'action') {
      const d = (e.data ?? {}) as ActionData;
      const stage = STAGES.has(d.stage ?? '') ? (d.stage as TimelineKind) : 'executed';
      entries.push({
        at,
        kind: stage,
        actor: e.actor,
        text: e.message,
        data: {
          ...(d.action && { action: d.action }),
          ...(d.outcome && { outcome: d.outcome }),
          ...(d.reason && { reason: d.reason }),
        },
      });
    } else if (e.kind === 'note' || e.kind === 'resolved') {
      const d = (e.data ?? {}) as ActionData;
      entries.push({
        at,
        kind: e.kind,
        actor: e.actor,
        text: e.message,
        ...(d.note && { note: d.note }),
      });
    }
  }
  // Stable sort by time (same-time entries keep their recorded order).
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => Date.parse(a.entry.at) - Date.parse(b.entry.at) || a.i - b.i)
    .map((x) => x.entry);
}

export interface Postmortem {
  summary: { title: string; service: string | null; severity: string; status: string };
  impact: { start: string; end: string | null; minutes: number | null; ongoing: boolean };
  cause: { id: string; confidence: number; diagnosedAt: string } | null;
  actionsTaken: {
    at: string;
    action: ResolvedAction;
    result: 'executed' | 'failed';
    verification: string | null;
  }[];
  followUps: string[];
  notes: { at: string; actor: string | null; note: UntrustedText }[];
}

export function draftPostmortem(
  incident: IncidentRecord,
  timeline: readonly TimelineEntry[],
): Postmortem {
  const firstAlert = timeline.find((t) => t.kind === 'alert');
  const start =
    firstAlert && Date.parse(firstAlert.at) < incident.openedAt.getTime()
      ? firstAlert.at
      : incident.openedAt.toISOString();
  const end = incident.resolvedAt?.toISOString() ?? null;

  const lastDiagnosis = [...timeline].reverse().find((t) => t.kind === 'diagnosis');
  const top = (lastDiagnosis?.data?.['causes'] as DiagnosisData['causes'])?.[0];

  const actionsTaken: Postmortem['actionsTaken'] = [];
  for (const t of timeline) {
    const action = t.data?.['action'] as ResolvedAction | undefined;
    if (!action || (t.kind !== 'executed' && t.kind !== 'failed')) continue;
    const verified = timeline.find(
      (v) =>
        v.kind === 'verified' &&
        Date.parse(v.at) >= Date.parse(t.at) &&
        JSON.stringify(v.data?.['action']) === JSON.stringify(action),
    );
    actionsTaken.push({
      at: t.at,
      action,
      result: t.kind,
      verification: (verified?.data?.['outcome'] as string | undefined) ?? null,
    });
  }

  const followUps: string[] = [];
  for (const a of actionsTaken) {
    if (a.result === 'failed') followUps.push(`Find out why ${a.action.action} failed.`);
    else if (a.action.action === 'failover_provider')
      followUps.push(`Fail back to ${a.action.from} once it is healthy.`);
    else if (a.action.action === 'rollback_deploy')
      followUps.push(`Fix ${a.action.fromVersion} before redeploying it.`);
    else followUps.push(`Find out why ${a.action.service} needed a restart.`);
    if (a.verification === 'no_improvement')
      followUps.push('Confirm the fix: errors had not recovered after the action.');
  }
  if (top?.id === 'no_clear_cause')
    followUps.push('Find the root cause: the rules found no clear cause.');
  if (actionsTaken.length === 0)
    followUps.push('Decide on a remediation, or record why none was needed.');
  if (incident.status !== 'resolved') followUps.push('Resolve the incident once it is stable.');

  return {
    summary: {
      title: incident.title,
      service: incident.service,
      severity: incident.severity,
      status: incident.status,
    },
    impact: {
      start,
      end,
      minutes: end ? Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60_000)) : null,
      ongoing: end === null,
    },
    cause:
      top && lastDiagnosis
        ? { id: top.id, confidence: top.confidence, diagnosedAt: lastDiagnosis.at }
        : null,
    actionsTaken,
    followUps,
    notes: timeline
      .filter(
        (t): t is TimelineEntry & { note: UntrustedText } =>
          (t.kind === 'note' || t.kind === 'resolved') && !!t.note,
      )
      .map((t) => ({ at: t.at, actor: t.actor, note: t.note })),
  };
}

const say = (name: string) => capitalize(toSpokenWords(name) || name);

const OUTCOME: Record<string, string> = {
  recovered: 'errors recovered',
  recovering: 'errors were recovering',
  no_improvement: 'errors had not improved',
  unknown: 'the effect was not measured',
};

function causePhrase(p: Postmortem): string {
  const failover = p.actionsTaken.find((a) => a.action.action === 'failover_provider')?.action;
  const rollback = p.actionsTaken.find((a) => a.action.action === 'rollback_deploy')?.action;
  switch (p.cause?.id) {
    case 'provider_failure':
      return failover?.action === 'failover_provider'
        ? `${say(failover.from)} failing`
        : 'a payment provider failing';
    case 'recent_deploy':
      return rollback?.action === 'rollback_deploy'
        ? `the ${spokenVersion(rollback.fromVersion) ?? 'recent'} deploy`
        : 'a recent deploy';
    case 'saturation':
      return 'saturation';
    case 'possible_attack':
      return 'a possible attack';
    case 'no_clear_cause':
      return 'not found yet';
    default:
      return 'not diagnosed';
  }
}

function actionPhrase(p: Postmortem, timeZone: string): string {
  const last = p.actionsTaken.at(-1);
  if (!last) return 'No action taken.';
  const at = spokenClock(new Date(last.at), timeZone);
  if (last.result === 'failed')
    return `The ${last.action.action.replace(/_/g, ' ')} at ${at} failed.`;
  const did =
    last.action.action === 'failover_provider'
      ? `Failed over to ${say(last.action.to)}`
      : last.action.action === 'rollback_deploy'
        ? `Rolled back to ${spokenVersion(last.action.toVersion) ?? last.action.toVersion}`
        : 'Restarted it';
  return `${did} at ${at}; ${OUTCOME[last.verification ?? 'unknown'] ?? OUTCOME['unknown']}.`;
}

/** ≤ 30 words: severity + status/duration, cause, last action, note count. Notes are never spoken. */
export function speakTimeline(
  incident: IncidentRecord,
  p: Postmortem,
  ctx: { now: Date; timeZone: string; serviceName: string },
): string {
  const startMs = Date.parse(p.impact.start);
  const minutes = Math.max(
    1,
    Math.round(((p.impact.end ? Date.parse(p.impact.end) : ctx.now.getTime()) - startMs) / 60_000),
  );
  const status = p.impact.ongoing
    ? `open for ${spokenDuration(minutes)}`
    : `resolved after ${spokenDuration(minutes)}`;
  const head = `${capitalize(incident.severity)} incident on ${ctx.serviceName}, ${status}.`;
  const cause = `Cause: ${causePhrase(p)}.`;
  const action = actionPhrase(p, ctx.timeZone);
  const n = p.notes.length;
  const notes =
    n === 0 ? '' : n === 1 ? ' One note.' : ` ${capitalize(String(n === 2 ? 'two' : n))} notes.`;
  const variants = [
    `${head} ${cause} ${action}${notes}`,
    `${head} ${cause} ${action}`,
    `${head} ${cause}`,
  ];
  return variants.find((v) => countWords(v) <= MAX_SPEAK_WORDS) ?? variants[variants.length - 1]!;
}
