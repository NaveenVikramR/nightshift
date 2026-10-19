/**
 * Voice in and out in the browser.
 * In: Web Speech API SpeechRecognition (Chrome; push-to-talk). Out: Polly MP3 from
 * our backend, or the browser's speechSynthesis when running locally without AWS.
 */
import { api } from './api';

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const canListen = () => typeof window !== 'undefined' && Boolean(recognitionCtor());

/** Starts listening. Calls onInterim with partial text and onFinal once with the result (or ''). */
export function listen(
  lang: string,
  onInterim: (text: string) => void,
  onFinal: (text: string, error?: string) => void,
): () => void {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    onFinal('', 'unsupported');
    return () => undefined;
  }
  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = '';
  let done = false;
  const finish = (error?: string) => {
    if (done) return;
    done = true;
    onFinal(finalText.trim(), error);
  };
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!;
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    onInterim((finalText + interim).trim());
  };
  rec.onerror = (e) => finish(e.error);
  rec.onend = () => finish();
  rec.start();
  return () => rec.stop();
}

let current: HTMLAudioElement | null = null;

/** Stops any reply being spoken (barge-in). */
export function stopSpeaking(): void {
  if (current) {
    current.pause();
    current = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
}

/** Speaks a reply; resolves when it ends (or fails). */
export async function speak(
  text: string,
  audio: { provider: 'browser' } | { provider: 'polly'; id: string } | { provider: 'none' },
  lang: string,
): Promise<void> {
  stopSpeaking();
  if (audio.provider === 'polly') {
    const res = await fetch(api.speechUrl(audio.id), { credentials: 'same-origin' });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const el = new Audio(url);
    current = el;
    await new Promise<void>((resolve) => {
      el.onended =
        el.onerror =
        el.onpause =
          () => {
            URL.revokeObjectURL(url);
            resolve();
          };
      void el.play().catch(() => resolve());
    });
    return;
  }
  if (audio.provider === 'browser' && 'speechSynthesis' in window) {
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      const voice = window.speechSynthesis
        .getVoices()
        .find((v) => v.lang === lang || v.lang.replace('_', '-') === lang);
      if (voice) u.voice = voice;
      u.rate = 1.02;
      u.onend = u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }
}
