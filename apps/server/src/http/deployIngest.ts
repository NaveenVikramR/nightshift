import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { IngestTokenEntry } from '../config.js';
import type { DeployStore } from '../db/deployStore.js';
import { hashInput, type AuditLog, type AuditOutcome } from '../lib/audit.js';
import { log } from '../lib/log.js';
import { quoteUntrusted, sanitizeLabel } from '../lib/untrusted.js';
import type { ServiceDef } from '../serviceConfig.js';

const MAX_FUTURE_MS = 5 * 60_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/**
 * Body CI systems send. Lengths are bounded; free text is sanitized before it
 * is stored. The commit message is untrusted data (invariant 6).
 */
export const deployIngestSchema = z
  .object({
    service: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
    environment: z.string().min(1).max(40).optional(),
    commitSha: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/i)
      .optional(),
    commitMessage: z.string().max(2000).optional(),
    author: z.string().max(100).optional(),
    status: z.enum(['success', 'failure', 'in_progress']).optional(),
    deployedAt: z.iso.datetime({ offset: true }).optional(),
    /** The caller's id for this deploy (e.g. the CI run id). Makes retries idempotent. */
    externalId: z
      .string()
      .regex(/^[\w.:/-]{1,128}$/)
      .optional(),
  })
  .strict();

export interface DeployIngestDeps {
  tokens: readonly IngestTokenEntry[];
  store: DeployStore;
  services: readonly ServiceDef[];
  audit: AuditLog;
  now: () => Date;
}

/** Constant-time lookup of an ingest token; scans every entry. */
export function verifyIngestToken(
  header: string | undefined,
  tokens: readonly IngestTokenEntry[],
): string | undefined {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return undefined;
  const digest = createHash('sha256').update(token, 'utf8').digest();
  let source: string | undefined;
  for (const t of tokens) {
    if (timingSafeEqual(digest, Buffer.from(t.sha256, 'hex')) && !source) source = t.source;
  }
  return source;
}

/**
 * POST /events/deploy: any CI system reports a deploy. Runs after the Host,
 * Origin and failed-auth guards. Only ingest tokens are accepted here (MCP
 * tokens are not), and every request writes an audit row.
 */
export function deployIngestHandler(deps: DeployIngestDeps): RequestHandler {
  return (req, res) => {
    void (async () => {
      const body: unknown = req.body;
      const source = verifyIngestToken(req.header('authorization'), deps.tokens);
      const audit = async (outcome: AuditOutcome) =>
        deps.audit.record({
          actor: source ?? 'unknown',
          role: source ? 'ingest' : 'unknown',
          tool: 'events/deploy',
          inputHash: hashInput(body ?? {}),
          outcome,
        });

      if (!source) {
        await audit('unauthenticated');
        res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
        return;
      }

      const parsed = deployIngestSchema.safeParse(body);
      if (!parsed.success) {
        await audit('invalid_input');
        res.status(400).json({
          error: 'invalid_input',
          issues: parsed.error.issues.slice(0, 5).map((i) => ({
            path: i.path.map(String).join('.'),
            message: i.message,
          })),
        });
        return;
      }
      const d = parsed.data;

      const service = deps.services.find((s) => s.name === d.service);
      if (!service) {
        await audit('unknown_service');
        res.status(404).json({ error: 'unknown_service' });
        return;
      }

      const now = deps.now().getTime();
      const deployedAt = d.deployedAt ? new Date(d.deployedAt) : new Date(now);
      const version = sanitizeLabel(d.version);
      const problems = [
        ...(deployedAt.getTime() > now + MAX_FUTURE_MS ? ['deployedAt is in the future'] : []),
        ...(deployedAt.getTime() < now - MAX_AGE_MS ? ['deployedAt is older than 30 days'] : []),
        ...(version ? [] : ['version has no usable characters']),
      ];
      if (problems.length > 0) {
        await audit('invalid_input');
        res
          .status(400)
          .json({ error: 'invalid_input', issues: problems.map((message) => ({ message })) });
        return;
      }

      const message =
        d.commitMessage === undefined
          ? null
          : quoteUntrusted(d.commitMessage, 200, { multiline: true }).text;
      const { record, created } = await deps.store.insertOnce({
        source,
        externalId: d.externalId ?? randomUUID(),
        service: service.name,
        environment: sanitizeLabel(
          d.environment ?? service.deploys?.environment ?? 'production',
          40,
        ),
        version,
        commitSha: d.commitSha?.toLowerCase() ?? null,
        commitMessage: message || null,
        author: sanitizeLabel(d.author ?? '', 100) || null,
        status: d.status ?? 'success',
        deployedAt,
      });
      await audit('ok');
      res.status(created ? 201 : 200).json({
        id: record.id,
        created,
        service: record.service,
        environment: record.environment,
        version: record.version,
        deployedAt: record.deployedAt.toISOString(),
      });
    })().catch((err: unknown) => {
      log.error('deploy ingest failed', { error: err instanceof Error ? err.message : 'unknown' });
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    });
  };
}
