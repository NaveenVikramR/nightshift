# Nightshift

Nightshift is a voice on-call and security copilot for small engineering teams: a self-hosted
**MCP server** that Alexa+ (or any MCP client) calls to explain what's wrong in production and to
take safe, explicitly confirmed actions.

> Status: **Day 3.** Transport, auth, roles, database and audit log, plus seven tools:
> `ping_nightshift`, `list_active_alerts`, `get_service_health`, `acknowledge_alert`,
> `silence_alert`, `get_recent_deploys` and `explain_incident` (grounded incident diagnosis),
> running against a local Prometheus + Alertmanager stack with deploy history from CI or GitHub.
> Two-phase remediation and security posture land next.

## Prerequisites

- Node.js **20.12+** for the server (developed on 24.x; the demo target needs 22.18+) and npm 10+
- Docker (Docker Desktop on Windows/macOS) for the local Prometheus + Alertmanager stack
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

## Local observability stack (demo)

A small simulated payments service (`apps/demo-target`) exposes Prometheus metrics; Prometheus
scrapes it and evaluates alert rules; Alertmanager holds the alerts Nightshift reads.

```bash
cp infra/.env.example infra/.env   # set DEMO_ADMIN_TOKEN (any random string, 16+ chars)
npm run stack:up                   # builds demo-target, starts all three, waits until healthy
npm run stack:check                # optional: promtool / amtool validation of the configs
```

| Service      | URL (localhost only)   |
| ------------ | ---------------------- |
| demo-target  | http://127.0.0.1:18080 |
| Prometheus   | http://127.0.0.1:9090  |
| Alertmanager | http://127.0.0.1:9093  |

demo-target uses host port **18080** because 8080 is often taken by a local web server; change
`DEMO_TARGET_PORT` / `DEMO_TARGET_URL` in `infra/.env` if needed.

**Chaos scenarios** (each takes 15–45 s to turn into a firing alert):

| Command                          | What breaks                                                         | Alerts that fire                      |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------- |
| `npm run chaos:provider_outage`  | Razorpay is down: its breaker opens, charges fail                   | `CircuitBreakerOpen`, `HighErrorRate` |
| `npm run chaos:latency_spike`    | 80% of payments requests take 1.2–3 s                               | `HighLatencyP95`                      |
| `npm run chaos:auth_bruteforce`  | ~20 failed logins per second                                        | `AuthFailureSpike`                    |
| `npm run chaos:webhook_spoofing` | ~4 forged webhooks per second fail HMAC                             | `WebhookSignatureFailures`            |
| `npm run chaos:bad_deploy`       | Reports deploy v1.4.2 to Nightshift, then Razorpay fails 60 s later | `CircuitBreakerOpen`, `HighErrorRate` |
| `npm run chaos:failover`         | Route payments to Stripe (what failover will do)                    | `HighErrorRate` clears                |
| `npm run chaos:reset`            | Back to healthy (scenarios off, Razorpay active)                    | everything resolves                   |

`npm run chaos:state` shows what is active. `npm run stack:down` stops the stack.

### Plugging in your own app

Nightshift has no app-specific code. Edit `apps/server/config/nightshift.yaml`: point
`prometheus.url` / `alertmanager.url` at your stack (or set `PROMETHEUS_URL` / `ALERTMANAGER_URL`),
and list your services with aliases, one PromQL per signal (error rate, p95 latency, throughput,
optional circuit breakers, optional auth and webhook failure rates) and thresholds. Alerts must
carry `service` and `severity` labels. Set `display.timeZone` for spoken clock times.

### Deploy history

Each service picks a source in `nightshift.yaml` (`deploys: { source: ingest | github }`).

**From any CI system (`ingest`).** Create an ingest token (it works only on this endpoint, never
on `/mcp`), put its JSON entry in `NIGHTSHIFT_INGEST_TOKENS`, and add a step after each deploy:

```bash
npm run token:new -- github-actions ingest
curl -fsS -X POST "$NIGHTSHIFT_URL/events/deploy" \
  -H "Authorization: Bearer $NIGHTSHIFT_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"service":"payments-api","version":"v1.4.2","commitSha":"'"$GITHUB_SHA"'","commitMessage":"tune payment retry config","author":"ci","externalId":"run-'"$GITHUB_RUN_ID"'"}'
```

`externalId` makes retries idempotent. Commit messages are stored sanitized and treated as untrusted
data. `chaos:bad_deploy` uses this same endpoint (set `NIGHTSHIFT_INGEST_TOKEN` in `infra/.env`).

**From GitHub (`github`).** Set `deploys: { source: github, repo: owner/name, environment:
production }` and `GITHUB_TOKEN` (a fine-grained token on that repo with read-only Deployments,
Contents and Metadata). Nightshift reads deployments, their latest status and the commit.

### How `explain_incident` decides

Deterministic rules over collected evidence (an LLM never decides the cause):

1. **Evidence:** for the alerted service, in parallel with timeouts: firing alerts, 60 minutes of
   error rate, p95 latency, throughput, breaker states and auth/webhook failure rates (30 s steps),
   and deploys from 10 minutes before the window. If a source is down, Nightshift says so and
   continues.
2. **Change detection:** onset = the start of the most recent sustained rise above
   `max(median + 3 × MAD, threshold)`.
3. **Rules → causes**, each with confidence, evidence (real timestamps, values, versions) and
   suggested actions:
   - a deploy within ±10 minutes of the onset suggests `rollback_deploy`;
   - one provider breaker open suggests `failover_provider`;
   - latency up with errors flat is saturation (investigate);
   - an auth or webhook-signature spike is a possible attack (investigate, never automated);
   - otherwise "no clear cause".
4. **Speech:** templates, at most 30 words, e.g. _"Critical. Payments API errors at 58 percent for 1
   minute. The Razorpay breaker opened right after the 1:16 deploy, version 1.4.2. I can fail over to
   Stripe or roll back."_ Commit messages and alert text are never spoken here.

Each diagnosis opens or updates the service's open incident in Postgres.

## Test

```bash
npm test                  # unit tests, all workspaces; no network, no database needed
npm run test:integration  # against the live stack (npm run stack:up first)
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

| Requirement                                                         | Where / how                                                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP **2025-11-25** over Streamable HTTP, single `/mcp` (POST + GET) | `src/http/createApp.ts`, SDK `NodeStreamableHTTPServerTransport` (stateful). A client asking for a newer revision gets `2025-11-25` back.                                       |
| SDK imported and called at runtime                                  | `McpServer`, `NodeStreamableHTTPServerTransport`, `hostHeaderValidation`, `requireBearerAuth`, `isInitializeRequest`                                                            |
| `Origin` validated on every request, 403 if invalid                 | SDK host/origin guard + exact `scheme://host:port` allowlist (`src/http/originGuard.ts`)                                                                                        |
| Bind to 127.0.0.1 locally                                           | `HOST` defaults to `127.0.0.1`                                                                                                                                                  |
| `MCP-Session-Id`                                                    | crypto-random UUIDs; unknown or expired session → 404; `DELETE` ends it; sessions are bound to the token's actor                                                                |
| `MCP-Protocol-Version`                                              | unsupported → 400 (SDK)                                                                                                                                                         |
| Auth + roles                                                        | bearer tokens stored as SHA-256, compared in constant time; roles `viewer` / `responder` checked in every tool (`src/tools/runTool.ts`)                                         |
| Audit everything                                                    | every `tools/call` writes one `AuditLog` row (actor, role, tool, input hash, outcome), including invalid arguments, unknown tools and auth/origin/session refusals; fail-closed |
| Hardening                                                           | 1 MB JSON body limit (413); 20 failed auths per IP per 10 min → 429                                                                                                             |

**Protocol versions.** Nightshift targets MCP **2025-11-25**. Modern clients (MCP Inspector 2.x,
Claude Code) negotiate exactly that, and a client that asks for a newer revision such as
2026-07-28 is answered with 2025-11-25. As the SDK does by default, the server also still
accepts older revisions (2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07) during `initialize` and
in the `MCP-Protocol-Version` header, so older clients keep working. Any other value gets 400.

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
  src/domain/         pure business logic (alerts, health, service resolution, spoken text)
  src/clients/        Prometheus + Alertmanager HTTP clients (typed errors)
  src/lib/            auth, roles, audit, rate limiting, untrusted-text handling, logging
  src/db/             Prisma client, audit sink, ack/silence stores
  config/             nightshift.yaml service catalog
  prisma/             schema, migrations, seed
apps/demo-target/     simulated payments API with Prometheus metrics and chaos switches
infra/                docker compose: demo-target, Prometheus, Alertmanager + alert rules
apps/alexa-sim/       (coming) simulated Alexa+ client
packages/mcp-prometheus-tools/  (coming) reusable OSS package
docs/                 friction log, product feedback
```

The monitored demo system, TruePay, is a pre-existing project and only a monitoring target.
Nightshift itself stays generic.

## License

MIT, see [LICENSE](LICENSE).
