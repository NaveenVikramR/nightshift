# Feature requests (top 5)

## 1. Proactive Alexa+ announcements from MCP servers — **Critical**

An MCP server can't make Alexa+ speak unprompted. For on-call, the most important moment is "an
alert just fired", and today the assistant can only answer once someone asks. We push to Telegram
instead ("🔴 Critical: … Ask Alexa: what's wrong?"), which breaks the voice-first experience.

**Request:** a permissioned notification path. The MCP server sends a short, server-written
announcement; the user opts in per skill or server; quiet hours and rate limits apply. Alexa+
reads it, or shows it on an Echo Show with a "what's wrong?" follow-up.

## 2. A small default Bedrock quota for new and free-plan accounts — **Critical**

On our free-plan project, all 62 on-demand token quotas are 0 and "not adjustable", including the
cross-Region profile. The first call fails with a misleading "Too many tokens per day" (FL-31).
First-time builders can't tell whether to wait, upgrade or open a case.

**Request:**

- a small default quota (a few requests per minute on one small model in the project's Region),
  or a clear "upgrade or request access to unlock" error;
- the reason shown in Service Quotas;
- a self-service request for one model.

## 3. A way for third-party developers to test against real Alexa+ — **Important**

There's no way to connect an MCP server to real Alexa+ as a third-party developer today, so we
built a simulated Alexa+: a real MCP client with an agent loop, Polly and cards. Judges and
builders can't verify how Alexa+ actually chooses tools, handles multi-turn confirmation, or
reconnects sessions.

**Request:** a developer sandbox or test console where an MCP server can be connected to Alexa+
and tried by voice and on an Echo Show. Also document Alexa+'s MCP client behaviour: session reuse
across turns, which MCP Apps features it supports, and its timeouts.

## 4. One hook for every `tools/call` in the MCP TypeScript SDK — **Important**

Security tools must audit every call, including invalid arguments and unknown tools. Today the SDK
rejects those before any server code runs, so we needed a pass-through schema and an HTTP-level tap
(FL-08).

**Request:** `onToolCall({ name, arguments, outcome, error, ctx })` for every call, or
`validateInput: false` on `registerTool`.

## 5. Per-item verdicts in `ApplyGuardrail` — **Nice-to-have**

We check several untrusted texts from one tool result (commit messages, annotations) in one call,
to save cost. When the guardrail intervenes we can't tell which text tripped it, so we withhold all
of them.

**Request:** return an assessment per `content` item (or an index on each finding), so a guardrail
can withhold only the flagged text.
