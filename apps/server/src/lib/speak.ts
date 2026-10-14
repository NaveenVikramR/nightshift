export const MAX_SPEAK_WORDS = 30;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** User-safe spoken messages for failures (no internals, IDs or URLs). */
export const SPEAK = {
  unauthenticated: "I couldn't verify who you are. Check your Nightshift access token.",
  forbidden: (minRole: string) =>
    `Sorry, that needs ${minRole} access, and your token doesn't have it. Ask a teammate with ${minRole} access.`,
  internalError: 'Something went wrong on the Nightshift server. Try again in a minute.',
  auditFailed:
    "I couldn't record this request in the audit log, so I stopped. Try again in a minute.",
} as const;
