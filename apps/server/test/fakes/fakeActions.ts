import { ClientError, type ClientErrorKind } from '../../src/clients/errors.js';
import type {
  NewPendingAction,
  PendingActionRecord,
  PendingActionStore,
} from '../../src/db/pendingActionStore.js';
import type {
  ActionExecutor,
  ExecutionResult,
  TargetState,
} from '../../src/domain/actions/executors/types.js';
import type { ActionName, ResolvedAction } from '../../src/domain/actions/types.js';

/** Scriptable target: holds state, applies actions to it, can fail. */
export class FakeExecutor implements ActionExecutor {
  readonly type = 'admin_api' as const;
  readonly executed: ResolvedAction[] = [];
  state_: TargetState = { activeProvider: 'razorpay', version: 'v1.4.2', restarting: false };
  failStateWith: ClientErrorKind | undefined;
  failExecuteWith: ClientErrorKind | undefined;
  /** Runs after a successful execute (e.g. make the fake metrics recover). */
  onExecute: ((a: ResolvedAction) => void) | undefined;
  /** Slows execute down so concurrent confirms really overlap. */
  executeDelayMs = 0;

  constructor(readonly name = 'demo-admin') {}

  supports(_action: ActionName): boolean {
    return true;
  }

  async state(): Promise<TargetState> {
    if (this.failStateWith) throw new ClientError('AdminApi', this.failStateWith);
    return { ...this.state_ };
  }

  async execute(a: ResolvedAction): Promise<ExecutionResult> {
    if (this.executeDelayMs) await new Promise((r) => setTimeout(r, this.executeDelayMs));
    if (this.failExecuteWith) throw new ClientError('AdminApi', this.failExecuteWith);
    this.executed.push(a);
    if (a.action === 'failover_provider') this.state_.activeProvider = a.to;
    if (a.action === 'rollback_deploy') this.state_.version = a.toVersion;
    this.onExecute?.(a);
    return { detail: { endpoint: a.action } };
  }
}

/** In-memory store with the same atomic-claim semantics as the Prisma one. */
export class InMemoryPendingActionStore implements PendingActionStore {
  readonly rows = new Map<string, PendingActionRecord>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(a: NewPendingAction) {
    const row: PendingActionRecord = {
      ...a,
      status: 'pending',
      usedAt: null,
      executedAt: null,
      result: null,
      verification: null,
      createdAt: this.now(),
    };
    this.rows.set(a.confirmationId, row);
    return { ...row };
  }

  async find(id: string) {
    const r = this.rows.get(id);
    return r ? { ...r } : undefined;
  }

  async claim(id: string, now: Date) {
    // Synchronous check-and-set: the JS equivalent of one conditional UPDATE.
    const r = this.rows.get(id);
    if (!r || r.status !== 'pending' || r.expiresAt <= now) return false;
    r.status = 'executing';
    r.usedAt = now;
    return true;
  }

  async finish(id: string, patch: Parameters<PendingActionStore['finish']>[1]) {
    const r = this.rows.get(id);
    if (!r) throw new Error(`no pending action ${id}`);
    Object.assign(r, patch);
  }

  async executedSince(since: Date) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.executedAt &&
          r.executedAt >= since &&
          (r.status === 'succeeded' || r.status === 'failed'),
      )
      .map((r) => r.executedAt!)
      .sort((a, b) => a.getTime() - b.getTime());
  }
}
