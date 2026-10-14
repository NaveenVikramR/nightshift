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
