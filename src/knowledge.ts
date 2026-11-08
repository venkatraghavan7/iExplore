/**
 * What the bot has learned across runs.
 *
 * One JSON file per target+vertical (knowledge/<target>-<vertical>.json) holding:
 *   steps     the journey map, discovered automatically: every step (URL path) seen, its heading, every option shown,
 *             how often each option was chosen, who/what device visited, dwell time, errors and technical signals.
 *   edges     step -> step transitions and the option that led there.
 *   findings  a deduplicated ledger: each issue once, with occurrences, first/last seen, status and triage.
 *   runs      a short history of sessions (persona, charter, device, outcome, reward).
 *
 * Derived: hotSpots(), fragility(), weakPathways(), gaps(), plan(), brief(), impact().
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Dict } from "./config.js";

export const SEV_W: Record<string, number> = { blocker: 10, major: 5, minor: 2, cosmetic: 1, observation: 0.5 };
const NAV_LABELS = new Set(["back", "next", "next step", "close", "?", "menu", "continue", "skip"]);
const STOP = new Set("a an the of on in to is are be and or for with when not no it its this that as at by from".split(" "));
const PICK_LIST = 12; // steps with more choices than this (makes, years, colours) are pick-lists, not branches

const now = () => Math.round(Date.now() / 100) / 10;
export const round = (x: number, n = 2) => { const p = 10 ** n; return Math.round(x * p) / p; };
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pstdev = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const last = <T>(xs: T[], fallback: T) => (xs.length ? xs[xs.length - 1] : fallback);
const tail = <T>(xs: T[], n: number) => xs.slice(-n);

export class Counter<K> extends Map<K, number> {
  constructor(items: Iterable<K> = []) { super(); for (const k of items) this.inc(k); }
  inc(k: K, n = 1) { this.set(k, (this.get(k) ?? 0) + n); return this; }
  n(k: K) { return this.get(k) ?? 0; }
  mostCommon(top?: number): [K, number][] { const e = [...this.entries()].sort((a, b) => b[1] - a[1]); return top === undefined ? e : e.slice(0, top); }
}

export function tokens(text: string): Set<string> {
  return new Set(((text || "").toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => !STOP.has(w) && w.length > 2));
}
function jaccard(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / new Set([...a, ...b]).size;
}
const isNav = (label: string) => { const l = label.toLowerCase().trim(); return NAV_LABELS.has(l) || l.startsWith("‹") || l === "< back"; };

/** Options that count as journey branches: not navigation, not free-text fields, not long pick-lists. */
export function branches(st: Dict): Record<string, Dict> {
  const opts = Object.fromEntries(Object.entries(st.options as Record<string, Dict>).filter(([l]) => !isNav(l) && !l.startsWith("field:")));
  return Object.keys(opts).length > PICK_LIST ? {} : opts;
}

/** JSON with sorted keys, like Python's json.dumps(sort_keys=True). */
export function stableStringify(v: unknown, indent = 1): string {
  const sort = (x: any): any => Array.isArray(x) ? x.map(sort)
    : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x;
  return JSON.stringify(sort(v), null, indent);
}

export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (x: number) => `${Math.round(x * 100)}%`;

const RISK: Record<string, number> = { data: 1.0, trust: 1.0, functional: 0.9, accessibility: 0.6, performance: 0.6, usability: 0.6, content: 0.45, visual: 0.3 };
const RISK_WORDS = ["consent", "privacy", "pds", "general advice", "disclos", "premium", "price", "excess", "claim", "date of birth", "dob", "lost", "wrong", "scrambl", "double", "duplicate"];

export class Knowledge {
  data: Dict;
  readonly boundary: RegExp[];
  constructor(readonly path: string, target: string, vertical: string, boundarySteps: string[] = [], readonly impactCfg: Dict = {}) {
    this.boundary = (boundarySteps ?? []).map((b) => new RegExp(b));
    this.impactCfg ??= {};
    this.data = { version: 1, target, vertical, updated: null, ingested: [], runs: [], steps: {}, edges: {}, findings: {} };
    if (existsSync(path)) Object.assign(this.data, JSON.parse(readFileSync(path, "utf8")));
  }

  static forTarget(root: string, target: string, vertical: string, boundarySteps?: string[], impactCfg?: Dict) {
    return new Knowledge(join(root, `${target}-${vertical}.json`), target, vertical, boundarySteps, impactCfg);
  }

  inScope(key: string) { return !this.boundary.some((b) => b.test(key)); }

  save() {
    this.data.updated = now();
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, stableStringify(this.data));
  }

  // ------------------------------------------------------------------ ingest
  ingestRunDir(runDir: string): boolean {
    const resP = join(runDir, "result.json"), traceP = join(runDir, "trace.jsonl");
    if (!existsSync(resP)) return false;
    const run = JSON.parse(readFileSync(resP, "utf8"));
    if (this.data.ingested.includes(run.run_id)) return false;
    const events = existsSync(traceP) ? readFileSync(traceP, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
    this.ingest(run, events);
    return true;
  }

  private chosenSet(): Set<string> {
    const s = new Set<string>();
    for (const [k, st] of Object.entries<Dict>(this.data.steps)) for (const [l, o] of Object.entries<Dict>(st.options)) if (o.chosen) s.add(`${k}\u0000${l}`);
    return s;
  }

  ingest(run: Dict, events: Dict[]) {
    const d = this.data, rid = run.run_id, t = now();
    const beforeSteps = new Set(Object.keys(d.steps)), beforeChosen = this.chosenSet(), beforeFindings = new Set(Object.keys(d.findings));
    const persona = run.persona ?? null, device = run.device ?? null;
    const visited: string[] = [];

    for (const ev of events) {
      if (ev.kind !== "step") continue;
      const key = ev.step;
      visited.push(key);
      const st = (d.steps[key] ??= { headings: [], visits: 0, personas: {}, devices: {}, options: {}, dwell: [], actions: [], errors: 0,
        signals: { console: 0, failed: 0, slow: 0 }, first_seen: t, last_seen: t });
      st.visits += 1; st.last_seen = t;
      if (ev.heading && !st.headings.includes(ev.heading)) st.headings = tail([...st.headings, ev.heading], 3);
      st.personas[persona] = (st.personas[persona] ?? 0) + 1;
      st.devices[device] = (st.devices[device] ?? 0) + 1;
      for (const o of ev.options ?? []) (st.options[o] ??= { seen: 0, chosen: 0 }).seen += 1;
      for (const c of ev.chosen ?? []) (st.options[c] ??= { seen: 1, chosen: 0 }).chosen += 1;
      st.dwell = tail([...st.dwell, ev.dwell_s ?? 0], 50);
      st.actions = tail([...st.actions, ev.actions ?? 0], 50);
      st.errors += ev.errors ?? 0;
      if (ev.from) {
        const e = (d.edges[`${ev.from}>>${key}`] ??= { n: 0, via: {} });
        e.n += 1;
        if (ev.via) e.via[ev.via] = (e.via[ev.via] ?? 0) + 1;
      }
    }

    const tel = run.telemetry ?? {};
    for (const [kind, items] of [["console", tel.console_errors ?? []], ["failed", tel.failed_requests ?? []], ["slow", tel.slow_requests ?? []]] as const)
      for (const it of items) if (it.page && d.steps[it.page]) d.steps[it.page].signals[kind] += 1;

    for (const f of run.findings ?? []) this.mergeFinding(f, rid, persona, t, !!run.human_observed);
    for (const chk of run.rechecks ?? []) {
      const led = d.findings[chk.fingerprint];
      if (!led) continue;
      led.rechecks = tail([...(led.rechecks ?? []), { run: rid, t, ...chk }], 10);
      led.status = chk.status === "still_present" ? "open" : led.status === "open" ? "not_reproduced" : "candidate";
      if (chk.status === "still_present") led.last_seen = t;
    }

    // What did this session add? Used to learn which strategies and personas pay off.
    const newFindings = Object.keys(d.findings).filter((k) => !beforeFindings.has(k)).map((k) => d.findings[k]);
    const newSteps = Object.keys(d.steps).filter((k) => !beforeSteps.has(k)).length;
    const newBranches = [...this.chosenSet()].filter((x) => !beforeChosen.has(x)).length;
    const confirmed = (run.rechecks ?? []).filter((c: Dict) => c.status === "still_present").length;
    const cleared = (run.rechecks ?? []).filter((c: Dict) => c.status === "not_reproduced").length;
    const reward = round(newFindings.reduce((a, f) => a + (SEV_W[f.severity] ?? 1), 0) + 0.5 * newBranches + newSteps + 0.3 * confirmed + 0.5 * cleared);
    const strategy = run.strategy || "static";
    const ss = ((d.strategies ??= {})[strategy] ??= { n: 0, reward: 0, best: 0 });
    ss.n += 1; ss.reward = round(ss.reward + reward); ss.best = Math.max(ss.best, reward);
    if (run.persona_origin === "dynamic" && run.persona_profile) {
      const lib = (d.persona_library ??= {});
      lib[run.persona] = { strategy, reward, t, run: rid, summary: (run.persona_profile.summary ?? "").slice(0, 300), device: run.device,
        interaction: run.persona_profile.interaction ?? {}, profile: run.persona_profile };
      const keys = Object.keys(lib);
      if (keys.length > 200) for (const k of keys.sort((a, b) => lib[a].reward - lib[b].reward).slice(0, keys.length - 200)) delete lib[k];
    }

    d.runs = tail([...d.runs, {
      run_id: rid, t, persona, charter: run.charter ?? null, device, outcome: run.result?.outcome ?? null,
      findings: (run.findings ?? []).length, steps: visited.length, furthest: visited.length ? last(visited, null) : null,
      would_continue: run.result?.would_persona_continue ?? null, strategy, persona_origin: run.persona_origin ?? "static", reward,
      new_findings: newFindings.length, new_branches: newBranches, new_steps: newSteps,
    }], 500);
    d.ingested = tail([...d.ingested, rid], 2000);
  }

  /** Fold one finding into the ledger. New findings start as `candidate` until seen a second time, confirmed by a
   *  re-check, deterministic (axe), human-observed, or a blocker. */
  mergeFinding(f: Dict, rid: string, persona: string | null, t: number, human = false): string {
    const led = this.data.findings;
    const step = f.step_key || f.step || "";
    const toks = tokens(`${f.title ?? ""} ${f.observed ?? ""}`);
    let best: string | null = null, bestScore = 0;
    for (const [fp, ex] of Object.entries<Dict>(led)) {
      if (f.dedup_key && ex.dedup_key === f.dedup_key) { best = fp; bestScore = 1; break; }
      if (ex.step !== step || ex.dedup_key) continue;
      let score = jaccard(toks, new Set(ex.tokens));
      if (ex.category === f.category) score += 0.15;
      if (score > bestScore) { best = fp; bestScore = score; }
    }
    if (best && bestScore >= 0.45) {
      const ex = led[best];
      ex.occurrences += 1; ex.last_seen = t;
      ex.runs = tail([...ex.runs, rid], 20);
      ex.personas = [...new Set([...ex.personas.filter(Boolean), persona].filter(Boolean))].sort();
      ex.confidence = Math.max(ex.confidence ?? 0.5, Number(f.confidence || 0.5));
      if (f.source === "axe") { ex.title = f.title; ex.observed = f.observed ?? null; ex.step = step; } // scanner facts: keep latest wording
      if (["candidate", "not_reproduced"].includes(ex.status)) ex.status = "open";           // second sighting confirms it
      if (f.screenshot) ex.screenshot = `${rid}/${f.screenshot}`;
      if (f.suggested_fix && !ex.suggested_fix) ex.suggested_fix = f.suggested_fix;
      if ((SEV_W[f.severity] ?? 0) > (SEV_W[ex.severity] ?? 0)) {
        ex.severity = f.severity;
        if (ex.triage === "reject" && SEV_W[ex.severity] > (SEV_W[ex.rejected_at_severity] ?? 0)) { ex.triage = "pending"; ex.escalated = true; }
      }
      return best;
    }
    const fp = `K${String(Object.keys(led).length + 1).padStart(3, "0")}`;
    const confirmed = human || f.source === "axe" || f.severity === "blocker";
    led[fp] = {
      title: f.title ?? null, severity: f.severity ?? "minor", category: f.category ?? null, step, observed: f.observed ?? null,
      expected: f.expected ?? null, tokens: [...toks].sort(), occurrences: 1, first_seen: t, last_seen: t, runs: [rid],
      personas: persona ? [persona] : [], status: confirmed ? "open" : "candidate", rechecks: [], repro_steps: f.repro_steps ?? [],
      confidence: Number(f.confidence || 0.5), source: f.source ?? "agent", dedup_key: f.dedup_key ?? null,
      suggested_fix: f.suggested_fix ?? null, triage: "pending", screenshot: f.screenshot ? `${rid}/${f.screenshot}` : null,
    };
    return fp;
  }

  // ------------------------------------------------------------- impact
  /** Share of customers who reach a step (0-1). Configured values win; otherwise estimated from position. */
  reach(step: string): number {
    if (step.endsWith("*")) return 1.0; // journey-wide issue: every customer meets it
    for (const [rx, v] of Object.entries(this.impactCfg.reach ?? {})) if (new RegExp(rx).test(step)) return Number(v);
    const order = this.stepOrder();
    const i = order.indexOf(step);
    if (i >= 0 && order.length > 1) return round(1 - (0.6 * i) / (order.length - 1)); // 100% at entry -> 40% at the end
    return 0.6;
  }

  risk(f: Dict): number {
    let base = RISK[f.category ?? ""] ?? 0.5;
    const text = `${f.title ?? ""} ${f.observed ?? ""}`.toLowerCase();
    if (RISK_WORDS.some((w) => text.includes(w))) base = Math.max(base, 0.95);
    return base;
  }

  /** 0-100: severity x reach x business risk x confidence x recurrence. */
  impact(f: Dict): number {
    const conf = 0.5 + 0.5 * Math.min(Math.max(f.confidence ?? 0.5, 0), 1);
    const rec = 1 + 0.25 * Math.log(Math.max(f.occurrences ?? 1, 1));
    const raw = (SEV_W[f.severity] ?? 1) * this.reach(f.step) * this.risk(f) * conf * rec;
    return round(Math.min(100, raw * 10), 1);
  }

  // ------------------------------------------------------------- triage feedback / quality bar
  /** Pull human decisions back into the ledger so the bot learns what the team wants. */
  applyTriage(register: Record<string, Dict>) {
    for (const [fp, r] of Object.entries(register)) {
      const led = this.data.findings[fp];
      if (!led) continue;
      const dec = r.decision || "pending";
      if (dec === "reject" && led.triage !== "reject") led.rejected_at_severity = led.severity;
      if (!(led.escalated && dec === "reject" && led.triage === "pending")) led.triage = dec;
      if (dec !== "reject") delete led.escalated;
      led.triage_note = r.notes || "";
      if (r.ado_id) led.ado_id = r.ado_id;
    }
  }

  qualityBar(extraRules: string[] = [], maxLearned = 12): string[] {
    const rules = [...(extraRules ?? [])];
    const f = Object.values<Dict>(this.data.findings);
    const rejected = f.filter((v) => v.triage === "reject").sort((a, b) => b.last_seen - a.last_seen);
    for (const v of rejected.slice(0, maxLearned))
      rules.push(`Not wanted: "${v.title}" (${v.category} at ${v.step}).` + (v.triage_note ? ` Reason: ${v.triage_note}` : ""));
    const decided = new Counter(f.filter((v) => ["accept", "reject", "duplicate"].includes(v.triage)).map((v) => `${v.category}\u0000${v.triage}`));
    for (const cat of new Set([...decided.keys()].map((k) => k.split("\u0000")[0]))) {
      const n = ["accept", "reject", "duplicate"].reduce((a, dd) => a + decided.n(`${cat}\u0000${dd}`), 0);
      const acc = decided.n(`${cat}\u0000accept`);
      if (n >= 4 && acc / n < 0.3) rules.push(`The team rarely accepts ${cat} findings (${acc}/${n}). Only report ${cat} issues that are major or worse.`);
    }
    return rules;
  }

  // ------------------------------------------------------------- analysis
  hotSpots(top = 10): Dict[] {
    const steps: Record<string, Dict> = this.data.steps, findings: Record<string, Dict> = this.data.findings;
    if (!Object.keys(steps).length) return [];
    const medDwell = median(Object.values(steps).filter((s) => s.dwell.length).map((s) => median(s.dwell)));
    const medActs = median(Object.values(steps).filter((s) => s.actions.length).map((s) => median(s.actions)));
    const out: Dict[] = [];
    for (const [key, st] of Object.entries(steps)) {
      const openF = Object.entries(findings).filter(([, f]) => f.step === key && ["open", "candidate"].includes(f.status) && f.triage !== "reject");
      const fScore = openF.reduce((a, [, f]) => a + (SEV_W[f.severity] ?? 1) * (1 + Math.log(f.occurrences)) * (f.status === "candidate" ? 0.5 : 1), 0);
      const v = Math.max(st.visits, 1), sig = st.signals;
      const sScore = (0.1 * sig.console + 0.5 * sig.failed + 0.3 * sig.slow) / v;
      const dwell = median(st.dwell), acts = median(st.actions);
      let friction = (2 * st.errors) / v;
      friction += medDwell && dwell > 2 * medDwell ? 1 : 0;
      friction += medActs && acts > 2 * medActs ? 1 : 0;
      const score = round(fScore + sScore + friction);
      if (score <= 0) continue;
      const reasons: string[] = [];
      if (openF.length) {
        const worst = openF.reduce((a, b) => (SEV_W[b[1].severity] > SEV_W[a[1].severity] ? b : a))[1].severity;
        reasons.push(`${openF.length} open finding(s), worst ${worst}`);
      }
      if (friction) reasons.push("friction (errors / slow / many actions)");
      if (sScore) reasons.push("technical signals");
      out.push({ step: key, heading: last(st.headings, ""), score, visits: st.visits, reasons, findings: openF.map(([k]) => k) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, top);
  }

  /** Steps that behave inconsistently: errors, drop-offs, erratic timing, flaky findings, failing calls. */
  fragility(top = 10): Dict[] {
    const steps: Record<string, Dict> = this.data.steps, findings = Object.values<Dict>(this.data.findings);
    const dropped = new Counter(this.data.runs.filter((r: Dict) => r.furthest && ["blocked", "abandoned", "incomplete"].includes(r.outcome)).map((r: Dict) => r.furthest));
    const out: Dict[] = [];
    for (const [key, st] of Object.entries(steps)) {
      const v = Math.max(st.visits, 1);
      const dw = st.dwell.filter((x: number) => x);
      const cv = dw.length >= 2 && mean(dw) ? pstdev(dw) / mean(dw) : 0;
      const flaky = findings.filter((f) => f.step === key && new Set((f.rechecks ?? []).map((c: Dict) => c.status)).size > 1).length;
      const parts: Record<string, number> = {
        errors: (2 * st.errors) / v, drop_off: (3 * dropped.n(key)) / v, erratic_timing: Math.min(cv, 2) * 0.5,
        flaky_findings: 1.5 * flaky, failing_calls: (st.signals.failed + 0.5 * st.signals.slow) / v,
      };
      const score = round(Object.values(parts).reduce((a, b) => a + b, 0));
      if (score > 0.25) out.push({ step: key, heading: last(st.headings, ""), score,
        why: Object.entries(parts).sort((a, b) => b[1] - a[1]).filter(([, x]) => x > 0.2).map(([k]) => k.replace(/_/g, " ")) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, top);
  }

  /** Branches tested only once (low confidence), and untried branches next to hot or fragile steps. */
  weakPathways(top = 10): Dict[] {
    const steps: Record<string, Dict> = this.data.steps;
    const risky = new Set([...this.hotSpots(8).map((h) => h.step), ...this.fragility(8).map((f) => f.step)]);
    const near = new Set<string>();
    for (const e of Object.keys(this.data.edges)) { const [a, b] = e.split(">>"); if (risky.has(a) || risky.has(b)) { near.add(a); near.add(b); } }
    const out: Dict[] = [];
    for (const [key, st] of Object.entries(steps)) {
      if (!this.inScope(key)) continue;
      for (const [label, o] of Object.entries(branches(st))) {
        if (o.chosen === 1) out.push({ step: key, question: last(st.headings, ""), option: label, why: "tested only once" });
        else if (o.chosen === 0 && near.has(key)) out.push({ step: key, question: last(st.headings, ""), option: label, why: "untested, next to a hot or fragile step" });
      }
    }
    const nearWhy = "untested, next to a hot or fragile step";
    out.sort((a, b) => Number(a.why !== nearWhy) - Number(b.why !== nearWhy) || (a.step < b.step ? -1 : a.step > b.step ? 1 : 0));
    return out.slice(0, top);
  }

  strategyStats(): Record<string, Dict> {
    return Object.fromEntries(Object.entries<Dict>(this.data.strategies ?? {}).map(([k, v]) => [k, { ...v, mean: v.n ? round(v.reward / v.n) : 0 }]));
  }

  gaps(personas?: Record<string, Dict>, charters?: Record<string, Dict>): Dict {
    const steps: Record<string, Dict> = this.data.steps;
    const untried: Dict[] = [];
    let totalOpts = 0;
    for (const [key, st] of Object.entries(steps)) {
      if (!this.inScope(key)) continue;
      const br = branches(st), n = Object.keys(br).length;
      totalOpts += n;
      for (const [label, o] of Object.entries(br))
        if (o.chosen === 0) untried.push({ step: key, heading: last(st.headings, ""), option: label, times_shown: o.seen, step_visits: st.visits, step_options: n });
    }
    // Short decision questions first: their branches change the journey; long lists are variations of one path.
    untried.sort((a, b) => Number(a.step_options > 6) - Number(b.step_options > 6) || a.step_options - b.step_options
      || b.step_visits - a.step_visits || (a.step < b.step ? -1 : a.step > b.step ? 1 : 0));
    const thin = Object.entries(steps).filter(([, s]) => s.visits <= 1).map(([k, s]) => ({ step: k, visits: s.visits }));
    const deviceGaps: Dict[] = [];
    for (const [k, s] of Object.entries(steps)) for (const dev of ["desktop", "mobile"]) if (!s.devices[dev]) deviceGaps.push({ step: k, missing_device: dev });
    const pairsRun = new Counter(this.data.runs.map((r: Dict) => `${r.persona}\u0000${r.charter}`));
    const never: Dict[] = [];
    if (personas && charters)
      for (const pid of Object.keys(personas)) for (const [cid, c] of Object.entries(charters))
        if ((!c.personas?.length || c.personas.includes(pid)) && !pairsRun.n(`${pid}\u0000${cid}`)) never.push({ persona: pid, charter: cid });
    const tried = totalOpts - untried.length;
    const furthest = new Counter(this.data.runs.filter((r: Dict) => r.furthest).map((r: Dict) => r.furthest as string));
    return {
      option_coverage: totalOpts ? round(tried / totalOpts, 3) : 0, options_total: totalOpts, options_tried: tried,
      steps_known: Object.keys(steps).length, untried, thin_steps: thin, device_gaps: deviceGaps, never_run_pairs: never,
      boundary: furthest.mostCommon(3),
    };
  }

  /** Open and candidate findings worth re-checking, highest impact first (rejected and axe excluded). */
  openFindings(top = 12): Dict[] {
    const items = Object.entries<Dict>(this.data.findings)
      .filter(([, v]) => ["open", "candidate"].includes(v.status) && v.triage !== "reject" && v.source !== "axe")
      .map(([k, v]) => ({ fingerprint: k, impact: this.impact(v), title: v.title, severity: v.severity, category: v.category, step: v.step, occurrences: v.occurrences, status: v.status }));
    return items.sort((a, b) => Number(a.status !== "candidate") - Number(b.status !== "candidate") || b.impact - a.impact).slice(0, top);
  }

  // ------------------------------------------------------------- planning
  /** Pick the next persona x charter and build a focus brief from gaps and hot spots. */
  plan(personas: Record<string, Dict>, charters: Record<string, Dict>): Dict {
    const g = this.gaps(personas, charters);
    const runs: Dict[] = this.data.runs;
    const pairRuns = new Counter(runs.map((r) => `${r.persona}\u0000${r.charter}`));
    const personaRuns = new Counter(runs.map((r) => r.persona));
    const deviceVisits = new Counter<string>();
    for (const s of Object.values<Dict>(this.data.steps)) for (const [dv, n] of Object.entries<number>(s.devices)) deviceVisits.inc(dv, n);
    const minDev = deviceVisits.size ? Math.min(...deviceVisits.values()) : 0;
    const hot = this.hotSpots(5);
    let best: [string, string] | null = null, bestScore = -1e9;
    for (const [pid, p] of Object.entries(personas)) for (const [cid, c] of Object.entries(charters)) {
      if (c.personas?.length && !c.personas.includes(pid)) continue;
      const dev = p.device ?? "desktop";
      let score = 3 / (1 + pairRuns.n(`${pid}\u0000${cid}`)) + 1 / (1 + personaRuns.n(pid));
      score += deviceVisits.n(dev) <= minDev ? 1 : 0;
      if (cid === "coverage-sweep") score += Math.min(g.untried.length / 20, 2);
      if (hot.length && ["form-resilience", "results-scrutiny"].includes(cid)) score += 0.5;
      if (score > bestScore) { best = [pid, cid]; bestScore = score; }
    }
    return best ? { persona: best[0], charter: best[1], score: round(bestScore), brief: this.brief(g, hot) } : {};
  }

  brief(g?: Dict, hot?: Dict[], nUntried = 10): Dict {
    g ??= this.gaps();
    hot ??= this.hotSpots(5);
    const perStep = new Counter<string>(), picks: Dict[] = [];
    for (const u of g.untried) {
      if (perStep.n(u.step) < 1) { picks.push(u); perStep.inc(u.step); }
      if (picks.length >= nUntried) break;
    }
    return {
      option_coverage: g.option_coverage,
      untried_branches: picks.map((u) => ({ step: u.step, question: u.heading, option: u.option })),
      hot_spots: hot.map((h) => ({ step: h.step, question: h.heading, why: h.reasons.join("; ") })),
      known_findings: this.openFindings(10),
      thin_steps: g.thin_steps.slice(0, 6).map((t: Dict) => t.step),
      fragile_steps: this.fragility(5).map((f) => ({ step: f.step, question: f.heading, why: f.why.join(", ") })),
      weak_pathways: this.weakPathways(8),
      quality_bar: this.qualityBar(this.impactCfg.quality_rules),
    };
  }

  // ------------------------------------------------------------- reports
  renderMarkdown(personas?: Record<string, Dict>, charters?: Record<string, Dict>): string {
    const g = this.gaps(personas, charters), hot = this.hotSpots(10), d = this.data;
    const F = Object.values<Dict>(d.findings);
    const L = [`# What the bot has learned: ${d.target} / ${d.vertical}`, "",
      `- Sessions learned from: **${d.runs.length}** · Journey steps mapped: **${g.steps_known}** · `
      + `Branch coverage: **${g.options_tried}/${g.options_total} (${pct(g.option_coverage)})**`,
      `- Open findings: **${F.filter((f) => f.status === "open").length}** · Not reproduced on re-check: ${F.filter((f) => f.status === "not_reproduced").length}`,
      `- Furthest step reached most often: ${g.boundary.map(([k, n]: [string, number]) => `\`${k}\` (${n})`).join(", ") || "n/a"}`, "",
      "## Hot spots", "", "| Score | Step | Question | Why |", "|---:|---|---|---|"];
    L.push(...(hot.length ? hot.map((h) => `| ${h.score} | \`${h.step}\` | ${h.heading} | ${h.reasons.join("; ")} |`) : ["| | | _none yet_ | |"]));
    const frag = this.fragility(10);
    L.push("", "## Fragile steps", "", "| Score | Step | Question | Why |", "|---:|---|---|---|");
    L.push(...(frag.length ? frag.map((f) => `| ${f.score} | \`${f.step}\` | ${f.heading} | ${f.why.join(", ")} |`) : ["| | | _none yet_ | |"]));
    const stats = this.strategyStats();
    if (Object.keys(stats).length) {
      L.push("", "## What's paying off (reward per session by strategy)", "", "| Strategy | Sessions | Mean reward | Best |", "|---|---:|---:|---:|");
      for (const [k, v] of Object.entries(stats).sort((a, b) => b[1].mean - a[1].mean)) L.push(`| ${k} | ${v.n} | ${v.mean} | ${v.best} |`);
    }
    const lib: Record<string, Dict> = d.persona_library ?? {};
    if (Object.keys(lib).length) {
      L.push("", "## Best dynamic personas", "");
      for (const [k, v] of Object.entries(lib).sort((a, b) => b[1].reward - a[1].reward).slice(0, 8))
        L.push(`- **${k}** (${v.strategy}, reward ${v.reward}, ${v.device}): ${String(v.summary).slice(0, 140)}`);
    }
    L.push("", "## Coverage gaps: branches shown but never taken", "", "| Step | Question | Untried option |", "|---|---|---|");
    for (const u of g.untried.slice(0, 40)) L.push(`| \`${u.step}\` | ${u.heading} | ${u.option} |`);
    if (g.untried.length > 40) L.push(`| | | _…and ${g.untried.length - 40} more_ |`);
    if (g.never_run_pairs.length) { L.push("", "## Persona × charter pairs never run", ""); for (const p of g.never_run_pairs) L.push(`- ${p.persona} × ${p.charter}`); }
    const dev = new Counter(g.device_gaps.map((x: Dict) => x.missing_device as string));
    L.push("", "## Device gaps", "", `- Steps never seen on mobile: ${dev.n("mobile")} · on desktop: ${dev.n("desktop")}`,
      "", "## Finding ledger", "", "| Id | Sev | Step | Title | Seen | Status |", "|---|---|---|---|---:|---|");
    for (const [k, f] of Object.entries<Dict>(d.findings).sort((a, b) => (SEV_W[b[1].severity] ?? 0) - (SEV_W[a[1].severity] ?? 0) || a[0].localeCompare(b[0])))
      L.push(`| ${k} | ${f.severity} | \`${f.step}\` | ${f.title} | ${f.occurrences} | ${f.status} |`);
    L.push("", "## Journey map (step → next step, via option)", "");
    for (const [e, v] of Object.entries<Dict>(d.edges).sort((a, b) => b[1].n - a[1].n).slice(0, 60)) {
      const [a, b] = e.split(">>");
      const via = Object.entries<number>(v.via).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, n]) => `${k} (${n})`).join(", ");
      L.push(`- \`${a}\` → \`${b}\` ×${v.n}` + (via ? ` via ${via}` : ""));
    }
    return L.join("\n") + "\n";
  }

  /** Self-contained page: one row per journey step, coloured by hot-spot score, with option coverage. */
  renderHtml(personas?: Record<string, Dict>, charters?: Record<string, Dict>): string {
    const g = this.gaps(personas, charters);
    const hot = new Map(this.hotSpots(100).map((h) => [h.step, h]));
    const maxs = Math.max(...[...hot.values()].map((h) => h.score), 1);
    const rows = this.stepOrder().map((key) => {
      const st = this.data.steps[key];
      const opts = this.inScope(key) ? branches(st) : {};
      const n = Object.keys(opts).length, tried = Object.values(opts).filter((o) => o.chosen).length;
      const cov = n ? tried / n : 1;
      const h = hot.get(key), heat = h ? h.score / maxs : 0;
      const chips = Object.entries(opts).sort((a, b) => b[1].chosen - a[1].chosen).map(([l, o]) =>
        `<span class="chip ${o.chosen ? "on" : "off"}" title="chosen ${o.chosen}×, shown ${o.seen}×">${esc(l)}</span>`).join("");
      return `<tr><td class="heat" style="--h:${heat.toFixed(2)}">${h ? h.score : ""}</td>`
        + `<td><div class="q">${esc(last(st.headings, key))}</div><div class="k">${esc(key)}</div></td>`
        + `<td class="num">${st.visits}</td><td><div class="bar"><i style="width:${(cov * 100).toFixed(0)}%"></i></div>`
        + `<div class="k">${tried}/${n}</div></td><td class="chips">${chips}</td><td class="k">${esc(h ? h.findings.join(", ") : "")}</td></tr>`;
    });
    const d = this.data;
    const open = Object.values<Dict>(d.findings).filter((f) => f.status === "open").length;
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>iExplore coverage · ${esc(d.target)} ${esc(d.vertical)}</title>
<style>
:root{--bg:#fbfaf8;--fg:#1d1d1b;--mut:#6b6a66;--line:#e6e3dd;--hot:#c2410c;--ok:#2f6f4f}
@media (prefers-color-scheme:dark){:root{--bg:#191917;--fg:#ecebe7;--mut:#9a9893;--line:#33322f;--hot:#fb923c;--ok:#6fbf8f}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:28px 20px} h1{font-size:22px;margin:0 0 4px} .sub{color:var(--mut);margin-bottom:20px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:22px}
.kpi{border:1px solid var(--line);border-radius:10px;padding:12px 14px} .kpi b{display:block;font-size:22px} .kpi span{color:var(--mut);font-size:12px}
table{width:100%;border-collapse:collapse} th,td{text-align:left;vertical-align:top;padding:8px 6px;border-bottom:1px solid var(--line)}
th{font-size:12px;color:var(--mut);font-weight:600} .q{font-weight:600} .k{color:var(--mut);font-size:12px} .num{text-align:right}
.heat{width:46px;text-align:center;font-weight:700;color:#fff;background:color-mix(in srgb,var(--hot) calc(var(--h)*100%),transparent);border-radius:6px}
.bar{width:90px;height:6px;background:var(--line);border-radius:3px;overflow:hidden} .bar i{display:block;height:100%;background:var(--ok)}
.chip{display:inline-block;margin:2px 4px 2px 0;padding:1px 7px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
.chip.on{background:color-mix(in srgb,var(--ok) 18%,transparent);border-color:color-mix(in srgb,var(--ok) 40%,transparent)}
.chip.off{color:var(--mut);border-style:dashed} .chips{max-width:520px}
</style></head><body><main>
<h1>Journey coverage & hot spots</h1>
<div class="sub">${esc(d.target)} · ${esc(d.vertical)} · learned from ${d.runs.length} session(s). Solid chips = branches tested, dashed = never taken.</div>
<div class="kpis">
<div class="kpi"><b>${g.steps_known}</b><span>journey steps mapped</span></div>
<div class="kpi"><b>${pct(g.option_coverage)}</b><span>branches tested (${g.options_tried}/${g.options_total})</span></div>
<div class="kpi"><b>${open}</b><span>open findings</span></div>
<div class="kpi"><b>${g.never_run_pairs.length}</b><span>persona × charter pairs not yet run</span></div>
</div>
<table><thead><tr><th>Hot</th><th>Step</th><th class="num">Visits</th><th>Coverage</th><th>Options</th><th>Findings</th></tr></thead>
<tbody>${rows.join("")}</tbody></table></main></body></html>`;
  }

  /** Order steps along the journey using the learned edges (fallback: first seen). */
  stepOrder(): string[] {
    const steps: Record<string, Dict> = this.data.steps;
    const nxt = new Map<string, Counter<string>>(), indeg = new Counter<string>();
    for (const [e, v] of Object.entries<Dict>(this.data.edges)) {
      const [a, b] = e.split(">>");
      if (!nxt.has(a)) nxt.set(a, new Counter());
      nxt.get(a)!.inc(b, v.n); indeg.inc(b, v.n);
    }
    const byFirst = (a: string, b: string) => steps[a].first_seen - steps[b].first_seen;
    const starts = Object.keys(steps).filter((k) => !indeg.n(k)).sort(byFirst);
    const order: string[] = [], seen = new Set<string>();
    for (const s of starts.length ? starts : Object.keys(steps).sort(byFirst).slice(0, 1)) {
      let cur: string | null = s;
      while (cur && !seen.has(cur)) {
        order.push(cur); seen.add(cur);
        const cands: string[] = (nxt.get(cur)?.mostCommon() ?? []).map(([b]) => b).filter((b) => !seen.has(b));
        cur = cands[0] ?? null;
      }
    }
    order.push(...Object.keys(steps).filter((k) => !seen.has(k)).sort(byFirst));
    return order;
  }
}
