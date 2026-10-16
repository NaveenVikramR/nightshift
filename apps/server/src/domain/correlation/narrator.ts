/**
 * Narration of a Diagnosis. The default is the deterministic template. An
 * LLM narrator (Bedrock, later) may only rephrase: its output is rejected when
 * it mentions any number, clock time or version that is not in the evidence,
 * or echoes untrusted text, or breaks the voice contract. On rejection the
 * template is spoken instead (invariant 5: never fabricate).
 */
import { log } from '../../lib/log.js';
import { countWords, MAX_SPEAK_WORDS } from '../../lib/speak.js';
import { spokenClock } from '../spoken.js';
import type { Diagnosis, EvidenceItem } from './rules.js';
import { speakDiagnosis, speechVariants, type SpeakContext } from './speak.js';

export interface Narrator {
  readonly name: string;
  narrate(d: Diagnosis, ctx: SpeakContext): Promise<string>;
}

export const templateNarrator: Narrator = {
  name: 'template',
  narrate: async (d, ctx) => speakDiagnosis(d, ctx),
};

const NUMBER_TOKEN = /\d+(?:[.:]\d+)*/g;
const WORD_NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};
const UNSPEAKABLE = /[*_`#[\]]|https?:|www\.|[0-9a-f]{8}-[0-9a-f]{4}|[0-9a-f]{12,}/i;

type Unit = 'ratio' | 'seconds' | 'plain';

const SIGNAL_UNIT: Record<string, Unit> = {
  errorRate: 'ratio',
  latencyP95: 'seconds',
  throughput: 'plain',
  authFailures: 'plain',
  webhookFailures: 'plain',
};
const THRESHOLD_UNIT: Record<string, Unit> = { errorRate: 'ratio', latencyP95Seconds: 'seconds' };

/** The ways a value may be spoken, by unit: ratios as percents, seconds also as ms. */
function numberForms(v: number, unit: Unit = 'plain'): string[] {
  const scaled = unit === 'ratio' ? [v * 100] : unit === 'seconds' ? [v, v * 1000] : [v];
  const forms = new Set<string>();
  for (const x of scaled) {
    forms.add(String(Math.round(x)));
    forms.add(Number(x.toFixed(1)).toString());
    forms.add(Number(x.toFixed(2)).toString());
  }
  return [...forms];
}

function collectValues(items: readonly EvidenceItem[], into: Set<string>, dates: Date[]): void {
  for (const item of items) {
    if (item.at) dates.push(new Date(item.at));
    const signal = item.values['signal'];
    const unit = typeof signal === 'string' ? (SIGNAL_UNIT[signal] ?? 'plain') : 'plain';
    for (const [key, v] of Object.entries(item.values)) {
      if (typeof v === 'number') {
        const measured = key === 'baseline' || key === 'peak' || key === 'current';
        numberForms(v, measured ? unit : 'plain').forEach((x) => into.add(x));
      }
      if (typeof v === 'string') {
        if (/^\d{4}-\d{2}-\d{2}T/.test(v)) dates.push(new Date(v));
        else for (const t of v.match(NUMBER_TOKEN) ?? []) into.add(t);
      }
    }
  }
}

/**
 * Every number/time/version token the evidence supports, each only in the
 * forms its unit allows (error ratios as percents, latency as s or ms):
 * measured values, thresholds, clock times of every timestamp and minutes
 * elapsed since them, deploy versions, counts, and whatever the template
 * variants say. Confidence scores are not speakable facts.
 */
export function allowedTokens(d: Diagnosis, ctx: SpeakContext): Set<string> {
  const allowed = new Set<string>();
  const add = (forms: string[]) => forms.forEach((x) => allowed.add(x));
  const dates: Date[] = [d.window.start];
  for (const c of d.causes) collectValues(c.evidence, allowed, dates);
  for (const [signal, o] of Object.entries(d.facts.onsets)) {
    if (!o || o.kind === 'insufficient_data') continue;
    const unit = SIGNAL_UNIT[signal] ?? 'plain';
    for (const v of [o.baseline.level, o.peak.value, o.last.value]) add(numberForms(v, unit));
    if (o.kind === 'spike') dates.push(o.onset.time);
  }
  for (const r of d.relations) {
    dates.push(r.deployedAt, r.openedAt);
    add(numberForms(r.minutesAfter));
  }
  for (const dep of d.deploys) {
    dates.push(dep.deployedAt);
    for (const t of dep.version.match(NUMBER_TOKEN) ?? []) allowed.add(t);
  }
  for (const a of d.alerts) dates.push(new Date(a.startsAt));
  for (const [key, t] of Object.entries(d.facts.thresholds)) {
    add(numberForms(t, THRESHOLD_UNIT[key] ?? 'plain'));
  }
  for (const date of dates) {
    allowed.add(spokenClock(date, ctx.timeZone));
    const minutes = (ctx.now.getTime() - date.getTime()) / 60_000;
    allowed.add(String(Math.floor(minutes)));
    allowed.add(String(Math.round(minutes)));
  }
  allowed.add(String(d.alerts.length));
  for (const v of speechVariants(d, ctx)) {
    for (const t of v.match(NUMBER_TOKEN) ?? []) allowed.add(t);
  }
  return allowed;
}

/** Quoted untrusted text (commit messages, alert summaries) in this diagnosis. */
function untrustedQuotes(d: Diagnosis): string[] {
  return [
    ...d.causes.flatMap((c) => c.evidence.flatMap((e) => (e.quote ? [e.quote.text] : []))),
    ...d.deploys.flatMap((x) => (x.commitMessage ? [x.commitMessage.text] : [])),
    ...d.alerts.map((a) => a.summary.text),
  ].filter((t) => t.split(/\s+/).length >= 4);
}

export type NarrationCheck = { ok: true } | { ok: false; reason: string };

export function validateNarration(text: string, d: Diagnosis, ctx: SpeakContext): NarrationCheck {
  if (!text.trim()) return { ok: false, reason: 'empty' };
  if (countWords(text) > MAX_SPEAK_WORDS) return { ok: false, reason: 'too_long' };
  if (UNSPEAKABLE.test(text)) return { ok: false, reason: 'markup_url_or_id' };

  const allowed = allowedTokens(d, ctx);
  for (const token of text.match(NUMBER_TOKEN) ?? []) {
    if (!allowed.has(token)) return { ok: false, reason: `unsupported_number:${token}` };
  }
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const n = WORD_NUMBERS[word];
    if (n !== undefined && !allowed.has(String(n))) {
      return { ok: false, reason: `unsupported_number:${word}` };
    }
  }
  const lower = text.toLowerCase();
  for (const quote of untrustedQuotes(d)) {
    // any 4 consecutive words of untrusted text = echoing it
    const words = quote.toLowerCase().split(/\s+/);
    for (let i = 0; i + 4 <= words.length; i++) {
      if (lower.includes(words.slice(i, i + 4).join(' '))) {
        return { ok: false, reason: 'echoes_untrusted_text' };
      }
    }
  }
  return { ok: true };
}

export interface Narration {
  speak: string;
  narrator: string;
  /** Why a custom narrator's text was rejected (template spoken instead). */
  rejected?: string;
}

/** Narrate with `narrator`, falling back to the template on any failure or rejection. */
export async function narrateSafely(
  narrator: Narrator,
  d: Diagnosis,
  ctx: SpeakContext,
): Promise<Narration> {
  const template = speakDiagnosis(d, ctx);
  if (narrator === templateNarrator) return { speak: template, narrator: 'template' };
  let text: string;
  try {
    text = (await narrator.narrate(d, ctx)).trim();
  } catch (err) {
    log.warn('narrator failed', {
      narrator: narrator.name,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return { speak: template, narrator: 'template', rejected: 'narrator_error' };
  }
  const check = validateNarration(text, d, ctx);
  if (!check.ok) {
    log.warn('narration rejected', { narrator: narrator.name, reason: check.reason });
    return { speak: template, narrator: 'template', rejected: check.reason };
  }
  return { speak: text, narrator: narrator.name };
}
