/** Browser-side API calls (same origin; basePath must be added by hand for fetch). */
export const BASE = '/alexa';

export interface SessionInfo {
  actor: string;
  role: 'viewer' | 'responder';
  csrf: string;
  model: string;
  speech: string;
  speechProvider: 'browser' | 'polly';
  voices: { id: 'en-IN' | 'en-US'; label: string }[];
  demo: boolean;
  trace: TraceEntry[];
}

export interface TraceEntry {
  turn: number;
  at: string;
  source: 'agent' | 'card' | 'demo';
  tool: string;
  input: Record<string, unknown>;
  outcome: 'ok' | 'error' | 'refused';
  note: string;
  confirmation?: { step: 'prepared' | 'human_yes' | 'confirmed' | 'refused'; id: string };
  verification?: { outcome: string; before: number | null; after: number | null };
}

export interface ToolResultPayload {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface CardOut {
  tool: string;
  resourceUri: string;
  result: ToolResultPayload;
}

export interface TurnResponse {
  reply: string;
  replySource: 'model' | 'tool' | 'guard';
  cards: CardOut[];
  trace: TraceEntry[];
  audio: { provider: 'browser' } | { provider: 'polly'; id: string } | { provider: 'none' };
  model: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

let csrf = '';
export const setCsrf = (token: string) => {
  csrf = token;
};

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(method === 'POST' && csrf && { 'x-nightshift-csrf': csrf }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    throw new ApiError(res.status, typeof data['error'] === 'string' ? data['error'] : 'error');
  return data as T;
}

export const api = {
  session: () => call<SessionInfo>('GET', 'session'),
  login: (token: string) =>
    call<{ actor: string; role: string; csrf: string }>('POST', 'login', { token }),
  logout: () => call<{ ok: boolean }>('POST', 'logout', {}),
  turn: (text: string, voice: string) => call<TurnResponse>('POST', 'turn', { text, voice }),
  tool: (name: string, args: Record<string, unknown>) =>
    call<{ result: ToolResultPayload; trace: TraceEntry[] }>('POST', 'tool', {
      name,
      arguments: args,
    }),
  demo: (scenario: string) =>
    call<{ ok: boolean; message: string }>('POST', `demo/${scenario}`, {}),
  speechUrl: (id: string) => `${BASE}/api/speech?id=${encodeURIComponent(id)}`,
  cardUrl: (uri: string) => `${BASE}/api/card?uri=${encodeURIComponent(uri)}`,
};
