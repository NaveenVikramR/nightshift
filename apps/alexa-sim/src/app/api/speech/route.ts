/** GET /alexa/api/speech?id=… → the Polly MP3 for the last reply (one fetch, session-bound). */
import type { NextRequest } from 'next/server';
import { guard, json } from '@/server/http';

export async function GET(req: NextRequest) {
  const g = guard(req, { session: true });
  if ('response' in g) return g.response;
  const id = req.nextUrl.searchParams.get('id') ?? '';
  const audio = g.session.audio.get(id);
  if (!audio) return json({ error: 'not_found' }, 404);
  g.session.audio.delete(id);
  return new Response(new Uint8Array(audio), {
    headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' },
  });
}
