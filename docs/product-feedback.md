# Product feedback

One section per tool, API or SDK used. Friction details live in [friction-log.md](friction-log.md).

## MCP TypeScript SDK (v2: `@modelcontextprotocol/server` 2.3.1, `/node` 2.1.1, `/express` 2.0.2)

- **What I used it for:** The whole MCP layer of Nightshift: `McpServer` + `registerTool` (zod
  schemas), the stateful `NodeStreamableHTTPServerTransport` on a single `/mcp` endpoint,
  `createMcpExpressApp` (JSON body limit and Host-header DNS-rebinding guard), `requireBearerAuth`
  with a custom `OAuthTokenVerifier`, and `isInitializeRequest`.
- **What worked well:**
  - The stateful transport handled the spec's session rules out of the box: 404 for unknown
    sessions, 400 for missing sessions and unsupported `MCP-Protocol-Version`, and `DELETE`.
  - Version negotiation is correct: a client asking for `2026-07-28` gets `2025-11-25`.
  - `requireBearerAuth` → `ctx.http.authInfo` gives tool handlers a clean, typed path to the
    caller's identity.
  - The types are excellent documentation. JSDoc examples are compiled from real example files.
- **What needs work:**
  - Two serving models (2026-07-28 `createMcpHandler` vs. 2025 stateful transport) with no guide
    to choosing between them (FL-01).
  - Origin validation is hostname-only (FL-04).
  - `expiresAt` is required in practice but optional in the type (FL-05).
- **Onboarding:** About 45 minutes from install to a session-aware server answering
  `initialize`, mostly spent reading `.d.mts` files to pick the right serving API. The package
  READMEs' Express snippet is stateless only; a stateful example would have saved time.
- **Would I build with it again?** Yes. Once the right entry point was clear, the wiring was
  small and the defaults are secure.

## MCP Inspector 2.11.0

- **What I used it for:** Manual verification from the CLI (`--cli`): `tools/list`, `tools/call`
  as viewer and responder, with `--header "Authorization: Bearer …"`.
- **What worked well:** CLI mode makes MCP checks scriptable, auto-detects transport from `/mcp`,
  and prints the raw result, including `structuredContent`.
- **What needs work:** A missing token produces an interactive-OAuth error instead of "401"
  (FL-06).
- **Onboarding:** Under 5 minutes with `--help`.
- **Would I build with it again?** Yes. It's the quickest way to check a server outside any LLM
  client.

## Claude Code (as an MCP client)

- **What I used it for:** End-to-end client check via
  `claude mcp add --transport http nightshift http://127.0.0.1:3000/mcp --header "Authorization: Bearer …"`,
  then a natural-language prompt that should pick `ping_nightshift`.
- **What worked well:** `claude mcp get` shows connection health directly ("Connected"); it
  redacts the Authorization header in its own output; the model chose the right tool from its
  description alone.
- **What needs work:** Nothing blocking today.
- **Onboarding:** About 2 minutes.
- **Would I build with it again?** Yes.

## Prisma ORM 7.10.0 (+ `@prisma/adapter-pg`, `prisma dev`)

- **What I used it for:** Schema and migrations for audit log, pending actions, incidents and
  scans; the generated client (driver adapter for Postgres); local Postgres via `prisma dev` for
  verification without a cloud database.
- **What worked well:**
  - `prisma migrate diff --from-empty --to-schema … --script` generates the first migration
    with no database.
  - `prisma dev --detach` gives a working local Postgres in seconds.
  - The generated TypeScript client typechecks cleanly under strict NodeNext.
- **What needs work:**
  - npm `latest` is an RC, and the update notifier pushes it (FL-02).
  - The config file was renamed (`prisma7.config.ts`) without clear docs (FL-03).
  - `npm audit` reports 4 high-severity advisories through the CLI's own dependencies
    (`mysql2`, `deepmerge-ts` via `@prisma/config`); the suggested fix downgrades to Prisma 6.
    These are dev-time only for a Postgres project, but noisy.
- **Onboarding:** About 20 minutes, including the v7 adapter and config changes.
- **Would I build with it again?** Yes. Migrations and the typed client are worth it.

## AWS services

Not used yet (Bedrock, Polly and App Runner arrive with the Alexa+ simulator and deployment).
