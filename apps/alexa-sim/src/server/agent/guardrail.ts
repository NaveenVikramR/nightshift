/**
 * Second layer against prompt injection, independent of the model provider
 * (Bedrock or Groq): one ApplyGuardrail call (prompt-attack filter) on the
 * person's words before the model sees them, and one on the untrusted text of
 * each tool result (commit messages, alert annotations, notes, advisories:
 * Nightshift marks it `{ untrusted: true, text }` and never speaks it).
 * Blocked or unchecked text is withheld (fail closed).
 * Nightshift's server-side rules (two-phase actions, roles, allowlists) remain
 * the primary protection; this only keeps injected instructions away from the model.
 */
import { awsClientConfig } from '../awsClient';
import { ApplyGuardrailCommand, BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { ApplyGuardrailCommandOutput } from '@aws-sdk/client-bedrock-runtime';

export interface GuardrailRef {
  id: string;
  version: string;
}

export const WITHHELD_FLAGGED = '[withheld: flagged by guardrail]';
export const WITHHELD_UNCHECKED = '[withheld: guardrail unavailable]';
export const GUARDRAIL_SPOKEN = 'I left out text that looked like an instruction.';
/** Spoken when the person's own words trip the filter. */
export const GUARDRAIL_INPUT_SPOKEN = 'That looked like an instruction to me, so I left it out.';
export const GUARDRAIL_UNCHECKED_SPOKEN =
  "I couldn't check that safely just now. Try again in a minute.";

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
    this.label = `Amazon Bedrock Guardrails (${ref.id} v${ref.version})`;
  }

  static fromRegion(ref: GuardrailRef, region: string): BedrockTextGuard {
    return new BedrockTextGuard(ref, new BedrockRuntimeClient(awsClientConfig(region)));
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
