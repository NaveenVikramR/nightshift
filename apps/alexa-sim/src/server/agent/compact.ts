/**
 * Tool results for the model, compacted (cost and provider limits): the card gets
 * the full CallToolResult, but the model only needs the facts to reason about
 * (`speak`, causes, suggested actions, confirmation ids, verification), not the
 * chart series. While the JSON is over `maxChars`, the largest array is replaced
 * by `{ omitted: <n> items }`. Deterministic, so the same result always yields
 * the same model input.
 */
export const MODEL_DATA_MAX_CHARS = 2_500;

type Path = (string | number)[];

function largestArray(v: unknown, path: Path = [], best = { path: [] as Path, size: 0 }) {
  if (Array.isArray(v)) {
    const size = JSON.stringify(v).length;
    if (size > best.size && v.length > 0) {
      best.path = path;
      best.size = size;
    }
    v.forEach((x, i) => largestArray(x, [...path, i], best));
  } else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) largestArray(x, [...path, k], best);
  }
  return best;
}

function setAt(root: unknown, path: Path, value: unknown): void {
  let cur = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) cur = cur[key] as Record<string | number, unknown>;
  cur[path[path.length - 1]!] = value;
}

export function compactForModel<T>(data: T, maxChars = MODEL_DATA_MAX_CHARS): T {
  if (JSON.stringify(data).length <= maxChars) return data;
  const copy = structuredClone(data) as unknown;
  for (let i = 0; i < 50 && JSON.stringify(copy).length > maxChars; i++) {
    const { path, size } = largestArray(copy);
    if (!size || path.length === 0) break;
    let arr: unknown = copy;
    for (const key of path) arr = (arr as Record<string | number, unknown>)[key];
    setAt(copy, path, { omitted: (arr as unknown[]).length });
  }
  return copy as T;
}
