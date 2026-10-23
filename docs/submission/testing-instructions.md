# Testing instructions (local, about 5 minutes)

Demo video: https://youtu.be/wR8AIjl1880. Nightshift runs on your machine; there is no public
endpoint, and no testing credentials are needed: step 3 creates your own tokens. The MCP server and
all 13 tools need no AWS account and no API keys.

**Needs:** Node.js 22.18+ (npm 10+), Docker Desktop (running) and Git. Everything binds to
127.0.0.1. Replace every `<…>` placeholder; no secrets are in the repo.

## 1. Install (≈ 2 min)

```bash
git clone https://github.com/NaveenVikramR/nightshift && cd nightshift
npm install                                         # also generates the Prisma client
cp infra/.env.example infra/.env
cp apps/server/.env.example apps/server/.env
```

## 2. Database and demo stack (≈ 2 min)

In `apps/server/.env` set:

```
DATABASE_URL=postgresql://nightshift:nightshift@127.0.0.1:15432/nightshift
ALLOWED_HOSTS=localhost,127.0.0.1,[::1],host.docker.internal
DEMO_ADMIN_TOKEN=<any random string, 16+ characters>
```

In `infra/.env`, set the same `DEMO_ADMIN_TOKEN=<…>` (Docker Compose refuses to start without it).
Then:

```bash
docker compose -f infra/docker-compose.yml --profile localdb up -d --wait postgres   # local Postgres
npm run db:migrate -w @nightshift/server
npm run stack:up        # demo service :18080, Prometheus :9090, Alertmanager :9093 (healthy = ready)
```

## 3. Tokens (≈ 1 min)

```bash
npm run token:new -- judge responder     # prints <judge-responder-token> + a JSON entry
npm run token:new -- judge-viewer viewer # prints <judge-viewer-token> + a JSON entry
npm run token:new -- chaos-ci ingest     # prints <ingest-token> + a JSON entry
```

- Put the two MCP entries in `NIGHTSHIFT_TOKENS=[…, …]` in `apps/server/.env`.
- Put the ingest entry in `NIGHTSHIFT_INGEST_TOKENS=[…]`.
- Put `<ingest-token>` in `infra/.env` as `NIGHTSHIFT_INGEST_TOKEN`.

Only SHA-256 hashes go in `.env`.

## 4. Run and connect

```bash
npm run dev             # Nightshift on http://127.0.0.1:3000/mcp  (GET /healthz → ok)
```

**MCP Inspector (CLI):**

```bash
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --transport http \
  --header "Authorization: Bearer <judge-responder-token>" --method tools/list
```

**Or Claude Code:**

```bash
claude mcp add --transport http nightshift http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer <judge-responder-token>"
claude mcp get nightshift      # → Connected
```

## 5. Try it

1. Ask "Give me the ops brief."
2. Break the demo service: `npm run demo:outage`. It waits until both alerts fire, about 30–60 s.
3. Ask "What's wrong?". You get a grounded diagnosis: payments API errors, the Razorpay breaker is
   open, and a failover is suggested.
4. Ask "Fail over to Stripe." Nightshift prepares the action and asks for confirmation. Say
   "yes": it executes once and measures the recovery.
5. Ask "Run a security scan." You get a grade from A to F. Then run `npm run chaos:security_weak`
   (the demo service drops its security headers) and scan again a minute later: the grade drops,
   and the findings name the missing headers. `npm run demo:harden` restores them.
6. Ask "What was deployed recently?" and "Show me the incident timeline."
7. Reset with `npm run chaos:reset`.

With `<judge-viewer-token>`, every read works and every write tool refuses.

## Optional: the simulated Alexa+ at /alexa (voice, cards, AWS)

Needs an AWS profile in ap-southeast-2, with a role that can use `bedrock:ApplyGuardrail`,
`polly:SynthesizeSpeech` and `cloudwatch:PutMetricData` (see `infra/aws/`). It also needs a Groq
API key, or a Bedrock model quota.

```bash
cp apps/alexa-sim/.env.example apps/alexa-sim/.env.local
```

In `.env.local`, set:

- `ALEXA_MODEL_PROVIDER=groq` and `GROQ_API_KEY=<groq-key>` (or `ALEXA_MODEL_PROVIDER=bedrock`);
- `BEDROCK_GUARDRAIL_ID=<id>` and `BEDROCK_GUARDRAIL_VERSION=<n>`;
- `DEMO_ADMIN_TOKEN=<same as above>` and `NIGHTSHIFT_INGEST_TOKEN=<ingest-token>`.

Then:

```bash
AWS_PROFILE=<profile> npm run build -w @nightshift/alexa-sim
AWS_PROFILE=<profile> npm start -w @nightshift/alexa-sim   # http://127.0.0.1:3002/alexa
```

Sign in with `<judge-responder-token>`. Use **Demo controls → Provider outage**, then "What's
wrong?" → tap **Fail over to Stripe** → "Yes". **What Nightshift did** shows every MCP call, the
prepare → yes → confirm steps, the measured verification, guardrail blocks and tokens per turn.
The server refuses to start if a provider setting or AWS credentials are missing.

**Checks:** `npm test`, `npm run lint` and `npm run typecheck` need no network or database.
