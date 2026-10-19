/** GET /alexa/api/health → "ok" (container healthcheck; no session, no data). */
export function GET() {
  return new Response('ok', {
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  });
}
