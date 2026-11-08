# iExplore: design

> TypeScript port of persona-bot (same design, same knowledge format). Code lives in `src/`.

Always-on exploratory UAT testing. Claude plays a realistic customer persona, looks at the site through screenshots,
drives it with mouse and keyboard, and reports what's broken, confusing or untrustworthy.

## Why computer use over scripted Playwright (and why Playwright is still here)

| | Scripted Playwright (POM) | Computer use (this bot) |
|---|---|---|
| Finds | Regressions in paths you already wrote | Things nobody wrote a test for: odd copy, layout breaks, confusing flows, inconsistent numbers |
| Breaks when | Selectors/DOM change | Rarely; it reads the screen like a person |
| Judges | Exact assertions | Visual and semantic judgement, plus telemetry |
| Cost per run | ~free | Model tokens (screenshots dominate) |
| Determinism | High | Low by design: it explores |

**Recommendation:** use both. Keep the existing Playwright suite as the deterministic regression gate in the pipeline.
Use this bot for continuous exploratory coverage between releases and as the source of new test ideas.

In this bot Playwright is only the **hands and eyes**: it opens a headless Chromium, takes screenshots, and replays
Claude's pixel-level clicks and keystrokes with `page.mouse` / `page.keyboard`. There are no selectors and no page
objects. That gives you:

- headless, containerised runs (no VNC/Xvfb desktop needed), so it fits GitHub Actions and the Kubernetes platform
- real network/console telemetry as a second oracle next to vision
- hard guardrails at the network layer (blocked hosts, stop pages, blocked API calls)
- device emulation (mobile personas) and 2x pixel density for sharp `zoom`

A full virtual desktop is only worth it if you need to test outside the browser (native apps, OS dialogs).

## Architecture

```
            ┌──────────────── schedule (cron hourly / ECS always-on) ────────────────┐
            ▼                                                                         │
  persona_bot run --rotate                                                            │
     │  picks persona x charter (personas/car/*.yaml, charters/car.yaml)              │
     ▼                                                                                │
  PersonaAgent loop ──► ModelClient ──► Anthropic API (computer_toolset_20260801)     │
     │      ▲                     └──► Amazon Bedrock AU (computer_20251124 beta)     │
     │      │ screenshots / results                                                   │
     ▼      │                                                                         │
  BrowserSession (Playwright, headless Chromium)                                      │
     ├─ executes clicks/typing/scroll/zoom                                            │
     ├─ guardrails: host allowlist, stop_url_patterns, blocked_request_patterns       │
     └─ telemetry: console errors, 4xx/5xx, slow calls, a11y basics                   │
     ▼                                                                                │
  runs/<id>/ report.md · findings.json · junit.xml · trace.jsonl · shots/  ───────────┘
     └─► GitHub step summary + artifact  (next: ADO bug per blocker/major finding)
```

## Components

| File | Role |
|---|---|
| `src/llm.ts` | Provider adapter. Same `ToolCall` shape for the GA toolset (Anthropic API) and the beta single tool (Bedrock). Switching provider is config only. |
| `src/browser.ts` | Playwright executor, guardrails, telemetry. |
| `src/agent.ts` | Agent loop: batching, stop-on-first-failure rule, screenshot history trimming, budgets, recorder. |
| `src/tools.ts` | Custom tools: `navigate`, `page_signals`, `read_page_text`, `report_finding`, `finish_mission`. |
| `src/prompts.ts` | System prompt: persona + test data + charter + rules of engagement. |
| `personas/<vertical>/*.yaml` | Who the customer is: situation, device, traits, behaviours, test data. |
| `charters/<vertical>.yaml` | What to explore and the oracles for spotting a defect. |
| `config/bot.yaml` | Target, guardrails, model/provider, budgets, devices. |

## How it's "smart"

1. **Persona-driven behaviour.** Patience, reading style, device and habits change what it clicks and notices
   (Margaret hesitates at phone-number fields; Daniel refreshes mid-flow; Mei compares card vs detail prices).
2. **Charters and oracles.** Each session has a mission, focus areas and explicit "how would I know it's wrong"
   heuristics (consistency with earlier answers, card vs detail, disclosures present, etc.).
3. **Two oracles.** Vision (what a customer sees) and telemetry (what they don't). A page that looks fine but
   throws a 500 is still a finding.
4. **Structured findings.** Severity, category, step, observed vs expected, repro steps, persona impact,
   confidence, and an auto-attached screenshot.
5. **Persona verdict.** Each run ends with "would this person continue?", a cheap conversion-risk signal.

## Learning loop: coverage, hot spots, gaps

Every session is instrumented automatically, without relying on the model to report what it did:

- **Journey map.** Each URL path is a step. The bot records the step heading, every option shown, which control
  each click actually landed on (read from the DOM just before the click), time on step, actions and errors.
  Typed values are never stored, only their length. Steps link into a graph of step → next step via option.
- **Finding ledger.** Findings are deduplicated across runs (same step, similar wording) into fingerprints
  (`K001`...), with occurrences, first/last seen, personas affected and re-check status.
- **Hot spots** score each step on severity-weighted open findings × recurrence, plus friction (errors, unusual
  dwell or action counts) and technical signals (console errors, failed and slow requests).
- **Gaps:** branches shown but never taken, steps rarely visited, steps never seen on a device, and persona ×
  charter pairs never run. Long pick-lists (makes, years, colours) and free-text fields don't count as branches.
  Steps the bot is told to stop at (contact details on prod) are not gaps.
- **Adaptive runs** (`run --adaptive`): the knowledge base picks the next persona × charter, favouring novelty,
  the weaker device and a `coverage-sweep` when many branches are untried. It also injects a
  `<learned_context>` brief into the prompt:
  - untried branches to take where they fit the persona
  - hot spots to slow down on
  - known findings to re-check, using `verify_known_finding`, without re-reporting them

  Findings that can't be reproduced become `not_reproduced`; with a ticket, that flags it `possibly_fixed`.
- **Dynamic personas** (`run --dynamic`, the default in CI): every session invents its own persona.
  1. **Strategy.** A bandit (UCB1) over past reward picks one of:
     - `explore`: untested and weak branches
     - `hotspot`: dig into problem clusters
     - `fragility`: fast typing, slow-3G, CPU throttling, double-clicks, back and refresh
     - `recheck`: re-verify known findings
     - `journey`: fresh eyes end to end

     Context adjusts the pick: explore fades as coverage rises; recheck is skipped when nothing is open.
  2. **Design.** Claude designs a realistic person for that strategy from the learned context (fragile steps,
     hot spots, weak pathways, untested branches, known findings, recent personas, best past personas). The
     result is a persona file plus an `interaction` profile and `focus` steps. Network and CPU throttling are
     applied for real through Chrome DevTools, and typing speed changes the keystroke timing.
  3. **Sanitise.** Code enforces fictional data, no rego, a valid device and bounded settings, whatever the
     model wrote. If the model call fails, a heuristic designer remixes a fixed persona instead.
  4. **Reward.** Each session is scored: new findings weighted by severity, plus new branches, new steps and
     re-check results. The score updates the strategy stats and the persona library. Personas scoring ≥ 5 are
     written to `personas/<vertical>/proposed/` (in CI, `personas-proposed/` on the `bot-knowledge` branch) for
     you to promote into the fixed set.
- **Fragility** per step blends errors, drop-offs (sessions ending there blocked or abandoned), erratic timing
  (variation in time on step), flaky findings (re-checks that flip between still present and not reproduced),
  and failing or slow calls.
- **Weak pathways** are branches tested only once, and untested branches next to hot or fragile steps.
- **Persona evolution** (`evolve`): Claude proposes new, realistic personas whose real situation takes the
  untested branches (leased car, foreign licence, business-only use). They are written to
  `personas/<vertical>/proposed/` for human review and never run until moved into the persona folder.

Outputs: `knowledge/<target>-<vertical>.json` (state), `knowledge/coverage.md` and `coverage.html` (heatmap of steps
with tested and untested branches). In CI this lives on the `bot-knowledge` branch, so bot commits never touch `main`.

## Signal over noise

The bot runs often; people's attention doesn't scale. Three mechanisms keep what reaches people small and worth it.

1. **Impact score (0-100)** = severity × reach × business risk × confidence × recurrence.
   - **Reach:** the share of customers who get to the step. Estimated from journey position until funnel data
     replaces it (`impact.reach` in config). Journey-wide issues count as 100%.
   - **Business risk:** data and pricing, and trust and consent, rank highest; copy and visual issues rank lowest.
     Words such as premium, excess, claim, consent, PDS and lost raise it.
2. **Second sighting.** A new agent finding is a `candidate` until another session reproduces it. That can be a
   re-check by a different persona, which candidates get first, or a fresh report. Blockers, axe results and
   human-observed findings are confirmed at once. Candidates never reach triage, so one-off model misreads die quietly.
3. **Weekly cap and digest.** At most `impact.weekly_cap` (default 5) new confirmed findings join the
   **triage queue** each ISO week, highest impact first; blockers and escalated rejects bypass the cap.
   Everything else sits in the **digest**, grouped by category, and competes again next week.
   `triage/digest.md` is the weekly one-pager:
   - what needs a decision
   - what's below the line
   - what's waiting for a second sighting
   - what's possibly fixed
   - the **triage acceptance rate**: a target of 50% or higher; lower means it's too noisy

**Quality bar learned from triage.**
- **Decisions flow back.** Every `triage` run reads the decisions in the register back into the knowledge base.
- **Rejections stay rejected.** A rejected finding is never re-raised unless its severity rises; if it does, it
  comes back flagged `escalated`.
- **Rejection reasons become rules.** The `notes` on a rejected row become "Not wanted: …" rules in the agent's
  prompt.
- **Weak categories are throttled.** A category the team rarely accepts (fewer than 30% of 4 or more decisions)
  is limited to major findings or worse.
- **Standing rules.** Team rules in `impact.quality_rules` apply on top.

**Deterministic accessibility.**
- **Scan.** axe-core 4.14 (vendored, MPL-2.0) runs WCAG 2.x A/AA checks once per journey step.
- **Grouping.** Violations become one finding per rule, listing every step it fails on, with axe's suggested fix.
- **Weighting.** These findings are confirmed immediately but weighted mid-tier: axe's "critical" describes the
  element, not the business. Raise `RISK["accessibility"]` if accessibility compliance is a priority.
- **Split with the agent.** The agent is told to leave rule checks to the scanner and report only what a scanner
  can't see: keyboard traps, focus order, meaning lost without sight.
- **Fixes on tickets.** Suggested fixes, from axe or from the agent, appear in the triage pack and in each ADO
  Bug, alongside the impact score.

## Triage → Azure DevOps

1. `triage` merges the ledger into `triage/<target>-<vertical>.csv` and writes a triage pack
   (`triage/<target>-<vertical>.html`): problem areas first, then one card per finding with evidence and the
   proposed ticket. One screenshot per finding is kept in `triage/evidence/`.
2. People triage in the CSV (Excel, or edit on the `bot-knowledge` branch). Set `decision` to `accept`,
   `reject`, `duplicate` (with `duplicate_of`) or `needs-info`, and optionally `priority`, `area_path`,
   `assigned_to` and `notes`. The bot refreshes its own columns every run and never overwrites these human
   columns, including edits made while a run is in progress.
3. `ado-sync` (dry run by default, `--apply` to create): one **Bug** per accepted row without an `ado_id`.
   Each Bug gets the title, HTML repro steps, severity mapped to ADO (`blocker` → 1 - Critical … `cosmetic` → 4 - Low),
   priority, area/iteration path, tags `iexplore; iexplore-K001; <category>; target-prod`, and the evidence
   screenshot attached. It writes back `ado_id` and `ado_url`.
   - **Idempotent:** it skips rows with an id and checks ADO for the fingerprint tag before creating anything.
   - **Auth:** a PAT with *Work Items: Read & Write* in `ADO_PAT`.
   - **Where to run it:** the `ado-sync` workflow (manual, with an apply toggle).

## Compute and cost

The model runs on Anthropic's API or on Bedrock, so no GPUs are needed. The runner only hosts headless
Chromium plus a small Node process.

| | Per session | Hourly schedule |
|---|---|---|
| CPU / memory | ~2 vCPU, 4 GB | same, one at a time |
| Wall time | 10-15 min (prod pages are slow) | ~4-6 h/day |
| Tokens | screenshots dominate; recorded in every report | set a budget after the first real runs |

Hosting options:

1. **GitHub-hosted runner:** zero ops, per-minute billing, prod only (can't reach internal UAT).
2. **Self-hosted runner on Unicorn/EKS:** reaches UAT, Bedrock through the pod's IAM role, stays in your account.
3. **Scheduled ECS Fargate task:** pay per run.

**Decision (6 Nov 2026):** run on GitHub-hosted runners (option 1) for the pilot, against production.
Move to a self-hosted runner on EKS (option 2) once the code and findings quality are signed off.
The move is one repository variable, `RUNNER_LABEL`. No code changes.

Token cost is the bigger lever. `keep_screenshots`, `max_turns`, time boxes and Sonnet as the default keep it bounded.

## Moving to iCompare (GitHub + Bedrock)

1. Enable the Claude model in Bedrock (ap-southeast-2) and note the AU inference profile ID.
   Confirm it supports `computer_20251124`. Current docs list Opus/Sonnet/Haiku 5.5 on Bedrock.
2. IAM role trusted by GitHub OIDC, scoped to `bedrock:InvokeModel` on that profile.
   Repo variable `AWS_BEDROCK_ROLE_ARN`.
3. Repo variables: `IEXPLORE_START_URL`, `IEXPLORE_HOST`, `BEDROCK_MODEL_ID`, `IEXPLORE_PROVIDER=bedrock`,
   optionally `RUNNER_LABEL` for a self-hosted runner that can reach UAT.
4. Fill in the real UAT `blocked_request_patterns` (lead hand-off, purchase, CRM/email triggers) and test regos.
5. WAF/bot protection: allowlist the `CTM-PersonaBot` user-agent suffix or the runner egress IPs; exclude
   `X-Synthetic-Test` traffic from analytics.

For true always-on (rather than hourly), run the same container as a long-running ECS/K8s worker that loops over the
rotation with a pause between sessions.

## Cost control

- Only the newest `keep_screenshots` (default 3) images are kept in context.
- System prompt and toolset definition are cached (`cache_control`).
- Per-charter `max_turns` and `time_box_minutes`; global `max_input_tokens`.
- Default model is Sonnet; use Opus for deeper exploratory charters if the findings justify it.
- Tokens per run are in every report, so you can set a monthly budget from real data.

## Synthetic traffic tagging

Every page the bot loads carries `?automated-test=true`, the parameter agreed with Nathan Handy (Nov 2026) so
production synthetic traffic is filtered out of analytics and commercial reporting. The same pattern is used
across the test kits.

- **How it's added:** to the start URL and every `navigate`. Any untagged full-page GET navigation on our hosts
  (links, redirects, `location.href`) is answered with a 302 to the tagged URL, so the tag survives however the
  page was reached.
- **Verified on prod (8 Nov 2026):** the site reads the parameter on landing and sets an `automated-test=true`
  cookie that rides along with every later request, so the journey stays tagged even where its URLs drop the
  parameter. The bot counts a step as tagged if either the URL or the cookie carries the marker.
- **Client-side routes:** route changes inside the app (`history.pushState`) don't hit the network. Each report
  lists steps where the tag dropped off the URL. If analytics needs the tag on every route, rather than only the
  landing page or session, set `tag_spa_routes: true` (or `IEXPLORE_TAG_SPA_ROUTES=true`) to keep it on those
  routes too.
- **Why a query parameter:** Cloudflare and internal-IP filtering exist, but the parameter is more reliable because
  it travels with the test wherever it runs. The `CTM-PersonaBot` user-agent suffix stays as a secondary marker.

## Safety

- UAT only, with test data from the persona file (`persona-bot+<run>@example.com`).
- Network-level blocks on hosts outside the allowlist, stop pages and blocked API calls. These hold even if the model
  is misled, and they are logged as guardrail events.
- Page text is treated as data, not instructions (prompt-injection rule). Anthropic also scans screenshots for injection.
- No credentials in prompts. Basic auth is handled by the browser context.

## Roadmap

- [x] ADO Boards: triage register + idempotent Bug creation with evidence (`triage`, `ado-sync`)
- [x] Learning loop: journey map, coverage gaps, hot spots, adaptive planning, persona evolution
- [ ] Post occurrence updates and `possibly_fixed` as comments on existing ADO bugs
- [ ] Teams/Slack digest of the hourly summary
- [ ] Other verticals: `personas/pet`, `charters/pet.yaml`, etc. No code changes needed
- [ ] Hand confirmed findings to the agentic Playwright harness to turn into deterministic regression tests
- [ ] Trend view over time: coverage %, open findings and "would continue" rate per week
