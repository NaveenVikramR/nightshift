/**
 * Structured logs: event names and counts only. Never pass user text, model
 * output, tokens or tool inputs here.
 */
type Fields = Record<string, string | number | boolean | null | undefined>;

function write(level: 'info' | 'warn' | 'error', msg: string, fields: Fields = {}): void {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    app: 'alexa-sim',
    msg,
    ...fields,
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};

/** Failure fields for an AWS/network error: name, SDK attempts, network code. Never messages. */
export function errorFields(err: unknown): Record<string, string | number | null> {
  if (!(err instanceof Error)) return { error: 'unknown' };
  const e = err as Error & {
    code?: unknown;
    cause?: { code?: unknown };
    $metadata?: { attempts?: number; totalRetryDelay?: number };
  };
  const code = typeof e.code === 'string' ? e.code : e.cause?.code;
  return {
    error: e.name,
    code: typeof code === 'string' ? code.slice(0, 40) : null,
    attempts: e.$metadata?.attempts ?? null,
    retryDelayMs: e.$metadata?.totalRetryDelay ?? null,
  };
}

/** Logs when the event loop stalls (> 1 s late): a blocked process looks like a network hang. */
export function watchEventLoop(): void {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - 500;
    if (lag > 1_000) write('warn', 'event loop stalled', { lagMs: lag });
    last = now;
  }, 500);
  timer.unref();
}
