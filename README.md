# Nightshift

**A voice on-call and security copilot for Alexa+: an open, self-hosted MCP server that explains
what's wrong in production and takes safe, explicitly confirmed actions.**

[![Watch the 3-minute demo](https://img.youtube.com/vi/wR8AIjl1880/maxresdefault.jpg)](https://youtu.be/wR8AIjl1880)

▶ **Demo video (under 3 minutes):** https://youtu.be/wR8AIjl1880

| "What's wrong?" → incident card                                                 | Fail over → confirmation card                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| ![Incident card in the simulated Alexa+](docs/screenshots/alexa-2-incident.png) | ![Confirmation card](docs/screenshots/alexa-3-confirm.png)                      |
| **"Anything security-wise?" → scorecard**                                       | **Injected commit message withheld by Bedrock Guardrails (trace)**              |
| ![Security scorecard](docs/screenshots/alexa-7-security.png)                    | ![Guardrail refusal in the trace panel](docs/screenshots/alexa-8-guardrail.png) |

Built for the **Build, Ship, Shape: Amazon Developer Hackathon** (Alexa+ track, AWS Builder mini
challenge). Everything in this repository was written during the hackathon: the first commit is
dated **2026-10-14**.

## What it does

Small teams have no SRE or security staff. When an alert fires at 3 a.m., the on-call engineer
opens a laptop and digs through dashboards, deploys and logs, and quiet risks (missing security
headers, vulnerable dependencies, failed-login spikes) go unnoticed.

With Nightshift, the engineer asks Alexa+ (or any MCP client):

- **"What's wrong?"** Nightshift correlates firing alerts, error-rate and latency changes, circuit
  breakers and recent deploys with **deterministic rules** and answers in under 30 spoken words:
  severity, what, likely cause, next step. It never invents a cause; weak evidence is said out loud.
- **"Fail over to Stripe."** Nightshift prepares the change, says exactly what will happen, waits
  for an explicit **yes**, runs it once, then **measures** whether the errors recovered.
- **"Anything security-wise?"** A scan of allowlisted assets (security headers, TLS expiry,
  Dependabot and secret-scanning alerts, auth-failure and webhook-signature spikes) gives a grade
  from A to F with the worst issue first.
- **Proactive pushes.** MCP servers can't make Alexa+ speak first, so Alertmanager → Nightshift →
  Telegram sends "🔴 Critical: … Ask Alexa: what's wrong?".

Every tool returns `speak` (≤ 30 words, voice-first) plus structured `data`, and four **MCP Apps
cards** for an Echo Show-like screen. Because there is no way for third-party developers to connect
an MCP server to real Alexa+ yet, the repo includes a **simulated Alexa+** (`apps/alexa-sim`): a
real MCP client with an agent loop, Amazon Polly voice, Amazon Bedrock Guardrails and the cards.

## Try it in 5 minutes

**Needs:** Node.js 22.18+ (npm 10+), Docker Desktop (running) and Git. Everything binds to
127.0.0.1. The MCP server and all 13 tools need **no AWS account and no API keys**.

```bash
git clone https://github.com/NaveenVikramR/nightshift && cd nightshift
npm install                                   # also generates the Prisma client
cp infra/.env.example infra/.env
cp apps/server/.env.example apps/server/.env

# Local Postgres (compose profile "localdb")
docker compose -f infra/docker-compose.yml --profile localdb up -d --wait postgres
```

Edit `apps/server/.env`:

```
DATABASE_URL=postgresql://nightshift:nightshift@127.0.0.1:15432/nightshift
ALLOWED_HOSTS=host.docker.internal
DEMO_ADMIN_TOKEN=<any random string, 16+ characters>
```

Set the same `DEMO_ADMIN_TOKEN` in `infra/.env`, then:

```bash
npm run db:migrate -w @nightshift/server     # create the tables
npm run stack:up                             # demo service :18080, Prometheus :9090, Alertmanager :9093
npm run token:new -- judge responder         # prints a token once + a JSON entry
```

Put the printed JSON entry in `NIGHTSHIFT_TOKENS=[…]` in `apps/server/.env` (only the SHA-256 hash
is stored), then start the server and call it:

```bash
npm run dev                                  # http://127.0.0.1:3000/mcp  (GET /healthz → ok)

npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --transport http \
  --header "Authorization: Bearer <token>" --method tools/call --tool-name ping_nightshift
```

Or connect Claude Code and talk to it:

```bash
claude mcp add --transport http nightshift http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer <token>"
```

Then: "Give me the ops brief." → `npm run demo:outage` (waits until the alerts fire) → "What's
wrong?" → "Fail over to Stripe." → "Yes" → "Run a security scan." → `npm run chaos:reset`.
Step-by-step judge instructions are in
[docs/submission/testing-instructions.md](docs/submission/testing-instructions.md).

**The simulated Alexa+ (`/alexa`)** additionally needs an AWS profile in ap-southeast-2 (Bedrock
Guardrails, Polly, CloudWatch; see [infra/aws/](infra/aws/README.md)) and a Groq API key while the
Bedrock model quota is 0. It refuses to start without them rather than silently falling back. See
[Simulated Alexa+](#simulated-alexa-appsalexa-sim).

## Architecture

```mermaid
flowchart LR
  subgraph Browser["Simulated Alexa+ (/alexa, browser)"]
    UI["Echo Show UI<br/>mic (Web Speech) · captions<br/>cards via ext-apps AppBridge"]
  end
  subgraph Sim["alexa-sim (Next.js backend)"]
    Agent["Agent loop<br/>guards: human yes, 6 tools/turn,<br/>20 req/10 min, daily caps"]
    MCPC["MCP client SDK<br/>one session per browser"]
  end
  subgraph AWS["AWS (ap-southeast-2, role nightshift-app)"]
    Guard["Bedrock Guardrails<br/>(ApplyGuardrail)"]
    Polly["Polly neural TTS"]
    CW["CloudWatch metrics"]
  end
  Model["Model: Groq gpt-oss-120b today<br/>Bedrock Converse · Nova Lite (pending quota)"]
  subgraph NS["Nightshift MCP server (/mcp)"]
    Tools["13 tools + 4 MCP Apps cards<br/>+ 3 prompts"]
    Rules["Deterministic correlation,<br/>two-phase actions, posture scans,<br/>audit log (Postgres)"]
  end
  Prom["Prometheus"] --> Tools
  AM["Alertmanager"] --> Tools
  AM -- webhook --> Tele["Telegram push"]
  Tools --> Rules
  Rules -- "allowlisted actions" --> Demo["Monitored service<br/>(apps/demo-target)"]
  Demo --> Prom
  UI -- "text, CSRF-protected" --> Agent
  Agent --> Guard
  Agent --> Model
  Agent --> Polly
  Agent --> CW
  Agent --> MCPC
  MCPC -- "Streamable HTTP, bearer token" --> Tools
  CC["Claude Code / MCP Inspector / any MCP client"] -- "Streamable HTTP" --> Tools
```

The simulator never talks to Prometheus, the demo service or the database for answers; everything
goes through Nightshift's MCP tools. Its demo controls are the only exception: they break the demo
service on purpose, through its token-protected admin API, server-side.

## The 13 tools

| Tool                    | What it does                                                                                      | Role      |
| ----------------------- | ------------------------------------------------------------------------------------------------- | --------- |
| `get_ops_brief`         | One call: every service's health, firing alerts, open incidents, security grade, today's deploys  | viewer    |
| `list_active_alerts`    | Firing alerts, worst first, with who acknowledged them                                            | viewer    |
| `explain_incident`      | Grounded diagnosis: ranked causes with confidence, evidence and suggested actions (incident card) | viewer    |
| `get_service_health`    | Live error rate, p95 latency, throughput and circuit breakers from Prometheus                     | viewer    |
| `get_recent_deploys`    | Recent deploys from CI events or the GitHub API                                                   | viewer    |
| `acknowledge_alert`     | Mark a firing alert as acknowledged                                                               | responder |
| `silence_alert`         | Silence one alert in Alertmanager for 1–240 minutes (idempotent)                                  | responder |
| `prepare_action`        | Check live state and describe one allowlisted fix; no side effect; returns a confirmation id      | responder |
| `confirm_action`        | Execute a prepared fix after an explicit yes, once, then measure the recovery                     | responder |
| `run_security_scan`     | Run the allowlisted posture checks, grade A–F, deltas vs the previous scan (scorecard card)       | viewer    |
| `get_security_findings` | The latest grade and open findings without scanning again                                         | viewer    |
| `get_incident_timeline` | The incident as an ordered story plus a postmortem draft built only from recorded events          | viewer    |
| `add_incident_note`     | Add a note to an incident (stored as untrusted text) or resolve it                                | responder |

Plus `ping_nightshift` (diagnostic: server version and your role). Three guided prompts
(`on_call_triage`, `security_check`, `postmortem`) and a publishable Agent Skill
([skills/nightshift-on-call](skills/nightshift-on-call/SKILL.md)) sit on top.

## Safety model

Nightshift can change production, so every remediation goes through the same guarded path. The
rules are enforced in the server, never in a prompt.

1. **Two-phase confirmation.** `prepare_action` changes nothing. It checks live state and returns
   what would change (changes, who is affected, how to undo, expected effect), plus a confirmation
   id. The assistant must ask, for example _"This will route all payments API traffic from Razorpay
   to Stripe. You can switch back anytime. Shall I go ahead?"_ Only after a clear yes does
   `confirm_action` run it.
2. **Allowlist.** Only `failover_provider`, `rollback_deploy` and `restart_service`, and only where
   `nightshift.yaml` lists that action for that service with an executor. There's no shell, no
   Docker socket and no arbitrary URLs. Secrets are referenced by env var name only.
3. **Roles.** `viewer` tokens can diagnose but never prepare or confirm; every write tool needs
   `responder`.
4. **Bound, short-lived, single-use.** A confirmation id is random (128 bits) and never spoken. It is
   bound to the actor (token) that prepared it and to the exact params (`paramsHash`). It expires
   after 2 minutes and works once. Anyone else gets "I can't find that confirmation".

   **Session binding is optional** (`STRICT_SESSION_BINDING`, default `false`). Voice clients may
   reconnect between "fail over?" and "yes", which opens a new MCP session, and strict binding would
   refuse the yes. With it off, a stolen confirmation id is still useless without the same actor's
   token within 2 minutes.

5. **Idempotency.** Confirming claims the action atomically (one conditional update), so
   concurrent confirms run it once. A reused id returns the original result ("That's already
   done.") and never runs it again.
6. **Re-check before acting.** Just before executing, Nightshift re-reads live state. If someone
   already failed over, or the provider recovered, it does nothing and says why.
7. **Rate limit.** At most 3 executed actions per 10 minutes per team.
8. **Verification.** After acting, it polls the error rate for up to about 20 seconds and reports
   _recovered_, _recovering_ (with the measured numbers) or _no improvement yet_. It never claims
   a recovery the metrics don't show.
9. **Untrusted data stays data.** Alert annotations, commit messages, advisory text and notes are
   stored quoted (`{ untrusted: true, text }`), never spoken by the diagnosis and never read by a
   rule. In the simulator, Bedrock Guardrails checks that text again before a model sees it.
10. **Audit everything.** Every `tools/call` writes an audit row (actor, role, tool, input hash,
    outcome), including invalid arguments, unknown tools and auth/origin/session refusals. The
    audit write is fail-closed.

In the simulated Alexa+, the model can call `confirm_action` only for a confirmation **this
session prepared in an earlier turn**, and only when the person's latest words are an explicit yes
(a card's Confirm button counts as the yes).

## AWS

Everything runs in **ap-southeast-2 (Sydney)** with no access keys: the AWS SDK for JavaScript v3
default chain loads the least-privilege role `nightshift-app` (assumed locally from `aws login`).

| Service                                    | How it's used                                                                                                                                                                                                                                 | Status                                                                                                                                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Amazon Bedrock Guardrails                  | `ApplyGuardrail` (prompt-attack filter) on the person's words before any model call, and on the untrusted text in every tool result before the model sees it. A block withholds the text and speaks a safe line; a failed check fails closed. | **Live** (guardrail blocked the injected commit message in the demo)                                                                                                                                                                                         |
| Amazon Polly                               | Neural voices Kajal (en-IN) and Joanna (en-US) speak every answer, card taps included; the browser never chooses the text.                                                                                                                    | **Live**                                                                                                                                                                                                                                                     |
| Amazon CloudWatch                          | One `PutMetricData` per turn, namespace `Nightshift`, 5 counts (AgentTurns, ToolCalls, GuardrailBlocks, ModelErrors, PollyCharacters).                                                                                                        | **Live**                                                                                                                                                                                                                                                     |
| AWS IAM, AWS Budgets                       | Role `nightshift-app` with a [least-privilege policy](infra/aws/iam/app-access-policy.json); a $5/month budget whose action attaches a deny-Bedrock/Polly policy to that role.                                                                | **Live**                                                                                                                                                                                                                                                     |
| Amazon Bedrock Converse (Amazon Nova Lite) | The agent's model with tool use: Nightshift's MCP tools become Converse `toolSpec`s.                                                                                                                                                          | **Implemented and unit-tested; live run pending quota.** Every on-demand Bedrock quota on this free-plan project is 0 and not adjustable ([FL-31](docs/friction-log.md#fl-31-every-bedrock-on-demand-quota-is-0-and-not-adjustable-on-a-free-plan-project)). |
| Amazon EC2                                 | A t3.micro deploy path (`infra/aws/ec2/`, `infra/deploy/`, `infra/docker-compose.prod.yml`).                                                                                                                                                  | **Prepared, not deployed**                                                                                                                                                                                                                                   |

Until the Bedrock quota is raised, the model is **Groq `openai/gpt-oss-120b`**, chosen by
`ALEXA_MODEL_PROVIDER`. Switching is one config line (`ALEXA_MODEL_PROVIDER=bedrock`). There is no
silent fallback: the header and the trace panel always name the real model, guardrail and voice.

**Measured cost:** one live conversation (5 questions, 10 model calls) cost **≈ $0.010 of AWS**:
Polly 545 characters ≈ $0.0087, Guardrails ≤ $0.0015, CloudWatch within the free tier. The same
turns on Nova Lite would add about $0.002. Details: [docs/live-run.md](docs/live-run.md). Daily caps
bound the worst case (100 model requests, 300 Polly requests, 40,000 Polly characters per day).
Setup commands: [infra/aws/README.md](infra/aws/README.md).

## How it's built

- **MCP server** (`apps/server`): TypeScript 6 (strict), Node 20+, Express 5, the official MCP
  TypeScript SDK, zod 4, Prisma 7.10 + PostgreSQL (Neon or local), Vitest.
- **MCP 2025-11-25 over Streamable HTTP**, one `/mcp` endpoint (POST, GET, DELETE), stateful
  sessions. The SDK is imported and called at runtime:
  - [`src/mcp/createMcpServer.ts`](apps/server/src/mcp/createMcpServer.ts): `McpServer`;
  - [`src/http/createApp.ts`](apps/server/src/http/createApp.ts): `NodeStreamableHTTPServerTransport`
    (`@modelcontextprotocol/node`), the SDK Host-header guard (`@modelcontextprotocol/express`),
    `isInitializeRequest`;
  - [`src/lib/auth.ts`](apps/server/src/lib/auth.ts): `requireBearerAuth`;
  - [`src/mcp/registerTools.ts`](apps/server/src/mcp/registerTools.ts) and
    [`src/ui/cards.ts`](apps/server/src/ui/cards.ts): `registerAppTool` / `registerAppResource`
    from `@modelcontextprotocol/ext-apps`.
- **Correlation** (`src/domain/correlation/`): evidence from all sources in parallel (partial
  failure is fine) → robust median/MAD change detection → pure rules → ≤ 30-word templates.
- **Simulated Alexa+** (`apps/alexa-sim`): Next.js 16, the MCP client SDK, an agent loop with a
  human-yes guard and grounded speech, Polly, Guardrails, CloudWatch, the cards in sandboxed
  iframes via the ext-apps `AppBridge`.
- **Demo stack** (`apps/demo-target`, `infra/`): a simulated payments service with chaos switches,
  Prometheus rules and Alertmanager, in Docker Compose.

### How the hard requirements are met

| Requirement                                                         | Where / how                                                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| MCP **2025-11-25** over Streamable HTTP, single `/mcp` (POST + GET) | `src/http/createApp.ts`, SDK `NodeStreamableHTTPServerTransport` (stateful). A client asking for a newer revision gets `2025-11-25` back. |
| SDK imported and called at runtime                                  | `McpServer`, `NodeStreamableHTTPServerTransport`, `hostHeaderValidation`, `requireBearerAuth`, `isInitializeRequest`, `registerAppTool`   |
| `Origin` validated on every request, 403 if invalid                 | SDK Host guard + exact `scheme://host:port` Origin allowlist (`src/http/originGuard.ts`)                                                  |
| Bind to 127.0.0.1 locally                                           | `HOST` defaults to `127.0.0.1`                                                                                                            |
| `MCP-Session-Id`                                                    | crypto-random UUIDs; unknown or expired session → 404; `DELETE` ends it; sessions are bound to the token's actor                          |
| `MCP-Protocol-Version`                                              | unsupported → 400 (SDK)                                                                                                                   |
| Auth + roles                                                        | bearer tokens stored as SHA-256, compared in constant time; roles `viewer` / `responder` checked in every tool (`src/tools/runTool.ts`)   |
| Hardening                                                           | 1 MB JSON body limit (413); 20 failed auths per IP per 10 min → 429                                                                       |

Older protocol revisions (2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07) are still accepted during
`initialize`, as the SDK does by default; any other value gets 400.

## Testing

```bash
npm test                  # unit tests, all workspaces; no network, no database
npm run lint && npm run typecheck
npm run test:integration  # against the live Docker stack (npm run stack:up first)
npm run screenshots -w @nightshift/server   # every card in Chromium via a real ext-apps host
```

`npm test` on the submitted commit: **625 tests, all passing**:

| Suite                           | Files | Tests |
| ------------------------------- | ----- | ----- |
| `apps/server` (Vitest)          | 43    | 506   |
| `apps/alexa-sim` (Vitest)       | 4     | 92    |
| `apps/demo-target` (Vitest)     | 3     | 22    |
| `infra/scripts` (`node --test`) | 1     | 5     |

Write tools are tested for the happy path and a viewer (wrong role); the two-phase tools also for
expired and reused confirmations, concurrent confirms and the rate limit. CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs Prettier, ESLint,
`tsc`, all unit tests and gitleaks over the full history on every push. The simulator also has
Playwright end-to-end flows (`apps/alexa-sim/test/e2e/`) that were run against the real stack; see
[docs/live-run.md](docs/live-run.md).

## Limitations

- **Not tested on real Alexa+.** Third-party developers can't connect an MCP server to Alexa+ yet,
  so the voice experience is shown with the simulated Alexa+. Nightshift itself is a standard MCP
  server and works with Claude Code and MCP Inspector.
- **No proactive Alexa+ announcements.** MCP servers can't make Alexa+ speak first; pushes go to
  Telegram ("Ask Alexa: what's wrong?") instead. Tested with a real bot.
- **The live model is Groq, not Bedrock,** until the project's Bedrock quota is raised (FL-31).
  The Bedrock Converse adapter is unit-tested against a fake client only.
- **Single instance only.** MCP sessions, failed-auth counters and the confirm lock live in
  process memory. Scale up, not out.
- **Runs locally; no public deployment.** The EC2 + Caddy path is prepared but not deployed.
- **Security scan coverage depends on config.** Locally, TLS expiry has no target unless
  `SECURITY_DOMAIN` is set, and the GitHub checks need `GITHUB_TOKEN`; skipped checks are reported
  as "didn't run", never as passing.

## Reference

### Demo stack and chaos scenarios

```bash
npm run stack:up       # builds demo-target, starts it with Prometheus and Alertmanager, waits until healthy
npm run stack:status   # health of all three
npm run stack:check    # promtool / amtool validation of the configs
```

| Command                          | What breaks                                                         | Alerts that fire                      |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------- |
| `npm run chaos:provider_outage`  | Razorpay is down: its breaker opens, charges fail                   | `CircuitBreakerOpen`, `HighErrorRate` |
| `npm run chaos:latency_spike`    | 80% of payments requests take 1.2–3 s                               | `HighLatencyP95`                      |
| `npm run chaos:auth_bruteforce`  | ~20 failed logins per second                                        | `AuthFailureSpike`                    |
| `npm run chaos:webhook_spoofing` | ~4 forged webhooks per second fail HMAC                             | `WebhookSignatureFailures`            |
| `npm run chaos:bad_deploy`       | Reports deploy v1.4.2 to Nightshift, then Razorpay fails 60 s later | `CircuitBreakerOpen`, `HighErrorRate` |
| `npm run chaos:security_weak`    | The demo service drops its security headers                         | (found by the security scan)          |
| `npm run chaos:reset`            | Back to healthy (scenarios off, Razorpay active)                    | everything resolves                   |

`npm run demo:prep`, `demo:outage` and `demo:harden` wrap these for a recording.

### Plugging in your own app

Nightshift has no app-specific code. Edit `apps/server/config/nightshift.yaml`: point
`prometheus.url` / `alertmanager.url` at your stack, list your services with aliases, one PromQL per
signal and thresholds, the deploy source (`ingest` from any CI via `POST /events/deploy`, or
`github`), the executors for the three allowlisted actions, and the `security` allowlist (header
URLs, TLS host:port, GitHub repos). Nothing outside that allowlist is ever scanned. Alerts must
carry `service` and `severity` labels.

### How `explain_incident` decides

1. **Evidence:** firing alerts, 60 minutes of error rate, p95 latency, throughput, breaker states
   and auth/webhook failure rates, and deploys, in parallel with timeouts. A source that's down is
   named and skipped.
2. **Change detection:** onset = the start of the most recent sustained rise above
   `max(median + 3 × MAD, threshold)`.
3. **Rules:** a deploy within ±10 minutes of the onset suggests `rollback_deploy`; one provider
   breaker open suggests `failover_provider`; latency up with errors flat is saturation
   (investigate); an auth or webhook-signature spike is a possible attack (investigate only);
   otherwise "no clear cause".
4. **Speech:** server-side templates of at most 30 words; no LLM decides or phrases the diagnosis.
   (A narrator hook exists that would reject any text with a number, time or version not in the
   evidence, but only the templates are used.)

### Security posture checks

| Check                        | What                                                            | Finding severity                                        |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| `tls_expiry`                 | TLS handshake to each `security.tls` host:port                  | <30 days medium, <7 days high, expired/invalid critical |
| `security_headers`           | CSP, HSTS (https only), nosniff, X-Frame-Options, X-Powered-By  | medium / low                                            |
| `dependabot`                 | Open Dependabot alerts for `security.repos`                     | from the advisory                                       |
| `secret_scanning`            | Open secret-scanning alerts for `security.repos`                | high                                                    |
| `auth_failure_spike`         | 15-minute peak of each service's auth-failure rate vs threshold | medium (high at 5x)                                     |
| `webhook_signature_failures` | Same, for webhook HMAC failures                                 | medium (high at 5x)                                     |

Score: 100 minus 40 / 20 / 8 / 3 per open critical / high / medium / low → grade A–F. A finding is
resolved only when its check completed and its target was actually checked, so a timeout never
looks like a fix. No token or a 403/404 from GitHub means "not configured", not a finding.

### MCP Apps cards

Four `ui://nightshift/*` cards (incident, confirmation, security scorecard, ops brief). Card buttons
only ever call `prepare_action`; **Confirm** is the explicit yes that calls `confirm_action`, and the
server re-checks everything. Cards make no network requests (empty resource CSP), and untrusted
text is only inserted as text nodes (ESLint bans `innerHTML` in `src/ui/**`; an injection test runs
in happy-dom and Chromium).

| Incident                                        | Confirmation                                       | Verified                                                  | Ops brief                                |
| ----------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------- |
| ![Incident card](docs/screenshots/incident.png) | ![Confirmation card](docs/screenshots/confirm.png) | ![Verified result](docs/screenshots/confirm-verified.png) | ![Ops brief](docs/screenshots/brief.png) |

### Simulated Alexa+ (`apps/alexa-sim`)

An Echo Show-style web app at `/alexa`: push-to-talk (Web Speech API, Chrome) and a text box,
captions, the cards, Polly voice, and a **"What Nightshift did"** panel listing the model, every
tool call, prepare → your yes → confirm, the measured verification, guardrail blocks and tokens per
turn. The Nightshift token is kept only in server memory. Routes check Host, exact Origin plus a
CSRF token on POST, and Sec-Fetch-Site on GET; pages get a per-request nonce CSP.

```bash
cp apps/alexa-sim/.env.example apps/alexa-sim/.env.local   # every variable is documented there
# set GROQ_API_KEY, BEDROCK_GUARDRAIL_ID/VERSION, DEMO_ADMIN_TOKEN, NIGHTSHIFT_INGEST_TOKEN
aws login --profile nightshift                              # browser sign-in, no keys
AWS_PROFILE=nightshift-app npm run build -w @nightshift/alexa-sim
AWS_PROFILE=nightshift-app npm start -w @nightshift/alexa-sim   # http://127.0.0.1:3002/alexa
```

Cost guards (defaults): 6 tool calls per turn, 40 turns per session, 20 requests per token per 10
minutes, 100 model requests, 300 Polly requests and 40,000 Polly characters per day.

### Proactive alerts (Telegram)

```
Prometheus rule fires → Alertmanager → POST /webhooks/alertmanager → Nightshift → Telegram
```

Alertmanager authenticates with its own bearer token; the payload is zod-validated; the message is
written by Nightshift from the sanitized alert name and service only; at most one message per alert
and status per 5 minutes; each delivery is audited and added to the open incident's timeline. Set
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to enable it.

### Connect other clients

- **MCP Inspector UI:** `npx @modelcontextprotocol/inspector`, transport **Streamable HTTP**, URL
  `http://127.0.0.1:3000/mcp`, header `Authorization: Bearer <token>`. Its origin
  (`http://localhost:6274`) is in `ALLOWED_ORIGINS` by default.
- **Agent Skill:** copy `skills/nightshift-on-call` to `~/.claude/skills/` (or any agent that
  supports the Agent Skills format). A unit test keeps it in sync with the tools.

### Production deployment (prepared, not deployed)

`infra/docker-compose.prod.yml` runs Caddy (the only container publishing ports, automatic HTTPS
and a landing page), Nightshift, alexa-sim, demo-target, Prometheus and Alertmanager on one host.
`infra/deploy/bootstrap.sh`, `up.sh` and `update.sh` set it up on an Ubuntu EC2 instance; see the
comments in those scripts and [infra/aws/README.md](infra/aws/README.md). Run exactly one instance,
and set `TRUST_PROXY=true` behind a proxy.

### Repository layout

```
apps/server/          Nightshift MCP server
  src/http/           Express app, origin guard, session store, deploy ingest, Alertmanager webhook
  src/mcp/            McpServer factory, tool and prompt registration
  src/tools/          one file per tool + the shared runTool adapter
  src/domain/         correlation, actions, posture, incidents (pure logic)
  src/clients/        Prometheus, Alertmanager, GitHub, admin API clients
  src/lib/            auth, roles, audit, rate limiting, untrusted-text handling
  src/notify/         Notifier interface + Telegram
  src/ui/             MCP Apps cards
  config/             nightshift.yaml service catalog
  prisma/             schema and migrations
apps/alexa-sim/       simulated Alexa+ (Next.js): agent loop, MCP client, Polly, Guardrails, UI
apps/demo-target/     simulated payments API with Prometheus metrics and chaos switches
infra/                docker compose (local + prod), Prometheus rules, Alertmanager, Caddy, AWS IAM/budget/guardrail JSON
skills/nightshift-on-call/  Agent Skill
docs/                 friction log, product feedback, live run, submission texts, screenshots
```

## Hackathon documents

- [docs/submission/](docs/submission/): Devpost description, testing instructions, product
  feedback, friction log (top 12), feature requests, built-with list, submission checklist.
- [docs/friction-log.md](docs/friction-log.md): all 32 friction entries.
- [docs/product-feedback.md](docs/product-feedback.md): feedback per tool, SDK and service.
- [docs/live-run.md](docs/live-run.md): the live AWS run with transcript, tokens and cost.

## What's new

Everything in this repository (the MCP server, the simulated Alexa+, the demo service, the
Prometheus/Alertmanager configs, the deploy scripts and CI) was written for this hackathon,
starting 2026-10-14. Third-party software (the MCP TypeScript SDK, Prisma, Express, Next.js,
Prometheus, Alertmanager, Caddy) is used as published.

## License

MIT, see [LICENSE](LICENSE).
