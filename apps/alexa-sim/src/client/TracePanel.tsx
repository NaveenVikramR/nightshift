'use client';
import type { TraceEntry } from './api';

const STEP: Record<NonNullable<TraceEntry['confirmation']>['step'], string> = {
  prepared: 'Prepared — waiting for your yes',
  human_yes: 'You said yes',
  confirmed: 'Confirmed and executed once',
  refused: 'Refused — no yes from you yet',
};

const pct = (v: number | null) =>
  v === null ? '–' : `${v * 100 < 1 && v > 0 ? (v * 100).toFixed(1) : Math.round(v * 100)}%`;

/** "What Nightshift did": every tool call, inputs (redacted), the confirmation step and the verification. */
const NOT_TOOLS = new Set(['human', 'model', 'guardrail']);

const LABEL: Record<string, string> = { human: 'you', model: 'model', guardrail: 'guardrail' };

export function TracePanel({
  trace,
  model,
  guardrail,
}: {
  trace: TraceEntry[];
  model: string;
  guardrail: string | null;
}) {
  const turns = new Map<number, TraceEntry[]>();
  for (const e of trace) turns.set(e.turn, [...(turns.get(e.turn) ?? []), e]);
  return (
    <details className="trace">
      <summary>
        What Nightshift did{' '}
        <span className="muted small">
          ({trace.filter((e) => !NOT_TOOLS.has(e.tool)).length} calls)
        </span>
      </summary>
      <p className="muted small">
        Model: {model}. Every tool call below went through the Nightshift MCP server.{' '}
        {guardrail
          ? `Outside text in tool results is checked by ${guardrail} before the model sees it.`
          : 'No guardrail configured.'}{' '}
        Inputs are shown with secrets masked; token counts only, never content.
      </p>
      {trace.length === 0 ? <p className="muted">Nothing yet.</p> : null}
      <ol className="trace-turns">
        {[...turns.entries()].reverse().map(([turn, entries]) => (
          <li key={turn}>
            <p className="trace-turn">Turn {turn}</p>
            <ul>
              {entries.map((e, i) => (
                <li key={i} className={`trace-entry trace-${e.outcome}`}>
                  <p>
                    <span className="trace-tool">{LABEL[e.tool] ?? e.tool}</span>
                    <span className="trace-source">
                      {e.source === 'card'
                        ? 'card button'
                        : e.source === 'demo'
                          ? 'demo control'
                          : 'agent'}
                    </span>
                    <span className={`trace-outcome outcome-${e.outcome}`}>{e.outcome}</span>
                  </p>
                  {Object.keys(e.input).length ? (
                    <code className="trace-input">{JSON.stringify(e.input)}</code>
                  ) : null}
                  {e.confirmation ? (
                    <p className="trace-step">{STEP[e.confirmation.step]}</p>
                  ) : null}
                  {e.verification ? (
                    <p className="trace-step">
                      Verified: {e.verification.outcome.replace('_', ' ')}, errors{' '}
                      {pct(e.verification.before)} → {pct(e.verification.after)}
                    </p>
                  ) : null}
                  {e.note ? <p className="muted small">{e.note}</p> : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </details>
  );
}
