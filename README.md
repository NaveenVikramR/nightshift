# Nightshift

Nightshift is a voice on-call and security copilot for small engineering teams: a self-hosted
**MCP server** that Alexa+ (or any MCP client) calls to explain what's wrong in production and to
take safe, explicitly confirmed actions.

> Status: **Day 1 foundation.** Transport, auth, roles, database, audit log and one diagnostic
> tool (`ping_nightshift`) are working. Ops, incident and security tools land next.

## Prerequisites

- Node.js **20.12+** (developed on 24.x) and npm 10+
- A PostgreSQL database, e.g. a free [Neon](https://neon.tech) project. For local development you
  can also run Prisma's built-in local Postgres: `npx prisma dev` (see below).

## Setup

```bash
git clone <this repo> nightshift && cd nightshift
npm install                                   # also generates the Prisma client
cp apps/server/.env.example apps/server/.env  # then edit it (every variable is documented)
```

1. **Database:** set `DATABASE_URL` in `apps/server/.env`, then create the tables:
   ```bash
   npm run db:migrate -w @nightshift/server      # prisma migrate deploy
   npm run seed                                  # stub: checks connectivity
   ```
   No Neon yet? `cd apps/server && npx prisma dev --name nightshift --detach` prints a local
   `postgres://…` URL you can use.
2. **API tokens:** create one per person or client. Only the SHA-256 hash goes in `.env`:
   ```bash
   npm run token:new -- alice responder
   npm run token:new -- alexa-sim viewer
   ```
   Each run prints the token once and a JSON entry. Put the entries in the
   `NIGHTSHIFT_TOKENS=[…]` array, and store the tokens in your MCP clients. Restart the server
   after changing tokens.

## Run

```bash
npm run dev     # tsx watch, http://127.0.0.1:3000/mcp
# or
npm run build && npm start
```

- `GET /healthz` returns `ok` (no auth; for hosting health checks).
- `POST | GET | DELETE /mcp` is the MCP Streamable HTTP endpoint (bearer token required).

## Test

```bash
npm test          # Vitest; no external network, no database needed
npm run typecheck
npm run lint
```

## Connect a client

### MCP Inspector

CLI (scriptable):

```bash
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --transport http \
  --header "Authorization: Bearer <token>" --method tools/list

npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --transport http \
  --header "Authorization: Bearer <token>" --method tools/call --tool-name ping_nightshift
```

UI: run `npx @modelcontextprotocol/inspector`, open the URL it prints, choose transport
**Streamable HTTP**, URL `http://127.0.0.1:3000/mcp`, and add a header
`Authorization: Bearer <token>`. If the browser calls the server directly, its origin
(`http://localhost:6274` by default) must be in `ALLOWED_ORIGINS`.

### Claude Code

```bash
claude mcp add --transport http nightshift http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer <token>"
claude mcp get nightshift      # should say: Connected
```

Then ask, for example, "Is Nightshift up, and what am I allowed to do?" and Claude should call
`ping_nightshift`.

## How the hard requirements are met

| Requirement                                                         | Where / how                                                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| MCP **2025-11-25** over Streamable HTTP, single `/mcp` (POST + GET) | `src/http/createApp.ts`, SDK `NodeStreamableHTTPServerTransport` (stateful). A client asking for a newer revision gets `2025-11-25` back. |
| SDK imported and called at runtime                                  | `McpServer`, `NodeStreamableHTTPServerTransport`, `createMcpExpressApp`, `requireBearerAuth`, `isInitializeRequest`                       |
| `Origin` validated on every request, 403 if invalid                 | SDK host/origin guard + exact `scheme://host:port` allowlist (`src/http/originGuard.ts`)                                                  |
| Bind to 127.0.0.1 locally                                           | `HOST` defaults to `127.0.0.1`                                                                                                            |
| `MCP-Session-Id`                                                    | crypto-random UUIDs; unknown or expired session → 404; `DELETE` ends it; sessions are bound to the token's actor                          |
| `MCP-Protocol-Version`                                              | unsupported → 400 (SDK)                                                                                                                   |
| Auth + roles                                                        | bearer tokens stored as SHA-256, compared in constant time; roles `viewer` / `responder` checked in every tool (`src/tools/runTool.ts`)   |
| Audit everything                                                    | every tool call writes an `AuditLog` row (actor, role, tool, input hash, outcome); fail-closed                                            |
| Hardening                                                           | 1 MB JSON body limit (413); 20 failed auths per IP per 10 min → 429                                                                       |

## Deployment notes

- **Run exactly one instance.** MCP sessions and the failed-auth counters live in process memory.
  With two instances behind a load balancer, requests would land on a server that doesn't know
  the session and get 404. Scale up, not out (or add a shared session store first).
- Behind a reverse proxy, set `TRUST_PROXY=true` so rate limiting sees real client IPs, set
  `HOST=0.0.0.0`, and set `ALLOWED_HOSTS` to your public hostname.

## Repository layout

```
apps/server/          Nightshift MCP server (this is the submission's new work)
  src/http/           Express app, origin guard, session store
  src/mcp/            McpServer factory + tool registration
  src/tools/          one file per tool + the shared runTool adapter
  src/domain/         pure business logic
  src/lib/            auth, roles, audit, rate limiting, logging
  src/db/             Prisma client + audit sink
  prisma/             schema, migrations, seed
apps/alexa-sim/       (coming) simulated Alexa+ client
apps/demo-target/     (coming) TruePay-like demo service
packages/mcp-prometheus-tools/  (coming) reusable OSS package
docs/                 friction log, product feedback
```

The monitored demo system, TruePay, is a pre-existing project and only a monitoring target.
Nightshift itself stays generic.

## License

MIT, see [LICENSE](LICENSE).
