import { z } from 'zod';
import { ClientError, fetchJson, type FetchLike } from './errors.js';

/**
 * Alert as returned by Alertmanager API v2. Label and annotation values are
 * UNTRUSTED text (invariant 6): sanitize before speaking, quote in data.
 */
export interface AmAlert {
  fingerprint: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: Date;
  state: 'active' | 'suppressed' | 'unprocessed';
  silencedBy: string[];
  inhibitedBy: string[];
}

export interface AmMatcher {
  name: string;
  value: string;
  isRegex: boolean;
  isEqual: boolean;
}

export interface AmSilence {
  id: string;
  matchers: AmMatcher[];
  startsAt: Date;
  endsAt: Date;
  createdBy: string;
  comment: string;
  state: 'active' | 'pending' | 'expired';
}

export interface NewSilence {
  matchers: AmMatcher[];
  startsAt: Date;
  endsAt: Date;
  createdBy: string;
  comment: string;
}

export interface AlertmanagerClient {
  /** All current alerts (active, silenced and inhibited). */
  listAlerts(): Promise<AmAlert[]>;
  listSilences(): Promise<AmSilence[]>;
  /** Returns the new silence id. */
  createSilence(silence: NewSilence): Promise<string>;
}

const strRecord = z.record(z.string(), z.string());

const alertSchema = z.object({
  fingerprint: z.string().min(1),
  labels: strRecord,
  annotations: strRecord.default({}),
  startsAt: z.string(),
  status: z.object({
    state: z.enum(['active', 'suppressed', 'unprocessed']),
    silencedBy: z.array(z.string()).default([]),
    inhibitedBy: z.array(z.string()).default([]),
  }),
});

const matcherSchema = z.object({
  name: z.string(),
  value: z.string(),
  isRegex: z.boolean(),
  isEqual: z.boolean().default(true),
});

const silenceSchema = z.object({
  id: z.string(),
  matchers: z.array(matcherSchema),
  startsAt: z.string(),
  endsAt: z.string(),
  createdBy: z.string(),
  comment: z.string(),
  status: z.object({ state: z.enum(['active', 'pending', 'expired']) }),
});

export class HttpAlertmanagerClient implements AlertmanagerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async listAlerts(): Promise<AmAlert[]> {
    const body = await this.request(
      'GET',
      '/api/v2/alerts?active=true&silenced=true&inhibited=true',
    );
    const parsed = z.array(alertSchema).safeParse(body);
    if (!parsed.success)
      throw new ClientError('Alertmanager', 'bad_response', parsed.error.message);
    return parsed.data.map((a) => ({
      fingerprint: a.fingerprint,
      labels: a.labels,
      annotations: a.annotations,
      startsAt: new Date(a.startsAt),
      state: a.status.state,
      silencedBy: a.status.silencedBy,
      inhibitedBy: a.status.inhibitedBy,
    }));
  }

  async listSilences(): Promise<AmSilence[]> {
    const body = await this.request('GET', '/api/v2/silences');
    const parsed = z.array(silenceSchema).safeParse(body);
    if (!parsed.success)
      throw new ClientError('Alertmanager', 'bad_response', parsed.error.message);
    return parsed.data.map((s) => ({
      id: s.id,
      matchers: s.matchers,
      startsAt: new Date(s.startsAt),
      endsAt: new Date(s.endsAt),
      createdBy: s.createdBy,
      comment: s.comment,
      state: s.status.state,
    }));
  }

  async createSilence(s: NewSilence): Promise<string> {
    const body = await this.request('POST', '/api/v2/silences', {
      matchers: s.matchers,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt.toISOString(),
      createdBy: s.createdBy,
      comment: s.comment,
    });
    const parsed = z.object({ silenceID: z.string().min(1) }).safeParse(body);
    if (!parsed.success)
      throw new ClientError('Alertmanager', 'bad_response', parsed.error.message);
    return parsed.data.silenceID;
  }

  private async request(method: 'GET' | 'POST', path: string, json?: unknown): Promise<unknown> {
    const { body } = await fetchJson(
      'Alertmanager',
      `${this.baseUrl}${path}`,
      {
        method,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        ...(json !== undefined && { body: JSON.stringify(json) }),
      },
      this.timeoutMs,
      this.fetchImpl,
    );
    return body;
  }
}
