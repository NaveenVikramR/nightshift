import { z } from 'zod';
import {
  clarifyAlertQuestion,
  describeAlert,
  resolveAlert,
  sortAlerts,
  type AlertView,
} from '../domain/alerts/alerts.js';
import type { OnsetResult, Point } from '../domain/correlation/changeDetection.js';
import { collectEvidence, LOOKBACK, type Evidence } from '../domain/correlation/evidence.js';
import { narrateSafely, templateNarrator } from '../domain/correlation/narrator.js';
import { diagnose, type Diagnosis } from '../domain/correlation/rules.js';
import { capitalize } from '../domain/spoken.js';
import { UserFacingError } from '../lib/errors.js';
import type { ServiceDef } from '../serviceConfig.js';
import { clarify, loadAlertViews, lookupService, type Clarification } from './common.js';
import type { ToolDefinition, ToolDeps } from './types.js';

const inputSchema = z.object({
  alert: z
    .string()
    .max(120)
    .optional()
    .describe('Which alert, as the user said it ("the error alert") or a fingerprint. Optional.'),
  service: z
    .string()
    .max(60)
    .optional()
    .describe(
      'Service name as the user said it, e.g. "payments". Optional: default is whatever is worst right now.',
    ),
  lookback_minutes: z
    .number()
    .int()
    .min(LOOKBACK.min)
    .max(LOOKBACK.max)
    .optional()
    .describe('How far back to look for the change, in minutes (10 to 180). Default 60.'),
});

const MAX_CARD_POINTS = 60;

export interface SeriesSummary {
  /** Change-detection result; 'context' for signals shown but not judged (throughput). */
  kind: OnsetResult['kind'] | 'context';
  baseline: number | null;
  onset: string | null;
  peak: { at: string; value: number } | null;
  last: { at: string; value: number } | null;
  /** Downsampled [isoTime, value] pairs for the incident card. */
  points: [string, number][];
}

export interface ExplainData {
  incidentId: string | null;
  service: string;
  displayName: string;
  status: Diagnosis['status'];
  severity: Diagnosis['severity'];
  causes: Diagnosis['causes'];
  relations: (Omit<Diagnosis['relations'][number], 'deployedAt' | 'openedAt'> & {
    deployedAt: string;
    openedAt: string;
  })[];
  alerts: Diagnosis['alerts'];
  series: Record<string, SeriesSummary>;
  breakers: { dependency: string; current: string; openedAt: string | null }[];
  deploys: { version: string; deployedAt: string; status: string; author: string | null }[];
  sources: Diagnosis['sources'];
  window: { start: string; end: string; stepSeconds: number };
  narrator: { name: string; rejected?: string };
}

function downsample(points: readonly Point[]): [string, number][] {
  const every = Math.max(1, Math.ceil(points.length / MAX_CARD_POINTS));
  return points
    .filter((_, i) => i % every === 0 || i === points.length - 1)
    .map((p) => [p.time.toISOString(), Number(p.value.toFixed(4))]);
}

function summarize(o: OnsetResult, points: readonly Point[]): SeriesSummary {
  const at = (p: Point) => ({ at: p.time.toISOString(), value: Number(p.value.toFixed(4)) });
  if (o.kind === 'insufficient_data') {
    return {
      kind: o.kind,
      baseline: null,
      onset: null,
      peak: null,
      last: null,
      points: downsample(points),
    };
  }
  return {
    kind: o.kind,
    baseline: Number(o.baseline.mean.toFixed(4)),
    onset: o.kind === 'spike' ? o.onset.time.toISOString() : null,
    peak: at(o.peak),
    last: at(o.last),
    points: downsample(points),
  };
}

type Target =
  | { kind: 'service'; service: ServiceDef; alerts: AlertView[] | undefined }
  | { kind: 'reply'; speak: string; data: Clarification | AllClearData };

interface AllClearData {
  status: 'all_clear';
  incidentId: null;
  firing: 0;
}

/** Resolve what to diagnose: an alert, a service, or whatever is worst right now. */
async function resolveTarget(input: z.infer<typeof inputSchema>, deps: ToolDeps): Promise<Target> {
  if (input.service !== undefined && input.alert === undefined) {
    const found = lookupService(input.service, deps.services);
    if (found.kind === 'clarify') return { kind: 'reply', ...found.output };
    return { kind: 'service', service: found.service, alerts: undefined };
  }

  const all = await loadAlertViews(deps); // alerts are required to pick a target
  const firing = all.filter((a) => !a.silenced);
  let candidates = firing;
  if (input.service !== undefined) {
    const found = lookupService(input.service, deps.services);
    if (found.kind === 'clarify') return { kind: 'reply', ...found.output };
    candidates = firing.filter((a) => a.service === found.service.name);
  }

  let alert: AlertView | undefined;
  if (input.alert !== undefined) {
    const r = resolveAlert(input.alert, candidates, deps.services);
    if (r.kind === 'none') {
      throw new UserFacingError(
        'unknown_alert',
        "I can't find that alert firing. Ask me what's firing.",
      );
    }
    if (r.kind === 'ambiguous') {
      return {
        kind: 'reply',
        ...clarify(
          clarifyAlertQuestion(r.candidates),
          r.candidates.map((a) => ({ id: a.fingerprint, label: describeAlert(a) })),
        ),
      };
    }
    alert = r.alert;
  } else {
    alert = sortAlerts(candidates.filter((a) => a.service !== null))[0];
  }

  if (!alert) {
    if (input.service === undefined && deps.services.length > 1) {
      return {
        kind: 'reply',
        speak:
          'All clear. No alerts are firing. Name a service if you want me to check its metrics.',
        data: { status: 'all_clear', incidentId: null, firing: 0 },
      };
    }
    // A single configured service: check its metrics even with nothing firing.
    return { kind: 'service', service: deps.services[0]!, alerts: all };
  }
  const service = deps.services.find((s) => s.name === alert.service);
  if (!service) {
    throw new UserFacingError(
      'unknown_service',
      `${capitalize(alert.spokenName)} isn't tied to a service I know, so I can't diagnose it. Check the Nightshift config.`,
    );
  }
  return { kind: 'service', service, alerts: all };
}

/** Create or update the open incident for this service and log the diagnosis. */
async function recordIncident(d: Diagnosis, deps: ToolDeps, actor: string): Promise<string | null> {
  const existing = await deps.incidents.findOpen(d.service.name);
  if (d.status !== 'incident') return existing?.id ?? null;
  const top = d.causes[0];
  const title = d.alerts[0]
    ? `${d.alerts[0].name} on ${d.service.displayName}`
    : `${top?.title ?? 'Incident'} on ${d.service.displayName}`;
  const incident = existing
    ? await deps.incidents.update(existing.id, {
        severity: d.severity,
        primaryCause: top?.id ?? null,
      })
    : await deps.incidents.open({
        title,
        severity: d.severity,
        service: d.service.name,
        primaryCause: top?.id ?? null,
      });
  await deps.incidents.appendEvent(incident.id, {
    kind: 'diagnosis',
    actor,
    message: `${d.severity}: ${d.causes.map((c) => `${c.id} (${c.confidence})`).join(', ')}`,
    data: {
      causes: d.causes.map((c) => ({
        id: c.id,
        confidence: c.confidence,
        actions: c.suggestedActions,
      })),
      relations: d.relations,
      sources: d.sources,
      window: d.window,
    },
  });
  return incident.id;
}

function toData(
  d: Diagnosis,
  e: Evidence,
  incidentId: string | null,
  narrator: ExplainData['narrator'],
): ExplainData {
  const series: Record<string, SeriesSummary> = {};
  for (const [name, o] of Object.entries(d.facts.onsets)) {
    if (o) series[name] = summarize(o, e.series[name as keyof Evidence['series']] ?? []);
  }
  const tp = e.series.throughput;
  const last = tp?.[tp.length - 1];
  if (tp && last) {
    series['throughput'] = {
      kind: 'context',
      baseline: null,
      onset: null,
      peak: null,
      last: { at: last.time.toISOString(), value: Number(last.value.toFixed(4)) },
      points: downsample(tp),
    };
  }
  return {
    incidentId,
    service: d.service.name,
    displayName: d.service.displayName,
    status: d.status,
    severity: d.severity,
    causes: d.causes,
    relations: d.relations.map((r) => ({
      ...r,
      deployedAt: r.deployedAt.toISOString(),
      openedAt: r.openedAt.toISOString(),
    })),
    alerts: d.alerts,
    series,
    breakers: d.facts.breakers.map((b) => ({
      dependency: b.dependency,
      current: b.current,
      openedAt: b.change.kind === 'entered' ? b.change.at.toISOString() : null,
    })),
    deploys: d.deploys.map((x) => ({
      version: x.version,
      deployedAt: x.deployedAt.toISOString(),
      status: x.status,
      author: x.author,
    })),
    sources: d.sources,
    window: {
      start: d.window.start.toISOString(),
      end: d.window.end.toISOString(),
      stepSeconds: d.window.stepSeconds,
    },
    narrator,
  };
}

export const explainIncident: ToolDefinition<
  typeof inputSchema,
  ExplainData | Clarification | AllClearData
> = {
  name: 'explain_incident',
  title: 'Explain incident',
  description:
    'Diagnose what is wrong and why: correlates firing alerts, error and latency changes, circuit breakers and recent deploys with fixed rules, ' +
    'and records the incident. Use for "what\'s wrong?" or "why?". Returns causes with evidence and suggested actions; never executes anything.',
  inputSchema,
  minRole: 'viewer',
  annotations: {
    readOnlyHint: false, // writes Nightshift's own incident record; never touches the monitored system
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },

  async handler(input, { deps, principal }) {
    const target = await resolveTarget(input, deps);
    if (target.kind === 'reply') return { speak: target.speak, data: target.data };

    const now = deps.now();
    const evidence = await collectEvidence(target.service, deps, {
      end: now,
      ...(input.lookback_minutes !== undefined && { lookbackMinutes: input.lookback_minutes }),
      ...(target.alerts && { alerts: target.alerts }),
    });
    const diagnosis = diagnose(evidence);
    const narration = await narrateSafely(deps.narrator ?? templateNarrator, diagnosis, {
      now,
      timeZone: deps.timeZone,
    });
    const incidentId = await recordIncident(diagnosis, deps, principal.actor);
    return {
      speak: narration.speak,
      data: toData(diagnosis, evidence, incidentId, {
        name: narration.narrator,
        ...(narration.rejected && { rejected: narration.rejected }),
      }),
    };
  },
};
