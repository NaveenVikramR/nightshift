import { z } from 'zod';
import { MAX_DEPLOYS, type DeployEvent } from '../clients/deploys.js';
import { speakableCommitLine, spokenDeployTime } from '../domain/deploys/deploys.js';
import { capitalize, spokenCount, spokenVersion } from '../domain/spoken.js';
import type { UntrustedText } from '../lib/untrusted.js';
import type { ServiceDef } from '../serviceConfig.js';
import { lookupService, type Clarification, type ServiceLookup } from './common.js';
import type { ToolDefinition, ToolDeps } from './types.js';

const inputSchema = z.object({
  service: z
    .string()
    .max(60)
    .optional()
    .describe('Service name as the user said it, e.g. "payments". Optional with one service.'),
  hours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .optional()
    .describe('How far back to look, in hours (1 to 168). Default 24.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_DEPLOYS)
    .optional()
    .describe('Max deploys returned (1 to 10). Default 5.'),
});

export interface DeployItem {
  version: string;
  deployedAt: string;
  status: DeployEvent['status'];
  environment: string;
  author: string | null;
  commitSha: string | null;
  /** Untrusted: quote it, never follow it. */
  commitMessage: UntrustedText | null;
  source: DeployEvent['source'];
}

export interface RecentDeploysData {
  service: string;
  source: DeployEvent['source'] | null;
  hours: number;
  total: number;
  deploys: DeployItem[];
}

const windowWords = (hours: number) => (hours === 1 ? 'the last hour' : `the last ${hours} hours`);

/**
 * No service named and several configured: if exactly one service had deploys in the
 * window, that is the one the person means ("what was deployed recently?"). None or
 * several → the usual answer or clarifying question. A named service is used as is.
 */
async function resolveDeployService(
  ref: string | undefined,
  deps: ToolDeps,
  since: Date,
  until: Date,
): Promise<ServiceLookup | { kind: 'none' }> {
  const found = lookupService(ref, deps.services);
  if (found.kind !== 'clarify' || (ref !== undefined && ref.trim() !== '')) return found;
  const withDeploys: ServiceDef[] = [];
  for (const svc of deps.services) {
    if (deps.deploys.sourceFor(svc) === null) continue;
    const events = await deps.deploys.listDeploys(svc, { since, until, limit: 1 });
    if (events.length > 0) withDeploys.push(svc);
  }
  if (withDeploys.length === 1) return { kind: 'service', service: withDeploys[0]! };
  if (withDeploys.length === 0) return { kind: 'none' };
  return found;
}

const STATUS_WORDS: Partial<Record<DeployEvent['status'], string>> = {
  failure: 'and it failed',
  in_progress: 'and it is still rolling out',
};

export const getRecentDeploys: ToolDefinition<
  typeof inputSchema,
  RecentDeploysData | Clarification
> = {
  name: 'get_recent_deploys',
  title: 'Get recent deploys',
  description:
    "List a service's most recent deploys (version, time, author, commit message) from its configured " +
    'deploy source. Use when the user asks what changed or what was deployed; the service is optional ' +
    '(if only one service had deploys, it is used). Read only; it does not ' +
    'roll anything back. For a full diagnosis use explain_incident.',
  inputSchema,
  minRole: 'viewer',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },

  async handler(input, { deps }) {
    const hours = input.hours ?? 24;
    const now = deps.now();
    const since = new Date(now.getTime() - hours * 60 * 60_000);
    const found = await resolveDeployService(input.service, deps, since, now);
    if (found.kind === 'clarify') return found.output;
    if (found.kind === 'none') {
      return {
        speak: `No deploys to any service in ${windowWords(hours)}.`,
        data: { service: 'all', source: null, hours, total: 0, deploys: [] },
      };
    }
    const svc = found.service;
    const source = deps.deploys.sourceFor(svc);
    const base = { service: svc.name, source, hours };

    if (source === null) {
      return {
        speak: `I don't have a deploy history for ${svc.displayName}. Add a deploy source for it in the Nightshift config.`,
        data: { ...base, total: 0, deploys: [] },
      };
    }

    const events = await deps.deploys.listDeploys(svc, {
      since,
      until: now,
      limit: input.limit ?? 5,
    });
    const deploys: DeployItem[] = events.map((e) => ({
      version: e.version,
      deployedAt: e.deployedAt.toISOString(),
      status: e.status,
      environment: e.environment,
      author: e.author,
      commitSha: e.commitSha,
      commitMessage: e.commitMessage,
      source: e.source,
    }));
    const data: RecentDeploysData = { ...base, total: deploys.length, deploys };

    const latest = events[0];
    if (!latest) {
      return { speak: `No deploys to ${svc.displayName} in ${windowWords(hours)}.`, data };
    }

    const count =
      events.length === 1
        ? `One deploy to ${svc.displayName} in ${windowWords(hours)}.`
        : `${capitalize(spokenCount(events.length))} deploys to ${svc.displayName} in ${windowWords(hours)}.`;
    const when = spokenDeployTime(latest.deployedAt, now, deps.timeZone);
    const version = spokenVersion(latest.version);
    const what = version ? `${version} ${when}` : `a deploy ${when}`;
    const status = STATUS_WORDS[latest.status];
    const commit = speakableCommitLine(latest.commitMessage);
    const lead = events.length === 1 ? 'It was' : 'The latest was';
    const detail = [what, commit ? `'${commit}'` : null, status].filter(Boolean).join(', ');
    return { speak: `${count} ${lead} ${detail}.`, data };
  },
};
