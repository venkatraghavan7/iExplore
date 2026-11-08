/** Run outputs: result.json, report.md, junit.xml, plus a multi-run summary. */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Dict } from "./config.js";

// Plain-English meaning of common axe rules: who is affected and how. WCAG success criterion last.
export const A11Y_PLAIN: Record<string, [string, string, string]> = {
  "color-contrast": ["Low-vision users", "Text too faint to read comfortably", "1.4.3"],
  label: ["Screen-reader users", "A form field has no name, so it's announced as just 'edit text'", "1.3.1 / 4.1.2"],
  "select-name": ["Screen-reader users", "A dropdown has no name; users don't know what they're choosing", "4.1.2"],
  "aria-allowed-attr": ["Screen-reader users", "Invalid ARIA markup, so the tab state may be announced wrongly", "4.1.2"],
  "aria-valid-attr-value": ["Screen-reader users", "An ARIA value is malformed (e.g. ' true ' with spaces)", "4.1.2"],
  "aria-required-parent": ["Screen-reader users", "Tabs aren't inside a tab list, so they aren't announced as tabs", "1.3.1"],
  "nested-interactive": ["Screen-reader and keyboard users", "A control is nested inside another, so focus and announcements break", "4.1.2"],
  "scrollable-region-focusable": ["Keyboard users", "A scrolling box can't be reached or scrolled with the keyboard", "2.1.1"],
  "link-in-text-block": ["Colour-blind users", "A link looks like plain text (colour is the only difference)", "1.4.1"],
  "target-size": ["Motor-impaired and mobile users", "Tap targets are too small to hit reliably", "2.5.8"],
  "image-alt": ["Screen-reader users", "An image has no text alternative", "1.1.1"],
};

export const SEV_ORDER: Record<string, number> = { blocker: 0, major: 1, minor: 2, cosmetic: 3, observation: 4 };
export const SEV_ICON: Record<string, string> = { blocker: "🟥", major: "🟧", minor: "🟨", cosmetic: "⬜", observation: "🔹" };

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (n: number) => n.toLocaleString("en-US");
const pyStr = (v: unknown) => v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : String(v);
const sevKey = (f: Dict) => SEV_ORDER[f.severity] ?? 9;

export function failing(run: Dict, failOn: string[]): boolean {
  return ["blocked", "incomplete"].includes(run.result.outcome) || run.findings.some((f: Dict) => failOn.includes(f.severity));
}

export function writeRun(run: Dict, runDir: string, failOn: string[]) {
  writeFileSync(join(runDir, "result.json"), JSON.stringify(run, null, 2));
  writeFileSync(join(runDir, "findings.json"), JSON.stringify(run.findings, null, 2));
  writeFileSync(join(runDir, "report.md"), renderMarkdown(run));
  writeFileSync(join(runDir, "junit.xml"), renderJunit([run], failOn));
}

export function renderMarkdown(run: Dict): string {
  const r = run.result, u = run.usage, t = run.telemetry;
  const findings = [...run.findings].sort((a, b) => sevKey(a) - sevKey(b));
  const lines: string[] = [
    `# Persona run: ${run.persona_name} · ${run.charter}`, "",
    `**Outcome:** ${pyStr(r.outcome)} · **Furthest step:** ${pyStr(r.furthest_step)} · `
      + `**Would continue:** ${pyStr(r.would_persona_continue)} · **Device:** ${run.device}`, "",
    `**Strategy:** ${pyStr(run.strategy)} · **Persona:** ${run.persona_origin ?? "static"}`
      + (run.persona_origin === "dynamic" ? ` · **Conditions:** ${pyStr(run.persona_profile?.interaction)}` : ""), "",
    `> ${r.persona_verdict ?? ""}`, "", r.summary ?? "", "",
  ];
  if (r.coverage_notes) lines.push("**Coverage:** " + r.coverage_notes, "");
  const a11y = findings.filter((f) => f.source === "axe");
  if (a11y.length) {
    lines.push(`## Accessibility scan (axe-core, WCAG 2.2 AA): ${a11y.length} failing rule(s)`, "",
      "| Who is affected | Problem | WCAG | Steps | Fix |", "|---|---|---|---|---|");
    for (const f of [...a11y].sort((a, b) => a.dedup_key.localeCompare(b.dedup_key))) {
      const rule = f.dedup_key.split(":").slice(1).join(":");
      const [who, what, wcag] = A11Y_PLAIN[rule] ?? ["Assistive-technology users", f.title.replace("Accessibility: ", ""), ""];
      const steps = /on (\d+) step/.exec(f.observed ?? "")?.[1] ?? "1";
      const fix = (f.suggested_fix ?? "").replace("Fix any of the following:", "").replace("Fix all of the following:", "").trim();
      lines.push(`| ${who} | ${what} (\`${rule}\`) | ${wcag} | ${steps} | ${fix.slice(0, 140)} |`);
    }
    lines.push("", "_Rule details are listed as A-numbered findings below._", "");
  }
  lines.push(`## Findings (${findings.length})`, "");
  if (!findings.length) lines.push("_None reported._");
  for (const f of findings) {
    lines.push(
      `### ${SEV_ICON[f.severity] ?? ""} ${f.id} [${pyStr(f.severity)}/${pyStr(f.category)}] ${f.title}`,
      `- **Step:** ${pyStr(f.step)} · **Confidence:** ${pyStr(f.confidence)} · **URL:** ${pyStr(f.url)}`,
      `- **Observed:** ${pyStr(f.observed)}`, `- **Expected:** ${pyStr(f.expected)}`);
    if (f.persona_impact) lines.push(`- **Persona impact:** ${f.persona_impact}`);
    if (f.repro_steps?.length) lines.push("- **Repro:** " + f.repro_steps.join(" → "));
    if (f.suggested_fix) lines.push(`- **Suggested fix:** ${f.suggested_fix}`);
    if (f.screenshot) lines.push(`- ![screenshot](${f.screenshot})`);
    lines.push("");
  }
  if (run.rechecks?.length) {
    lines.push("## Re-checks of known findings", "");
    for (const c of run.rechecks) lines.push(`- ${c.fingerprint}: **${c.status}**: ${c.note ?? ""}` + (c.screenshot ? ` ([shot](${c.screenshot}))` : ""));
    lines.push("");
  }
  lines.push("## Technical signals",
    `- Console errors: ${t.console_errors.length} · Failed requests: ${t.failed_requests.length} · `
    + `Slow requests: ${t.slow_requests.length} · Guardrail events: ${t.guardrail_events.length}`);
  if (t.synthetic_tag && Object.keys(t.synthetic_tag).length) {
    const tag = Object.entries(t.synthetic_tag).map(([k, v]) => `${k}=${v}`).join("&");
    const un: string[] = t.untagged_steps ?? [];
    lines.push(`- Synthetic traffic tag \`?${tag}\`: ` + (un.length
      ? `MISSING (no URL parameter and no tag cookie) on ${un.length} step(s): ${un.slice(0, 8).join(", ")}`
      : "present on every step (URL parameter or the site's tag cookie)"));
    if (t.synthetic_tag_note) lines.push(`  - ${t.synthetic_tag_note}`);
  }
  for (const e of t.failed_requests.slice(0, 10)) lines.push(`  - ${e.status || e.error} ${e.method} ${e.url}`);
  for (const e of t.guardrail_events.slice(0, 10)) lines.push(`  - guardrail ${e.type}: ${e.url}`);
  lines.push("", "## Run",
    `- Stop reason: ${run.stop_reason} · Turns: ${run.turns} · Actions: ${run.actions}`,
    `- Tokens: input ${num(u.input_tokens)} · cache read ${num(u.cache_read_input_tokens)} · `
    + `cache write ${num(u.cache_creation_input_tokens)} · output ${num(u.output_tokens)}`,
    "- Trace: `trace.jsonl` · Screenshots: `shots/`");
  return lines.join("\n") + "\n";
}

export function renderJunit(runs: Dict[], failOn: string[]): string {
  const cases = runs.map((run) => {
    const name = esc(`${run.persona}::${run.charter}`);
    let body = "";
    if (failing(run, failOn)) {
      const bad = run.findings.filter((f: Dict) => failOn.includes(f.severity));
      const msg = esc(`outcome=${run.result.outcome}; ${bad.length} finding(s) at ${failOn.join("/")}`);
      const detail = esc(bad.map((f: Dict) => `${f.id} [${f.severity}] ${f.title} - ${f.observed}`).join("\n"));
      body = `<failure message="${msg}">${detail}</failure>`;
    }
    return `<testcase classname="iexplore.${esc(run.persona ?? "")}" name="${name}">${body}<system-out>${esc(run.result.summary ?? "")}</system-out></testcase>`;
  });
  const fails = runs.filter((r) => failing(r, failOn)).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="iexplore" tests="${runs.length}" failures="${fails}">\n${cases.join("\n")}\n</testsuite>\n`;
}

/** Recursively find files with a given name, sorted. */
export function findFiles(root: string, name: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries.sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p); else if (e === name) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

export function summarize(runsRoot: string, failOn: string[]): string {
  const runs = findFiles(runsRoot, "result.json").map((p) => JSON.parse(readFileSync(p, "utf8")));
  writeFileSync(join(runsRoot, "junit-all.xml"), renderJunit(runs, failOn));
  const lines = ["# iExplore summary", "", "| Persona | Charter | Device | Outcome | Blocker | Major | Minor | Would continue |", "|---|---|---|---|---|---|---|---|"];
  for (const r of runs) {
    const c = (s: string) => r.findings.filter((f: Dict) => f.severity === s).length;
    lines.push(`| ${r.persona_name} | ${r.charter} | ${r.device} | ${r.result.outcome} | ${c("blocker")} | ${c("major")} | ${c("minor")} | ${pyStr(r.result.would_persona_continue)} |`);
  }
  lines.push("", "## Top findings", "");
  const all = runs.flatMap((r) => r.findings.filter((f: Dict) => ["blocker", "major"].includes(f.severity)).map((f: Dict) => [f, r] as const));
  for (const [f, r] of all.sort((a, b) => SEV_ORDER[a[0].severity] - SEV_ORDER[b[0].severity]))
    lines.push(`- ${SEV_ICON[f.severity]} **${f.title}** (${r.persona_name}, ${f.step}): ${f.observed}`);
  if (!all.length) lines.push("_No blocker or major findings._");
  const text = lines.join("\n") + "\n";
  writeFileSync(join(runsRoot, "SUMMARY.md"), text);
  return text;
}
