import type { Role } from '../../lib/roles.js';

export interface ServerStatus {
  status: 'ok';
  serverVersion: string;
  protocolVersion: string;
  actor: string;
  role: Role;
  canWrite: boolean;
  uptimeSeconds: number;
  time: string;
}

export interface ServerStatusInput {
  serverVersion: string;
  protocolVersion: string;
  actor: string;
  role: Role;
  startedAt: Date;
  now: Date;
}

/** Pure: describe the server and the caller's access. */
export function buildServerStatus(i: ServerStatusInput): ServerStatus {
  return {
    status: 'ok',
    serverVersion: i.serverVersion,
    protocolVersion: i.protocolVersion,
    actor: i.actor,
    role: i.role,
    canWrite: i.role === 'responder',
    uptimeSeconds: Math.max(0, Math.floor((i.now.getTime() - i.startedAt.getTime()) / 1000)),
    time: i.now.toISOString(),
  };
}

/** Spoken summary, ≤ 30 words: status first, then access, then next step. */
export function speakServerStatus(s: ServerStatus): string {
  const access = s.canWrite
    ? 'responder access, so you can take actions after confirming'
    : 'viewer access, so you can check status but not take actions';
  return `Nightshift is online. You have ${access}. Ask me what's wrong to check your systems.`;
}
