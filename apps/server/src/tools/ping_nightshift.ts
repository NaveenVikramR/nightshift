import { z } from 'zod';
import {
  buildServerStatus,
  speakServerStatus,
  type ServerStatus,
} from '../domain/status/serverStatus.js';
import { TARGET_PROTOCOL_VERSION } from '../version.js';
import type { ToolDefinition } from './types.js';

const inputSchema = z.object({});

export const pingNightshift: ToolDefinition<typeof inputSchema, ServerStatus> = {
  name: 'ping_nightshift',
  title: 'Ping Nightshift',
  description:
    'Check that the Nightshift server is reachable and report your access level (viewer or responder) and the server version. ' +
    'Use when the user asks if Nightshift is working or what they are allowed to do. ' +
    'Does not check alerts or system health; use get_ops_brief for that.',
  inputSchema,
  minRole: 'viewer',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  async handler(_input, { principal, deps }) {
    const data = buildServerStatus({
      serverVersion: deps.serverVersion,
      protocolVersion: TARGET_PROTOCOL_VERSION,
      actor: principal.actor,
      role: principal.role,
      startedAt: deps.startedAt,
      now: deps.now(),
    });
    return { speak: speakServerStatus(data), data };
  },
};
