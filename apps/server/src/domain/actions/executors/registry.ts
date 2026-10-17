import type { FetchLike } from '../../../clients/errors.js';
import type { ServiceConfig, ServiceDef } from '../../../serviceConfig.js';
import type { ActionName } from '../types.js';
import { AdminApiExecutor } from './adminApi.js';
import { GitHubWorkflowExecutor } from './githubWorkflow.js';
import type { ActionExecutor } from './types.js';

/**
 * Executors from nightshift.yaml, looked up per service and action. Anything
 * not configured has no executor and is refused (invariant 3).
 */
export class ExecutorRegistry {
  constructor(private readonly executors: ReadonlyMap<string, ActionExecutor>) {}

  static fromConfig(
    catalog: Pick<ServiceConfig, 'executors' | 'github'>,
    env: NodeJS.ProcessEnv,
    fetchImpl?: FetchLike,
  ): ExecutorRegistry {
    const map = new Map<string, ActionExecutor>();
    for (const [name, cfg] of Object.entries(catalog.executors)) {
      const token = env[cfg.tokenEnv] || undefined;
      map.set(
        name,
        cfg.type === 'admin_api'
          ? new AdminApiExecutor(name, cfg.url, token, cfg.timeoutMs, fetchImpl)
          : new GitHubWorkflowExecutor(
              name,
              {
                apiUrl: catalog.github.apiUrl,
                repo: cfg.repo,
                workflow: cfg.workflow,
                ref: cfg.ref,
                token,
                timeoutMs: cfg.timeoutMs,
              },
              fetchImpl,
            ),
      );
    }
    return new ExecutorRegistry(map);
  }

  /** The executor allowed to run `action` on `service`, or undefined (refuse). */
  for(service: ServiceDef, action: ActionName): ActionExecutor | undefined {
    const cfg = service.actions[action];
    const executor = cfg ? this.executors.get(cfg.executor) : undefined;
    return executor?.supports(action) ? executor : undefined;
  }

  /** Names of executors whose token env var is missing (for a startup warning). */
  static missingTokens(
    catalog: Pick<ServiceConfig, 'executors'>,
    env: NodeJS.ProcessEnv,
  ): string[] {
    return Object.entries(catalog.executors)
      .filter(([, cfg]) => !env[cfg.tokenEnv])
      .map(([name, cfg]) => `${name} (${cfg.tokenEnv})`);
  }
}
