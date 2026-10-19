/**
 * Server-side enforcement of "prepare → ask the human → confirm" for the agent
 * (on top of Nightshift's own checks). The model can only confirm what this
 * session prepared, in an earlier turn, when the person's latest words are an
 * explicit yes. A card's Confirm button is itself the explicit yes.
 */

const NO = /\b(no|nope|don'?t|do not|stop|wait|cancel|hold on|not yet|abort|never ?mind)\b/i;
const YES =
  /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|confirm(ed)?|do it|go ahead|go for it|please do|proceed|affirmative|absolutely|correct)\b/i;

/** "Yes", "yes, do it", "go ahead please" → true; "yes but wait", "no", "what?" → false. */
export function isExplicitYes(utterance: string): boolean {
  const u = utterance.trim();
  return YES.test(u) && !NO.test(u);
}

export function isNo(utterance: string): boolean {
  return NO.test(utterance.trim()) && !YES.test(utterance.trim());
}

export type ConfirmDecision = { ok: true } | { ok: false; reason: string };

/**
 * May the MODEL call confirm_action now?
 * @param prepared confirmation ids this session got from prepare_action → turn prepared in
 */
export function checkAgentConfirm(opts: {
  confirmationId: unknown;
  prepared: ReadonlyMap<string, number>;
  currentTurn: number;
  utterance: string;
}): ConfirmDecision {
  const id = typeof opts.confirmationId === 'string' ? opts.confirmationId : '';
  const preparedTurn = opts.prepared.get(id);
  if (preparedTurn === undefined) {
    return {
      ok: false,
      reason: 'Nothing was prepared with that id in this conversation. Prepare the action first.',
    };
  }
  if (preparedTurn >= opts.currentTurn) {
    return {
      ok: false,
      reason: 'Ask the person first: tell them what will change and wait for their yes.',
    };
  }
  if (!isExplicitYes(opts.utterance)) {
    return { ok: false, reason: 'The person has not clearly said yes. Ask them first.' };
  }
  return { ok: true };
}
