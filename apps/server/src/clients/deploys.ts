import { z } from 'zod';
import type { DeployStore, StoredDeploy } from '../db/deployStore.js';
import { log } from '../lib/log.js';
import { quoteUntrusted, sanitizeLabel, type UntrustedText } from '../lib/untrusted.js';
import type { DeploySourceConfig, ServiceDef } from '../serviceConfig.js';
import { ClientError, fetchJson, type FetchLike } from './errors.js';

export type DeploySourceKind = DeploySourceConfig['source'];

/**
 * A deploy, from any source. Identifiers are sanitized; the commit message is
 * UNTRUSTED (invariant 6): quoted as evidence, never interpreted or spoken by
 * explain_incident.
 */
export interface DeployEvent {
  /** Source-specific id (row id, GitHub deployment id). Data only, never spoken. */
  id: string;
  source: DeploySourceKind;
  service: string;
  environment: string;
  version: string;
  commitSha: string | null;
  commitMessage: UntrustedText | null;
  author: string | null;
  status: 'success' | 'failure' | 'in_progress' | 'unknown';
  deployedAt: Date;
}

export interface DeployQuery {
  since: Date;
  until: Date;
  limit: number;
}

/** One backend (ingest table, GitHub). */
export interface DeploySource {
  listDeploys(
    service: ServiceDef,
    config: DeploySourceConfig,
    query: DeployQuery,
  ): Promise<DeployEvent[]>;
}

/** What tools and the correlation engine use: routes each service to its configured source. */
export interface DeployEventsClient {
  /** null when the service has no deploy source configured. */
  sourceFor(service: ServiceDef): DeploySourceKind | null;
  /** Newest first, deployedAt within [since, until]. [] when no source is configured. */
  listDeploys(service: ServiceDef, query: DeployQuery): Promise<DeployEvent[]>;
}

export const MAX_DEPLOYS = 10;

const STATUSES = new Set(['success', 'failure', 'in_progress']);

export function fromStored(row: StoredDeploy): DeployEvent {
  return {
    id: row.id,
    source: 'ingest',
    service: row.service,
    environment: row.environment,
    version: row.version,
    commitSha: row.commitSha,
    // Sanitized at ingest; quoted again so the type always says "untrusted".
    commitMessage: row.commitMessage === null ? null : quoteUntrusted(row.commitMessage),
    author: row.author,
    status: STATUSES.has(row.status) ? (row.status as DeployEvent['status']) : 'unknown',
    deployedAt: row.deployedAt,
  };
}

/** Deploys reported by CI through POST /events/deploy. */
export class IngestDeploySource implements DeploySource {
  constructor(private readonly store: DeployStore) {}

  async listDeploys(service: ServiceDef, config: DeploySourceConfig, q: DeployQuery) {
    let rows: StoredDeploy[];
    try {
      rows = await this.store.list({
        service: service.name,
        environment: config.environment,
        since: q.since,
        until: q.until,
        limit: Math.min(q.limit, MAX_DEPLOYS),
      });
    } catch (err) {
      throw new ClientError('Database', 'unreachable', err instanceof Error ? err.message : '');
    }
    return rows.map(fromStored);
  }
}

// --- GitHub ------------------------------------------------------------------

const ghDeployment = z.object({
  id: z.number(),
  sha: z.string(),
  ref: z.string(),
  environment: z.string(),
  created_at: z.string(),
  creator: z.object({ login: z.string() }).nullable().optional(),
  payload: z.unknown().optional(),
});
const ghStatus = z.object({ state: z.string(), created_at: z.string() });
const ghCommit = z.object({
  message: z.string(),
  author: z.object({ name: z.string().optional() }).nullable().optional(),
});

const GH_STATE: Record<string, DeployEvent['status']> = {
  success: 'success',
  inactive: 'success', // a previous successful deploy, since superseded
  failure: 'failure',
  error: 'failure',
  in_progress: 'in_progress',
  queued: 'in_progress',
  pending: 'in_progress',
};

const SHA = /^[0-9a-f]{40}$/i;

/** Version label: the ref when it's a tag/branch, else payload.version, else a short SHA. */
function githubVersion(d: z.infer<typeof ghDeployment>): string {
  if (!SHA.test(d.ref)) return sanitizeLabel(d.ref);
  const payload = d.payload as { version?: unknown } | undefined;
  const fromPayload = sanitizeLabel(payload?.version);
  return fromPayload || d.sha.slice(0, 7);
}

/**
 * GitHub deployments API. One list call, then per deployment (in parallel) its
 * latest status and its commit (Git Database API: small payload, message +
 * author). A failed per-deployment call degrades that deploy, not the list.
 */
export class GitHubDeploySource implements DeploySource {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string | undefined,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async listDeploys(service: ServiceDef, config: DeploySourceConfig, q: DeployQuery) {
    if (config.source !== 'github') return [];
    if (!this.token) throw new ClientError('GitHub', 'rejected', 'GITHUB_TOKEN is not set');
    const repo = config.repo;
    const params = new URLSearchParams({ environment: config.environment, per_page: '30' });
    const list = z
      .array(ghDeployment)
      .safeParse(await this.get(`/repos/${repo}/deployments?${params.toString()}`));
    if (!list.success) throw new ClientError('GitHub', 'bad_response', list.error.message);

    const candidates = list.data
      .filter((d) => Date.parse(d.created_at) <= q.until.getTime())
      .slice(0, Math.min(q.limit, MAX_DEPLOYS) * 2);

    const events = await Promise.all(
      candidates.map(async (d): Promise<DeployEvent> => {
        const [statuses, commit] = await Promise.allSettled([
          this.get(`/repos/${repo}/deployments/${d.id}/statuses?per_page=1`),
          this.get(`/repos/${repo}/git/commits/${d.sha}`),
        ]);
        const latest =
          statuses.status === 'fulfilled'
            ? z.array(ghStatus).safeParse(statuses.value).data?.[0]
            : undefined;
        const c = commit.status === 'fulfilled' ? ghCommit.safeParse(commit.value).data : undefined;
        if (statuses.status === 'rejected' || commit.status === 'rejected') {
          log.warn('github deployment details incomplete', { service: service.name });
        }
        const status = latest ? (GH_STATE[latest.state] ?? 'unknown') : 'unknown';
        const deployedAt = new Date(
          latest && status === 'success' ? latest.created_at : d.created_at,
        );
        return {
          id: String(d.id),
          source: 'github',
          service: service.name,
          environment: sanitizeLabel(d.environment),
          version: githubVersion(d),
          commitSha: SHA.test(d.sha) ? d.sha.toLowerCase() : null,
          commitMessage: c ? quoteUntrusted(c.message) : null,
          author: sanitizeLabel(c?.author?.name ?? d.creator?.login ?? '') || null,
          status,
          deployedAt,
        };
      }),
    );
    return events
      .filter((e) => e.deployedAt >= q.since && e.deployedAt <= q.until)
      .sort((a, b) => b.deployedAt.getTime() - a.deployedAt.getTime())
      .slice(0, Math.min(q.limit, MAX_DEPLOYS));
  }

  private async get(path: string): Promise<unknown> {
    const { body } = await fetchJson(
      'GitHub',
      `${this.apiUrl}${path}`,
      {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          authorization: `Bearer ${this.token ?? ''}`,
          'user-agent': 'nightshift-mcp',
        },
      },
      this.timeoutMs,
      this.fetchImpl,
    );
    return body;
  }
}

/** Routes each service to its configured source (nightshift.yaml `deploys`). */
export class DeploySourceRouter implements DeployEventsClient {
  constructor(private readonly sources: Record<DeploySourceKind, DeploySource>) {}

  sourceFor(service: ServiceDef): DeploySourceKind | null {
    return service.deploys?.source ?? null;
  }

  async listDeploys(service: ServiceDef, query: DeployQuery): Promise<DeployEvent[]> {
    const config = service.deploys;
    if (!config) return [];
    return this.sources[config.source].listDeploys(service, config, query);
  }
}
