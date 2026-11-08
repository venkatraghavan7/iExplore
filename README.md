# iExplore

Always-on exploratory UAT testing for Compare the Market, in TypeScript. Claude plays a realistic customer
(pilot vertical: **car**), uses the site through screenshots, mouse and keyboard (computer use), learns where
the journey is weak, and turns the problems that matter into a triage list and Azure DevOps bugs.

This is the TypeScript port of [persona-bot](https://github.com/venkatraghavan7/persona-bot): same design, same
knowledge-base format, same reports. Playwright runs the browser, Claude decides what to do.

- [DESIGN.md](DESIGN.md): architecture, computer use vs Playwright, Bedrock path, noise control
- [docs/guide.html](docs/guide.html): the illustrated field guide

## Quick start

```bash
npm ci
npx playwright install chromium        # or IEXPLORE_BROWSER_CHANNEL=chrome to use installed Chrome

# 1. Plumbing test: no API calls, against the bundled mock site with planted defects
npm run mock &
IEXPLORE_START_URL=http://localhost:8765/car-insurance/ IEXPLORE_HOST=localhost \
  npx iexplore run --target uat --persona first-car-priya --charter quote-happy-path --dry-run

# 2. Real run against production comparethemarket.com.au (default target, Anthropic API)
export ANTHROPIC_API_KEY=...
npx iexplore run --dynamic                       # invent a persona for the learned strategy (CI default)

# 3. Same on Bedrock (AWS creds from your normal chain / SSO / OIDC)
export IEXPLORE_PROVIDER=bedrock BEDROCK_MODEL_ID=<au-inference-profile-id>
npx iexplore run --dynamic
```

`npx iexplore` runs the compiled CLI after `npm run build`; during development use `npm run iexplore -- <command>`
(or `npx tsx src/cli.ts <command>`).

## Commands

```bash
npx iexplore list                                 # personas and the charters each can run
npx iexplore run --dynamic --strategy fragility   # force a strategy: explore|hotspot|fragility|recheck|journey
npx iexplore run --adaptive                       # knowledge base picks a fixed persona/charter + focus brief
npx iexplore run --persona family-mei --charter results-scrutiny --device mobile
npx iexplore learn runs/                          # fold run folders into knowledge/ (idempotent)
npx iexplore coverage                             # knowledge/coverage.md + coverage.html
npx iexplore evolve --n 3                         # propose personas for untested branches
npx iexplore triage                               # triage/prod-car.csv (edit `decision`), .html, digest.md
npx iexplore ado-sync                             # dry run: the Bugs it would create
ADO_PAT=... ADO_ORG_URL=https://dev.azure.com/<org> ADO_PROJECT=<project> npx iexplore ado-sync --apply
npx iexplore summarize runs/                      # SUMMARY.md + junit-all.xml across runs
```

`--strict` exits 1 on blocker/major findings. `npm test` runs the unit tests; `npm run typecheck` checks types.

## How it stays useful, not noisy

- **Second sighting:** new findings are candidates until seen again (blockers, axe and human-observed ones count at once).
- **Impact score 0–100:** severity × reach × business risk × confidence × recurrence.
- **Weekly cap:** at most 5 new findings a week reach the triage queue, plus 1 reserved accessibility slot.
- **Quality bar:** rejected findings and low-acceptance categories become rules the agent follows next time.

## Code map

| File | What it does |
|---|---|
| `src/cli.ts` | commands, rate limit, run orchestration |
| `src/agent.ts` | the loop: screenshot → Claude → action; budgets, history trimming, axe grouping |
| `src/browser.ts` | Playwright executor, guardrails, synthetic tag, throttling, journey tracking, axe-core |
| `src/llm.ts` | Anthropic API (`computer_toolset_20260801`) and Bedrock (`computer_20251124`) adapter |
| `src/prompts.ts`, `src/tools.ts` | system prompt (prod rules, learned context) and custom tools |
| `src/knowledge.ts` | journey map, finding ledger, hot spots, fragility, gaps, impact, plan |
| `src/designer.ts`, `src/evolve.ts` | UCB1 strategy choice, dynamic personas, persona proposals |
| `src/triage.ts` | triage register (CSV), digest, triage pack, ADO client |
| `src/report.ts` | per-run report.md, junit.xml, summary |
| `src/fakeModel.ts`, `mock_site/` | scripted model and mock site for zero-cost dry runs |

## Production mode (default target)

- **No contact details, no real quotes (default).** Explores up to the contact-details step, reviews it, stops.
  Set `IEXPLORE_ALLOW_SUBMISSION=true` only once synthetic quotes are excluded downstream.
- **No rego lookups;** cars are chosen manually. **Fictional data only** (ACMA fiction phone range, `example.com`).
- **Every request tagged `?automated-test=true`** so analytics can filter it; the report shows any untagged step.
- **At most one session per hour**, and payment, checkout and insurer hand-off are blocked at the network layer.

## CI

- `.github/workflows/iexplore.yml`: one session on a GitHub-hosted runner, then coverage + triage, saved to the
  `bot-knowledge` branch. Manual for now; the hourly cron is commented out.
- `.github/workflows/ado-sync.yml`: creates bugs for accepted rows (dry run unless `apply`).
- `.github/workflows/ci.yml`: typecheck, unit tests and a mock-site dry run on every push.

Secrets/vars: `ANTHROPIC_API_KEY` or `AWS_BEDROCK_ROLE_ARN` + `BEDROCK_MODEL_ID`; `ADO_PAT`, `ADO_ORG_URL`, `ADO_PROJECT`.
