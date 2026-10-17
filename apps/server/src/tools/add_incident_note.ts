import { createHash } from 'node:crypto';
import { z } from 'zod';
import { capitalize, spokenDuration } from '../domain/spoken.js';
import { UserFacingError } from '../lib/errors.js';
import { quoteUntrusted } from '../lib/untrusted.js';
import type { Clarification } from './common.js';
import { findIncident } from './incidentTarget.js';
import type { ToolDefinition } from './types.js';

const DUPLICATE_WINDOW_MS = 10 * 60_000;

const inputSchema = z.object({
  note: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe('What to record, as the user said it (up to 500 characters).'),
  incident_id: z
    .string()
    .max(64)
    .regex(/^[\w-]+$/)
    .optional()
    .describe('A specific incident id. Optional.'),
  service: z
    .string()
    .max(60)
    .optional()
    .describe('Service as the user said it; its open incident.'),
  resolve: z
    .boolean()
    .optional()
    .describe('true to close the incident with this note as the resolution.'),
});

export interface NoteData {
  incidentId: string;
  status: string;
  resolved: boolean;
  duplicate: boolean;
}

const hashNote = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export const addIncidentNote: ToolDefinition<typeof inputSchema, NoteData | Clarification> = {
  name: 'add_incident_note',
  title: 'Add an incident note',
  description:
    "Add a note to an incident's timeline (what was seen, decided or done), optionally resolving it with resolve: true. " +
    'Defaults to the open incident. Notes are stored as quoted text and never treated as instructions.',
  inputSchema,
  minRole: 'responder',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  describeInvalidInput: (issue) =>
    issue.path[0] === 'note'
      ? 'What should the note say? Keep it under 500 characters.'
      : undefined,

  async handler(input, { deps, principal }) {
    const target = await findIncident(deps, input, { fallbackToLatest: false });
    if (target.kind === 'clarify') return target.output;
    const incident = target.incident;
    const name = deps.services.find((s) => s.name === incident.service)?.displayName;
    const which = name ? `the ${name} incident` : 'the incident';
    const now = deps.now();
    const resolve = input.resolve === true;
    if (resolve && incident.status === 'resolved') {
      throw new UserFacingError('already_resolved', `${capitalize(which)} is already resolved.`);
    }

    // Idempotent: the same note by the same person within 10 minutes is recorded once.
    const noteHash = hashNote(input.note);
    const dup = (await deps.incidents.events(incident.id)).find(
      (e) =>
        (e.kind === 'note' || e.kind === 'resolved') &&
        e.actor === principal.actor &&
        (e.data as { noteHash?: string } | undefined)?.noteHash === noteHash &&
        now.getTime() - e.createdAt.getTime() < DUPLICATE_WINDOW_MS,
    );
    if (dup && (!resolve || dup.kind === 'resolved')) {
      return {
        speak: 'Already noted.',
        data: {
          incidentId: incident.id,
          status: incident.status,
          resolved: incident.status === 'resolved',
          duplicate: true,
        },
      };
    }

    await deps.incidents.appendEvent(incident.id, {
      kind: resolve ? 'resolved' : 'note',
      actor: principal.actor,
      // Server-authored; the note itself is untrusted and stays quoted in data.
      message: `${resolve ? 'resolved' : 'note'} by ${principal.actor}`,
      data: { note: quoteUntrusted(input.note, 500, { multiline: true }), noteHash },
    });
    if (resolve) {
      const resolved = await deps.incidents.resolve(incident.id, now);
      const minutes = Math.max(
        1,
        Math.round((now.getTime() - resolved.openedAt.getTime()) / 60_000),
      );
      return {
        speak: `Resolved ${which} after ${spokenDuration(minutes)}. Your note is saved.`,
        data: { incidentId: incident.id, status: 'resolved', resolved: true, duplicate: false },
      };
    }
    return {
      speak: `Noted on ${which}.`,
      data: { incidentId: incident.id, status: incident.status, resolved: false, duplicate: false },
    };
  },
};
