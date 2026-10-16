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
