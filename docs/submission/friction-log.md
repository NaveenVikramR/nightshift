# Friction log (top 12)

These 12 entries are selected from the full log in [docs/friction-log.md](../friction-log.md),
which has 32 entries. Times are approximate and versions exact. They are ordered by impact.

## 1. Every Bedrock on-demand quota is 0 ("not adjustable") on a free-plan project (FL-31)

- **Product:** Amazon Bedrock, Service Quotas; a new AWS experience project on the free plan;
  ap-southeast-2.
- **Task:** Run our voice agent on Amazon Nova Lite (Converse with tool use).
- **Steps:**
  1. Called Converse on `amazon.nova-lite-v1:0` with 5 max tokens. Model access showed
     `AUTHORIZED`.
  2. Ran `aws service-quotas list-service-quotas --service-code bedrock --region ap-southeast-2`.
- **Expected:** Bedrock is on the free plan's supported-services list and the model is
  authorized, so small calls should work.
- **Actual:**
  - The first call ever returned `ThrottlingException: Too many tokens per day`.
  - All 62 on-demand token quotas are `0.0` and `Adjustable: False`, including Nova Lite
    L-70423BF8, L-E386A278 and L-45E0AD92.
  - The cross-Region `apac.amazon.nova-lite-v1:0` quotas are also 0, while the AWS defaults are
    200 requests and 200K tokens per minute.
- **Severity:** Blocker.
- **Workaround:** Opened a support case. The model provider is now chosen by config (Groq for
  now). Guardrails, Polly and CloudWatch run live.
- **Suggestion:** Return a distinct error ("on-demand quota for this model is 0 in this
  account"), document free-plan quotas, and offer a self-service request for one model in the
  project's Region.

## 2. Account verification blocks Bedrock inference with no warning (FL-30)

- **Product:** Amazon Bedrock Runtime (Converse); AWS SDK for JavaScript 3.1152.0.
- **Task:** First Converse call right after creating IAM roles, a guardrail and a budget.
- **Steps:** IAM, Budgets and `CreateGuardrail` succeeded, and `get-foundation-model-availability`
  said `AUTHORIZED`. Then we called `ConverseCommand`.
- **Expected:** A model reply.
- **Actual:** `AccessDeniedException: Your account is currently being verified. Verification
normally takes less than 2 hours.` Nothing in the console or the availability API said so.
- **Severity:** Medium.
- **Workaround:** Waited about an hour and kept coding against fake clients.
- **Suggestion:** Show "verification pending" in `get-foundation-model-availability` and on the
  model access page.

## 3. The SDK's recommended entry point can't serve MCP 2025-11-25 with sessions (FL-01)

- **Product:** MCP TypeScript SDK `@modelcontextprotocol/server` 2.3.1, `/node` 2.1.1.
- **Task:** Serve spec 2025-11-25 over Streamable HTTP, with `MCP-Session-Id` and GET SSE.
- **Steps:** Read the installed types and found `createMcpHandler` and its `legacy` option.
- **Expected:** One recommended entry point for the spec revision a project targets.
- **Actual:** `createMcpHandler` targets 2026-07-28. It serves 2025-era clients only statelessly
  (GET and DELETE return 405), while `LATEST_PROTOCOL_VERSION` is still `2025-11-25`.
- **Severity:** Medium.
- **Workaround:** Used the stateful `NodeStreamableHTTPServerTransport` with our own session map.
- **Suggestion:** Add a "which serving API for which spec revision" table to the README.

## 4. Tool-argument validation and unknown-tool errors happen before any server hook (FL-08)

- **Product:** MCP TypeScript SDK 2.3.1 (`McpServer`).
- **Task:** Write an audit row for every `tools/call`, including invalid arguments and unknown
  tools.
- **Steps:** Registered tools with zod schemas, then called one with an out-of-range value and
  one with an unknown name. No audit rows appeared.
- **Expected:** A hook that sees every `tools/call` with its outcome.
- **Actual:** The SDK rejects these calls before any server code runs. The only alternative is
  replacing the whole `tools/call` handler.
- **Severity:** Medium.
- **Workaround:** A pass-through Standard Schema (the listing still shows the real schema;
  validation is ours), plus an HTTP-level audit tap for unknown tools.
- **Suggestion:** Add `onToolCall({ name, arguments, outcome, error })` or `validateInput: false`.

## 5. Prisma + `adapter-pg` hangs and blocks the event loop when Postgres refuses the connection (FL-16)

- **Product:** Prisma ORM 7.10.0, `@prisma/adapter-pg` 7.10.0, Node 24.
- **Task:** Fail fast at startup when the database is unreachable.
- **Steps:** Ran `$queryRaw\`SELECT 1\`` against a port with nothing listening, with a 20 s
  watchdog timer.
- **Expected:** A rejection within a second.
- **Actual:** The promise never settled and the watchdog never fired. The container sat at 100%
  CPU without logging. Plain `pg` rejected in 8 ms with `ECONNREFUSED`.
- **Severity:** High.
- **Workaround:** Probe with a plain `pg.Client` before creating Prisma.
- **Suggestion:** Treat `ECONNREFUSED` as a terminal connection error, and add a regression test.

## 6. Prisma's generator picks import extensions from whether a tsconfig exists (FL-15)

- **Product:** Prisma ORM 7.10.0 (`prisma-client` generator), Docker multi-stage build.
- **Task:** Run the compiled server in a production image.
- **Steps:** `npm ci` (which runs `prisma generate`) before copying the tsconfig, then `tsc`.
- **Expected:** The same client as locally.
- **Actual:** At runtime: `ERR_MODULE_NOT_FOUND … enums.ts`. Without a tsconfig the generator
  emitted `.ts` specifiers, and nothing failed at build time.
- **Severity:** High.
- **Workaround:** Set `moduleFormat = "esm"` and `importFileExtension = "js"` explicitly.
- **Suggestion:** Make the output deterministic, or log the inferred settings on every generate.

## 7. basic-host calls every tool twice, and the second result replaces the first (FL-23)

- **Product:** `@modelcontextprotocol/ext-apps` examples/basic-host (React 19 StrictMode).
- **Task:** Incident card → Fail over → confirmation card → Confirm.
- **Steps:** Opened the host with `call=true` and clicked the card's button.
- **Expected:** One `tools/call` per user action.
- **Actual:**
  - Every tool was called twice.
  - A late duplicate result re-rendered the card over the confirmation.
  - For the security scan, the duplicate hit our 1-per-minute limit.
- **Severity:** Medium.
- **Workaround:** A result gate in the cards. Server-side, `confirm_action` was already
  single-use and idempotent.
- **Suggestion:** Guard the auto-call against double effects, and document that Views may get
  duplicate results.

## 8. Next.js 16 proxy matchers miss the basePath root, so the CSP silently disappears (FL-25)

- **Product:** Next.js 16.4.2 (`proxy.ts`, `basePath: '/alexa'`).
- **Task:** A per-request nonce CSP on every page, following the official guide.
- **Steps:** Copied the guide's matcher, set `basePath`, and requested `/alexa`.
- **Expected:** A `Content-Security-Policy` header.
- **Actual:** No header and no error. Matchers are prefixed with `basePath`, so the root page
  never matches.
- **Severity:** Medium (a security header silently missing).
- **Workaround:** Add `'/'` as its own matcher. The e2e test now checks for CSP violations.
- **Suggestion:** Mention `basePath` in the CSP guide, or warn when no route matches the proxy.

## 9. Groq returns `400 tool_use_failed` for some gpt-oss tool calls (FL-32)

- **Product:** Groq chat completions, `openai/gpt-oss-120b`.
- **Task:** Multi-turn tool calling (explain → prepare → confirm).
- **Steps:** Called the API with `tools`, `tool_choice: auto` and `parallel_tool_calls: false`.
- **Expected:** A tool call or text.
- **Actual:** About one turn in five returned HTTP 400 `tool_use_failed`. A retry usually
  succeeded.
- **Severity:** Medium.
- **Workaround:** One automatic retry. If a tool already answered, its grounded result is spoken.
- **Suggestion:** Re-sample server-side, or document the rate and the recommended retry.

## 10. Agent Toolkit for AWS crashes with a `'charmap' codec` error on Windows PowerShell (FL-29)

- **Product:** AWS CLI 2.38.3 (`aws agent-toolkit`), Windows 10, PowerShell 5.1.
- **Task:** The documented verification step: `aws agent-toolkit list-available-skills`.
- **Steps:** Ran `aws login`, then `configure agent-toolkit` (it succeeded), then the list
  command.
- **Expected:** A JSON list of skills.
- **Actual:** Exit 255: `'charmap' codec can't encode character '→'`.
- **Severity:** Medium.
- **Workaround:** `$env:PYTHONUTF8='1'`.
- **Suggestion:** Write UTF-8 output, or add the step to the troubleshooting guide.

## 11. SDK bearer auth rejects tokens without `expiresAt`, even static API keys (FL-05)

- **Product:** MCP TypeScript SDK 2.3.1 (`requireBearerAuth`, `OAuthTokenVerifier`).
- **Task:** Use the SDK's bearer auth with long-lived, hashed API tokens.
- **Steps:** Implemented `verifyAccessToken` and read its JSDoc.
- **Expected:** `expiresAt` optional, as the type says.
- **Actual:** Tokens without `expiresAt` are rejected. This is stated only in a comment.
- **Severity:** Low.
- **Workaround:** Stamp `expiresAt = now + 300 s` on each verification.
- **Suggestion:** Add an `allowNonExpiringTokens` option, or make the type match.

## 12. Alertmanager has no env substitution, and a secret mount inside the config mount fails (FL-17)

- **Product:** Prometheus Alertmanager 0.34.1 (Docker image), Docker Compose.
- **Task:** Give the webhook receiver a bearer token without committing it.
- **Steps:** Used `credentials_file`, and mounted the secret directory inside the read-only
  config mount.
- **Expected:** Both mounts work.
- **Actual:** `mkdirat …/etc/alertmanager/secrets: read-only file system`.
- **Severity:** Medium.
- **Workaround:** Mount the secrets at a sibling path, with the file readable by uid 65534.
- **Suggestion:** A full `credentials_file` example with a Docker/Kubernetes secret, noting that
  the image runs as `nobody`.
