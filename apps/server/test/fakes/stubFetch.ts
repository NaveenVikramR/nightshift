import { ClientError, type FetchLike } from '../../src/clients/errors.js';

export interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Stub fetch: records calls, returns a canned response or throws. */
export function stubFetch(respond: (call: Call) => Response | Error): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      const r = respond(call);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The ClientError kind a promise rejects with ('resolved' / 'other' otherwise). */
export const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof ClientError ? e.kind : 'other';
  }
};
