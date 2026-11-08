/**
 * Triage register: the bridge between what the bot finds and what goes into Azure DevOps.
 *
 *  1. `iexplore triage`   merges the knowledge-base ledger into triage/<target>-<vertical>.csv, writes a readable
 *                         triage pack (HTML) and a weekly digest (Markdown).
 *  2. A person edits the CSV: decision = accept / reject / duplicate / needs-info, plus priority, area_path,
 *                         assigned_to, notes. Human columns are never overwritten.
 *  3. `iexplore ado-sync` creates an ADO Bug for every `accept` row without an ado_id, attaches the evidence,
 *                         tags it `iexplore` + the fingerprint and writes the id back. Re-running is safe.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Dict } from "./config.js";
import { esc, type Knowledge } from "./knowledge.js";

export const BOT_COLS = ["fingerprint", "impact", "queue", "severity", "category", "step", "title", "observed", "expected",
  "suggested_fix", "source", "confidence", "occurrences", "personas", "first_seen", "last_seen",
  "bot_status", "hot_spot_score", "screenshot", "flag", "admitted_week", "lane"];
export const HUMAN_COLS = ["decision", "priority", "area_path", "assigned_to", "duplicate_of", "notes", "ado_id", "ado_url"];
export const COLS = [...BOT_COLS, ...HUMAN_COLS];
export const DECISIONS = new Set(["", "pending", "accept", "reject", "duplicate", "needs-info"]);
const ADO_SEVERITY: Record<string, string> = { blocker: "1 - Critical", major: "2 - High", minor: "3 - Medium", cosmetic: "4 - Low", observation: "4 - Low" };
const DEFAULT_PRIORITY: Record<string, string> = { blocker: "1", major: "2", minor: "3", cosmetic: "4", observation: "4" };
export const TAG = "iexplore";

type Row = Record<string, string>;
const imp = (r: Row) => Number(r.impact || 0);
const pad = (n: number) => String(n).padStart(2, "0");
const date = (ts: unknown) => { if (!ts) return ""; const d = new Date(Number(ts) * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const pyNum = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x !== 0 ? `${x}.0` : String(x ?? "");

// ---------------------------------------------------------------- CSV (RFC 4180, like Python's csv module)
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0]);
}
const csvCell = (v: unknown) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function readRegister(path: string): Record<string, Row> {
  if (!existsSync(path)) return {};
  const [head, ...rows] = parseCsv(readFileSync(path, "utf8").replace(/^﻿/, ""));
  return Object.fromEntries(rows.map((r) => { const o: Row = Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])); return [o.fingerprint, o]; }));
}

export function writeRegister(path: string, rows: Record<string, Row>) {
  mkdirSync(dirname(path), { recursive: true });
  const ordered = Object.values(rows).sort((a, b) => Number(a.queue !== "triage") - Number(b.queue !== "triage")
    || Number(!["", "pending"].includes(a.decision ?? "")) - Number(!["", "pending"].includes(b.decision ?? ""))
    || imp(b) - imp(a) || a.fingerprint.localeCompare(b.fingerprint));
  writeFileSync(path, [COLS, ...ordered.map((r) => COLS.map((c) => r[c]))].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n");
}

/** Copy one screenshot per finding into triage/evidence/<fingerprint>.png (small, kept with the register). */
export function collectEvidence(kb: Knowledge, runsRoots: string[], outDir: string): Record<string, string> {
  mkdirSync(outDir, { recursive: true });
  const found: Record<string, string> = {};
  for (const [fp, f] of Object.entries<Dict>(kb.data.findings)) {
    const dest = join(outDir, `${fp}.png`);
    if (f.screenshot) for (const root of runsRoots) {
      const src = join(root, f.screenshot);
      if (existsSync(src) && statSync(src).isFile()) { copyFileSync(src, dest); break; }
    }
    if (existsSync(dest)) found[fp] = `evidence/${fp}.png`;
  }
  return found;
}

export function isoWeek(ts?: number): string {
  const d = ts ? new Date(ts * 1000) : new Date();
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${pad(w)}`;
}

/**
 * Refresh bot-owned columns from the knowledge base; keep every human decision.
 * Only CONFIRMED findings enter the register (candidates wait for a second sighting). Each week at most `weeklyCap`
 * new findings are admitted to the triage queue, highest impact first; the rest wait in the digest. Blockers and
 * escalated rejects bypass the cap; reserved lanes give a category (accessibility) its own weekly slot(s).
 */
export function merge(kb: Knowledge, register: Record<string, Row>, evidence: Record<string, string> = {}, weeklyCap = 5,
                      week?: string, lanes: Record<string, number> = {}): Record<string, Row> {
  week ??= isoWeek();
  const hot = new Map(kb.hotSpots(500).map((h) => [h.step, h.score]));
  for (const [fp, f] of Object.entries<Dict>(kb.data.findings)) {
    if (f.status === "candidate" && !(fp in register)) continue;
    const row: Row = register[fp] ?? Object.fromEntries(COLS.map((c) => [c, ""]));
    Object.assign(row, {
      fingerprint: fp, impact: pyNum(kb.impact(f)), severity: f.severity, category: f.category || "", step: f.step, title: f.title,
      observed: f.observed || "", expected: f.expected || "", suggested_fix: f.suggested_fix || "", source: f.source ?? "agent",
      confidence: pyNum(f.confidence ?? ""), occurrences: String(f.occurrences), personas: (f.personas ?? []).filter(Boolean).join(", "),
      first_seen: date(f.first_seen), last_seen: date(f.last_seen), bot_status: f.status,
      hot_spot_score: hot.has(f.step) ? pyNum(hot.get(f.step)) : "", screenshot: evidence[fp] ?? row.screenshot ?? "",
    });
    row.decision ||= "pending";
    row.priority ||= DEFAULT_PRIORITY[f.severity] ?? "3";
    row.flag = "";
    if (f.escalated && row.decision === "reject") Object.assign(row, { decision: "pending", flag: "escalated", queue: "triage", admitted_week: week });
    else if (f.status === "not_reproduced" && row.ado_id) row.flag = "possibly_fixed";
    else if (f.occurrences >= 3 && row.decision === "reject") row.flag = "recurring";
    register[fp] = row;
  }
  const rows = Object.values(register);
  for (const [cat, slots] of Object.entries(lanes ?? {})) {
    const used = rows.filter((r) => r.admitted_week === week && r.lane === cat).length;
    const pool = rows.filter((r) => r.queue !== "triage" && r.decision === "pending" && r.category === cat).sort((a, b) => imp(b) - imp(a));
    for (const r of pool.slice(0, Math.max(0, slots - used))) Object.assign(r, { queue: "triage", admitted_week: week, lane: cat });
  }
  let admitted = rows.filter((r) => r.admitted_week === week && r.queue === "triage" && !r.lane).length;
  const waiting = rows.filter((r) => r.queue !== "triage" && r.decision === "pending").sort((a, b) => imp(b) - imp(a));
  for (const r of waiting) {
    if (r.severity === "blocker" || admitted < weeklyCap) { r.queue = "triage"; r.admitted_week = week; admitted += Number(r.severity !== "blocker"); }
    else r.queue = "digest";
  }
  for (const r of rows) r.queue ||= r.decision !== "pending" ? "triage" : "digest";
  return register;
}

/** Weekly one-pager: what needs a decision, what's below the line, what's waiting, and the value signals. */
export function renderDigest(kb: Knowledge, register: Record<string, Row>, cap: number, week?: string, qualityBar?: string[]): string {
  week ??= isoWeek();
  const rows = Object.values(register);
  const triageQ = rows.filter((r) => r.queue === "triage" && r.decision === "pending").sort((a, b) => imp(b) - imp(a));
  const digestQ = rows.filter((r) => r.queue === "digest" && r.decision === "pending");
  const cands = Object.entries<Dict>(kb.data.findings).filter(([, f]) => f.status === "candidate");
  const decided = rows.filter((r) => ["accept", "reject", "duplicate"].includes(r.decision));
  const acc = decided.filter((r) => r.decision === "accept").length;
  const fixed = rows.filter((r) => r.flag === "possibly_fixed");
  const admitted = rows.filter((r) => r.admitted_week === week && r.queue === "triage").length;
  const runsWeek = kb.data.runs.filter((x: Dict) => isoWeek(x.t) === week);
  const L = [`# Weekly quality digest · ${kb.data.target} ${kb.data.vertical} · ${week}`, "",
    `- **Needs a decision:** ${triageQ.length} (admitted this week ${admitted}/${cap})`,
    `- **Below the line:** ${digestQ.length} confirmed lower-impact findings, held in the digest`,
    `- **Waiting for a second sighting:** ${cands.length} candidates`,
    `- **Possibly fixed** (ticketed, no longer reproduces): ${fixed.length}`,
    "- **Triage acceptance rate:** " + (decided.length ? `${acc}/${decided.length} (${Math.round((100 * acc) / decided.length)}%)` : "no decisions yet")
      + " (target 50% or higher; lower means the bot is too noisy)",
    `- **Sessions this week:** ${runsWeek.length}`, "", "## Needs a decision (highest impact first)", ""];
  L.push(...(triageQ.length ? triageQ.map((r) => `- **${r.fingerprint}** · impact ${r.impact} · ${r.severity} · ${r.title} (\`${r.step}\`)`) : ["_Nothing waiting._"]));
  const a11y = rows.filter((r) => r.source === "axe").sort((a, b) => imp(b) - imp(a));
  if (a11y.length) {
    L.push("", `## Accessibility scan: ${a11y.length} failing WCAG rule(s)`, "");
    for (const r of a11y) L.push(`- ${r.fingerprint} · ${r.queue}${r.lane ? " (reserved slot)" : ""} · ${r.title}`);
  }
  L.push("", "## Below the line, by category", "");
  const byCat = new Map<string, Row[]>();
  for (const r of digestQ) { const c = r.category || "other"; byCat.set(c, [...(byCat.get(c) ?? []), r]); }
  for (const [cat, items] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    items.sort((a, b) => imp(b) - imp(a));
    L.push(`- **${cat}** (${items.length}): ` + items.slice(0, 3).map((r) => `${r.fingerprint} ${r.title.slice(0, 70)}`).join("; ") + (items.length > 3 ? " …" : ""));
  }
  if (!byCat.size) L.push("_Empty._");
  L.push("", "## Waiting for a second sighting", "");
  const cs = cands.sort((a, b) => kb.impact(b[1]) - kb.impact(a[1])).slice(0, 10);
  L.push(...(cs.length ? cs.map(([k, f]) => `- ${k} · ${f.severity} · ${f.title} (\`${f.step}\`)`) : ["_None._"]));
  if (fixed.length) L.push("", "## Possibly fixed: verify and close", "", ...fixed.map((r) => `- ${r.fingerprint} ADO ${r.ado_id}: ${r.title}`));
  if (qualityBar?.length) L.push("", "## Quality bar the bot is following", "", ...qualityBar.map((q) => `- ${q}`));
  return L.join("\n") + "\n";
}

export function validate(register: Record<string, Row>): string[] {
  const errs: string[] = [];
  for (const [fp, r] of Object.entries(register)) {
    if (!DECISIONS.has(r.decision ?? "")) errs.push(`${fp}: unknown decision '${r.decision}' (use ${[...DECISIONS].filter(Boolean).sort().join(", ")})`);
    if (r.decision === "duplicate" && !r.duplicate_of) errs.push(`${fp}: duplicate needs duplicate_of (a fingerprint or ADO id)`);
  }
  return errs;
}

// ---------------------------------------------------------------- triage pack (HTML)
export function renderHtml(kb: Knowledge, register: Record<string, Row>, title: string, digestMd = ""): string {
  const hot = kb.hotSpots(8), g = kb.gaps(), rows = Object.values(register);
  const count = (d: string) => rows.filter((r) => r.decision === d).length;
  const hotRows = hot.map((h) => `<tr><td class='n'>${h.score}</td><td><b>${esc(h.heading)}</b><div class='k'>${esc(h.step)}</div></td>`
    + `<td>${esc(h.reasons.join("; "))}</td><td class='k'>${esc(h.findings.join(", "))}</td></tr>`).join("");
  const cards = [...rows].sort((a, b) => Number(a.queue !== "triage") - Number(b.queue !== "triage") || imp(b) - imp(a)).map((r) => {
    const shot = r.screenshot ? `<img src='${esc(r.screenshot)}' alt='evidence screenshot'>` : "";
    const ticket = r.ado_id ? `<a href='${esc(r.ado_url)}'>ADO ${esc(r.ado_id)}</a>` : "no ticket yet";
    const flag = r.flag ? `<span class='flag'>${esc(r.flag)}</span>` : "";
    return `<article class='card sev-${esc(r.severity)}' data-decision='${esc(r.decision)}' data-queue='${esc(r.queue)}'>
<header><span class='sev'>${esc(r.severity)}</span><span class='fp'>${esc(r.fingerprint)}</span>
<span class='imp'>impact ${esc(r.impact)}</span><span class='q q-${esc(r.queue)}'>${esc(r.queue)}</span>
<span class='dec'>${esc(r.decision)}</span>${flag}<span class='tk'>${ticket}</span></header>
<h3>${esc(r.title)}</h3>
<div class='k'>${esc(r.step)} · ${esc(r.category)} · seen ${esc(r.occurrences)}× (${esc(r.first_seen)} → ${esc(r.last_seen)}) · ${esc(r.personas)}</div>
<dl><dt>Observed</dt><dd>${esc(r.observed)}</dd><dt>Expected</dt><dd>${esc(r.expected)}</dd>
${r.suggested_fix ? `<dt>Suggested fix</dt><dd>${esc(r.suggested_fix)}</dd>` : ""}
${r.notes ? `<dt>Notes</dt><dd>${esc(r.notes)}</dd>` : ""}</dl>${shot}
<details><summary>Proposed ADO bug</summary><pre>${esc(ticketPreview(r))}</pre></details></article>`;
  }).join("");
  const filters = ["triage queue", "digest", "all", "pending", "accept", "reject", "duplicate", "needs-info"].map((d) => `<button data-f='${d}'>${d}</button>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{--bg:#fbfaf8;--fg:#1d1d1b;--mut:#6b6a66;--line:#e6e3dd;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#191917;--fg:#ecebe7;--mut:#9a9893;--line:#33322f;--card:#222220}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1000px;margin:0 auto;padding:28px 20px} h1{font-size:22px;margin:0} h2{font-size:16px;margin:28px 0 10px}
.k{color:var(--mut);font-size:12px} table{width:100%;border-collapse:collapse} td,th{padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left}
.n{font-weight:700;text-align:right;width:40px} .kpis{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}
.kpis div{border:1px solid var(--line);border-radius:10px;padding:8px 12px} .kpis b{font-size:18px;margin-right:6px}
.filters button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:4px 12px;margin:0 6px 6px 0;cursor:pointer}
.filters button.on{background:var(--fg);color:var(--bg)}
.card{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
.sev-blocker{border-left-color:#b91c1c} .sev-major{border-left-color:#ea580c} .sev-minor{border-left-color:#ca8a04} .sev-cosmetic,.sev-observation{border-left-color:#64748b}
.card header{display:flex;gap:10px;align-items:center;font-size:12px;color:var(--mut)} .sev{font-weight:700;text-transform:uppercase}
.dec,.q{border:1px solid var(--line);border-radius:999px;padding:0 8px} .q-triage{font-weight:700} .imp{font-weight:600} .tk{margin-left:auto} .flag{color:#b45309;font-weight:600}
h3{margin:6px 0 4px;font-size:15px} dl{margin:8px 0} dt{font-weight:600;font-size:12px;color:var(--mut)} dd{margin:0 0 6px}
img{max-width:100%;border:1px solid var(--line);border-radius:6px;margin-top:6px} pre{white-space:pre-wrap;font-size:12px}
</style></head><body><main>
<h1>${esc(title)}</h1>
<div class="k">Triage this list in the register CSV (column <code>decision</code>), then run <code>npx iexplore ado-sync</code>.</div>
<div class="kpis"><div><b>${count("pending")}</b>pending</div><div><b>${count("accept")}</b>accepted</div>
<div><b>${count("reject")}</b>rejected</div><div><b>${count("duplicate")}</b>duplicate</div><div><b>${count("needs-info")}</b>needs info</div>
<div><b>${Math.round(g.option_coverage * 100)}%</b>branch coverage</div></div>
${digestMd ? `<h2>This week</h2><pre class='digest'>${esc(digestMd)}</pre>` : ""}
<h2>Problem areas (hot spots)</h2><table><tr><th>Score</th><th>Step</th><th>Why</th><th>Findings</th></tr>${hotRows}</table>
<h2>Findings</h2>
<div class="filters">${filters}</div>
${cards}
<script>
document.querySelectorAll('.filters button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.filters button').forEach(x => x.classList.toggle('on', x === b));
  const f = b.dataset.f;
  document.querySelectorAll('.card').forEach(c => c.style.display = (f === 'all' || c.dataset.decision === f
    || (f === 'triage queue' && c.dataset.queue === 'triage') || (f === 'digest' && c.dataset.queue === 'digest')) ? '' : 'none');
});
document.querySelector(".filters button[data-f='triage queue']").click();
</script></main></body></html>`;
}

// ---------------------------------------------------------------- ADO
const ticketPreview = (r: Row) => `[iExplore] ${r.title}\nSeverity: ${ADO_SEVERITY[r.severity]} · Priority: ${r.priority}\n`
  + `Tags: ${TAG}; ${TAG}-${r.fingerprint}; ${r.category}\n\nStep: ${r.step}\nObserved: ${r.observed}\nExpected: ${r.expected}`;

export function reproHtml(r: Row, kb: Knowledge): string {
  const f = kb.data.findings[r.fingerprint] ?? {};
  const steps = (f.repro_steps ?? []).map((s: string) => `<li>${esc(s)}</li>`).join("");
  return `<p><b>Found by iExplore</b> (${esc(kb.data.target)}, ${esc(kb.data.vertical)}). `
    + `Seen ${esc(r.occurrences)} time(s) between ${esc(r.first_seen)} and ${esc(r.last_seen)}, personas: ${esc(r.personas)}.</p>`
    + `<p><b>Journey step:</b> ${esc(r.step)}</p>` + (steps ? `<ol>${steps}</ol>` : "")
    + `<p><b>Observed:</b> ${esc(r.observed)}</p><p><b>Expected:</b> ${esc(r.expected)}</p>`
    + (r.suggested_fix ? `<p><b>Suggested fix:</b> ${esc(r.suggested_fix)}</p>` : "")
    + `<p><b>Impact score:</b> ${esc(r.impact)} / 100 (severity × reach × business risk × confidence × recurrence)</p>`
    + (r.notes ? `<p><b>Triage notes:</b> ${esc(r.notes)}</p>` : "")
    + `<p><i>Fingerprint ${esc(r.fingerprint)}. Evidence screenshot attached when available.</i></p>`;
}

/** Minimal Azure DevOps REST client (work items + attachments) using a PAT. */
export class AdoClient {
  readonly base: string;
  private readonly auth: string;
  constructor(orgUrl: string, readonly project: string, pat: string, readonly api = "7.1") {
    this.base = orgUrl.replace(/\/+$/, "");
    this.auth = "Basic " + Buffer.from(`:${pat}`).toString("base64");
  }
  private async req(method: string, url: string, body?: unknown, ctype = "application/json"): Promise<Dict> {
    const data: BodyInit | undefined = body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body);
    const res = await fetch(url, { method, body: data, headers: { Authorization: this.auth, "Content-Type": ctype }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`ADO ${method} ${url} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
  async findByTag(tag: string): Promise<number | null> {
    const q = { query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Tags] CONTAINS '${tag}'` };
    const res = await this.req("POST", `${this.base}/${this.project}/_apis/wit/wiql?api-version=${this.api}`, q);
    return res.workItems?.[0]?.id ?? null;
  }
  async upload(path: string): Promise<string> {
    const url = `${this.base}/${this.project}/_apis/wit/attachments?fileName=${encodeURIComponent(basename(path))}&api-version=${this.api}`;
    return (await this.req("POST", url, readFileSync(path), "application/octet-stream")).url;
  }
  createBug(patch: Dict[]) {
    return this.req("POST", `${this.base}/${this.project}/_apis/wit/workitems/$Bug?api-version=${this.api}`, patch, "application/json-patch+json");
  }
}

export function bugPatch(r: Row, kb: Knowledge, defaults: Dict, attachmentUrl?: string | null): Dict[] {
  const add = (path: string, value: unknown) => ({ op: "add", path, value });
  const tags = [TAG, `${TAG}-${r.fingerprint}`, r.category, `target-${kb.data.target}`, `vertical-${kb.data.vertical}`, ...(defaults.tags ?? [])].filter(Boolean).join("; ");
  const patch = [add("/fields/System.Title", `[iExplore] ${r.title}`.slice(0, 255)),
    add("/fields/Microsoft.VSTS.TCM.ReproSteps", reproHtml(r, kb)),
    add("/fields/Microsoft.VSTS.Common.Severity", ADO_SEVERITY[r.severity] ?? "3 - Medium"),
    add("/fields/Microsoft.VSTS.Common.Priority", Number(r.priority || 3)),
    add("/fields/System.Tags", tags)];
  const area = r.area_path || defaults.area_path;
  if (area) patch.push(add("/fields/System.AreaPath", area));
  if (defaults.iteration_path) patch.push(add("/fields/System.IterationPath", defaults.iteration_path));
  if (r.assigned_to) patch.push(add("/fields/System.AssignedTo", r.assigned_to));
  if (attachmentUrl) patch.push(add("/relations/-", { rel: "AttachedFile", url: attachmentUrl, attributes: { comment: "iExplore evidence" } }));
  return patch;
}

/** Create Bugs for accepted rows without a ticket. Returns a log of what was (or would be) done. */
export async function sync(register: Record<string, Row>, kb: Knowledge, ado: AdoClient | null, defaults: Dict, evidenceRoot: string, dryRun = true): Promise<Dict[]> {
  const log: Dict[] = [];
  for (const [fp, r] of Object.entries(register)) {
    if (r.decision !== "accept" || r.ado_id) continue;
    if (dryRun || !ado) { log.push({ fingerprint: fp, action: "would_create", title: r.title, patch: bugPatch(r, kb, defaults) }); continue; }
    const existing = await ado.findByTag(`${TAG}-${fp}`);
    if (existing) {
      r.ado_id = String(existing); r.ado_url = `${ado.base}/${ado.project}/_workitems/edit/${existing}`;
      log.push({ fingerprint: fp, action: "linked_existing", ado_id: existing }); continue;
    }
    const shot = r.screenshot ? join(evidenceRoot, r.screenshot) : null;
    const att = shot && existsSync(shot) ? await ado.upload(shot) : null;
    const wi = await ado.createBug(bugPatch(r, kb, defaults, att));
    r.ado_id = String(wi.id);
    r.ado_url = wi._links?.html?.href || `${ado.base}/${ado.project}/_workitems/edit/${wi.id}`;
    log.push({ fingerprint: fp, action: "created", ado_id: wi.id });
  }
  return log;
}
