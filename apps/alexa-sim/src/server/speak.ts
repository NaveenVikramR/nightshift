/**
 * Server-side speech for a reply: Polly MP3 kept in session memory for one
 * fetch (/api/speech?id=…). The text is always server-authored (the agent's
 * grounded reply or a tool's `speak`); the browser never chooses what Polly says.
 */
import { randomBytes } from 'node:crypto';
import { log } from './log';
import type { Session } from './sessions';
import type { Speech, VoiceId } from './tts';

export type AudioRef =
  { provider: 'browser' } | { provider: 'polly'; id: string } | { provider: 'none' };

export async function speakReply(
  speech: Speech,
  session: Session,
  text: string,
  voice: VoiceId,
): Promise<{ audio: AudioRef; characters: number }> {
  try {
    const s = await speech.synthesize(text, voice, AbortSignal.timeout(10_000));
    if (s.provider === 'polly') {
      const id = randomBytes(12).toString('base64url');
      session.audio.clear();
      session.audio.set(id, s.audio);
      return { audio: { provider: 'polly', id }, characters: s.characters };
    }
    if (s.provider === 'browser') return { audio: { provider: 'browser' }, characters: 0 };
    log.warn('speech skipped', { reason: s.reason });
  } catch (err) {
    log.warn('speech failed', { error: err instanceof Error ? err.name : 'unknown' });
  }
  return { audio: { provider: 'none' }, characters: 0 };
}

export const voiceOf = (v: unknown): VoiceId => (v === 'en-US' ? 'en-US' : 'en-IN');
