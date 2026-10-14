/**
 * Minimal structured logger (JSON lines on stderr).
 * Never pass tokens, Authorization headers or request bodies here.
 */
type Level = 'info' | 'warn' | 'error';

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else process.stderr.write(line + '\n');
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
};
