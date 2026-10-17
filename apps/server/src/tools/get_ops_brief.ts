import { z } from 'zod';
import { describeAlert, sortAlerts, type AlertView } from '../domain/alerts/alerts.js';
import { checkHealth, type HealthCheck } from '../domain/health/checkHealth.js';
import { capitalize, spokenCount, spokenList } from '../domain/spoken.js';
import { countWords, MAX_SPEAK_WORDS } from '../lib/speak.js';
import { log } from '../lib/log.js';
import type { ServiceDef } from '../serviceConfig.js';
import { loadAlertViews } from './common.js';
import type { ToolDefinition, ToolDeps } from './types.js';

const inputSchema = z.object({});
const DAY_MS = 24 * 60 * 60_000;

type Section<T> = { ok: true; value: T } | { ok: false; reason: string };

async function section<T>(name: string, p: Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    log.warn('ops brief source failed', {
      source: name,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return { ok: false, reason: 'unavailable' };
  }
}

export interface OpsBriefData {
  services: {
    service: string;
    displayName: string;
    status: string;
    reasons: string[];
    activeProvider: string | null;
    available: boolean;
  }[];
  alerts: Section<{
    firing: number;
    worst: { name: string; service: string | null; severity: string } | null;
  }>;
  incidents: Section<{
    open: {
      id: string;
      title: string;
      service: string | null;
      severity: string;
      openedAt: string;
    }[];
  }>;
  security: Section<{
    grade: string;
    score: number;
    scannedAt: string;
    counts: Record<string, number>;
  } | null>;
  deploys: Section<{ last24h: number; byService: Record<string, number> }>;
  generatedAt: string;
}

/** Fragments in urgency order; the most urgent is always spoken, the rest while they fit. */
function speakBrief(
  services: { svc: ServiceDef; h: HealthCheck | null }[],
  firing: AlertView[] | null,
  incidents: { service: string | null }[] | null,
  security: { grade: string; counts: Record<string, number> } | null | undefined,
  deploys: number | null,
  servicesByName: Map<string, ServiceDef>,
): string {
  const critical = services.filter((s) => s.h?.assessment.status === 'critical');
  const degraded = services.filter((s) => s.h?.assessment.status === 'degraded');
  const unknown = services.filter((s) => !s.h);
  const worstAlert = firing ? sortAlerts(firing)[0] : undefined;
  const securityBad =
    security && (['D', 'F'].includes(security.grade) || (security.counts['critical'] ?? 0) > 0);

  const allClear =
    critical.length === 0 &&
    degraded.length === 0 &&
    unknown.length === 0 &&
    firing?.length === 0 &&
    incidents?.length === 0 &&
    !securityBad;
  if (allClear) {
    const names = spokenList(services.map((s) => s.svc.displayName));
    const sec = security ? `security grade ${security.grade}` : 'no security scan yet';
    const dep =
      deploys === null
        ? ''
        : `, ${deploys === 0 ? 'no' : spokenCount(deploys)} deploy${deploys === 1 ? '' : 's'} today`;
    const line = `All clear: ${names} ${services.length === 1 ? 'is' : 'are'} healthy, no alerts, ${sec}${dep}.`;
    return countWords(line) <= MAX_SPEAK_WORDS
      ? line
      : `All clear: everything is healthy, no alerts, ${sec}${dep}.`;
  }

  const fragments: string[] = [];
  for (const { svc, h } of critical) {
    fragments.push(
      `Critical: ${svc.displayName} has ${spokenList(h!.assessment.reasons.slice(0, 2).map((r) => r.spoken))}.`,
    );
  }
  if (worstAlert && critical.length === 0) {
    fragments.push(
      `${capitalize(worstAlert.severity === 'unknown' ? 'alert' : worstAlert.severity)}: ${describeAlert(worstAlert)}${firing!.length > 1 ? `, plus ${spokenCount(firing!.length - 1)} more alert${firing!.length === 2 ? '' : 's'}` : ''}.`,
    );
  } else if (firing && firing.length > 0) {
    fragments.push(
      `${capitalize(spokenCount(firing.length))} alert${firing.length === 1 ? '' : 's'} firing.`,
    );
  }
  if (incidents && incidents.length > 0) {
    const where = incidents[0]!.service
      ? ` on ${servicesByName.get(incidents[0]!.service)?.displayName ?? 'a service'}`
      : '';
    fragments.push(
      incidents.length === 1
        ? `One open incident${where}.`
        : `${capitalize(spokenCount(incidents.length))} open incidents.`,
    );
  }
  for (const { svc, h } of degraded) {
    fragments.push(
      `${capitalize(svc.displayName)} is degraded: ${h!.assessment.reasons[0]?.spoken ?? 'check it'}.`,
    );
  }
  if (unknown.length > 0)
    fragments.push(`I couldn't check ${spokenList(unknown.map((s) => s.svc.displayName))}.`);
  if (firing === null) fragments.push("I couldn't check alerts.");
  if (security) fragments.push(`Security grade ${security.grade}.`);
  if (deploys !== null && deploys > 0)
    fragments.push(`${capitalize(spokenCount(deploys))} deploy${deploys === 1 ? '' : 's'} today.`);

  let speak = fragments[0] ?? 'I could not build the brief.';
  for (const f of fragments.slice(1)) {
    if (countWords(`${speak} ${f}`) > MAX_SPEAK_WORDS) continue;
    speak = `${speak} ${f}`;
  }
  return speak;
}

export const getOpsBrief: ToolDefinition<typeof inputSchema, OpsBriefData> = {
  name: 'get_ops_brief',
  title: 'Get the ops brief',
  description:
    "One-call summary of everything on call needs: each service's health, firing alerts, open incidents, the latest " +
    'security grade and deploys in the last 24 hours, most urgent first. Use for "give me the brief" or "how is everything".',
  inputSchema,
  minRole: 'viewer',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },

  async handler(_input, { deps }) {
    const now = deps.now();
    const [health, alerts, incidents, security, deploys] = await Promise.all([
      Promise.all(
        deps.services.map(async (svc) => ({
          svc,
          h: await checkHealth(svc, deps.prometheus).catch(() => null),
        })),
      ),
      section(
        'alerts',
        loadAlertViews(deps).then((all) => all.filter((a) => !a.silenced)),
      ),
      section('incidents', deps.incidents.listOpen()),
      section('security', deps.security.latestScan()),
      section('deploys', deployCounts(deps, now)),
    ]);
    const byName = new Map(deps.services.map((s) => [s.name, s]));
    const worst = alerts.ok ? sortAlerts(alerts.value)[0] : undefined;
    const scan = security.ok ? security.value : undefined;

    return {
      speak: speakBrief(
        health,
        alerts.ok ? alerts.value : null,
        incidents.ok ? incidents.value : null,
        scan === undefined ? undefined : scan && { grade: scan.grade, counts: scan.counts },
        deploys.ok ? deploys.value.last24h : null,
        byName,
      ),
      data: {
        services: health.map(({ svc, h }) => ({
          service: svc.name,
          displayName: svc.displayName,
          status: h?.assessment.status ?? 'unknown',
          reasons: h?.assessment.reasons.map((r) => r.spoken) ?? [],
          activeProvider: h?.activeProvider ?? null,
          available: h !== null,
        })),
        alerts: alerts.ok
          ? {
              ok: true,
              value: {
                firing: alerts.value.length,
                worst: worst
                  ? { name: worst.alertname, service: worst.service, severity: worst.severity }
                  : null,
              },
            }
          : alerts,
        incidents: incidents.ok
          ? {
              ok: true,
              value: {
                open: incidents.value.map((i) => ({
                  id: i.id,
                  title: i.title,
                  service: i.service,
                  severity: i.severity,
                  openedAt: i.openedAt.toISOString(),
                })),
              },
            }
          : incidents,
        security: security.ok
          ? {
              ok: true,
              value: security.value
                ? {
                    grade: security.value.grade,
                    score: security.value.score,
                    scannedAt: security.value.startedAt.toISOString(),
                    counts: security.value.counts,
                  }
                : null,
            }
          : security,
        deploys,
        generatedAt: now.toISOString(),
      },
    };
  },
};

async function deployCounts(
  deps: ToolDeps,
  now: Date,
): Promise<{ last24h: number; byService: Record<string, number> }> {
  const since = new Date(now.getTime() - DAY_MS);
  const byService: Record<string, number> = {};
  for (const svc of deps.services) {
    if (deps.deploys.sourceFor(svc) === null) continue;
    byService[svc.name] = (
      await deps.deploys.listDeploys(svc, { since, until: now, limit: 10 })
    ).length;
  }
  return { last24h: Object.values(byService).reduce((a, b) => a + b, 0), byService };
}
