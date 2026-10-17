import type { ActionName, ResolvedAction } from '../types.js';

/** Live state of the target system, as far as its executor can tell. */
export interface TargetState {
  /** Provider currently receiving traffic, when the target reports it. */
  activeProvider: string | null;
  /** Version currently running, when the target reports it. */
  version: string | null;
  restarting: boolean;
}

export interface ExecutionResult {
  /** Small, non-secret description of what the target answered (stored on the action). */
  detail: Record<string, string | number | boolean | null>;
}

/**
 * Performs one allowlisted action against one configured target. Throws a
 * ClientError on any failure (never reports success it didn't get).
 */
export interface ActionExecutor {
  readonly name: string;
  readonly type: 'admin_api' | 'github_workflow';
  supports(action: ActionName): boolean;
  /** null when this executor can't report live state (e.g. a workflow dispatch). */
  state(service: string): Promise<TargetState | null>;
  execute(action: ResolvedAction): Promise<ExecutionResult>;
}
