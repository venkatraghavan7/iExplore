/**
 * Dynamic personas: each session invents the person most likely to find something new.
 *
 * 1. Choose a STRATEGY with a multi-armed bandit (UCB1) over past reward: explore, hotspot, fragility, recheck, journey.
 * 2. DESIGN a persona for it from the learned context (Claude writes one realistic person plus an interaction profile
 *    the browser applies for real: network/CPU throttling, typing speed). Heuristic fallback without a model.
 * 3. SANITISE in code: fictional test data, no rego, bounded interaction settings.
 * 4. After the run, high-reward personas are proposed to personas/<v>/proposed/ for a human to promote.
 */
import YAML from "yaml";
import type { BotConfig, Dict } from "./config.js";
import { FICTIONAL_MOBILES, TEST_EMAIL, YAML_BLOCK, dumpYaml, writeProposals } from "./evolve.js";
import type { Knowledge } from "./knowledge.js";
import { ModelClient } from "./llm.js";

export const STRATEGIES: Record<string, { charter: string; goal: string }> = {
  explore: { charter: "coverage-sweep", goal: "take branches that are untested or only tested once, especially near hot or fragile steps" },
  hotspot: { charter: "hot-spot-deep-dive", goal: "dig into the steps where problems cluster, varying inputs and order to expose root causes" },
  fragility: { charter: "fragility-probe", goal: "stress fragile steps the way real people do: fast typing, slow connections, double-clicks, back and refresh" },
  recheck: { charter: "regression-recheck", goal: "re-verify known open findings on their steps and record whether they still reproduce" },
  journey: { charter: "quote-happy-path", goal: "a new kind of customer end to end, judging copy, trust and flow with fresh eyes" },
};
const TYPING = ["slow", "normal", "fast"], NETWORK = ["none", "fast-3g", "slow-3g"];
export const PROMOTE_REWARD = 5.0;

/** Small seedable PRNG (mulberry32) so --seed makes designs reproducible. */
export class Rng {
  private s: number;
  constructor(seed?: number) { this.s = (seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0; }
  random() { let t = (this.s = (this.s + 0x6d2b79f5) >>> 0); t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  choice<T>(xs: T[]): T { return xs[Math.floor(this.random() * xs.length)]; }
}

/** UCB1 over strategy reward, with context: skip recheck when nothing is open, de-weight explore at high coverage. */
export function chooseStrategy(kb: Knowledge, rng = new Rng(), c = 1.2): [string, Dict] {
  const stats = kb.strategyStats(), g = kb.gaps();
  const eligible = Object.keys(STRATEGIES).filter((s) => !(s === "recheck" && kb.openFindings(100).length === 0));
  const untried = eligible.filter((s) => !stats[s]?.n);
  if (untried.length) {
    const order = ["explore", "fragility", "hotspot", "recheck", "journey"];
    return [untried.sort((a, b) => order.indexOf(a) - order.indexOf(b))[0], { reason: "not tried yet", ucb: null }];
  }
  const total = eligible.reduce((a, s) => a + stats[s].n, 0);
  const bestMean = Math.max(...eligible.map((s) => stats[s].mean)) || 1;
  const scores: Record<string, number> = {};
  for (const s of eligible) {
    let score = stats[s].mean / bestMean + c * Math.sqrt(Math.log(total) / stats[s].n);
    if (s === "explore") score *= 1 - 0.6 * g.option_coverage; // fewer gaps -> explore less
    if (s === "fragility" && kb.fragility(1).length) score *= 1.2;
    if (s === "hotspot" && kb.hotSpots(1).length) score *= 1.1;
    scores[s] = Math.round((score + rng.random() * 1e-3) * 1000) / 1000;
  }
  const pick = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  return [pick, { reason: "bandit (UCB1)", scores }];
}

function schemaExample(statics: Record<string, Dict>): string {
  const { status: _s, ...ex } = Object.values(statics)[0] ?? {};
  ex.interaction = { typing_speed: "fast", network: "none", cpu_slowdown: 1, habits: ["double-clicks buttons", "uses the browser back button"] };
  ex.focus = ["/car-insurance/journey/<step>: why this person will stress it"];
  return dumpYaml(ex);
}

export function buildDesignPrompt(kb: Knowledge, strategy: string, statics: Record<string, Dict>, vertical: string): string {
  const b = kb.brief();
  const lib: Record<string, Dict> = kb.data.persona_library ?? {};
  const used = kb.data.runs.slice(-12).map((r: Dict) => `- ${r.persona} (${r.device}, ${r.strategy}): reward ${r.reward}`).join("\n") || "- none yet";
  const best = Object.entries(lib).sort((a, b2) => b2[1].reward - a[1].reward).slice(0, 5).map(([k, v]) => `- ${k} (reward ${v.reward}): ${String(v.summary).slice(0, 160)}`).join("\n") || "- none yet";
  const fmt = (items: Dict[] = [], f: (x: Dict) => string) => items.map(f).join("\n") || "- none";
  return `You design ONE synthetic customer persona for an exploratory test session of an Australian ${vertical}
insurance comparison journey. The session's strategy is **${strategy}**: ${STRATEGIES[strategy].goal}.

What the bot has learned so far (branch coverage ${Math.round(b.option_coverage * 100)}%):

Fragile steps:
${fmt(b.fragile_steps, (f) => `- [${f.step}] ${f.question} (${f.why})`)}

Hot spots:
${fmt(b.hot_spots, (h) => `- [${h.step}] ${h.question} (${h.why})`)}

Weak pathways (untested near trouble, or tested once):
${fmt(b.weak_pathways, (w) => `- [${w.step}] ${w.question} -> "${w.option}" (${w.why})`)}

Untested branches:
${fmt(b.untried_branches, (u) => `- [${u.step}] ${u.question} -> "${u.option}"`)}

Known open findings:
${fmt(b.known_findings, (f) => `- ${f.fingerprint} [${f.severity}] [${f.step}] ${f.title}`)}

Recent sessions (avoid repeating the same kind of person):
${used}

Best-performing invented personas so far:
${best}

Design a realistic, specific Australian person (not a test-case list) whose genuine circumstances, abilities and
habits make them hit the targets above for this strategy. Give a believable reason for every unusual answer.
Vary age, device, ability, language confidence and life situation versus recent sessions.

Set \`interaction\`: typing_speed (slow|normal|fast), network (none|fast-3g|slow-3g), cpu_slowdown (1-6), habits
(realistic behaviours like double-clicking, back button, refreshing, keyboard-only, zoomed text). For the
fragility strategy, choose settings that stress the fragile steps. Set \`focus\`: 3-6 lines naming the target
steps and why this person will stress them.

Test data must be fictional: last_name "Testpersona", email ${TEST_EMAIL}. No vehicle rego.
Use exactly this YAML schema:
\`\`\`yaml
${schemaExample(statics)}\`\`\`
Return only one \`\`\`yaml block.`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function sanitise(input: Dict, vertical: string, strategy: string, seq: number): Dict {
  const p: Dict = { ...(input ?? {}) };
  const d = new Date();
  const stamp = `${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slug = String(p.id || p.name || "persona").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/, "");
  Object.assign(p, { id: `dyn-${stamp}-${slug}`, vertical, origin: "dynamic", strategy, device: ["desktop", "mobile"].includes(p.device) ? p.device : "desktop" });
  p.name ??= slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  p.summary ??= ""; p.traits ??= {}; p.behaviours ??= [];
  if (p.vehicle && typeof p.vehicle === "object") delete p.vehicle.rego;
  const td: Dict = p.test_data && typeof p.test_data === "object" ? { ...p.test_data } : {};
  Object.assign(td, { last_name: "Testpersona", email: TEST_EMAIL, mobile: FICTIONAL_MOBILES[seq % FICTIONAL_MOBILES.length] });
  td.first_name ??= String(p.name).split(/\s+/)[0].slice(0, 20);
  p.test_data = td;
  const ix: Dict = p.interaction && typeof p.interaction === "object" ? { ...p.interaction } : {};
  ix.typing_speed = TYPING.includes(ix.typing_speed) ? ix.typing_speed : "normal";
  ix.network = NETWORK.includes(ix.network) ? ix.network : "none";
  const cpu = parseInt(ix.cpu_slowdown ?? 1, 10);
  ix.cpu_slowdown = Number.isFinite(cpu) ? Math.max(1, Math.min(6, cpu)) : 1;
  ix.habits = (Array.isArray(ix.habits) ? ix.habits : []).map((h: unknown) => String(h).slice(0, 80)).slice(0, 6);
  p.interaction = ix;
  p.focus = (Array.isArray(p.focus) ? p.focus : []).map((f: unknown) => String(f).slice(0, 200)).slice(0, 6);
  return p;
}

/** No-model fallback: remix an existing persona and point it at the learned targets. */
export function heuristicPersona(kb: Knowledge, strategy: string, statics: Record<string, Dict>, rng: Rng): Dict {
  const base: Dict = structuredClone(rng.choice(Object.values(statics)));
  const b = kb.brief();
  const targets: string[] = {
    explore: b.weak_pathways.slice(0, 4).map((w: Dict) => `${w.step}: answer "${w.option}" (${w.why})`),
    hotspot: b.hot_spots.slice(0, 4).map((h: Dict) => `${h.step}: ${h.why}`),
    fragility: b.fragile_steps.slice(0, 4).map((f: Dict) => `${f.step}: ${f.why}`),
    recheck: b.known_findings.slice(0, 5).map((f: Dict) => `${f.step}: re-check ${f.fingerprint} ${String(f.title).slice(0, 60)}`),
    journey: ["whole journey with fresh eyes: copy, trust, consent, layout"],
  }[strategy] ?? [];
  if (strategy === "explore" && !targets.length) targets.push(...b.untried_branches.slice(0, 4).map((u: Dict) => `${u.step}: answer "${u.option}"`));
  if (strategy === "fragility" && !targets.length) targets.push(...b.hot_spots.slice(0, 4).map((h: Dict) => `${h.step}: stress with fast input and back/refresh`));
  const plain = { typing_speed: "normal", network: "none", cpu_slowdown: 1, habits: [] as string[] };
  const interaction: Dict = ({
    explore: plain, recheck: plain,
    hotspot: { ...plain, habits: ["re-reads and edits answers"] },
    fragility: { typing_speed: "fast", network: rng.choice(["fast-3g", "slow-3g"]), cpu_slowdown: rng.choice([2, 4]),
      habits: ["double-clicks buttons", "uses the browser back button", "refreshes when the page is slow"] },
    journey: { ...plain, typing_speed: rng.choice(["slow", "normal"]) },
  } as Record<string, Dict>)[strategy] ?? plain;
  Object.assign(base, {
    id: `${base.id}-${strategy}`, name: `${base.name} (${strategy} variant)`,
    device: ["fragility", "journey"].includes(strategy) ? rng.choice(["desktop", "mobile"]) : base.device ?? "desktop",
    summary: `${base.summary ?? ""} This session they ${STRATEGIES[strategy].goal}.`, interaction, focus: targets,
  });
  return base;
}

export async function designPersona(kb: Knowledge, cfg: BotConfig, statics: Record<string, Dict>, vertical: string, strategy: string,
                                    useModel = true, seed?: number): Promise<Dict> {
  const rng = new Rng(seed);
  const seq = kb.data.runs.length;
  if (useModel) {
    try {
      const mc = new ModelClient(cfg.provider, cfg.providerSettings, [1280, 800], 3000);
      const text = await mc.complete(buildDesignPrompt(kb, strategy, statics, vertical), 3000);
      const m = [...text.matchAll(YAML_BLOCK)][0];
      const p = m ? YAML.parse(m[1]) : null;
      if (p && typeof p === "object" && p.summary) return sanitise(p, vertical, strategy, seq);
    } catch (e) { console.log(`  persona designer fell back to heuristic: ${String(e).slice(0, 120)}`); }
  }
  return sanitise(heuristicPersona(kb, strategy, statics, rng), vertical, strategy, seq);
}

/** High-reward dynamic personas are proposed (not auto-added) for the permanent set. */
export function maybePromote(kb: Knowledge, run: Dict, vertical: string): string | null {
  const last: Dict = kb.data.runs.at(-1) ?? {};
  const prof = run.persona_profile;
  if (run.persona_origin !== "dynamic" || !prof || (last.reward ?? 0) < PROMOTE_REWARD) return null;
  const p = { ...prof, status: "proposed", promoted_because: `reward ${last.reward} in run ${run.run_id} (${last.new_findings} new findings)` };
  return writeProposals([p], vertical)[0];
}
