import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Builds the MCP Apps cards (dist-ui/) once before the test run. */
export default function setup(): void {
  const script = fileURLToPath(new URL('../../scripts/build-ui.mjs', import.meta.url));
  execFileSync(process.execPath, [script], { stdio: 'inherit' });
}
