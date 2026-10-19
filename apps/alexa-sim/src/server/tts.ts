/**
 * Text to speech. Prod: Amazon Polly (neural voices, MP3), credentials from the
 * instance role via the default provider chain. Local: the browser speaks with
 * its own speechSynthesis (no AWS needed).
 */
import {
  PollyClient,
  SynthesizeSpeechCommand,
  type SynthesizeSpeechCommandOutput,
} from '@aws-sdk/client-polly';
import type { DailyCap, Usage } from './limits';

export type VoiceId = 'en-IN' | 'en-US';

/** Neural voices per locale. */
export const VOICES: Record<VoiceId, { voice: string; label: string }> = {
  'en-IN': { voice: 'Kajal', label: 'Indian English' },
  'en-US': { voice: 'Joanna', label: 'US English' },
};

export const MAX_SPEECH_CHARS = 600;

export type SpeechResult =
  | { provider: 'browser' }
  | { provider: 'polly'; audio: Uint8Array }
  | { provider: 'none'; reason: string };

export interface Speech {
  readonly label: string;
  synthesize(text: string, voice: VoiceId, signal?: AbortSignal): Promise<SpeechResult>;
}

export class BrowserSpeech implements Speech {
  readonly label = 'Browser speech synthesis (local)';
  async synthesize(): Promise<SpeechResult> {
    return { provider: 'browser' };
  }
}

/** The one SDK method we use (a fake implements it in tests). */
export interface PollySender {
  send(
    command: SynthesizeSpeechCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<SynthesizeSpeechCommandOutput>;
}

export class PollySpeech implements Speech {
  readonly label = 'Amazon Polly (neural)';

  constructor(
    private readonly client: PollySender,
    private readonly cap: DailyCap,
    private readonly usage: Usage,
  ) {}

  static fromRegion(region: string | undefined, cap: DailyCap, usage: Usage): PollySpeech {
    return new PollySpeech(new PollyClient(region ? { region } : {}), cap, usage);
  }

  async synthesize(text: string, voice: VoiceId, signal?: AbortSignal): Promise<SpeechResult> {
    const clipped = text.slice(0, MAX_SPEECH_CHARS);
    if (!clipped.trim()) return { provider: 'none', reason: 'empty' };
    if (!this.cap.take()) {
      this.usage.add('dailyCapHit');
      return { provider: 'none', reason: 'daily_cap' };
    }
    this.usage.add('speechRequests');
    this.usage.add('speechCharacters', clipped.length);
    const out = await this.client.send(
      new SynthesizeSpeechCommand({
        Engine: 'neural',
        OutputFormat: 'mp3',
        VoiceId: VOICES[voice].voice as SynthesizeSpeechCommand['input']['VoiceId'],
        LanguageCode: voice,
        Text: clipped,
      }),
      signal ? { abortSignal: signal } : undefined,
    );
    if (!out.AudioStream) return { provider: 'none', reason: 'no_audio' };
    return { provider: 'polly', audio: await out.AudioStream.transformToByteArray() };
  }
}
