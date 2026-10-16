import { describe, expect, it } from 'vitest';
import { collectEvidence } from '../../src/domain/correlation/evidence.js';
import { allowedTokens, validateNarration } from '../../src/domain/correlation/narrator.js';
import { diagnose } from '../../src/domain/correlation/rules.js';
import { fakeToolDeps, NOW, TEST_SERVICES } from '../fakes/toolDeps.js';
import { applyScenario } from '../fixtures/scenarios.js';

async function badDeploy() {
  const f = fakeToolDeps();
  applyScenario(f, 'bad_deploy');
  return diagnose(await collectEvidence(TEST_SERVICES[0]!, f.deps, { end: NOW }));
}
const ctx = { now: NOW, timeZone: 'UTC' };

describe('narration guard', () => {
  it('allows the facts in their spoken units only', async () => {
    const allowed = allowedTokens(await badDeploy(), ctx);
    // error ratio as a percent, deploy and breaker clock times, the version, minutes elapsed
    for (const t of ['45', '11:55', '11:56', '1.4.2', '5', '4', '3']) expect(allowed).toContain(t);
    // timestamps are dates, not loose digits; confidences are not speakable
    for (const t of ['2026', '90', '84', '0.45']) expect(allowed).not.toContain(t);
  });

  it('accepts a faithful rephrasing and rejects an invented figure', async () => {
    const d = await badDeploy();
    expect(
      validateNarration(
        'Critical: errors at 45 percent since the 11:55 deploy, version 1.4.2.',
        d,
        ctx,
      ),
    ).toEqual({ ok: true });
    expect(validateNarration('Critical: errors at 97 percent.', d, ctx)).toEqual({
      ok: false,
      reason: 'unsupported_number:97',
    });
    expect(validateNarration('Critical since 2026.', d, ctx)).toEqual({
      ok: false,
      reason: 'unsupported_number:2026',
    });
  });
});
