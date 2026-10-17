import type { FetchLike } from '../../clients/errors.js';
import type { PrometheusClient } from '../../clients/prometheus.js';
import type { ServiceConfig, ServiceDef } from '../../serviceConfig.js';
import { DependabotCheck, SecretScanningCheck } from './checks/github.js';
import { PrometheusSpikeCheck } from './checks/prometheusSpikes.js';
import {
  fetchHeaders,
  SecurityHeadersCheck,
  type HeaderFetcher,
} from './checks/securityHeaders.js';
import { nodeTlsProbe, TlsExpiryCheck, type TlsProbe } from './checks/tlsExpiry.js';
import type { Check } from './types.js';

export interface PostureScanner {
  /** Per-check timeout for one scan. */
  timeoutMs: number;
  checks(): Check[];
}

/** Every check over the allowlisted targets in nightshift.yaml `security` (and service queries). */
export function createPostureScanner(o: {
  security: ServiceConfig['security'];
  services: readonly ServiceDef[];
  prometheus: PrometheusClient;
  githubApiUrl: string;
  githubToken: string | undefined;
  now: () => Date;
  tlsProbe?: TlsProbe;
  headerFetcher?: HeaderFetcher;
  fetchImpl?: FetchLike;
}): PostureScanner {
  const t = o.security.scanTimeoutMs;
  const gh = {
    apiUrl: o.githubApiUrl,
    token: o.githubToken,
    repos: o.security.repos,
    timeoutMs: t,
    ...(o.fetchImpl && { fetchImpl: o.fetchImpl }),
  };
  return {
    timeoutMs: t,
    checks: () => [
      new TlsExpiryCheck(o.security.tls, o.tlsProbe ?? nodeTlsProbe, t, o.now),
      new SecurityHeadersCheck(o.security.headers, o.headerFetcher ?? fetchHeaders, t),
      new DependabotCheck(gh),
      new SecretScanningCheck(gh),
      new PrometheusSpikeCheck('authFailures', o.services, o.prometheus, o.now),
      new PrometheusSpikeCheck('webhookFailures', o.services, o.prometheus, o.now),
    ],
  };
}
