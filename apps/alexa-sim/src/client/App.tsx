'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  setCsrf,
  type CardOut,
  type SessionInfo,
  type CardToolResponse,
  type TraceEntry,
} from './api';
import { CardHost } from './CardHost';
import { DemoPanel } from './DemoPanel';
import { TracePanel } from './TracePanel';
import { canListen, listen, speak, stopSpeaking } from './voice';

type RingState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';
interface Caption {
  id: number;
  who: 'you' | 'nightshift';
  text: string;
}

const RING_LABEL: Record<RingState, string> = {
  idle: 'Ready',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking',
  error: 'Something went wrong',
};

const CHIPS = [
  "What's wrong?",
  'Give me the ops brief',
  'Any security issues?',
  'What happened last time?',
];

let captionSeq = 0;

export function App() {
  const [session, setSession] = useState<SessionInfo | null | undefined>(undefined);
  const refresh = useCallback(async () => {
    try {
      const s = await api.session();
      setCsrf(s.csrf);
      setSession(s);
    } catch {
      setSession(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (session === undefined) return <main className="center muted">Loading…</main>;
  if (session === null) return <Login onDone={refresh} />;
  return <Device session={session} onSignedOut={() => setSession(null)} />;
}

function Login({ onDone }: { onDone: () => Promise<void> }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.login(token.trim());
      setCsrf(r.csrf);
      setToken('');
      await onDone();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Too many attempts. Wait a few minutes and try again.'
          : "That token didn't work. Check it and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <p className="brand">
          <span className="brand-moon" aria-hidden="true" /> Nightshift
        </p>
        <h1>Talk to your on-call copilot</h1>
        <p className="muted">
          A simulated Alexa+ on an Echo Show. Enter your Nightshift token. It stays on the server
          for this session only; it isn&apos;t stored in your browser.
        </p>
        <label htmlFor="token">Nightshift token</label>
        <input
          id="token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste the token from the instructions"
          required
        />
        <button
          className="btn btn-primary"
          type="submit"
          disabled={busy || token.trim().length < 16}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <p className="error" role="alert">
          {error}
        </p>
      </form>
    </main>
  );
}

function Device({ session, onSignedOut }: { session: SessionInfo; onSignedOut: () => void }) {
  const [ring, setRing] = useState<RingState>('idle');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [cards, setCards] = useState<(CardOut & { key: number })[]>([]);
  const [trace, setTrace] = useState<TraceEntry[]>(session.trace);
  const [text, setText] = useState('');
  const [voice, setVoice] = useState<'en-IN' | 'en-US'>('en-IN');
  const [listening, setListening] = useState(false);
  const stopListening = useRef<(() => void) | null>(null);
  const captionsEnd = useRef<HTMLDivElement>(null);
  const cardsBox = useRef<HTMLDivElement>(null);

  const say = useCallback((who: Caption['who'], t: string) => {
    setCaptions((c) => [...c.slice(-11), { id: ++captionSeq, who, text: t }]);
  }, []);

  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scroll methods, and an
    // effect must return nothing or a cleanup function.
    void captionsEnd.current?.scrollIntoView({ block: 'end' });
  }, [captions]);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        onSignedOut();
        return;
      }
      setRing('error');
      say('nightshift', "I couldn't reach Nightshift. Try again in a moment.");
    },
    [onSignedOut, say],
  );

  const ask = useCallback(
    async (utterance: string) => {
      const q = utterance.trim();
      if (!q) return;
      stopSpeaking();
      setText('');
      say('you', q);
      setRing('thinking');
      try {
        const r = await api.turn(q, voice);
        say('nightshift', r.reply);
        if (r.cards.length) setCards(r.cards.map((c) => ({ ...c, key: ++captionSeq })));
        setTrace((t) => [...t, ...r.trace].slice(-60));
        setRing('speaking');
        await speak(r.reply, r.audio, voice);
        setRing('idle');
      } catch (err) {
        handleError(err);
      }
    },
    [voice, say, handleError],
  );

  /** A card button ran a tool (prepare/confirm/findings): caption + speak the server's answer. */
  const onCardTool = useCallback(
    (_tool: string, out: CardToolResponse) => {
      setTrace((t) => [...t, ...out.trace].slice(-60));
      // The card just changed view (e.g. incident -> confirmation): show it from the top.
      void cardsBox.current?.scrollTo({ top: 0, behavior: 'smooth' });
      if (!out.speak) return;
      say('nightshift', out.speak);
      setRing('speaking');
      void speak(out.speak, out.audio, voice).then(() => setRing('idle'));
    },
    [say, voice],
  );

  const toggleMic = () => {
    if (listening) {
      stopListening.current?.();
      return;
    }
    stopSpeaking(); // barge-in
    setListening(true);
    setRing('listening');
    stopListening.current = listen(
      voice,
      (interim) => setText(interim),
      (final, error) => {
        setListening(false);
        stopListening.current = null;
        if (error && error !== 'no-speech' && error !== 'aborted') {
          setRing('error');
          say(
            'nightshift',
            error === 'not-allowed'
              ? 'Microphone access is blocked. Type instead.'
              : "I didn't catch that. Try again or type.",
          );
          return;
        }
        setRing('idle');
        if (final) void ask(final);
      },
    );
  };

  const logout = async () => {
    stopSpeaking();
    await api.logout().catch(() => undefined);
    onSignedOut();
  };

  return (
    <main className="stage">
      <header className="topbar">
        <p className="brand">
          <span className="brand-moon" aria-hidden="true" /> Nightshift{' '}
          <span className="muted small">simulated Alexa+</span>
        </p>
        <div className="who">
          <span className={`role role-${session.role}`}>{session.role}</span>
          <span className="muted small">{session.actor}</span>
          <button className="btn btn-ghost small" type="button" onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

      <section className={`device ring-${ring}`} aria-label="Echo Show">
        <div className="ring" aria-hidden="true" />
        <p className="ring-label" role="status">
          {RING_LABEL[ring]}
        </p>
        <div className="screen">
          <div className="cards" aria-live="polite" ref={cardsBox}>
            {cards.length === 0 ? (
              <div className="empty">
                <p className="empty-title">Ask Nightshift</p>
                <p className="muted">Tap a suggestion, hold the mic, or type.</p>
              </div>
            ) : (
              cards.map((c) => (
                <CardHost key={c.key} card={c} voice={voice} onToolResult={onCardTool} />
              ))
            )}
          </div>
          <div className="captions" aria-label="Conversation">
            {captions.map((c) => (
              <p key={c.id} className={`caption caption-${c.who}`}>
                <span className="caption-who">{c.who === 'you' ? 'You' : 'Nightshift'}</span>
                {c.text}
              </p>
            ))}
            <div ref={captionsEnd} />
          </div>
        </div>
      </section>

      <section className="controls" aria-label="Talk to Nightshift">
        <div className="chips">
          {CHIPS.map((c) => (
            <button
              key={c}
              className="chip"
              type="button"
              onClick={() => void ask(c)}
              disabled={ring === 'thinking'}
            >
              {c}
            </button>
          ))}
        </div>
        <form
          className="talk"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(text);
          }}
        >
          <button
            className={`mic${listening ? ' mic-on' : ''}`}
            type="button"
            onClick={toggleMic}
            disabled={!canListen() || ring === 'thinking'}
            aria-pressed={listening}
            aria-label={listening ? 'Stop listening' : 'Talk (push to talk)'}
            title={
              canListen()
                ? 'Push to talk (stops any reply being spoken)'
                : 'Voice input needs Chrome; type instead'
            }
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
              <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
            </svg>
          </button>
          <label className="sr-only" htmlFor="say">
            Say or type
          </label>
          <input
            id="say"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={listening ? 'Listening…' : 'Type, or hold the mic and talk'}
            autoComplete="off"
            maxLength={500}
          />
          <button
            className="btn btn-primary"
            type="submit"
            disabled={!text.trim() || ring === 'thinking'}
          >
            Send
          </button>
        </form>
        <div className="settings">
          <label htmlFor="voice" className="muted small">
            Voice
          </label>
          <select
            id="voice"
            value={voice}
            onChange={(e) => setVoice(e.target.value as 'en-IN' | 'en-US')}
          >
            {session.voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
          <span className="muted small">
            {session.model} · {session.speech}
            {session.guardrail ? ` · ${session.guardrail}` : ''}
          </span>
        </div>
      </section>

      <TracePanel trace={trace} model={session.model} guardrail={session.guardrail} />
      {session.demo ? (
        <DemoPanel onEntry={(e) => setTrace((t) => [...t, e])} onError={handleError} />
      ) : null}
    </main>
  );
}
