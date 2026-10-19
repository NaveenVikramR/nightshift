# Nightshift tools (reference)

Every tool returns `structuredContent: { speak, data }` (and the same JSON as text).
`speak` is ≤ 30 words, plain English, safe to read aloud. Hosts that support MCP Apps also show
a card for the tools marked with one; the card's buttons go through the same tools.

| Tool                    | Role      | Inputs (all optional unless noted)                      | Card               |
| ----------------------- | --------- | ------------------------------------------------------- | ------------------ |
| `get_ops_brief`         | viewer    | —                                                       | ops brief          |
| `list_active_alerts`    | viewer    | `service`, `severity`, `include_silenced`, `limit`      |                    |
| `explain_incident`      | viewer    | `alert`, `service`, `lookback_minutes`                  | incident           |
| `get_service_health`    | viewer    | `service`                                               |                    |
| `get_recent_deploys`    | viewer    | `service`, `hours`, `limit`                             |                    |
| `acknowledge_alert`     | responder | `alert`                                                 |                    |
| `silence_alert`         | responder | `alert`, `duration_minutes` (required, 1–240)           |                    |
| `prepare_action`        | responder | `suggested_action` or `action` + `service` (+ `params`) | confirmation       |
| `confirm_action`        | responder | `confirmation_id` (required)                            | confirmation       |
| `run_security_scan`     | viewer    | —                                                       | security scorecard |
| `get_security_findings` | viewer    | `severity`                                              | security scorecard |
| `get_incident_timeline` | viewer    | `incident_id`, `service`                                |                    |
| `add_incident_note`     | responder | `note` (required), `incident_id`, `service`, `resolve`  |                    |
| `ping_nightshift`       | viewer    | —                                                       |                    |

Service names are fuzzy ("payments", "the webhook thing"); Nightshift resolves them or asks back.

## Useful `data` fields

- `explain_incident`: `status` (`incident` / `all_clear`), `severity`, `causes[]`
  (`title`, `confidence` 0–1, `evidence[]` with `text` and optional untrusted `quote`,
  `suggestedActions[]`), `series.errorRate` (points, onset), `deploys[]`, `incidentId`.
- `prepare_action`: `confirmationId`, `summary` (`changes`, `affected`, `undo`, `expectedEffect`),
  `expiresAt` (2 minutes).
- `confirm_action`: `status` (`succeeded` / `failed` / `refused`), `verification`
  (`outcome`: `recovered` / `recovering` / `no_improvement` / `unknown`, `before`, `after`,
  `threshold`), `replayed` (true = nothing ran again).
- `run_security_scan`: `grade` A–F, `previousGrade`, `change`, `checks[]` (status per check),
  `open[]`, `resolved[]`.

## Error codes (`data.error`, with `isError: true`)

| Code                                            | Meaning                         | What to do                                      |
| ----------------------------------------------- | ------------------------------- | ----------------------------------------------- |
| `unauthenticated` / `forbidden`                 | missing token / role too low    | say the `speak`; ask a responder                |
| `invalid_input`                                 | bad arguments                   | rephrase, ask the person for the missing detail |
| `confirmation_expired` / `unknown_confirmation` | 2 minutes passed, or wrong id   | prepare again and re-ask                        |
| `rate_limited`                                  | 3 actions in 10 minutes already | wait; investigate instead                       |
| `scan_rate_limited`                             | scanned < 1 minute ago          | use `get_security_findings`                     |
| `internal_error` / `audit_unavailable`          | server problem                  | say so; check state before retrying a write     |

## Connecting

Streamable HTTP, one endpoint, bearer token per person:

```bash
claude mcp add --transport http nightshift https://<your-domain>/mcp \
  --header "Authorization: Bearer <token>"
```
