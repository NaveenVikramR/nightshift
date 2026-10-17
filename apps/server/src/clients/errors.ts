import { UserFacingError } from '../lib/errors.js';

export type Upstream = 'Prometheus' | 'Alertmanager' | 'GitHub' | 'Database' | 'AdminApi';
export type ClientErrorKind = 'unreachable' | 'timeout' | 'bad_response' | 'rejected';

/** How each upstream is named out loud (sentence-initial form). */
const SPOKEN: Record<Upstream, string> = {
  Prometheus: 'Prometheus',
  Alertmanager: 'Alertmanager',
  GitHub: 'GitHub',
  Database: 'The Nightshift database',
  AdminApi: 'The service admin API',
};
const spokenMid = (u: Upstream) => SPOKEN[u].replace(/^The /, 'the ');

const SPEAK: Record<ClientErrorKind, (u: Upstream) => string> = {
  unreachable: (u) => `I couldn't reach ${spokenMid(u)}. Try again in a minute.`,
  timeout: (u) => `${SPOKEN[u]} is taking too long to answer. Try again in a minute.`,
  bad_response: (u) => `${SPOKEN[u]} sent an answer I couldn't read. Check its configuration.`,
  rejected: (u) => `${SPOKEN[u]} rejected my request. Check the Nightshift service config.`,
};

/** Typed upstream failure; `speak` is user-safe, `message` (internal detail) is for logs only. */
export class ClientError extends UserFacingError {
  constructor(
    readonly upstream: Upstream,
    readonly kind: ClientErrorKind,
    detail?: string,
  ) {
    super(`${upstream.toLowerCase()}_${kind}`, SPEAK[kind](upstream), detail);
    this.name = 'ClientError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * fetch + timeout + JSON, mapping every failure to a ClientError:
 * network error → unreachable, timeout → timeout, 4xx → rejected,
 * 5xx → unreachable, unparseable body → bad_response.
 */
export async function fetchJson(
  upstream: Upstream,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ClientError(upstream, 'timeout', `${upstream} timed out after ${timeoutMs} ms`);
    }
    throw new ClientError(upstream, 'unreachable', err instanceof Error ? err.message : undefined);
  }

  const text = await res.text().catch(() => '');
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (res.status >= 500) throw new ClientError(upstream, 'unreachable', `HTTP ${res.status}`);
  if (res.status >= 400) {
    throw new ClientError(upstream, 'rejected', `HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (body === undefined && text !== '') {
    throw new ClientError(upstream, 'bad_response', 'response is not JSON');
  }
  return { status: res.status, body };
}
