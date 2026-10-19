'use client';
import { useState } from 'react';
import { api, type TraceEntry } from './api';

const SCENARIOS: { id: string; label: string; hint: string }[] = [
  { id: 'provider_outage', label: 'Provider outage', hint: 'Razorpay fails; try a failover' },
  { id: 'bad_deploy', label: 'Bad deploy', hint: 'v1.4.2 breaks payments; try a rollback' },
  { id: 'latency_spike', label: 'Latency spike', hint: 'Slow, not failing' },
  { id: 'auth_bruteforce', label: 'Auth brute force', hint: 'Failed-login spike (security)' },
  { id: 'weak_headers', label: 'Weak headers', hint: 'Then ask for a security scan' },
  { id: 'reset', label: 'Reset', hint: 'Back to healthy' },
];

/** Judges' controls (responder only): break or reset the demo service. Nightshift still does the diagnosis. */
export function DemoPanel({
  onEntry,
  onError,
}: {
  onEntry: (e: TraceEntry) => void;
  onError: (e: unknown) => void;
}) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState('');
  const run = async (id: string) => {
    setBusy(id);
    setStatus('');
    try {
      const r = await api.demo(id);
      setStatus(r.message);
      onEntry({
        turn: 0,
        at: new Date().toISOString(),
        source: 'demo',
        tool: `demo:${id}`,
        input: {},
        outcome: 'ok',
        note: r.message,
      });
    } catch (err) {
      setStatus("Couldn't start that scenario.");
      onError(err);
    } finally {
      setBusy('');
    }
  };
  return (
    <details className="demo">
      <summary>Demo controls</summary>
      <p className="muted small">
        These break the demo payments service on purpose. Alerts take about 30–60 s to fire; then
        ask &ldquo;What&apos;s wrong?&rdquo;.
      </p>
      <div className="demo-grid">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="demo-btn"
            onClick={() => void run(s.id)}
            disabled={Boolean(busy)}
          >
            <span className="demo-label">{busy === s.id ? 'Starting…' : s.label}</span>
            <span className="muted small">{s.hint}</span>
          </button>
        ))}
      </div>
      <p className="demo-status" role="status">
        {status}
      </p>
    </details>
  );
}
