export const SCENARIOS = [
  'provider_outage',
  'latency_spike',
  'auth_bruteforce',
  'webhook_spoofing',
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const PROVIDERS = ['razorpay', 'stripe'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** provider_outage always takes down this provider. */
export const OUTAGE_PROVIDER: Provider = 'razorpay';

export function isScenario(value: unknown): value is Scenario {
  return typeof value === 'string' && (SCENARIOS as readonly string[]).includes(value);
}

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

/** Mutable chaos state shared by the traffic generator and the admin API. */
export class DemoState {
  readonly active = new Set<Scenario>();
  activeProvider: Provider = 'razorpay';

  enable(scenario: Scenario): void {
    this.active.add(scenario);
  }

  reset(): void {
    this.active.clear();
    this.activeProvider = 'razorpay';
  }

  routeTo(provider: Provider): void {
    this.activeProvider = provider;
  }

  isProviderDown(provider: Provider): boolean {
    return this.active.has('provider_outage') && provider === OUTAGE_PROVIDER;
  }

  snapshot() {
    return {
      scenarios: [...this.active].sort(),
      activeProvider: this.activeProvider,
      downProviders: PROVIDERS.filter((p) => this.isProviderDown(p)),
    };
  }
}
