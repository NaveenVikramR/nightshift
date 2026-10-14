import type { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { McpServer } from '@modelcontextprotocol/server';

export interface SessionEntry {
  transport: NodeStreamableHTTPServerTransport;
  server: McpServer;
  /** The actor whose token opened the session; other tokens cannot use it. */
  actor: string;
  lastSeen: number;
}

/**
 * In-memory MCP session registry. Because sessions live in process memory,
 * Nightshift must run as a SINGLE instance (see README, "Deployment").
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly idleTtlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  add(id: string, entry: Omit<SessionEntry, 'lastSeen'>): void {
    this.sessions.set(id, { ...entry, lastSeen: this.now() });
  }

  /** Returns the live session for this actor, or undefined (unknown, expired or not theirs). */
  get(id: string, actor: string): SessionEntry | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    if (this.now() - entry.lastSeen > this.idleTtlMs) {
      void this.close(id);
      return undefined;
    }
    if (entry.actor !== actor) return undefined;
    entry.lastSeen = this.now();
    return entry;
  }

  /** Forget a session without closing it (the transport already closed). */
  forget(id: string): void {
    this.sessions.delete(id);
  }

  async close(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) return;
    this.sessions.delete(id); // delete first: transport.onclose calls forget()
    await entry.transport.close().catch(() => undefined);
    await entry.server.close().catch(() => undefined);
  }

  /** Close every session idle for longer than the TTL. */
  async sweep(): Promise<void> {
    const cutoff = this.now() - this.idleTtlMs;
    const stale = [...this.sessions].filter(([, e]) => e.lastSeen < cutoff).map(([id]) => id);
    await Promise.all(stale.map((id) => this.close(id)));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
