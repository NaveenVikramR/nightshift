# Devpost submission checklist

Deadline: **Oct 23, 2026, 12:00 PM PT** (Oct 24, 00:30 IST). Paste each field from the file named.

| Devpost field                | Value / paste from                                                                                                                                                                                                                        | Done |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Project name                 | `Nightshift`                                                                                                                                                                                                                              | [ ]  |
| Tagline                      | `Voice on-call & security copilot for Alexa+ — open MCP server`                                                                                                                                                                           | [ ]  |
| Track                        | **Alexa+**                                                                                                                                                                                                                                | [ ]  |
| Mini challenge               | **AWS Builder**                                                                                                                                                                                                                           | [ ]  |
| Project story / description  | [description.md](description.md) (everything below the title)                                                                                                                                                                             | [ ]  |
| Built with                   | [built-with.md](built-with.md)                                                                                                                                                                                                            | [ ]  |
| Demo video URL               | https://youtu.be/wR8AIjl1880 (public, under 3 minutes)                                                                                                                                                                                    | [ ]  |
| Code repository URL          | https://github.com/NaveenVikramR/nightshift (public, MIT)                                                                                                                                                                                 | [ ]  |
| Testing instructions         | [testing-instructions.md](testing-instructions.md)                                                                                                                                                                                        | [ ]  |
| Testing credentials          | None needed: judges create their own tokens with `npm run token:new` (step 3 of the testing instructions)                                                                                                                                 | [ ]  |
| Product feedback             | [product-feedback.md](product-feedback.md)                                                                                                                                                                                                | [ ]  |
| Friction log                 | [friction-log.md](friction-log.md) (top 12; the full log is [docs/friction-log.md](../friction-log.md))                                                                                                                                   | [ ]  |
| Feature requests             | [feature-requests.md](feature-requests.md)                                                                                                                                                                                                | [ ]  |
| What's new vs pre-existing   | "Everything in the repository was written for this hackathon, starting 2026-10-14 (first commit). Third-party libraries and tools (MCP TypeScript SDK, Prisma, Express, Next.js, Prometheus, Alertmanager, Caddy) are used as published." | [ ]  |
| Image gallery                | `docs/screenshots/alexa-2-incident.png`, `alexa-3-confirm.png`, `alexa-7-security.png`, `alexa-8-guardrail.png`                                                                                                                           | [ ]  |
| AWS services used (if asked) | Amazon Bedrock Guardrails, Amazon Polly, Amazon CloudWatch, AWS IAM, AWS Budgets (live); Amazon Bedrock Converse with Nova Lite (implemented, pending quota). See the AWS section of [description.md](description.md)                     | [ ]  |

## Before pressing Submit

- [ ] The video plays logged out and is public: https://youtu.be/wR8AIjl1880
- [ ] The repo is public and GitHub shows the MIT licence.
- [ ] CI is green on the last commit of `main`.
- [ ] Release `v1.0.0-hackathon` exists.
- [ ] Every field above is filled; the preview shows the video embed.
