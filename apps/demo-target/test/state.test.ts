import { describe, expect, it } from 'vitest';
import { DemoState } from '../src/state.ts';

describe('bad_deploy', () => {
  it('breaks razorpay only after the delay, then reset clears it', () => {
    const clock = { now: 1_000_000 };
    const state = new DemoState(() => clock.now);
    state.enable('bad_deploy', { delaySeconds: 60 });

    expect(state.isProviderDown('razorpay')).toBe(false);
    expect(state.snapshot()).toMatchObject({
      scenarios: ['bad_deploy'],
      downProviders: [],
      badDeployFailsAt: new Date(1_060_000).toISOString(),
    });

    clock.now += 59_999;
    expect(state.isProviderDown('razorpay')).toBe(false);
    clock.now += 1;
    expect(state.isProviderDown('razorpay')).toBe(true);
    expect(state.isProviderDown('stripe')).toBe(false);

    state.reset();
    expect(state.isProviderDown('razorpay')).toBe(false);
    expect(state.snapshot()).not.toHaveProperty('badDeployFailsAt');
  });

  it('defaults to a 60 second delay', () => {
    const clock = { now: 0 };
    const state = new DemoState(() => clock.now);
    state.enable('bad_deploy');
    clock.now = 59_000;
    expect(state.isProviderDown('razorpay')).toBe(false);
    clock.now = 60_000;
    expect(state.isProviderDown('razorpay')).toBe(true);
  });
});

describe('rollback and restart', () => {
  it('rolling back from the bad version stops the bad_deploy failure', () => {
    const clock = { now: 0 };
    const state = new DemoState(() => clock.now);
    state.enable('bad_deploy', { delaySeconds: 0 });
    expect(state.snapshot()).toMatchObject({ version: 'v1.4.2', downProviders: ['razorpay'] });

    state.rollbackTo('v1.4.1');
    expect(state.snapshot()).toMatchObject({
      version: 'v1.4.1',
      scenarios: [],
      downProviders: [],
    });
  });

  it('a rollback does not fix an unrelated provider outage', () => {
    const state = new DemoState();
    state.enable('provider_outage');
    state.rollbackTo('v1.4.0');
    expect(state.isProviderDown('razorpay')).toBe(true);
  });

  it('restart makes the service unavailable for 5 s, then normal', () => {
    const clock = { now: 1000 };
    const state = new DemoState(() => clock.now);
    state.restart();
    expect(state.isRestarting()).toBe(true);
    clock.now += 4999;
    expect(state.isRestarting()).toBe(true);
    clock.now += 1;
    expect(state.isRestarting()).toBe(false);
  });
});
