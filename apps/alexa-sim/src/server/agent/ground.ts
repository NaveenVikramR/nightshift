/** Spoken replies: grounded in tool results, plain text, voice length. */
const NUMBER = /\d+(?:[.,]\d+)?/g;
const MAX_WORDS = 40;

export function numbersIn(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((n) => n.replace(',', '.'));
}

function capWords(text: string): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= MAX_WORDS) return text.trim();
  const cut = words.slice(0, MAX_WORDS).join(' ');
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '));
  return lastStop > 40 ? cut.slice(0, lastStop + 1) : `${cut}…`;
}

/** Strip markdown a voice device would read out loud. */
function plain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Grounded speech (invariant 5): when a tool answered this turn, say the last
 * tool's server-written `speak` (deterministic, from measured evidence). The
 * model's own words are spoken only when no tool ran (a greeting or a short
 * clarifying question), after stripping markdown and capping the length. A live
 * run showed why: asked "what's wrong", a model added a cause ("a traffic
 * spike") that no tool had found; number checks alone don't catch that.
 */
export function groundedReply(
  modelText: string,
  toolResults: { speak: string; data: unknown }[],
): { text: string; source: 'model' | 'tool' } {
  // A confirmed action's measured result outranks anything after it.
  const confirmed = toolResults.find(
    (r) => typeof (r.data as { verification?: unknown } | null)?.verification === 'object',
  );
  const spoken = confirmed ?? [...toolResults].reverse().find((r) => r.speak.trim());
  if (spoken) return { text: capWords(spoken.speak), source: 'tool' };
  const reply = plain(modelText);
  return { text: capWords(reply || 'Done.'), source: 'model' };
}
