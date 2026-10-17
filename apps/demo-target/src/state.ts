export const SCENARIOS = [
  'provider_outage',
  'latency_spike',
  'auth_bruteforce',
  'webhook_spoofing',
  'bad_deploy',
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export const PROVIDERS = ['razorpay', 'stripe'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** provider_outage and bad_deploy always take down this provider. */
export const OUTAGE_PROVIDER: Provider = 'razorpay';

/** The version running before bad_deploy, and the bad one it ships. */
export const BASELINE_VERSION = 'v1.4.1';
export const BAD_VERSION = 'v1.4.2';
export const VERSION_PATTERN = /^v?\d+(\.\d+){1,3}$/;

/** restart: how long the service is unavailable while it comes back. */
export const RESTART_MS = 5000;

/** bad_deploy: seconds between the deploy and the failure (default and bounds). */
export const BAD_DEPLOY_DELAY = { default: 60, min: 0, max: 300 } as const;

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
  /** bad_deploy: when the bad config starts breaking razorpay calls (epoch ms). */
  badDeployFailsAt: number | null = null;
  currentVersion: string = BASELINE_VERSION;
  /** restart: payments answers 503 and /readyz is not ready until then (epoch ms). */
  restartingUntil: number | null = null;

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  enable(scenario: Scenario, opts: { delaySeconds?: number } = {}): void {
    this.active.add(scenario);
    if (scenario === 'bad_deploy') {
      const delay = opts.delaySeconds ?? BAD_DEPLOY_DELAY.default;
      this.badDeployFailsAt = this.now() + delay * 1000;
      this.currentVersion = BAD_VERSION;
    }
  }

  /**
   * Deploy another version. Leaving the bad version reverts its config, so the
   * bad_deploy failure stops (the admin API's "rollback").
   */
  rollbackTo(version: string): void {
    this.currentVersion = version;
    if (version !== BAD_VERSION) {
      this.active.delete('bad_deploy');
      this.badDeployFailsAt = null;
    }
  }

  /** Simulated restart: ~5 s of unavailability. Scenarios are not cleared (a restart fixes nothing). */
  restart(): void {
    this.restartingUntil = this.now() + RESTART_MS;
  }

  isRestarting(): boolean {
    return this.restartingUntil !== null && this.now() < this.restartingUntil;
  }

  reset(): void {
    this.active.clear();
    this.activeProvider = 'razorpay';
    this.badDeployFailsAt = null;
    this.currentVersion = BASELINE_VERSION;
    this.restartingUntil = null;
  }

  routeTo(provider: Provider): void {
    this.activeProvider = provider;
  }

  isProviderDown(provider: Provider): boolean {
    if (provider !== OUTAGE_PROVIDER) return false;
    if (this.active.has('provider_outage')) return true;
    return this.badDeployFailsAt !== null && this.now() >= this.badDeployFailsAt;
  }

  snapshot() {
    return {
      scenarios: [...this.active].sort(),
      activeProvider: this.activeProvider,
      downProviders: PROVIDERS.filter((p) => this.isProviderDown(p)),
      version: this.currentVersion,
      restarting: this.isRestarting(),
      ...(this.badDeployFailsAt !== null && {
        badDeployFailsAt: new Date(this.badDeployFailsAt).toISOString(),
      }),
    };
  }
}
