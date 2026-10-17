# Product feedback

One section per tool, API or SDK used. Friction details live in [friction-log.md](friction-log.md).

## MCP TypeScript SDK (v2: `@modelcontextprotocol/server` 2.3.1, `/node` 2.1.1, `/express` 2.0.2)

- **What I used it for:** The whole MCP layer of Nightshift: `McpServer` + `registerTool`
  (Standard Schema input schemas), the stateful `NodeStreamableHTTPServerTransport` on a single
  `/mcp` endpoint, `hostHeaderValidation` / `localhostHostValidation` (DNS-rebinding guard),
  `requireBearerAuth` with a custom `OAuthTokenVerifier`, and `isInitializeRequest`. (Day 1
  used `createMcpExpressApp`; Day 2 replaced it with an explicit chain, see FL-09.)
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
  - No hook sees every `tools/call`: validation failures and unknown tools are answered before
    any server code runs, so auditing them needs a workaround (FL-08). The Standard Schema
    design did make that workaround clean: listing and validation are separate functions.
  - `createMcpExpressApp` can't be combined with middleware that must run first (FL-09).
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
- **Day 3 end-to-end ("What's wrong?" then "Why do you think that?"):**
  - **Choice:** it picked `explain_incident` on its own.
  - **Answer:** its answer stayed within the returned evidence.
  - **The follow-up:** it separated what the data showed from what it was guessing, and flagged a real
    timeline oddity (an earlier staged spike).
  - **One misreading:** it read our downsampled card points as raw data ("90 s gaps"). We fixed that
    on our side by labelling the sampling in `data`.
  - **Lesson:** tool output that will be reasoned over needs to say what it is.
- **Day 4 end-to-end (two-phase remediation):**
  - **Asked first:** after "Fail over to Stripe" it called `prepare_action`, passing the
    `explain_incident` suggestion through unchanged, and asked before acting. `confirm_action` only
    ran after "Yes".
  - **Viewer:** a viewer token was refused at `prepare_action`. Claude Code explicitly declined to work
    around it (for example, by calling the admin API directly).
  - **Session binding:** `claude -p --resume` starts a new MCP session, so a confirmation bound to the
    first session would be refused by design. Multi-turn checks therefore need one process with
    `--input-format stream-json`.
- **Onboarding:** About 2 minutes.
- **Would I build with it again?** Yes.

## GitHub REST API (deployments, deployment statuses, Git commits)

- **What I used it for:** An optional deploy-history source for `get_recent_deploys` and
  `explain_incident`, used when a service sets `deploys: { source: github }`.
- **What worked well:**
  - Fine-grained tokens scoped to one repo, read-only.
  - `X-GitHub-Api-Version` pins behaviour.
  - Status states map cleanly to success, failure and in progress.
- **What needs work:** A deployment has no commit message or "went live" time, so N deploys cost
  1 + 2N calls, and `/commits/{sha}` returns full diffs (FL-12).
- **Onboarding:** Docs are clear per endpoint, but nothing explains how to get "recent deploys
  with messages" end to end.
- **Would I build with it again?** Yes, but most teams will find CI-pushed deploy events (our
  `POST /events/deploy`) simpler and cheaper.

## Prometheus 3.15 (HTTP API: instant and range queries)

- **What I used it for:**
  - `/api/v1/query` for live health.
  - `/api/v1/query_range` (60 min at 30 s steps) as evidence for change detection.
- **What worked well:** It's one API for any app. Plugging in another app only means writing
  PromQL in the catalog.
- **What needs work:**
  - `rate(...[1m])` makes error onsets trail the real change by up to about 30 s, so correlation
    has to allow for that.
  - `histogram_quantile` over idle windows returns `NaN` (as a string), so every consumer must
    drop non-finite values.
- **Onboarding:** About 30 minutes, including the compose stack.
- **Would I build with it again?** Yes.

## Alertmanager 0.34 (API v2)

- **What I used it for:** Listing active alerts, and creating silences for `silence_alert`.
- **What worked well:** Fingerprints are stable, silences are easy to create, and `silencedBy` makes
  state obvious.
- **What needs work:** There's no acknowledgement concept, so ack lives in our database. Alert
  annotations are free text that the API passes through unescaped, and we must treat them as
  untrusted.
- **Onboarding:** About 15 minutes.
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

## Docker Desktop 4.89.0 (WSL 2 backend)

- **What I used it for:** Running the local demo stack (demo-target, Prometheus, Alertmanager)
  with `docker compose`, and the `promtool` / `amtool` config checks.
- **What worked well:**
  - `docker compose up --wait` with healthchecks gives a reliable "stack is ready" signal.
  - `restart: unless-stopped` brought the containers back by itself after Docker restarted.
- **What needs work:**
  - After the disk image location changed, Docker ran on a new empty disk with no warning, so the
    stack looked deleted (FL-10).
  - The engine hung when the C: drive filled up, with no clear error.
- **Onboarding:** Already installed; writing the compose stack took about 30 minutes.
- **Would I build with it again?** Yes for local stacks, but I now run `npm run stack:status`
  before trusting it.

## AWS services

Not used yet (Bedrock, Polly and App Runner arrive with the Alexa+ simulator and deployment).
