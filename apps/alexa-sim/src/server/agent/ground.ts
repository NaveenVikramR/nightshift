/**
 * Keep spoken numbers grounded (like Nightshift's narrator guard): when one tool
 * answered the question and the model's reply mentions a number that isn't in
 * that tool's result, say the tool's own `speak` instead. Replies are capped to
 * a voice length either way.
 */
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

export function groundedReply(
  modelText: string,
  toolResults: { speak: string; data: unknown }[],
): { text: string; source: 'model' | 'tool' } {
  const reply = plain(modelText);
  const last = toolResults[toolResults.length - 1];
  if (!reply) return { text: capWords(last?.speak || 'Done.'), source: last ? 'tool' : 'model' };
  if (toolResults.length === 1 && last) {
    const evidence = `${last.speak} ${JSON.stringify(last.data)}`;
    const allowed = new Set(numbersIn(evidence));
    // Percent values: data has ratios (0.45) while speech says 45; allow both forms.
    for (const n of numbersIn(JSON.stringify(last.data))) {
      const v = Number(n);
      if (v > 0 && v <= 1) {
        allowed.add(String(Math.round(v * 100)));
        allowed.add(String(Number((v * 100).toFixed(1))));
      }
    }
    if (numbersIn(reply).some((n) => !allowed.has(n)))
      return { text: capWords(last.speak), source: 'tool' };
  }
  return { text: capWords(reply), source: 'model' };
}
