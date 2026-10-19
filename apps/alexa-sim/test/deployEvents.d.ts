// Types for the shared chaos deploy-event helpers (infra/scripts/deployEvents.mjs).
declare module '*deployEvents.mjs' {
  type DeployEvent = Record<string, unknown>;
  export function baselineEvent(now?: Date): DeployEvent;
  export function badDeployEvent(now?: Date): DeployEvent;
  export function resetEvent(now?: Date): DeployEvent;
}
