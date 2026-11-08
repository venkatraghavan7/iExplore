/** The exploratory agent loop: screenshot -> Claude decides -> act -> repeat. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BotConfig, Dict } from "./config.js";
import { BrowserSession, GuardrailStop } from "./browser.js";
import { emptyUsage, imageBlock, toolResult, type Model, type ToolCall, type Turn, type Usage } from "./llm.js";
import { buildSystemPrompt, kickoffText } from "./prompts.js";
import { A11Y_PLAIN } from "./report.js";
import { CUSTOM_TOOLS } from "./tools.js";

const NOT_EXECUTED = "Not executed: an earlier computer action in this turn failed.";
const b64 = (png: Buffer) => png.toString("base64");

/** Writes the run folder: screenshots, trace.jsonl, findings. */
export class Recorder {
  n = 0;
  findings: Dict[] = [];
  constructor(readonly dir: string) { mkdirSync(join(dir, "shots"), { recursive: true }); }

  shot(png: Buffer, label = "step"): string {
    this.n += 1;
    const name = `shots/${String(this.n).padStart(3, "0")}-${label}.png`;
    writeFileSync(join(this.dir, name), png);
    return name;
  }

  log(event: Dict) {
    appendFileSync(join(this.dir, "trace.jsonl"), JSON.stringify({ ...event, t: Math.round(Date.now()) / 1000 }) + "\n");
  }
}

/** Keep only the newest `keep` images; older ones become a text stub. Screenshots dominate cost. */
export function trimHistory(messages: Dict[], keep: number) {
  let seen = 0;
  for (const msg of [...messages].reverse()) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    for (const block of [...msg.content].reverse()) {
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (let i = block.content.length - 1; i >= 0; i--) {
          if (block.content[i].type === "image" && ++seen > keep) block.content[i] = { type: "text", text: "[older screenshot removed]" };
        }
      } else if (block.type === "image" && ++seen > keep) {
        for (const k of Object.keys(block)) delete block[k];
        Object.assign(block, { type: "text", text: "[older screenshot removed]" });
      }
    }
  }
}

// axe "critical" is about the element, not the business: keep scanner findings mid-tier so they compete fairly.
export const AXE_SEVERITY: Record<string, string> = { critical: "minor", serious: "minor", moderate: "cosmetic", minor: "observation" };

export function a11yTitle(rule: string, help: string, steps: string[]): string {
  const [, what, wcag] = A11Y_PLAIN[rule] ?? [null, help, ""];
  const where = steps.length > 1 ? `${steps.length} steps` : (steps[0].replace(/\/+$/, "").split("/").pop() || "landing");
  return `Accessibility: ${what} (${where}` + (wcag ? `, WCAG ${wcag})` : ")");
}

const commonPrefix = (xs: string[]) => xs.reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); });

/** axe-core violations become deterministic findings: ONE per rule, listing every step it fails on, with axe's fix. */
export function accessibilityFindings(a11y: Dict[]): Dict[] {
  const byRule = new Map<string, Dict>();
  for (const v of a11y) {
    const g = byRule.get(v.id) ?? { ...v, steps: [] as string[], elements: 0 };
    if (!g.steps.includes(v.step)) g.steps.push(v.step);
    g.elements += v.count ?? 0;
    byRule.set(v.id, g);
  }
  return [...byRule.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([rule, g], i) => {
    const steps: string[] = g.steps;
    let stepKey = steps[0];
    if (steps.length > 1) { const p = commonPrefix(steps); stepKey = p.slice(0, p.lastIndexOf("/") + 1) + "*"; }
    const ex = g.nodes?.[0] ?? {};
    const wcag = (g.tags ?? []).slice(0, 3).join(", ");
    return {
      id: `A${String(i + 1).padStart(2, "0")}`, source: "axe", dedup_key: `axe:${rule}`,
      title: a11yTitle(rule, g.help, steps), severity: AXE_SEVERITY[g.impact] ?? "minor",
      category: "accessibility", step: stepKey, step_key: stepKey, url: g.url,
      observed: `${g.elements} element(s) fail axe rule '${rule}' (${wcag}, axe impact ${g.impact}) on ${steps.length} step(s): `
        + `${steps.slice(0, 8).join(", ")}${steps.length > 8 ? " …" : ""}. e.g. ${ex.target ?? ""}: ${ex.html ?? ""}`,
      expected: g.description ?? "", confidence: 1.0,
      suggested_fix: `${ex.fix ?? ""} See ${g.helpUrl ?? ""}`.replace(/\s+/g, " ").trim(),
      screenshot: null,
    };
  });
}

export class PersonaAgent {
  readonly rec: Recorder;
  usage: Usage = emptyUsage();
  result: Dict | null = null;
  actions = 0;
  rechecks: Dict[] = [];

  constructor(readonly model: Model, readonly b: BrowserSession, readonly persona: Dict, readonly charter: Dict,
              readonly cfg: BotConfig, runDir: string, readonly runId: string, readonly brief?: Dict | null) {
    this.rec = new Recorder(runDir);
  }

  private async flushCoverage() {
    await this.b.trackStep();
    for (const ev of this.b.drainEvents()) this.rec.log(ev);
  }

  private async runComputer(call: ToolCall): Promise<Dict> {
    const out = await this.b.execute(call.action, call.input);
    this.actions += 1;
    await this.flushCoverage();
    if (Buffer.isBuffer(out)) {
      const name = this.rec.shot(out, call.action);
      this.rec.log({ kind: "computer", action: call.action, input: call.input, shot: name, url: this.b.page.url() });
      return toolResult(call, [imageBlock(b64(out))]);
    }
    this.rec.log({ kind: "computer", action: call.action, input: call.input, result: out, url: this.b.page.url() });
    return toolResult(call, out);
  }

  private async runCustom(call: ToolCall): Promise<Dict> {
    const { action: name, input: inp } = call;
    let out: string;
    if (name === "navigate") { out = await this.b.navigate(inp.url); await this.flushCoverage(); }
    else if (name === "page_signals") out = JSON.stringify(await this.b.pageSignals(), null, 1).slice(0, 8000);
    else if (name === "read_page_text") out = await this.b.pageText();
    else if (name === "report_finding") {
      const f: Dict = { ...inp, id: `F${String(this.rec.findings.length + 1).padStart(2, "0")}`, url: this.b.page.url(), step_key: BrowserSession.stepKey(this.b.page.url()) };
      f.screenshot = this.rec.shot(await this.b.screenshotPng(), `finding-${f.id}`);
      this.rec.findings.push(f);
      out = `Logged ${f.id}.`;
    } else if (name === "verify_known_finding") {
      this.rechecks.push({ ...inp, step_key: BrowserSession.stepKey(this.b.page.url()), screenshot: this.rec.shot(await this.b.screenshotPng(), `recheck-${inp.fingerprint}`) });
      out = `Recorded re-check of ${inp.fingerprint}: ${inp.status}.`;
    } else if (name === "finish_mission") { this.result = { ...inp }; out = "Session ended."; }
    else throw new Error(`Unknown tool ${name}`);
    this.rec.log({ kind: "custom", tool: name, input: inp, result: out.slice(0, 500) });
    return toolResult(call, out);
  }

  private async executeTurn(turn: Turn): Promise<Dict[]> {
    const results: Dict[] = [];
    let failed = false;
    for (const call of turn.toolCalls) {
      if (failed && call.kind === "computer") { results.push(toolResult(call, NOT_EXECUTED, true)); continue; }
      try {
        results.push(call.kind === "computer" ? await this.runComputer(call) : await this.runCustom(call));
      } catch (e) {
        if (e instanceof GuardrailStop) {
          this.rec.log({ kind: "guardrail", url: e.url });
          results.push(toolResult(call, `GUARDRAIL: navigation to ${e.url} was blocked because it is a protected step. `
            + "Record what you saw and call finish_mission with outcome stopped_by_guardrail.", true));
          failed = true;
        } else {
          if (this.b.step) this.b.step.errors += 1;
          this.rec.log({ kind: "error", action: call.action, error: String(e).slice(0, 500) });
          results.push(toolResult(call, `Error: ${String(e).slice(0, 500)}`, true));
          failed ||= call.kind === "computer";
        }
      }
    }
    return results;
  }

  async run(): Promise<Dict> {
    const budgets = this.cfg.budgets;
    const maxTurns = this.charter.max_turns ?? budgets.max_turns ?? 60;
    const deadline = Date.now() + 60_000 * (this.charter.time_box_minutes ?? budgets.max_minutes ?? 15);
    const maxInput = budgets.max_input_tokens ?? 2_000_000;
    const keep = this.cfg.model.keep_screenshots ?? 3;
    const startUrl: string = this.cfg.target.start_url;

    const system = buildSystemPrompt(this.persona, this.charter, this.cfg.target, this.runId, this.brief);
    writeFileSync(join(this.rec.dir, "system_prompt.txt"), system);
    if (this.brief) writeFileSync(join(this.rec.dir, "brief.json"), JSON.stringify(this.brief, null, 1));

    await this.b.navigate(startUrl);
    await this.flushCoverage();
    const first = await this.b.screenshotPng();
    this.rec.shot(first, "start");
    const messages: Dict[] = [{ role: "user", content: [
      { type: "text", text: kickoffText(this.charter, startUrl) }, // text before image helps click accuracy
      imageBlock(b64(first)),
    ] }];

    let stopReason = "max_turns", nudged = false, turnNo = 0;
    for (turnNo = 1; turnNo <= maxTurns; turnNo++) {
      if (Date.now() > deadline) { stopReason = "time_box"; break; }
      if (this.usage.input_tokens + this.usage.cache_read_input_tokens > maxInput) { stopReason = "token_budget"; break; }
      trimHistory(messages, keep);
      const turn = await this.model.create(system, messages, CUSTOM_TOOLS);
      for (const k of Object.keys(this.usage) as (keyof Usage)[]) this.usage[k] += turn.usage[k];
      this.rec.log({ kind: "model", turn: turnNo, text: turn.text, stop_reason: turn.stopReason, calls: turn.toolCalls.map((c) => [c.action, c.input]), usage: turn.usage });
      messages.push({ role: "assistant", content: turn.content });
      if (!turn.toolCalls.length) {
        if (this.result || nudged) { stopReason = "model_stopped"; break; }
        nudged = true;
        messages.push({ role: "user", content: "Continue the charter, or call finish_mission if you are done." });
        continue;
      }
      messages.push({ role: "user", content: await this.executeTurn(turn) });
      if (this.result) { stopReason = "finished"; break; }
    }
    if (turnNo > maxTurns) turnNo = maxTurns;

    this.b.closeStep();
    for (const ev of this.b.drainEvents()) this.rec.log(ev);
    const a11y = accessibilityFindings(this.b.a11y);
    this.rec.findings.push(...a11y);
    this.rec.log({ kind: "a11y", violations: this.b.a11y.length, findings: a11y.length });

    this.result ??= { outcome: "incomplete", summary: `Session ended by ${stopReason} before finish_mission.`, furthest_step: "unknown", would_persona_continue: null, persona_verdict: "" };
    const t = this.b.telemetry;
    return {
      run_id: this.runId, persona: this.persona.id, persona_name: this.persona.name, charter: this.charter.id,
      device: this.b.device, stop_reason: stopReason, turns: turnNo, actions: this.actions, usage: this.usage,
      result: this.result, findings: this.rec.findings, rechecks: this.rechecks,
      telemetry: {
        console_errors: t.consoleErrors, failed_requests: t.failedRequests, slow_requests: t.slowRequests,
        guardrail_events: t.guardrailEvents, synthetic_tag: this.b.tag, untagged_steps: [...this.b.untaggedSteps].sort(),
      },
    };
  }
}
