/** Minimal shape needed to resolve a spoken service reference. */
export interface NamedService {
  name: string;
  displayName: string;
  aliases: readonly string[];
}

export type ServiceResolution<S extends NamedService> =
  { kind: 'match'; service: S } | { kind: 'ambiguous'; candidates: S[] } | { kind: 'none' };

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'our',
  'my',
  'service',
  'app',
  'system',
  'how',
  'is',
]);

/** "The Payments-API!" → ["payment", "api"] (lowercase, punctuation → space, naive singular). */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

const phrase = (text: string) => tokens(text).join(' ');

/**
 * Resolve a fuzzy, voice-style service reference ("payments", "the payment API")
 * against the catalog. Pure.
 *   1. exact name / display name / alias (after normalization)
 *   2. best weighted token overlap (stop words ignored; name tokens 2, alias tokens 1)
 * Several equally good candidates → ambiguous (the tool asks which one).
 */
export function resolveService<S extends NamedService>(
  query: string,
  services: readonly S[],
): ServiceResolution<S> {
  const q = phrase(query);
  if (!q) return { kind: 'none' };

  const exact = services.filter((s) =>
    [s.name, s.displayName, ...s.aliases].some((label) => phrase(label) === q),
  );
  if (exact.length === 1) return { kind: 'match', service: exact[0]! };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact };

  const queryTokens = new Set(tokens(query).filter((t) => !STOP_WORDS.has(t)));
  if (queryTokens.size === 0) return { kind: 'none' };

  // A token in the service's own name counts double an alias-only token, so
  // "payments" prefers payments-api over an alias like "payment webhooks".
  const scored = services
    .map((s) => {
      const primary = new Set([s.name, s.displayName].flatMap(tokens));
      const alias = new Set(s.aliases.flatMap(tokens));
      const score = [...queryTokens].reduce(
        (sum, t) => sum + (primary.has(t) ? 2 : alias.has(t) ? 1 : 0),
        0,
      );
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: 'none' };
  const best = scored[0]!.score;
  const top = scored.filter((x) => x.score === best).map((x) => x.s);
  return top.length === 1
    ? { kind: 'match', service: top[0]! }
    : { kind: 'ambiguous', candidates: top };
}
