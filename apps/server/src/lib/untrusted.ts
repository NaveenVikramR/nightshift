/**
 * Helpers for text Nightshift did not author (invariant 6): alert labels and
 * annotations, tool names sent by clients, log lines, commit messages.
 * Such text is DATA. It is quoted as evidence, never followed as instructions.
 */

// C0/C1 control characters and Unicode bidi / zero-width formatting characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * For identifiers (label values, alert names, tool names): keep only
 * [A-Za-z0-9 _.:/-], collapse whitespace, cap length. Safe to put in `speak`.
 */
export function sanitizeLabel(value: unknown, maxLength = 64): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[^A-Za-z0-9 _.:/-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export interface UntrustedText {
  untrusted: true;
  text: string;
}

/**
 * For free text (annotations, log lines, commit messages): strip control and
 * bidi characters, collapse whitespace, truncate, and mark as untrusted. Goes
 * in `data` only, never in `speak`. `multiline` keeps one line break between
 * non-empty lines, so a commit subject stays separate from its body.
 */
export function quoteUntrusted(
  value: unknown,
  maxLength = 200,
  opts: { multiline?: boolean } = {},
): UntrustedText {
  const raw = typeof value === 'string' ? value : '';
  const flatten = (s: string) => s.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const clean = opts.multiline
    ? raw.split(/\r?\n/).map(flatten).filter(Boolean).join('\n')
    : flatten(raw);
  const text = clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
  return { untrusted: true, text };
}

/** "HighErrorRate" → "high error rate"; "webhook-receiver" → "webhook receiver". */
export function toSpokenWords(identifier: string): string {
  return sanitizeLabel(identifier)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.:/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
