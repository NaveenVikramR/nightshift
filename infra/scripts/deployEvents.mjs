// Deploy events the chaos scripts report to Nightshift (POST /events/deploy),
// exactly like a CI system would. Shared by bad_deploy and reset.

export const SERVICE = 'payments-api';

/** The version running before bad_deploy. Once per day, dated two hours back. */
export function baselineEvent(now = new Date()) {
  return {
    service: SERVICE,
    version: 'v1.4.1',
    commitMessage: 'stable payments release',
    author: 'ci',
    externalId: `chaos-baseline-v1.4.1-${now.toISOString().slice(0, 10)}`,
    deployedAt: new Date(now.getTime() - 2 * 60 * 60_000).toISOString(),
  };
}

export function badDeployEvent(now = new Date()) {
  return {
    service: SERVICE,
    version: 'v1.4.2',
    commitMessage: 'tune payment retry config',
    author: 'ci',
    externalId: `chaos-bad-deploy-${now.getTime()}`,
  };
}

/**
 * reset puts demo-target back on v1.4.1. Only a real version change is a deploy:
 * resetting while already on v1.4.1 must not record one (it would look like a
 * fresh deploy to the correlation rules).
 */
export function resetChangesVersion(stateBefore) {
  return typeof stateBefore?.version === 'string' && stateBefore.version !== 'v1.4.1';
}

/** reset puts demo-target back on v1.4.1; the deploy history must say so too. */
export function resetEvent(now = new Date()) {
  return {
    service: SERVICE,
    version: 'v1.4.1',
    commitMessage: 'chaos reset: restore baseline',
    author: 'chaos-reset',
    externalId: `chaos-reset-${now.getTime()}`,
  };
}

/**
 * POST one deploy event. Resolves with Nightshift's JSON answer; rejects with
 * a readable Error on network failure or a non-2xx answer.
 */
export async function reportDeploy({ fetchImpl = fetch, url, token, event }) {
  let res;
  try {
    res = await fetchImpl(`${url}/events/deploy`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch (err) {
    throw new Error(
      `Could not reach Nightshift at ${url} (${err.cause?.code ?? err.message}). Is it running?`,
    );
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`Nightshift refused the deploy event (${res.status}): ${body}`);
  return JSON.parse(body);
}
