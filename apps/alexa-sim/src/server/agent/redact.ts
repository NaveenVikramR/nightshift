/** Tool inputs as shown in the judges' "What Nightshift did" panel: secrets and long ids masked. */
const SECRET_KEY = /token|secret|password|authorization|api[_-]?key|credential/i;

export function redactInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET_KEY.test(k)) out[k] = '[redacted]';
    else if (k === 'confirmation_id' && typeof v === 'string') out[k] = `${v.slice(0, 4)}…`;
    else if (typeof v === 'string') out[k] = v.length > 120 ? `${v.slice(0, 119)}…` : v;
    else if (typeof v === 'object' && v !== null && !Array.isArray(v))
      out[k] = redactInput(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}
