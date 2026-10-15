import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { z } from 'zod';

/**
 * Wrap a zod schema for `registerTool` so that:
 * - `tools/list` advertises the zod schema's exact JSON Schema (the SDK reads only
 *   `~standard.jsonSchema` for listing), but
 * - `~standard.validate` accepts anything, so the SDK never rejects arguments
 *   before our code runs.
 *
 * Real validation happens in `runTool`, which audits failures (invariant 7).
 * Without this, the SDK turns schema failures into an error result before any
 * Nightshift code runs, and no audit row is written. See friction log.
 */
export function passThroughSchema<S extends z.ZodType>(
  schema: S,
): StandardSchemaWithJSON<z.input<S>, z.input<S>> {
  return {
    '~standard': {
      version: 1,
      vendor: 'nightshift-pass-through',
      validate: (value: unknown) => ({ value: value as z.input<S> }),
      jsonSchema: schema['~standard'].jsonSchema,
    },
  };
}
