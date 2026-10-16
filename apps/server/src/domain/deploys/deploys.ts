import type { DeployEvent } from '../../clients/deploys.js';
import type { UntrustedText } from '../../lib/untrusted.js';
import { spokenAgo, spokenClock, spokenVersion } from '../spoken.js';

const SAFE_COMMIT_LINE = /^[A-Za-z0-9 ,.'-]+$/;
const MAX_COMMIT_WORDS = 8;
const CLOCK_WINDOW_MS = 12 * 60 * 60_000;
/**
 * Defense in depth only: lines that address an assistant are never spoken.
 * The real guarantee is structural (explain_incident never speaks commit
 * text, and no rule reads it).
 */
const INSTRUCTION_LIKE =
  /\b(ignore|disregard|instructions?|prompt|system|assistant|alexa|claude|you must|confirm|execute)\b/i;

/**
 * The ONLY place untrusted commit text may reach speech (get_recent_deploys):
 * the first line, if it uses just letters, digits and basic punctuation, is at
 * most 8 words and doesn't read like an instruction. Anything else returns
 * null and stays in data only. explain_incident never calls this.
 */
export function speakableCommitLine(message: UntrustedText | null): string | null {
  if (!message) return null;
  const first = (message.text.split(/\r?\n/)[0] ?? '').trim().replace(/[.]+$/, '');
  if (!first || !SAFE_COMMIT_LINE.test(first) || INSTRUCTION_LIKE.test(first)) return null;
  const words = first.split(/\s+/).filter(Boolean);
  return words.length <= MAX_COMMIT_WORDS ? words.join(' ') : null;
}

/**
 * When a deploy happened, spoken: "at 2:41" within the last 12 hours,
 * otherwise relative ("2 days ago") so a bare clock time is never ambiguous.
 */
export function spokenDeployTime(at: Date, now: Date, timeZone: string): string {
  return now.getTime() - at.getTime() <= CLOCK_WINDOW_MS
    ? `at ${spokenClock(at, timeZone)}`
    : spokenAgo(at, now);
}

/**
 * How to refer to one deploy out loud: "the 2:41 deploy, version 1.4.2" or,
 * when the version isn't speakable (branch, SHA), just "the 2:41 deploy".
 * Never a SHA or an id.
 */
export function deployReference(d: Pick<DeployEvent, 'version' | 'deployedAt'>, timeZone: string) {
  const clock = spokenClock(d.deployedAt, timeZone);
  const version = spokenVersion(d.version);
  return {
    clock,
    version,
    phrase: version ? `the ${clock} deploy, ${version}` : `the ${clock} deploy`,
  };
}
