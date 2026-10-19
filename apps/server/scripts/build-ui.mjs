// Builds the MCP Apps cards (src/ui/view) into self-contained HTML files in
// dist-ui/: one shared script bundle (ext-apps App + our renderers) and the
// shared CSS, inlined into one file per card. No external URLs, no web fonts.
//   node scripts/build-ui.mjs
import { build } from 'esbuild';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const view = join(root, 'src', 'ui', 'view');
const out = join(root, 'dist-ui');

/** Card id -> page title. Keep in sync with CARDS in src/ui/cards.ts. */
const CARDS = {
  incident: 'Incident',
  confirm: 'Confirm action',
  security: 'Security scorecard',
  brief: 'Ops brief',
};

const result = await build({
  entryPoints: [join(view, 'main.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  write: false,
  logLevel: 'warning',
});
// Inline-safe: a "</script" inside the bundle would end the script element.
const js = result.outputFiles[0].text.replaceAll('</script', '<\\/script');

const css = readdirSync(join(view, 'styles'))
  .filter((f) => f.endsWith('.css'))
  .sort()
  .map((f) => readFileSync(join(view, 'styles', f), 'utf8'))
  .join('\n');

mkdirSync(out, { recursive: true });
for (const [id, title] of Object.entries(CARDS)) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Nightshift · ${title}</title>
<style>${css}</style>
</head>
<body data-card="${id}">
<main id="app" class="card" aria-live="polite"></main>
<script>${js}</script>
</body>
</html>
`;
  writeFileSync(join(out, `${id}.html`), html);
}
console.log(
  `built ${Object.keys(CARDS).length} cards -> dist-ui/ (${Math.round(js.length / 1024)} KB script)`,
);
