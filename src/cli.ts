#!/usr/bin/env node
/**
 * iExplore CLI.
 *
 *   npx iexplore list      --vertical car
 *   npx iexplore run       --vertical car --dynamic                 # invent a persona for a learned strategy
 *   npx iexplore run       --vertical car --persona first-car-priya --charter quote-happy-path
 *   npx iexplore learn     runs/   ·   coverage   ·   triage   ·   ado-sync [--apply]   ·   evolve   ·   summarize runs/
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { ROOT, allPersonas, listPersonas, loadCharters, loadConfig, loadPersona, type BotConfig, type Dict } from "./config.js";
import { Knowledge } from "./knowledge.js";
import { findFiles, failing, summarize, writeRun } from "./report.js";
import * as triage from "./triage.js";

type Args = Record<string, any>;

function kbFor(cfg: BotConfig, vertical: string, root?: string): Knowledge {
  const bounds = cfg.target.allow_quote_submission ? [] : cfg.target.boundary_steps;
  return Knowledge.forTarget(root ?? join(ROOT, "knowledge"), cfg.target.id, vertical, bounds, cfg.raw.impact);
}

const fits = (persona: Dict, charter: Dict) => !charter.personas?.length || charter.personas.includes(persona.id);
const pickRandom = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

function pick(vertical: string, rotate: boolean, persona?: string, charter?: string): [string, string] {
  const personas = listPersonas(vertical), charters = loadCharters(vertical);
  if (rotate) { // deterministic per hour so parallel jobs/cron runs spread across the matrix
    const slot = Math.floor(Date.now() / 3_600_000);
    const pairs = personas.flatMap((p) => Object.keys(charters).filter((c) => fits(loadPersona(vertical, p), charters[c])).map((c) => [p, c] as [string, string]));
    return pairs[slot % pairs.length];
  }
  persona ??= pickRandom(personas);
  charter ??= pickRandom(Object.keys(charters).filter((c) => fits(loadPersona(vertical, persona!), charters[c])));
  return [persona, charter];
}

/** Production rate limit, enforced regardless of how often the scheduler fires. */
function rateOk(target: Dict, out: string): boolean {
  const gap = target.min_minutes_between_runs;
  if (!gap) return true;
  const file = join(out, `.last-run-${target.id}`), now = Date.now() / 1000;
  if (existsSync(file) && now - Number(readFileSync(file, "utf8") || 0) < gap * 60) return false;
  mkdirSync(out, { recursive: true });
  writeFileSync(file, String(now));
  return true;
}

async function cmdRun(a: Args): Promise<number> {
  const { BrowserSession } = await import("./browser.js");
  const { PersonaAgent } = await import("./agent.js");
  const cfg = loadConfig(a.config, a.target);
  if (a["start-url"]) cfg.target.start_url = a["start-url"];
  if (!a["dry-run"] && !rateOk(cfg.target, a.out)) {
    console.log(`Skipping: last ${cfg.target.id} run was under ${cfg.target.min_minutes_between_runs} min ago.`);
    return 0;
  }
  let brief: Dict | null = null, strategy = "static", origin = "static", persona: Dict | null = null;
  let personaId: string, charterId: string;
  const kb = a["no-learn"] ? null : kbFor(cfg, a.vertical, a.knowledge);
  if (a.dynamic && kb) {
    const { STRATEGIES, chooseStrategy, designPersona } = await import("./designer.js");
    const [s, why] = a.strategy ? [a.strategy, { reason: "forced" }] : chooseStrategy(kb);
    strategy = s;
    persona = await designPersona(kb, cfg, allPersonas(a.vertical), a.vertical, strategy, !a["dry-run"]);
    personaId = persona.id; charterId = a.charter ?? STRATEGIES[strategy].charter; origin = "dynamic";
    brief = kb.brief();
    console.log(`  strategy: ${strategy} (${why.reason}) -> charter ${charterId}`);
    console.log(`  designed persona: ${persona.name} · ${persona.device} · ${JSON.stringify(persona.interaction)}`);
  } else if (a.adaptive && kb) {
    const plan = a.persona && a.charter ? {} : kb.plan(allPersonas(a.vertical), loadCharters(a.vertical));
    [personaId, charterId] = [a.persona ?? plan.persona, a.charter ?? plan.charter];
    if (!personaId || !charterId) [personaId, charterId] = pick(a.vertical, false, personaId, charterId);
    brief = kb.brief();
    console.log(`  adaptive plan: ${personaId} x ${charterId} (option coverage so far ${Math.round(brief.option_coverage * 100)}%)`);
  } else {
    [personaId, charterId] = pick(a.vertical, !!a.rotate, a.persona, a.charter);
  }
  if (kb && !brief) brief = { quality_bar: kb.qualityBar(cfg.raw.impact?.quality_rules) };
  persona ??= loadPersona(a.vertical, personaId);
  const charter = loadCharters(a.vertical)[charterId];
  if (!charter) throw new Error(`Unknown charter ${charterId}`);
  const device = a.device ?? persona.device ?? "desktop";
  const runId = `${stamp()}-${personaId}-${charterId}`;
  const runDir = join(a.out, runId);
  mkdirSync(runDir, { recursive: true });
  console.log(`▶ ${persona.name} · ${charterId} · ${device} → ${runDir}`);
  if (origin === "dynamic") writeFileSync(join(runDir, "persona.yaml"), YAML.stringify(persona, { lineWidth: 0 }));

  const browser = await new BrowserSession(cfg.target, cfg.browser, device, persona.interaction ?? {}).start();
  let run: Dict;
  try {
    let model;
    if (a["dry-run"]) model = new (await import("./fakeModel.js")).ScriptedModel(browser);
    else { const { ModelClient } = await import("./llm.js"); model = new ModelClient(cfg.provider, cfg.providerSettings, browser.viewport, cfg.model.max_tokens ?? 4096); }
    run = await new PersonaAgent(model, browser, persona, charter, cfg, runDir, runId, brief).run();
  } finally {
    await browser.close();
  }
  Object.assign(run, { strategy, persona_origin: origin });
  if (origin === "dynamic") run.persona_profile = persona;
  const failOn: string[] = cfg.budgets.fail_on ?? ["blocker", "major"];
  writeRun(run, runDir, failOn);
  if (kb) {
    kb.ingestRunDir(runDir);
    kb.save();
    const last = kb.data.runs.at(-1);
    console.log(`  reward ${last.reward}: ${last.new_findings} new finding(s), ${last.new_branches} new branch(es), ${last.new_steps} new step(s)`);
    if (origin === "dynamic" && !a["dry-run"]) {
      const promoted = (await import("./designer.js")).maybePromote(kb, run, a.vertical);
      if (promoted) console.log(`  persona proposed for the permanent set: ${promoted}`);
    }
  }
  console.log(`■ ${run.result.outcome} · ${run.findings.length} finding(s) · report: ${join(runDir, "report.md")}`);
  return a.strict && failing(run, failOn) ? 1 : 0;
}

function cmdList(a: Args): number {
  const charters = loadCharters(a.vertical);
  for (const p of listPersonas(a.vertical)) {
    const persona = loadPersona(a.vertical, p);
    console.log(`${p.padEnd(28)} ${(persona.device ?? "desktop").padEnd(8)} charters: ${Object.keys(charters).filter((c) => fits(persona, charters[c])).join(", ")}`);
  }
  return 0;
}

/** Fold finished run folders into the knowledge base (idempotent). */
function cmdLearn(a: Args): number {
  const cfg = loadConfig(a.config, a.target);
  const kb = kbFor(cfg, a.vertical, a.knowledge);
  let n = 0;
  for (const runs of a._) for (const p of findFiles(runs, "result.json")) n += Number(kb.ingestRunDir(join(p, "..")));
  kb.save();
  console.log(`Learned from ${n} new run(s) -> ${kb.path}`);
  return 0;
}

/** Write coverage.md + coverage.html: hot spots, gaps, finding ledger, journey map. */
function cmdCoverage(a: Args): number {
  const cfg = loadConfig(a.config, a.target);
  const kb = kbFor(cfg, a.vertical, a.knowledge);
  const personas = allPersonas(a.vertical), charters = loadCharters(a.vertical);
  const out = a.out ?? "knowledge";
  mkdirSync(out, { recursive: true });
  const md = kb.renderMarkdown(personas, charters);
  writeFileSync(join(out, "coverage.md"), md);
  writeFileSync(join(out, "coverage.html"), kb.renderHtml(personas, charters));
  console.log(a.print ? md : `Wrote ${join(out, "coverage.md")} and ${join(out, "coverage.html")}`);
  const plan = kb.plan(personas, charters);
  if (plan.persona) console.log(`Next suggested session: ${plan.persona} x ${plan.charter}`);
  return 0;
}

async function cmdEvolve(a: Args): Promise<number> {
  const { proposePersonas } = await import("./evolve.js");
  const cfg = loadConfig(a.config, a.target);
  for (const p of await proposePersonas(cfg, kbFor(cfg, a.vertical, a.knowledge), a.vertical, Number(a.n ?? 3))) console.log(`proposed: ${p}`);
  console.log("Review, then move approved files from proposed/ into the persona folder.");
  return 0;
}

/** Build/refresh the triage register (CSV), triage pack (HTML) and weekly digest from what the bot has learned. */
function cmdTriage(a: Args): number {
  const cfg = loadConfig(a.config, a.target);
  const kb = kbFor(cfg, a.vertical, a.knowledge);
  const out = a.out ?? "triage", name = `${cfg.target.id}-${a.vertical}`, regPath = join(out, `${name}.csv`);
  const evidence = triage.collectEvidence(kb, a.runs?.length ? a.runs : ["runs", "seed/prod-car"], join(out, "evidence"));
  const current = triage.readRegister(regPath);
  kb.applyTriage(current);
  if (a["human-from"] && existsSync(a["human-from"])) {
    // Human edits made on the branch while this run was in progress win.
    for (const [fp, row] of Object.entries(triage.readRegister(a["human-from"]))) {
      const cur = (current[fp] ??= { ...row });
      for (const col of triage.HUMAN_COLS) if (row[col] && row[col] !== "pending") cur[col] = row[col];
    }
  }
  if (a["human-from"]) kb.applyTriage(current);
  const impact = cfg.raw.impact ?? {};
  const cap = Number(impact.weekly_cap ?? 5);
  const reg = triage.merge(kb, current, evidence, cap, undefined, impact.reserved_lanes ?? {});
  kb.save();
  triage.writeRegister(regPath, reg);
  const digest = triage.renderDigest(kb, reg, cap, undefined, kb.qualityBar(impact.quality_rules));
  writeFileSync(join(out, "digest.md"), digest);
  writeFileSync(join(out, `${name}.html`), triage.renderHtml(kb, reg, `iExplore triage: ${cfg.target.name} · ${a.vertical}`, digest));
  const rows = Object.values(reg);
  const q = rows.filter((r) => r.queue === "triage" && r.decision === "pending").length, d = rows.filter((r) => r.queue === "digest").length;
  const c = Object.values<Dict>(kb.data.findings).filter((f) => f.status === "candidate").length;
  console.log(`Register: ${regPath} · ${q} need a decision · ${d} in digest · ${c} candidates awaiting a second sighting\n`
    + `Pack: ${join(out, `${name}.html`)} · Digest: ${join(out, "digest.md")}`);
  for (const e of triage.validate(reg)) console.log("  ! " + e);
  return 0;
}

/** Create ADO Bugs for accepted findings. Dry run unless --apply. */
async function cmdAdoSync(a: Args): Promise<number> {
  const cfg = loadConfig(a.config, a.target);
  const kb = kbFor(cfg, a.vertical, a.knowledge);
  const out = a.out ?? "triage", regPath = join(out, `${cfg.target.id}-${a.vertical}.csv`);
  const reg = triage.readRegister(regPath);
  const errs = triage.validate(reg);
  if (errs.length) { console.log("Fix the register first:\n  " + errs.join("\n  ")); return 2; }
  const adoCfg = cfg.raw.ado ?? {};
  let ado: triage.AdoClient | null = null;
  if (a.apply) {
    const missing = ["org_url", "project"].filter((k) => !adoCfg[k]).concat(process.env.ADO_PAT ? [] : ["ADO_PAT env"]);
    if (missing.length) { console.log("Missing ADO settings: " + missing.join(", ")); return 2; }
    ado = new triage.AdoClient(adoCfg.org_url, adoCfg.project, process.env.ADO_PAT!);
  }
  const log = await triage.sync(reg, kb, ado, adoCfg, out, !a.apply);
  if (a.apply) triage.writeRegister(regPath, reg);
  for (const item of log) {
    console.log(`${item.action.padEnd(16)} ${item.fingerprint}  ${item.ado_id ?? item.title ?? ""}`);
    if (a.verbose && item.patch) console.log(JSON.stringify(item.patch, null, 1).slice(0, 3000));
  }
  console.log(`${log.length} item(s). ${a.apply ? "Applied." : "Dry run: add --apply to create tickets."}`);
  return 0;
}

function cmdSummarize(a: Args): number {
  const cfg = loadConfig(a.config);
  console.log(summarize(a._[0] ?? "runs", cfg.budgets.fail_on ?? ["blocker", "major"]));
  return 0;
}

const COMMON = {
  config: { type: "string" }, vertical: { type: "string", default: "car" }, target: { type: "string" }, knowledge: { type: "string" },
  out: { type: "string" }, help: { type: "boolean", short: "h" },
} as const;
const OPTIONS: Record<string, Dict> = {
  run: { persona: { type: "string" }, charter: { type: "string" }, rotate: { type: "boolean" }, device: { type: "string" },
    "start-url": { type: "string" }, "dry-run": { type: "boolean" }, strict: { type: "boolean" }, adaptive: { type: "boolean" },
    dynamic: { type: "boolean" }, strategy: { type: "string" }, "no-learn": { type: "boolean" } },
  learn: {}, coverage: { print: { type: "boolean" } }, evolve: { n: { type: "string" } },
  triage: { runs: { type: "string", multiple: true }, "human-from": { type: "string" } },
  "ado-sync": { apply: { type: "boolean" }, verbose: { type: "boolean" } }, list: {}, summarize: {},
};
const COMMANDS: Record<string, (a: Args) => number | Promise<number>> = {
  run: cmdRun, learn: cmdLearn, coverage: cmdCoverage, evolve: cmdEvolve, triage: cmdTriage, "ado-sync": cmdAdoSync, list: cmdList, summarize: cmdSummarize,
};
const HELP = `iexplore <command> [options]

  run        one exploratory session   (--dynamic | --adaptive | --persona X --charter Y | --rotate) [--dry-run] [--device mobile]
  learn      fold run folders into the knowledge base   (learn runs/)
  coverage   hot spots, gaps, journey map -> knowledge/coverage.{md,html}
  evolve     propose new personas for untested branches
  triage     refresh triage register (CSV), triage pack (HTML) and weekly digest
  ado-sync   create ADO bugs for accepted findings (dry run unless --apply)
  list       personas and the charters they fit
  summarize  roll up a folder of runs (summarize runs/)

Common: --vertical car  --target prod|uat  --config path  --knowledge dir  --out dir`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || !COMMANDS[cmd]) { console.log(HELP); return cmd ? 2 : 0; }
  const { values, positionals } = parseArgs({ args: rest, options: { ...COMMON, ...OPTIONS[cmd] } as any, allowPositionals: true });
  const a: Args = { ...values, _: positionals };
  if (a.help) { console.log(HELP); return 0; }
  if (cmd === "run") {
    a.out ??= "runs";
    if (a.device && !["desktop", "mobile"].includes(a.device)) throw new Error("--device must be desktop or mobile");
    if (a.strategy && !["explore", "hotspot", "fragility", "recheck", "journey"].includes(a.strategy)) throw new Error("--strategy must be explore|hotspot|fragility|recheck|journey");
  }
  if (cmd === "learn" && !positionals.length) throw new Error("learn needs a runs folder, e.g. iexplore learn runs/");
  return COMMANDS[cmd](a);
}

main().then((code) => process.exit(code), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
