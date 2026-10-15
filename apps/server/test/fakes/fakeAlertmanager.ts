import type {
  AlertmanagerClient,
  AmAlert,
  AmSilence,
  NewSilence,
} from '../../src/clients/alertmanager.js';
import { ClientError, type ClientErrorKind } from '../../src/clients/errors.js';

export function makeAlert(
  overrides: Partial<AmAlert> & { alertname: string; service?: string; severity?: string },
): AmAlert {
  const { alertname, service = 'payments-api', severity = 'critical', ...rest } = overrides;
  return {
    fingerprint: `fp-${alertname}-${service}`.toLowerCase(),
    labels: { alertname, service, severity },
    annotations: { summary: `${alertname} on ${service}` },
    startsAt: new Date('2026-10-16T11:57:00Z'),
    state: 'active',
    silencedBy: [],
    inhibitedBy: [],
    ...rest,
  };
}

/** In-memory Alertmanager. createSilence also marks matching alerts suppressed. */
export class FakeAlertmanager implements AlertmanagerClient {
  alerts: AmAlert[] = [];
  silences: AmSilence[] = [];
  failWith: ClientErrorKind | undefined;
  private nextId = 1;

  async listAlerts(): Promise<AmAlert[]> {
    if (this.failWith) throw new ClientError('Alertmanager', this.failWith);
    return structuredClone(this.alerts);
  }

  async listSilences(): Promise<AmSilence[]> {
    if (this.failWith) throw new ClientError('Alertmanager', this.failWith);
    return structuredClone(this.silences);
  }

  async createSilence(s: NewSilence): Promise<string> {
    if (this.failWith) throw new ClientError('Alertmanager', this.failWith);
    const id = `silence-${this.nextId++}`;
    this.silences.push({ id, ...s, state: 'active' });
    for (const a of this.alerts) {
      if (s.matchers.every((m) => a.labels[m.name] === m.value)) {
        a.state = 'suppressed';
        a.silencedBy = [...a.silencedBy, id];
      }
    }
    return id;
  }
}
