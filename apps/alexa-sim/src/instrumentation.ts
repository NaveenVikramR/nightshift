/**
 * Runs once when the Next.js server starts. A bad provider config or missing AWS
 * credentials stops the process here (no silent fallback to a fake model or voice).
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  const { checkStartup } = await import('./server/runtime');
  const { watchEventLoop } = await import('./server/log');
  watchEventLoop();
  try {
    await checkStartup();
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const issues = (err as { issues?: { path: PropertyKey[] }[] }).issues ?? [];
    const what =
      name === 'ConfigError'
        ? (err as Error).message
        : name === 'ZodError'
          ? `invalid settings: ${issues.map((i) => i.path.join('.')).join(', ')}`
          : `AWS credentials could not be loaded (${err instanceof Error ? err.name : 'unknown'}). Locally: aws login --profile nightshift, then AWS_PROFILE=nightshift-app.`;
    console.error(
      JSON.stringify({ level: 'error', app: 'alexa-sim', msg: 'startup failed', what }),
    );
    process.exit(1);
  }
}
