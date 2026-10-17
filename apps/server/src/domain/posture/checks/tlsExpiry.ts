import { connect } from 'node:tls';
import { sanitizeLabel } from '../../../lib/untrusted.js';
import type { Check, CheckResult, RawFinding } from '../types.js';

export interface TlsCertificateInfo {
  /** Chain verified against the trust store for this hostname. */
  authorized: boolean;
  /** e.g. CERT_HAS_EXPIRED, ERR_TLS_CERT_ALTNAME_INVALID (a code, not free text). */
  authorizationError: string | null;
  validTo: Date | null;
}

/** One TLS handshake; behind an interface so tests use fakes. */
export interface TlsProbe {
  probe(host: string, port: number, timeoutMs: number): Promise<TlsCertificateInfo>;
}

/**
 * Real probe: node:tls with SNI. rejectUnauthorized is false ONLY so an
 * expired or mismatched certificate can still be read and reported; no data is
 * sent over the connection.
 */
export const nodeTlsProbe: TlsProbe = {
  probe: (host, port, timeoutMs) =>
    new Promise((resolve, reject) => {
      const socket = connect({ host, port, servername: host, rejectUnauthorized: false });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('timeout'));
      }, timeoutMs);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        const cert = socket.getPeerCertificate();
        const err = socket.authorizationError as unknown;
        resolve({
          authorized: socket.authorized,
          authorizationError:
            err === null || err === undefined
              ? null
              : sanitizeLabel(String((err as { code?: string }).code ?? err), 80),
          validTo: cert?.valid_to ? new Date(cert.valid_to) : null,
        });
        socket.end();
      });
      socket.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    }),
};

const DAY = 24 * 60 * 60_000;

export class TlsExpiryCheck implements Check {
  readonly name = 'tls_expiry' as const;

  constructor(
    private readonly targets: readonly { name: string; host: string; port: number }[],
    private readonly probe: TlsProbe,
    private readonly timeoutMs: number,
    private readonly now: () => Date,
  ) {}

  async run(): Promise<CheckResult> {
    if (this.targets.length === 0) {
      return {
        check: this.name,
        status: 'not_configured',
        findings: [],
        checked: [],
        note: 'no TLS targets in security.tls',
      };
    }
    const findings: RawFinding[] = [];
    const checked: string[] = [];
    let failures = 0;
    for (const t of this.targets) {
      const target = `${t.host}:${t.port}`;
      let info: TlsCertificateInfo;
      try {
        info = await this.probe.probe(t.host, t.port, this.timeoutMs);
      } catch {
        failures++;
        continue;
      }
      checked.push(target);
      const days = info.validTo
        ? Math.floor((info.validTo.getTime() - this.now().getTime()) / DAY)
        : null;
      const base = {
        check: this.name,
        target,
        detail: {
          asset: sanitizeLabel(t.name),
          daysLeft: days,
          validTo: info.validTo?.toISOString() ?? null,
          error: info.authorizationError,
        },
      } as const;
      if (days !== null && days < 0) {
        findings.push({
          ...base,
          key: 'expired',
          severity: 'critical',
          title: `TLS certificate expired on ${sanitizeLabel(t.name)}`,
        });
      } else if (!info.authorized) {
        findings.push({
          ...base,
          key: 'invalid',
          severity: 'critical',
          title: `invalid TLS certificate on ${sanitizeLabel(t.name)}`,
        });
      } else if (days !== null && days < 7) {
        findings.push({
          ...base,
          key: 'expiring',
          severity: 'high',
          title: `TLS certificate on ${sanitizeLabel(t.name)} expires within a week`,
        });
      } else if (days !== null && days < 30) {
        findings.push({
          ...base,
          key: 'expiring',
          severity: 'medium',
          title: `TLS certificate on ${sanitizeLabel(t.name)} expires within a month`,
        });
      }
    }
    if (failures === this.targets.length) {
      return {
        check: this.name,
        status: 'error',
        findings: [],
        checked,
        note: 'no TLS target answered',
      };
    }
    return { check: this.name, status: findings.length > 0 ? 'findings' : 'ok', findings, checked };
  }
}
