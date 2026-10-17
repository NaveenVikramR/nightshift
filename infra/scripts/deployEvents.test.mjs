// node --test infra/scripts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { badDeployEvent, baselineEvent, reportDeploy, resetEvent } from './deployEvents.mjs';

const NOW = new Date('2026-10-18T10:00:00Z');

function stubFetch(status = 201, body = { id: 'x', created: true }) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    },
  };
}

test('reset reports the restored baseline version', () => {
  assert.deepEqual(resetEvent(NOW), {
    service: 'payments-api',
    version: 'v1.4.1',
    commitMessage: 'chaos reset: restore baseline',
    author: 'chaos-reset',
    externalId: `chaos-reset-${NOW.getTime()}`,
  });
});

test('baseline is idempotent per day and dated two hours back; bad deploy ships v1.4.2', () => {
  assert.equal(baselineEvent(NOW).externalId, 'chaos-baseline-v1.4.1-2026-10-18');
  assert.equal(baselineEvent(NOW).deployedAt, '2026-10-18T08:00:00.000Z');
  assert.equal(badDeployEvent(NOW).version, 'v1.4.2');
});

test('reportDeploy POSTs the event with the ingest token', async () => {
  const { calls, fetchImpl } = stubFetch();
  const answer = await reportDeploy({
    fetchImpl,
    url: 'http://nightshift.test',
    token: 'nsi_x',
    event: resetEvent(NOW),
  });
  assert.deepEqual(answer, { id: 'x', created: true });
  assert.equal(calls[0].url, 'http://nightshift.test/events/deploy');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer nsi_x');
  assert.equal(JSON.parse(calls[0].init.body).version, 'v1.4.1');
});

test('reportDeploy rejects on a refusal or an unreachable server', async () => {
  await assert.rejects(
    reportDeploy({
      ...stubFetch(401, { error: 'unauthorized' }),
      url: 'http://n.test',
      token: 't',
      event: {},
    }),
    /refused the deploy event \(401\)/,
  );
  await assert.rejects(
    reportDeploy({
      fetchImpl: async () => {
        throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      },
      url: 'http://n.test',
      token: 't',
      event: {},
    }),
    /Could not reach Nightshift at http:\/\/n.test \(ECONNREFUSED\)/,
  );
});
