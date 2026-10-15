/** Small pure formatters for voice output. */

/** "just now", "1 minute ago", "12 minutes ago", "2 hours ago", "3 days ago". */
export function spokenAgo(then: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** 45 → "45 minutes", 60 → "1 hour", 90 → "1 hour 30 minutes", 240 → "4 hours". */
export function spokenDuration(totalMinutes: number): string {
  const m = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const hPart = h > 0 ? `${h} hour${h === 1 ? '' : 's'}` : '';
  const mPart = rest > 0 || h === 0 ? `${rest} minute${rest === 1 ? '' : 's'}` : '';
  return [hPart, mPart].filter(Boolean).join(' ');
}

/** 0.6312 → "63 percent", 0.0412 → "4.1 percent", 0.0004 → "0.04 percent". */
export function spokenPercent(ratio: number): string {
  const p = ratio * 100;
  const text = p >= 10 ? String(Math.round(p)) : p >= 0.1 ? p.toFixed(1) : p.toFixed(2);
  return `${text.replace(/\.0+$/, '')} percent`;
}

/** 0.18 → "180 milliseconds", 1.42 → "1.4 seconds". */
export function spokenSeconds(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)} milliseconds`;
  return `${seconds.toFixed(1).replace(/\.0$/, '')} seconds`;
}

/** 19.6 → "20 requests per second", 0.42 → "0.4 requests per second". */
export function spokenRate(perSecond: number): string {
  const n = perSecond >= 1 ? String(Math.round(perSecond)) : perSecond.toFixed(1);
  return `${n} request${n === '1' ? '' : 's'} per second`;
}

/** Join for speech: "a", "a and b", "a, b and c" (or "a, b or c"). */
export function spokenList(items: readonly string[], conjunction: 'and' | 'or' = 'and'): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items[items.length - 1]}`;
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
