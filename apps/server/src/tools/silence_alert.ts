import { z } from 'zod';
import {
  clarifyAlertQuestion,
  describeAlert,
  resolveAlert,
  type AlertView,
} from '../domain/alerts/alerts.js';
import { capitalize, spokenDuration } from '../domain/spoken.js';
import { UserFacingError } from '../lib/errors.js';
import { clarify, loadAlertViews, type Clarification } from './common.js';
import type { ToolDefinition } from './types.js';

export const MAX_SILENCE_MINUTES = 240;
/** A repeat request for the same alert and duration within this window returns the first silence. */
const IDEMPOTENCY_WINDOW_MS = 10 * 60_000;

const inputSchema = z.object({
  alert: z
    .string()
    .max(120)
    .optional()
    .describe(
      'Which alert, as the user said it ("the latency alert") or a fingerprint from list_active_alerts. Optional when only one alert is unsilenced.',
    ),
  duration_minutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_SILENCE_MINUTES)
    .describe('How long to silence, in minutes (1 to 240, i.e. at most 4 hours). Required.'),
});

export interface SilenceData {
  fingerprint: string;
  alertname: string;
  service: string | null;
  silenceId: string;
  durationMinutes: number;
  endsAt: string;
  alreadySilenced: boolean;
}

const severityWord = (a: AlertView) =>
  a.severity === 'unknown' ? 'Alert' : capitalize(a.severity);

export const silenceAlert: ToolDefinition<
  typeof inputSchema,
  SilenceData | Clarification | { allSilenced: true }
> = {
  name: 'silence_alert',
  title: 'Silence alert',
  description:
    'Silence one firing alert in Alertmanager for 1 to 240 minutes so it stops notifying. ' +
    'Use only when the user asks to mute or snooze an alert and says for how long. ' +
    'Does not fix anything or acknowledge it; repeating the same request is safe.',
  inputSchema,
  minRole: 'responder',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },

  describeInvalidInput(issue) {
    if (issue.path[0] === 'duration_minutes') {
      return 'I can silence an alert for one minute up to four hours. How long should I silence it?';
    }
    return undefined;
  },

  async handler(input, { principal, deps }) {
    const minutes = input.duration_minutes;
    const views = await loadAlertViews(deps);
    if (views.length === 0) {
      throw new UserFacingError(
        'no_alerts',
        "No alerts are firing, so there's nothing to silence.",
      );
    }
    const candidates = input.alert ? views : views.filter((v) => !v.silenced);
    if (candidates.length === 0) {
      return { speak: 'All firing alerts are already silenced.', data: { allSilenced: true } };
    }

    const r = resolveAlert(input.alert, candidates, deps.services);
    if (r.kind === 'none') {
      throw new UserFacingError(
        'alert_not_found',
        "I couldn't find a firing alert like that. Ask me what alerts are firing.",
      );
    }
    if (r.kind === 'ambiguous') {
      return clarify(
        clarifyAlertQuestion(r.candidates),
        r.candidates.map((a) => ({ id: a.fingerprint, label: describeAlert(a) })),
      );
    }

    const alert = r.alert;
    const now = deps.now();
    const base = {
      fingerprint: alert.fingerprint,
      alertname: alert.alertname,
      service: alert.service,
    };
    const already = (
      silenceId: string,
      endsAt: Date,
      durationMinutes: number,
    ): { speak: string; data: SilenceData } => {
      const left = Math.max(1, Math.round((endsAt.getTime() - now.getTime()) / 60_000));
      return {
        speak: `${severityWord(alert)}: ${describeAlert(alert)} is already silenced for another ${spokenDuration(left)}.`,
        data: {
          ...base,
          silenceId,
          durationMinutes,
          endsAt: endsAt.toISOString(),
          alreadySilenced: true,
        },
      };
    };

    // Idempotency 1: same alert + same duration requested via Nightshift moments ago.
    const recent = await deps.silences.findRecent(
      alert.fingerprint,
      new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS),
    );
    if (recent && recent.durationMinutes === minutes && recent.endsAt > now) {
      return already(recent.silenceId, recent.endsAt, recent.durationMinutes);
    }

    // Idempotency 2: an active silence (from anyone) already covers the requested window.
    const wantedEnd = new Date(now.getTime() + minutes * 60_000);
    if (alert.silenced) {
      const covering = (await deps.alertmanager.listSilences())
        .filter((s) => s.state === 'active' && s.endsAt.getTime() >= wantedEnd.getTime() - 60_000)
        .filter((s) =>
          s.matchers.every((m) => !m.isRegex && m.isEqual && alert.rawLabels[m.name] === m.value),
        )
        .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0];
      if (covering) {
        const mins = Math.round((covering.endsAt.getTime() - covering.startsAt.getTime()) / 60_000);
        return already(covering.id, covering.endsAt, mins);
      }
    }

    const silenceId = await deps.alertmanager.createSilence({
      matchers: Object.entries(alert.rawLabels).map(([name, value]) => ({
        name,
        value,
        isRegex: false,
        isEqual: true,
      })),
      startsAt: now,
      endsAt: wantedEnd,
      createdBy: `nightshift:${principal.actor}`,
      comment: `Silenced via Nightshift by ${principal.actor} for ${spokenDuration(minutes)}.`,
    });
    await deps.silences.create({
      fingerprint: alert.fingerprint,
      alertname: alert.alertname,
      silenceId,
      durationMinutes: minutes,
      createdBy: principal.actor,
      endsAt: wantedEnd,
    });

    return {
      speak: `${severityWord(alert)}: silenced ${describeAlert(alert)} for ${spokenDuration(minutes)}. It is not fixed, so check on it later.`,
      data: {
        ...base,
        silenceId,
        durationMinutes: minutes,
        endsAt: wantedEnd.toISOString(),
        alreadySilenced: false,
      },
    };
  },
};
