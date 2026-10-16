import { randomUUID } from 'node:crypto';
import {
  type DeployEvent,
  type DeployEventsClient,
  type DeployQuery,
  type DeploySourceKind,
} from '../../src/clients/deploys.js';
import { ClientError, type ClientErrorKind } from '../../src/clients/errors.js';
import type { DeployStore, NewDeploy, StoredDeploy } from '../../src/db/deployStore.js';
import { quoteUntrusted } from '../../src/lib/untrusted.js';
import type { ServiceDef } from '../../src/serviceConfig.js';

export class InMemoryDeployStore implements DeployStore {
  readonly records: StoredDeploy[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}

  async insertOnce(deploy: NewDeploy) {
    const existing = this.records.find(
      (r) => r.source === deploy.source && r.externalId === deploy.externalId,
    );
    if (existing) return { record: existing, created: false };
    const record = { ...deploy, id: randomUUID(), createdAt: this.now() };
    this.records.push(record);
    return { record, created: true };
  }

  async list(q: { service: string; environment: string; since: Date; until: Date; limit: number }) {
    return this.records
      .filter(
        (r) =>
          r.service === q.service &&
          r.environment === q.environment &&
          r.deployedAt >= q.since &&
          r.deployedAt <= q.until,
      )
      .sort((a, b) => b.deployedAt.getTime() - a.deployedAt.getTime())
      .slice(0, q.limit);
  }
}

/** Scriptable deploy history: add events, or make the source fail. */
export class FakeDeploys implements DeployEventsClient {
  readonly events: DeployEvent[] = [];
  failWith: ClientErrorKind | undefined;
  /** Source per service name; default 'ingest' for every service. */
  sources = new Map<string, DeploySourceKind | null>();

  add(e: Partial<DeployEvent> & { service: string; version: string; deployedAt: Date }): this {
    this.events.push({
      id: randomUUID(),
      source: 'ingest',
      environment: 'production',
      commitSha: null,
      author: 'ci',
      status: 'success',
      ...e,
      commitMessage: e.commitMessage === undefined ? quoteUntrusted('a change') : e.commitMessage,
    });
    return this;
  }

  sourceFor(service: ServiceDef): DeploySourceKind | null {
    return this.sources.has(service.name) ? (this.sources.get(service.name) ?? null) : 'ingest';
  }

  async listDeploys(service: ServiceDef, q: DeployQuery): Promise<DeployEvent[]> {
    if (this.sourceFor(service) === null) return [];
    if (this.failWith) throw new ClientError('Database', this.failWith);
    return this.events
      .filter(
        (e) => e.service === service.name && e.deployedAt >= q.since && e.deployedAt <= q.until,
      )
      .sort((a, b) => b.deployedAt.getTime() - a.deployedAt.getTime())
      .slice(0, q.limit);
  }
}
