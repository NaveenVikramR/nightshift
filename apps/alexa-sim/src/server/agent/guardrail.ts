/**
 * Second layer for untrusted text (commit messages, alert annotations, notes,
 * advisories): Nightshift marks it `{ untrusted: true, text }` and never speaks
 * it; before a tool result reaches the model, one ApplyGuardrail call
 * (prompt-attack filter) checks all of it. Blocked or unchecked text is withheld.
 * Nightshift's server-side rules (two-phase actions, roles, allowlists) remain
 * the primary protection; this only keeps injected instructions away from the model.
 */
import { ApplyGuardrailCommand, BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { ApplyGuardrailCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import type { GuardrailRef } from './bedrock';

export const WITHHELD_FLAGGED = '[withheld: flagged by guardrail]';
export const WITHHELD_UNCHECKED = '[withheld: guardrail unavailable]';
export const GUARDRAIL_SPOKEN =
  'Some text in that result looked like an instruction, so I left it out.';

export interface TextGuard {
  readonly label: string;
  /** 'blocked' if any of the texts trips the filter. Throws if the check failed. */
  check(texts: string[], signal?: AbortSignal): Promise<'allowed' | 'blocked'>;
}

/** The one SDK method we use (a fake implements it in tests). */
export interface ApplyGuardrailSender {
  send(
    command: ApplyGuardrailCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ApplyGuardrailCommandOutput>;
}

export class BedrockTextGuard implements TextGuard {
  readonly label: string;

  constructor(
    private readonly ref: GuardrailRef,
    private readonly client: ApplyGuardrailSender,
  ) {
    this.label = `Bedrock Guardrails · ${ref.id} v${ref.version}`;
  }

  static fromRegion(ref: GuardrailRef, region: string): BedrockTextGuard {
    return new BedrockTextGuard(ref, new BedrockRuntimeClient({ region }));
  }

  async check(texts: string[], signal?: AbortSignal): Promise<'allowed' | 'blocked'> {
    const out = await this.client.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: this.ref.id,
        guardrailVersion: this.ref.version,
        source: 'INPUT',
        // One text block: billed per 1,000 characters, not per item.
        content: [{ text: { text: texts.join('\n---\n') } }],
      }),
      signal ? { abortSignal: signal } : undefined,
    );
    return out.action === 'GUARDRAIL_INTERVENED' ? 'blocked' : 'allowed';
  }
}

type Untrusted = { untrusted: true; text: string };

const isUntrusted = (v: unknown): v is Untrusted =>
  typeof v === 'object' &&
  v !== null &&
  (v as Record<string, unknown>)['untrusted'] === true &&
  typeof (v as Record<string, unknown>)['text'] === 'string';

/** Every `{ untrusted: true, text }` string in a tool result's data (non-empty, depth-limited). */
export function untrustedTexts(data: unknown, depth = 0): string[] {
  if (depth > 12 || typeof data !== 'object' || data === null) return [];
  if (isUntrusted(data)) return data.text.trim() ? [data.text] : [];
  const values = Array.isArray(data) ? data : Object.values(data);
  return values.flatMap((v) => untrustedTexts(v, depth + 1));
}

/** A copy of `data` with every untrusted text replaced by `marker`. */
export function withholdUntrusted<T>(data: T, marker: string, depth = 0): T {
  if (depth > 12 || typeof data !== 'object' || data === null) return data;
  if (isUntrusted(data)) return { untrusted: true, text: marker } as T;
  if (Array.isArray(data)) return data.map((v) => withholdUntrusted(v, marker, depth + 1)) as T;
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, withholdUntrusted(v, marker, depth + 1)]),
  ) as T;
}
