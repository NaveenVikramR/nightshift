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

## FL-13: A 1-minute `rate()` can't show recovery within a ~20 s post-action check

- **Date:** 2026-10-17
- **Product / tool:** Prometheus 3.15 (PromQL `rate()` / `query`)
- **Task attempted:** After `confirm_action` runs a failover or rollback, poll the error rate for about 20 s and report "recovered / recovering / no improvement".
- **Steps taken:**
  1. Reused the service's health query: `sum(rate(...{status=~"5.."}[1m])) / sum(rate(...[1m]))`.
  2. Ran the live integration test: `bad_deploy`, then rollback; `provider_outage`, then failover.
- **Expected:** The error ratio falls visibly within 20 s of the fix.
- **Actual:** Both actions worked (demo-target confirmed v1.4.1 and Stripe), but verification said `no_improvement` both times. Twenty seconds after the fix, 40 of the 60 seconds in a 1-minute window still hold the bad period, so at best the ratio has dropped about 33%, and scrape lag makes it less.
- **Severity:** Medium
- **Time lost:** ~25 minutes (one failed 6-minute live run plus diagnosis)
- **Workaround:** An optional per-service `verifyErrorRate` query with a short window (`rate[15s]`; scrape interval 5 s gives 3 samples), used for both the before and after readings so they are comparable. It falls back to the normal query when absent.
- **Suggestion:** In the `rate()` docs, add a short note on how the range window delays detecting recovery (with the "window ≥ 4 × scrape interval" guidance next to it), since alerting and remediation tools commonly reuse dashboard queries.

## FL-14: `node --test <directory>` runs the directory as a file in Node 24

- **Date:** 2026-10-18
- **Product / tool:** Node.js 24.16 test runner (`node --test`)
- **Task attempted:** Run the small `node:test` suite for the chaos scripts from `npm test`.
- **Steps taken:** Added `node --test infra/scripts` to the root `test` script.
- **Expected:** All `*.test.mjs` files in the directory run (older docs and blog posts describe directory arguments being searched).
- **Actual:** One failing "test" named after the directory (`✖ infra\scripts … 'test failed'`), with no hint that directories aren't supported. Newer Node versions take glob patterns instead.
- **Severity:** Low
- **Time lost:** ~5 minutes
- **Workaround:** `node --test "infra/scripts/*.test.mjs"` (quoted so the shell doesn't expand it).
- **Suggestion:** When a positional argument is a directory, print "directories are not supported; pass a glob such as dir/**/*.test.mjs" instead of reporting a failed test.

## FL-15: Prisma's `prisma-client` generator picks import extensions from whether a tsconfig exists

- **Date:** 2026-10-18
- **Product / tool:** Prisma ORM 7.10.0 (`prisma-client` generator), Docker multi-stage build
- **Task attempted:** Run the compiled server (`node dist/index.js`) in a production Docker image.
- **Steps taken:**
  1. In the build stage, copied `package.json` files and `prisma/` first, then ran `npm ci` (its postinstall runs `prisma generate`) so the dependency layer is cached.
  2. Copied `src/` and the tsconfig files, then ran `tsc`.
  3. Started the runtime image.
- **Expected:** The same generated client as on my machine, where it imports `./enums.js`.
- **Actual:** The container crashed at startup: `ERR_MODULE_NOT_FOUND … url: 'file:///app/apps/server/dist/generated/prisma/enums.ts'`. With no tsconfig present when `prisma generate` ran, the generator emitted `.ts` import specifiers. `tsc` then copied them unchanged into `dist`. Nothing failed at build time.
- **Severity:** High
- **Time lost:** ~40 minutes (including slow image rebuilds)
- **Workaround:** Set `moduleFormat = "esm"` and `importFileExtension = "js"` explicitly in the `generator client` block, so the output no longer depends on the environment.
- **Suggestion:** Make the generator's output deterministic by default, or at least log the inferred `moduleFormat` / `importFileExtension` (and where they came from) on every `prisma generate`. Add a "Docker / CI builds" note to the generator docs.

## FL-16: Prisma 7.10 with `@prisma/adapter-pg` hangs and blocks the event loop when Postgres refuses the connection

- **Date:** 2026-10-18
- **Product / tool:** Prisma ORM 7.10.0 + `@prisma/adapter-pg` 7.10.0 (pg 8.23.1), Node 24
- **Task attempted:** Fail fast at startup when the database is unreachable (`SELECT 1` health check).
- **Steps taken:**
  1. `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`, then ``await db.$queryRaw`SELECT 1` ``.
  2. Pointed `DATABASE_URL` at a port with nothing listening (`postgresql://u:p@127.0.0.1:1/x`).
  3. Added a 20 s `setTimeout` watchdog.
- **Expected:** A rejected promise within a second (connection refused).
- **Actual:**
  - The promise never settled and the watchdog timer never fired, so the event loop was blocked.
  - In the container the process used ~100% CPU, logged nothing, never opened its port, and the healthcheck failed.
  - With the same URL, plain `pg.Pool().query()` rejects in 8 ms with `ECONNREFUSED`. An unknown hostname makes Prisma reject in ~0.5 s.
- **Severity:** High (on a 1 GB instance, one refused connection pins the CPU)
- **Time lost:** ~45 minutes
- **Workaround:** `probeDatabase()`: a plain `pg.Client` connect + `SELECT 1` with `connectionTimeoutMillis` runs before the Prisma client is created. Startup now exits with "Can't reach the database at DATABASE_URL" and Docker restarts the container with backoff. A refusal during runtime is still unprotected.
- **Suggestion:** Treat `ECONNREFUSED` from the driver adapter as a terminal connection error (a P1001-style error) instead of retrying in a tight loop. Add a regression test with an unreachable port.

## FL-17: Alertmanager has no env substitution, and a secret mount inside the config mount fails

- **Date:** 2026-10-17
- **Product / tool:** Prometheus Alertmanager 0.34.1 (Docker image), Docker Compose
- **Task attempted:** Give Alertmanager's webhook receiver a bearer token without committing it.
- **Steps taken:**
  1. Looked for `${ENV}` support in `alertmanager.yml`. There is none, so I used `http_config.authorization.credentials_file`.
  2. Mounted the config dir read-only (`./alertmanager:/etc/alertmanager:ro`) and the secret dir at `/etc/alertmanager/secrets:ro`.
- **Expected:** Both mounts work. Nested bind mounts are common.
- **Actual:** `error mounting ".../infra/secrets/alertmanager" to rootfs at "/etc/alertmanager/secrets": … mkdirat …/etc/alertmanager/secrets: read-only file system`. The mountpoint has to be created inside the read-only parent mount.
- **Severity:** Medium
- **Time lost:** ~20 minutes
- **Workaround:**
  - Mount secrets at a sibling path, `/etc/alertmanager-secrets`.
  - The prod file is `root:65534` mode 0440, since the image runs as `nobody`.
  - A setup script keeps the token file and the server's env var in sync.
- **Suggestion:** In the webhook receiver docs, add a full `credentials_file` example with a Docker/Kubernetes secret mount. Mention that the image runs as `nobody` (uid 65534), so the file must be readable by that uid.

## FL-18: Caddy `header` doesn't touch error responses, and `-Server` needs `defer`

- **Date:** 2026-10-18
- **Product / tool:** Caddy 2.8.4 (Caddyfile `header`, `reverse_proxy`)
- **Task attempted:** Send HSTS, CSP, nosniff, X-Frame-Options and Referrer-Policy, and no `Server` header, on every response.
- **Steps taken:**
  1. Added a site-wide `header { Strict-Transport-Security …; -Server }` block.
  2. Smoke-tested with `curl -kI https://localhost/healthz` while the upstream was down.
- **Expected:** The same headers on every response, including proxy errors.
- **Actual:** The 502 responses carried only `Server: Caddy`, with no security headers. Even on success, `Server` remained until `defer` was added. Error responses are generated by the error route, which skips the site's `header` handlers.
- **Severity:** Medium (a header scan of the endpoint would have failed whenever the backend restarted)
- **Time lost:** ~20 minutes
- **Workaround:** A `(security_headers)` snippet with `defer`, imported in the site block and in `handle_errors` (which responds with only the status code).
- **Suggestion:** In the `header` directive docs, show a "security headers" recipe that covers `defer` for removing `Server`, and say plainly that `handle_errors` needs its own headers.

## FL-19: Git Bash rewrites container paths in `docker run` arguments

- **Date:** 2026-10-17
- **Product / tool:** Git for Windows (MSYS2 bash) + Docker Desktop 4.89
- **Task attempted:** Validate configs with `docker run … prom/alertmanager amtool check-config /etc/alertmanager/alertmanager.yml`.
- **Steps taken:** Ran the command from Git Bash on Windows.
- **Expected:** amtool reads the file inside the container.
- **Actual:** `amtool: error: path 'C:/Program Files/Git/etc/alertmanager/alertmanager.yml' does not exist`. MSYS converted the POSIX-looking argument into a Windows path before Docker saw it. `docker exec … ls /etc/…` did the same.
- **Severity:** Low
- **Time lost:** ~10 minutes
- **Workaround:** Prefix the command with `MSYS_NO_PATHCONV=1`. Our npm scripts call Docker from Node, which isn't affected.
- **Suggestion:** Docker docs for Windows could warn about MSYS path conversion in the `docker run` / `exec` pages. Docker Desktop could detect a `C:/Program Files/Git/` prefix in container-path arguments and print a hint.

## FL-20: The skills named for MCP Apps work aren't available unless installed by hand

- **Date:** 2026-10-19
- **Product / tool:** Claude Code skills; MCP Apps `mcp-apps` plugin (`add-app-to-server`); `frontend-design`
- **Task attempted:** Add MCP Apps cards to an existing server using the recommended skills.
- **Steps taken:** Asked for the `add-app-to-server` skill (the ext-apps README recommends it) and the `frontend-design` skill. Neither was in this session's skill list.
- **Expected:** The skills to be discoverable from the tooling that recommends them.
- **Actual:** Each needs a separate manual plugin install (`/plugin marketplace add modelcontextprotocol/ext-apps`, then `/plugin install mcp-apps@…`). Nothing in the session pointed to that.
- **Severity:** Low
- **Time lost:** ~10 minutes (I read `ext-apps` 2.0.3's README and type definitions instead)
- **Workaround:** Built from the package's `.d.ts` files: `registerAppTool`, `registerAppResource`, `RESOURCE_MIME_TYPE`, `App`, `AppBridge`.
- **Suggestion:** When a project or docs mention a skill that isn't installed, say so with the exact install command. The ext-apps npm README could also list the four skills' install commands next to "Getting Started".

## FL-21: ext-apps `basic-host` can't be run on its own from a clone

- **Date:** 2026-10-19
- **Product / tool:** `modelcontextprotocol/ext-apps` @ 82221c0, `examples/basic-host`
- **Task attempted:** Run basic-host locally to test our cards in a real MCP Apps host.
- **Steps taken:**
  1. `npm install` in `examples/basic-host` (installs at the monorepo root as a workspace), then `vite build`.
  2. Ran `serve.ts` with `HOST_PORT=8090 SANDBOX_PORT=8091` (8080 is taken on this machine).
- **Expected:** The README's `npm install && npm run start` works, and the ports are configurable.
- **Actual:**
  1. `Rollup failed to resolve import "@modelcontextprotocol/ext-apps/app-bridge"`: the example resolves the unbuilt workspace package, not the published one.
  2. `npm run serve` needs `bun`.
  3. `SANDBOX_PORT` changes the server, but `src/implementation.ts` hard-codes `http://localhost:8081/sandbox.html`, so the sandbox iframe failed with `chrome-error://chromewebdata/`.
- **Severity:** Medium
- **Time lost:** ~35 minutes (including an 8-minute install)
- **Workaround:** Copied the published `@modelcontextprotocol/ext-apps` 2.0.3 into the example's own `node_modules`, ran `node --import tsx serve.ts`, and kept the sandbox on 8081.
- **Suggestion:** Read the sandbox origin from the server (e.g. `/api/config` next to `/api/servers`). Document `npm run build` at the repo root first, and use `tsx` instead of `bun` in `serve`.

## FL-22: basic-host has no way to send an Authorization header, and no prompts UI

- **Date:** 2026-10-19
- **Product / tool:** ext-apps `examples/basic-host`
- **Task attempted:** Connect basic-host to Nightshift, which needs a bearer token (and allows only listed Origins).
- **Steps taken:** Looked for a header or token option in `SERVERS` and `implementation.ts`. It only takes URLs: `new StreamableHTTPClientTransport(serverUrl)`.
- **Expected:** A way to pass headers, like `claude mcp add --header` or the Inspector's `--header`.
- **Actual:** Not possible. The browser client also sends `Origin: http://localhost:8090`, and authenticated servers reject that by design. `prompts/list` isn't shown anywhere, so our guided prompts can't be tried there.
- **Severity:** Medium
- **Time lost:** ~20 minutes
- **Workaround:** A dev-only local proxy (kept out of the repo) answers CORS, adds a temporary responder token, and forwards like a non-browser client. Prompts were checked with the MCP Inspector CLI instead.
- **Suggestion:** Accept `{ url, headers }` objects in `SERVERS`. Add a prompts panel next to the tool picker.

## FL-23: basic-host calls every tool twice (React StrictMode), and the second result replaces the first

- **Date:** 2026-10-19
- **Product / tool:** ext-apps `examples/basic-host` (dev build, React 19 StrictMode)
- **Task attempted:** Incident card → Fail over → confirmation card → Confirm, end to end.
- **Steps taken:** Opened `?server=nightshift&tool=explain_incident&call=true` and clicked the card's action button.
- **Expected:** One `tools/call` per user action.
- **Actual:**
  - The host log shows `Calling tool explain_incident` twice. Each delivery mounts or updates a View.
  - The run was flaky at first: a late duplicate result re-rendered the card over the confirmation the user had just opened.
  - With `run_security_scan`, the duplicate hit our 1-per-minute scan limit, and the card showed "I scanned less than a minute ago" instead of the grade.
  - For a non-idempotent tool, duplicate calls from a host would be a real hazard.
- **Severity:** Medium
- **Time lost:** ~40 minutes
- **Workaround:** In the card, `createResultGate()` ignores host results once the user starts a flow, and never lets an error replace a good card. On the scan limit, the card offers "Show the latest results" (`get_security_findings`). Server-side, `confirm_action` was already single-use and idempotent, so nothing could run twice.
- **Suggestion:** Guard the auto-call against StrictMode double effects (e.g. with a ref or an AbortController). Note in the MCP Apps docs that Views may receive more than one `tool-result` and should handle it idempotently.

## FL-24: Playwright full-page screenshots don't paint iframe content below the fold

- **Date:** 2026-10-19
- **Product / tool:** Playwright 1.64.1 + Chromium (new headless)
- **Task attempted:** Screenshot each card (rendered in an iframe by the test host) at full height.
- **Steps taken:** `page.screenshot({ fullPage: true })` after the host resized the iframe to the card's height.
- **Expected:** The whole card.
- **Actual:** The capture was the full page height, but iframe content below about 745 px was blank. After resizing the viewport to work around it, `click()` inside the iframe failed: "<dt> … intercepts pointer events", from a stale iframe offset.
- **Severity:** Low
- **Time lost:** ~25 minutes
- **Workaround:** Grow the viewport to the iframe's height for the capture, shrink it back afterwards, and use `dispatchEvent('click')` for the click that follows a capture.
- **Suggestion:** Paint out-of-viewport iframe content in `fullPage` captures, or document the limitation and the viewport workaround.
