# Friction log

## FL-01: SDK's recommended HTTP entry point can't serve MCP 2025-11-25 with sessions

- **Date:** 2026-10-14
- **Product / tool:** MCP TypeScript SDK `@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/node` 2.1.1
- **Task attempted:** Serve MCP spec 2025-11-25 over Streamable HTTP with `MCP-Session-Id` sessions and a GET SSE stream, as the hackathon requires.
- **Steps taken:**
  1. Installed the four v2 packages and read the installed `.d.mts` types.
  2. Found `createMcpHandler(factory, options)`, the newest high-level serving entry.
  3. Read its `CreateMcpHandlerOptions.legacy` docs.
- **Expected:** One recommended entry point that can serve the spec revision a project targets, including 2025-era sessions.
- **Actual:** `createMcpHandler` targets protocol **2026-07-28** (per-request envelope). 2025-era traffic is served only by a _stateless_ fallback: "GET and DELETE (2025 session operations) are answered with `405` / `Method not allowed.`" (`legacy: 'stateless'`), or rejected entirely (`legacy: 'reject'`). Meanwhile `LATEST_PROTOCOL_VERSION` in `@modelcontextprotocol/core` is still `"2025-11-25"`, and many types carry `@deprecated Deprecated as of protocol version 2026-07-28`. It wasn't obvious which revision the SDK "is" on.
- **Severity:** Medium
- **Time lost:** ~30 minutes
- **Workaround:** Used the lower-level stateful `NodeStreamableHTTPServerTransport` (`sessionIdGenerator: () => randomUUID()`) with our own session map. Verified that an `initialize` asking for `2026-07-28` is answered with `2025-11-25`.
- **Suggestion:** Add a "Which serving API for which spec revision?" table to the server README: `createMcpHandler` for 2026-07-28 (+ stateless 2025), stateful transport for 2025-11-25 with sessions. Mention the 405 behaviour in the `createMcpHandler` JSDoc summary, not only in the option docs.

## FL-02: npm `latest` for Prisma is a release candidate, and the CLI nudges you to it

- **Date:** 2026-10-14
- **Product / tool:** Prisma CLI 7.10.0 / npm registry (`prisma` dist-tags)
- **Task attempted:** Install the current stable Prisma.
- **Steps taken:**
  1. `npm view prisma dist-tags` → `latest: 8.0.0-rc.22`, `prev: 7.10.0`.
  2. Installed `prisma@7.10.0` and `@prisma/client@7.10.0` explicitly.
  3. `npx prisma generate` printed an update box: `npm i @prisma/client@latest`.
- **Expected:** `latest` points to the newest stable release; the update notice recommends stable versions.
- **Actual:** `npm i prisma` would install an RC, and the CLI's own notice recommends upgrading a stable install to the RC.
- **Severity:** Low
- **Time lost:** ~10 minutes
- **Workaround:** Pinned 7.10.0 with `--save-exact`.
- **Suggestion:** Publish RCs under `next` only, and have the update notifier skip prerelease versions unless the installed version is itself a prerelease.

## FL-03: `prisma init` writes `prisma7.config.ts`, docs and examples say `prisma.config.ts`

- **Date:** 2026-10-14
- **Product / tool:** Prisma CLI 7.10.0 (`@prisma/config`)
- **Task attempted:** Create the Prisma 7 config file for a Postgres project.
- **Steps taken:** Ran `prisma init --datasource-provider postgresql --output ../src/generated/prisma --no-skills` in a scratch folder.
- **Expected:** `prisma.config.ts` (the name in the docs and most examples).
- **Actual:** It created `prisma7.config.ts`. Reading `@prisma/config` shows `prisma7.config.*` is searched first and `prisma.config.*` is treated as "legacy". Its "next steps" text also says "Configure your DATABASE_URL in prisma7.config.ts".
- **Severity:** Low
- **Time lost:** ~5 minutes
- **Workaround:** Kept `prisma7.config.ts`; noted it in CLAUDE.md.
- **Suggestion:** Document the rename (and the lookup order) in the Prisma config reference and the 7.x upgrade guide.

## FL-04: Exact Origin allowlisting needs custom middleware

- **Date:** 2026-10-14
- **Product / tool:** MCP TypeScript SDK `@modelcontextprotocol/express` 2.0.2, `@modelcontextprotocol/node` 2.1.1
- **Task attempted:** Validate the `Origin` header against an allowlist (spec: 403 if present and invalid).
- **Steps taken:**
  1. Looked for `allowedOrigins` on `WebStandardStreamableHTTPServerTransportOptions`: marked `@deprecated Use external middleware for origin validation instead.`
  2. Looked at the suggested middleware `originValidation(allowedOriginHostnames)` and `createMcpExpressApp({ allowedOrigins })`.
- **Expected:** An allowlist of full origins (`scheme://host:port`), which is what browsers send and what CORS uses.
- **Actual:** The SDK middleware is "port-agnostic, hostnames only", so `http://localhost:6274` in the allowlist also admits `http://localhost:9999` and `https://localhost`.
- **Severity:** Low
- **Time lost:** ~15 minutes
- **Workaround:** Kept the SDK guard (hostname level) and added a 20-line exact-origin middleware (`src/http/originGuard.ts`) with tests.
- **Suggestion:** Accept full origins in `originValidation` (treat entries containing `://` as exact matches), or document why hostname-only is enough.

## FL-05: SDK bearer auth rejects tokens without `expiresAt`, even for static API keys

- **Date:** 2026-10-14
- **Product / tool:** MCP TypeScript SDK `@modelcontextprotocol/server` 2.3.1 (`OAuthTokenVerifier`, `requireBearerAuth`)
- **Task attempted:** Use the SDK's `requireBearerAuth` with a verifier for long-lived, hashed API tokens.
- **Steps taken:** Implemented `OAuthTokenVerifier.verifyAccessToken`; read its JSDoc.
- **Expected:** `expiresAt` optional, as the `AuthInfo` type (`expiresAt?: number`) suggests.
- **Actual:** JSDoc: "bearer-auth verification rejects tokens whose `AuthInfo.expiresAt` is unset". Only visible in the comment; the type says optional.
- **Severity:** Low
- **Time lost:** ~10 minutes
- **Workaround:** The verifier stamps `expiresAt = now + 300 s` on each verification (tokens are re-verified on every request).
- **Suggestion:** Add an option such as `allowNonExpiringTokens: true`, or make the type reflect the requirement.

## FL-06: MCP Inspector CLI answers a 401 with an interactive-OAuth error

- **Date:** 2026-10-14
- **Product / tool:** MCP Inspector 2.11.0 (`--cli`)
- **Task attempted:** Check that the server rejects calls without a token.
- **Steps taken:** `npx @modelcontextprotocol/inspector@2.11.0 --cli http://127.0.0.1:3000/mcp --transport http --method tools/list` (no `--header`).
- **Expected:** A clear "401 Unauthorized" message.
- **Actual:** `{"error":{"code":"auth_required","message":"Interactive OAuth requires a TTY on stdin or stderr (or MCP_AUTO_OPEN_ENABLED=true). For CI/non-interactive runs use --stored-auth-only."}}`. It assumes every 401 means OAuth, which is misleading for servers that use static bearer tokens.
- **Severity:** Low
- **Time lost:** ~5 minutes
- **Workaround:** Pass `--header "Authorization: Bearer <token>"`.
- **Suggestion:** When the 401 challenge has no `resource_metadata` and OAuth discovery returns 404, report "Server returned 401; it may expect a static token, so pass --header".

## FL-07: Latest TypeScript (7.0) isn't supported by typescript-eslint

- **Date:** 2026-10-14
- **Product / tool:** TypeScript 7.0.2, typescript-eslint 8.71.2
- **Task attempted:** Set up strict TypeScript with ESLint.
- **Steps taken:** `npm i -D typescript` installed 7.0.2; `npm view typescript-eslint peerDependencies` → `typescript: ">=4.8.4 <6.1.0"`.
- **Expected:** The default `latest` toolchain to work together.
- **Actual:** Peer range mismatch, so TS 7 can't be used with typescript-eslint yet.
- **Severity:** Low
- **Time lost:** ~5 minutes
- **Workaround:** Pinned TypeScript 6.0.3.
- **Suggestion:** (typescript-eslint) publish a compatibility note for TS 7 in the README.

## FL-08: Tool-argument validation and unknown-tool errors happen before any server hook

- **Date:** 2026-10-16
- **Product / tool:** MCP TypeScript SDK `@modelcontextprotocol/server` 2.3.1 (`McpServer`)
- **Task attempted:** Write an audit-log row for every `tools/call`, including calls with malformed arguments or an unknown tool name (security requirement: audit everything).
- **Steps taken:**
  1. Registered tools with `server.registerTool(name, { inputSchema: zodSchema }, handler)` and audited inside the handler wrapper.
  2. Called a tool with `{ "minutes": 999 }` (schema max 240) and a non-existent tool name; found no audit rows.
  3. Read `dist/mcp-*.mjs`: the built-in `tools/call` handler runs `validateToolInput()` and turns a failure into `createToolError("Input validation error: …")` before the tool callback; an unknown name throws `ProtocolError(InvalidParams, "Tool X not found")`.
- **Expected:** A hook (e.g. `onToolCall` / `onToolError` / middleware) that sees every `tools/call` with its outcome, or an option to let the tool handle validation itself.
- **Actual:** No such hook. The only server-side alternative is replacing the whole `tools/call` handler via the low-level `server.setRequestHandler`, which also means re-implementing listing, output validation and result projection.
- **Severity:** Medium
- **Time lost:** ~40 minutes
- **Workaround:** Register each tool with a pass-through Standard Schema: `~standard.jsonSchema` delegates to zod (so `tools/list` still advertises the exact schema) and `~standard.validate` returns the value unchanged; our wrapper validates with zod and audits `invalid_input`. Unknown tools and HTTP-level refusals are audited by an Express middleware that inspects the parsed body and the response status (`src/http/toolCallAuditTap.ts`).
- **Suggestion:** Add an `McpServer` option such as `onToolCall({ name, arguments, outcome, error, ctx })` invoked for every `tools/call` (unknown tool, validation failure, handler error, success), or a `validateInput: false` flag on `registerTool`.

## FL-09: `createMcpExpressApp` guards can't be ordered with your own middleware

- **Date:** 2026-10-16
- **Product / tool:** MCP TypeScript SDK `@modelcontextprotocol/express` 2.0.2
- **Task attempted:** Run an audit middleware before the Host/Origin guards so 403 refusals of tool calls are logged too.
- **Steps taken:**
  1. Used `createMcpExpressApp({ host, allowedHosts, allowedOrigins, jsonLimit })`.
  2. Added `app.use('/mcp', auditTap)`; requests rejected by the SDK's Host/Origin check never reached it.
- **Expected:** A way to insert middleware before the built-in guards (e.g. a `before` hook), or documentation listing the exact middleware it installs so it can be rebuilt.
- **Actual:** The factory installs `express.json` and the guards app-wide during construction. Only the JSDoc hints at what is installed and in what order.
- **Severity:** Low
- **Time lost:** ~15 minutes
- **Workaround:** Built a plain Express app from the exported pieces in an explicit order: `express.json({limit})` → audit tap → `hostHeaderValidation()` / `localhostHostValidation()` → exact-origin guard → `requireBearerAuth()`.
- **Suggestion:** Document the middleware `createMcpExpressApp` installs (and its order) in the README, and accept an optional `beforeGuards: RequestHandler[]` option.

## FL-10: Docker Desktop came up on an empty data disk after the disk image location changed

- **Date:** 2026-10-16
- **Product / tool:** Docker Desktop 4.89.0 (Engine 29.7.2), WSL 2 backend, Windows 10
- **Task attempted:** Check that the local demo stack (demo-target, Prometheus, Alertmanager) was still healthy before an end-to-end test.
- **Steps taken:**
  1. Docker Desktop's disk image location setting was changed (`CustomWslDistroDir` → `D:\DockerDesktopWSL`). Data had been on that disk since September.
  2. Ran `docker ps`, `docker ps -a`, `docker images` and `docker volume ls`.
  3. Read the Docker Desktop logs (`%LOCALAPPDATA%\Docker\log`) and compared `docker_data.vhdx` timestamps.
- **Expected:** The same images, containers and volumes, or a clear warning that Docker was starting on a new, empty disk.
- **Actual:** All four commands returned nothing, as if everything had been deleted. Docker Desktop had created a new 1.6 GB `docker_data.vhdx` under `C:\Users\…\AppData\Local\Docker\wsl\disk` and was running on it. The original 5 GB disk sat untouched on D:. Nothing in the UI or CLI said which disk was active. A `docker system prune -a` 6 minutes earlier looked like the cause but wasn't (running containers survive it). After Docker Desktop quit and restarted, it used the D: disk again and everything reappeared.
- **Severity:** High
- **Time lost:** ~90 minutes
- **Workaround:** Restarted Docker Desktop, which picked up the original disk. Added `npm run stack:status` (container health + port probes) and a preflight to `npm run test:integration` that prints `stack not running (…) — run npm run stack:up` instead of three skipped tests.
- **Suggestion:** When Docker Desktop starts on a data disk that is new or different from the last run, show it in the dashboard and in `docker info` (e.g. `Data disk: C:\…\docker_data.vhdx (created just now)`), and offer to move the existing disk instead of starting empty.

## FL-11: `prisma migrate diff --from-migrations` needs a shadow database, and the error names the wrong config file

- **Date:** 2026-10-17
- **Product / tool:** Prisma CLI 7.10.0
- **Task attempted:** Generate the SQL for a new migration without a running database (same approach as the first migration).
- **Steps taken:**
  1. Edited `prisma/schema.prisma` (new `DeployEvent` model).
  2. Ran `npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script`.
- **Expected:** The SQL difference between the existing migrations and the edited schema.
- **Actual:** ``Error: You must set `datasource.shadowDatabaseUrl` in your `prisma.config.ts` if you want to diff a migrations directory.`` The loaded config file is `prisma7.config.ts` (the name `prisma init` itself writes, see FL-03), so the message points at a file that doesn't exist.
- **Severity:** Low
- **Time lost:** ~10 minutes
- **Workaround:** Diff from the last committed schema instead: `git show HEAD:apps/server/prisma/schema.prisma > old.prisma`, then `prisma migrate diff --from-schema old.prisma --to-schema prisma/schema.prisma --script`. No database needed.
- **Suggestion:** Name the config file that was actually loaded in the error, and mention the `--from-schema` alternative in it (or in the `migrate diff` docs) for teams without a shadow database.

## FL-12: GitHub deployments don't carry the commit message or when they went live

- **Date:** 2026-10-17
- **Product / tool:** GitHub REST API (`2022-11-28`): deployments, deployment statuses, Git commits
- **Task attempted:** List a service's recent deploys with version, deploy time, author and commit message for incident correlation.
- **Steps taken:**
  1. `GET /repos/{owner}/{repo}/deployments?environment=production`.
  2. Per deployment: `GET …/deployments/{id}/statuses?per_page=1` for when it actually succeeded, and a commit lookup for the message.
- **Expected:** One list call returning each deployment's latest state and commit summary.
- **Actual:** A deployment has only `sha`, `ref`, `created_at` and `creator`. The time it went live is on its statuses, and the message is on the commit, so N deploys cost 1 + 2N requests. `GET /repos/{o}/{r}/commits/{sha}` also returns the full file diff. The Git Database endpoint (`/git/commits/{sha}`) returns just message and author, but the deployments docs don't point to it.
- **Severity:** Low
- **Time lost:** ~20 minutes
- **Workaround:** Capped at 10 deployments; statuses and commits fetched in parallel through `/git/commits/{sha}`; a failed per-deployment call degrades that one deploy instead of the list.
- **Suggestion:** Add an `include=latest_status,commit` option (or `latest_status` and `commit.message` fields) to the deployments list, so one call answers "what was deployed, when did it go live, and what changed".
