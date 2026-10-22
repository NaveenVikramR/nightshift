/**
 * Browser sessions, in server memory only (single instance). The Nightshift
 * token lives here after login: it is never sent back to the browser, never
 * stored client-side and never logged. The cookie holds only a random id.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { McpGateway } from './mcp';
import type { Message } from './agent/types';

export type Role = 'viewer' | 'responder';

export interface TraceEntry {
  turn: number;
  at: string;
  /** 'agent' = chosen by the model; 'card' = a card button through the host bridge. */
  source: 'agent' | 'card' | 'demo';
  tool: string;
  input: Record<string, unknown>;
  outcome: 'ok' | 'error' | 'refused';
  /** Server-authored summary (the tool's speak, or why it was refused). */
  note: string;
  confirmation?: { step: 'prepared' | 'human_yes' | 'confirmed' | 'refused'; id: string };
  verification?: { outcome: string; before: number | null; after: number | null };
  /** On the "model" entry: tokens used this turn (counts only). */
  tokens?: { input: number; output: number };
}

export interface Session {
  id: string;
  csrf: string;
  token: string;
  /** sha256 of the token, for rate-limit keys (never the token itself). */
  tokenKey: string;
  actor: string;
  role: Role;
  mcp: McpGateway;
  history: Message[];
  turn: number;
  /** confirmation ids this session got from prepare_action, with the turn they were prepared in. */
  prepared: Map<string, number>;
  /** The last action this session confirmed (its server-written result), for a repeated "yes". */
  lastConfirmed?: { speak: string; at: number };
  trace: TraceEntry[];
  audio: Map<string, Uint8Array>;
  createdAt: number;
  lastSeen: number;
}

export function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly idleMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(init: Pick<Session, 'token' | 'actor' | 'role' | 'mcp'>): Session {
    this.sweep();
    const t = this.now();
    const s: Session = {
      ...init,
      id: randomBytes(32).toString('base64url'),
      csrf: randomBytes(32).toString('base64url'),
      tokenKey: tokenKey(init.token),
      history: [],
      turn: 0,
      prepared: new Map(),
      trace: [],
      audio: new Map(),
      createdAt: t,
      lastSeen: t,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (this.now() - s.lastSeen > this.idleMs) {
      void this.destroy(id);
      return undefined;
    }
    s.lastSeen = this.now();
    return s;
  }

  async destroy(id: string): Promise<void> {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    await s?.mcp.close().catch(() => undefined);
  }

  get size(): number {
    return this.sessions.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) if (t - s.lastSeen > this.idleMs) void this.destroy(id);
  }
}
