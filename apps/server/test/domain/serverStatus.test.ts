import { describe, expect, it } from 'vitest';
import { buildServerStatus, speakServerStatus } from '../../src/domain/status/serverStatus.js';
import { countWords } from '../../src/lib/speak.js';

const base = {
  serverVersion: '0.1.0',
  protocolVersion: '2025-11-25',
  actor: 'alice',
  startedAt: new Date('2026-10-14T11:00:00Z'),
  now: new Date('2026-10-14T12:00:30Z'),
};

describe('buildServerStatus', () => {
  it('computes uptime and write access for a responder', () => {
    const s = buildServerStatus({ ...base, role: 'responder' });
    expect(s).toMatchObject({ status: 'ok', canWrite: true, uptimeSeconds: 3630 });
  });

  it('marks viewers read-only', () => {
    expect(buildServerStatus({ ...base, role: 'viewer' }).canWrite).toBe(false);
  });

  it('never reports negative uptime', () => {
    const s = buildServerStatus({ ...base, role: 'viewer', now: new Date('2026-10-14T10:00:00Z') });
    expect(s.uptimeSeconds).toBe(0);
  });
});

describe('speakServerStatus', () => {
  it.each(['viewer', 'responder'] as const)('stays within 30 words for a %s', (role) => {
    const speak = speakServerStatus(buildServerStatus({ ...base, role }));
    expect(countWords(speak)).toBeLessThanOrEqual(30);
    expect(speak.startsWith('Nightshift is online.')).toBe(true);
  });
});
