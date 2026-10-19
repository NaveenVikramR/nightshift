/** Formatting for cards. Pure functions (unit-tested without a DOM). */

export type Tone = 'crit' | 'warn' | 'ok' | 'info';

export interface ToneInfo {
  tone: Tone;
  label: string;
}

/** Alert / incident / service / finding severities -> tone + word (never colour alone). */
export function toneOf(severity: string | null | undefined): ToneInfo {
  switch ((severity ?? '').toLowerCase()) {
    case 'critical':
      return { tone: 'crit', label: 'Critical' };
    case 'high':
      return { tone: 'crit', label: 'High' };
    case 'warning':
    case 'degraded':
      return { tone: 'warn', label: severity === 'degraded' ? 'Degraded' : 'Warning' };
    case 'medium':
      return { tone: 'warn', label: 'Medium' };
    case 'low':
      return { tone: 'info', label: 'Low' };
    case 'ok':
    case 'healthy':
    case 'all_clear':
      return { tone: 'ok', label: 'Healthy' };
    case 'unknown':
    case '':
      return { tone: 'info', label: 'Unknown' };
    default:
      return { tone: 'info', label: capitalize(severity ?? '') };
  }
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Error ratio 0.4512 -> "45%", 0.005 -> "0.5%", null -> "–". */
export function pct(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '–';
  const p = ratio * 100;
  if (p === 0) return '0%';
  if (p < 1) return `${Number(p.toFixed(1))}%`;
  return `${Math.round(p)}%`;
}

/** "just now", "4 min ago", "2 h ago", "3 days ago". */
export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "9:31" in the viewer's clock (no seconds, no date). */
export function clock(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** 125 -> "2:05". Negative -> "0:00". */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Untrusted/long text: single line, at most `max` characters. */
export function truncate(text: unknown, max = 140): string {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** plural(2, 'alert') -> "2 alerts". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Human labels for posture checks. */
export const CHECK_LABELS: Record<string, string> = {
  tls_expiry: 'TLS certificates',
  security_headers: 'Security headers',
  dependabot: 'Dependabot',
  secret_scanning: 'Secret scanning',
  auth_failure_spike: 'Failed logins',
  webhook_signature_failures: 'Webhook signatures',
};

export const ACTION_LABELS: Record<string, string> = {
  failover_provider: 'Fail over',
  rollback_deploy: 'Roll back',
  restart_service: 'Restart',
};
