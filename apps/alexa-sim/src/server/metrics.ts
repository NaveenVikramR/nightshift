/**
 * CloudWatch custom metrics, inside the free tier: namespace Nightshift, no
 * dimensions, five metrics, one PutMetricData per turn (or card tap). Counts
 * only, never content. Fire-and-forget: a failure is logged and never breaks a turn.
 */
import { awsClientConfig } from './awsClient';
import {
  CloudWatchClient,
  PutMetricDataCommand,
  type PutMetricDataCommandOutput,
} from '@aws-sdk/client-cloudwatch';
import { log } from './log';

export const NAMESPACE = 'Nightshift';

export interface TurnMetrics {
  AgentTurns: number;
  ToolCalls: number;
  GuardrailBlocks: number;
  ModelErrors: number;
  PollyCharacters: number;
}

export interface Metrics {
  record(m: TurnMetrics): void;
}

export class NoMetrics implements Metrics {
  record(): void {}
}

/** The one SDK method we use (a fake implements it in tests). */
export interface PutMetricSender {
  send(command: PutMetricDataCommand): Promise<PutMetricDataCommandOutput>;
}

export class CloudWatchMetrics implements Metrics {
  failures = 0;

  constructor(
    private readonly client: PutMetricSender,
    private readonly now: () => number = Date.now,
  ) {}

  static fromRegion(region: string): CloudWatchMetrics {
    return new CloudWatchMetrics(new CloudWatchClient(awsClientConfig(region)));
  }

  record(m: TurnMetrics): void {
    const at = new Date(this.now());
    const command = new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: (Object.keys(m) as (keyof TurnMetrics)[]).map((name) => ({
        MetricName: name,
        Value: m[name],
        Unit: 'Count',
        Timestamp: at,
      })),
    });
    this.client.send(command).catch((err: unknown) => {
      this.failures++;
      log.warn('cloudwatch put failed', {
        error: err instanceof Error ? err.name : 'unknown',
        failures: this.failures,
      });
    });
  }
}
