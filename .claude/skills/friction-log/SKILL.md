---
name: friction-log
description: Use whenever a tool, SDK, API, doc or platform (MCP SDK, MCP Apps, Bedrock, Polly, App Runner, GitHub API, Alexa+) caused confusion, errors, a workaround or wasted time, to record a hackathon friction-log entry and product-feedback notes.
---

# Recording friction (worth up to a 10% judging bonus)

Amazon's reviewers score the friction log, so entries must be specific, honest and actionable.
Record friction **at the moment it happens**, not at the end of the project.

## 1. Append an entry to `docs/friction-log.md`

Use exactly this template (create the file with a `# Friction log` heading if it doesn't exist):

```markdown
## FL-<NN>: <short title>

- **Date:** YYYY-MM-DD
- **Product / tool:** e.g. MCP TypeScript SDK v<x.y.z>, Amazon Bedrock Converse API
- **Task attempted:** what I was trying to do, in one sentence
- **Steps taken:** numbered, exact (commands, doc pages followed, config used)
- **Expected:** what the docs or common sense said would happen
- **Actual:** what really happened (paste the exact error message, trimmed)
- **Severity:** Blocker / High / Medium / Low
- **Time lost:** approximate minutes
- **Workaround:** what I did to get past it (or "none yet")
- **Suggestion:** one concrete, actionable fix for the product team
  (doc change, better error message, missing feature, sample code)
```

## 2. Rules for good entries

- One problem per entry. Number entries sequentially.
- Always include version numbers and the exact error text. Never include secrets, tokens or keys.
- Severity guide: Blocker = couldn't proceed; High = needed a non-obvious workaround or >1h lost;
  Medium = confusing docs or 15–60 min lost; Low = papercut.
- The suggestion must be something the team could actually ship. Avoid "make it better".
- Positive notes go in product feedback, not the friction log.

## 3. Also update `docs/product-feedback.md`

Keep one section per tool/API/SDK used, with these headings (the submission form asks for them):

- What I used it for
- What worked well
- What needs work (link the related FL-<NN> entries)
- Onboarding (zero to hello world: how long, what helped, what hurt)
- Would I build with it again? Yes/No and why
- For AWS services: which service and exactly how it's used (needed for the AWS Builder mini challenge)

## 4. Known entries to watch for in this project

- MCP servers cannot trigger proactive Alexa+ announcements (we push via Telegram instead).
- No way to test against real Alexa+ as a third-party developer; we simulate it.
- Any mismatch between the MCP spec and SDK behaviour (sessions, protocol-version header, SSE).
- MCP Apps rendering differences between clients.
