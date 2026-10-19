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
