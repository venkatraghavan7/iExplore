/**
 * Scripted stand-in for Claude, for `--dry-run` plumbing tests against mock_site/.
 * Emits computer-toolset tool calls (coordinates looked up from the page, since it can't see) so the executor,
 * guardrails, history trimming and reporting run end to end with no API cost.
 */
import type { Dict } from "./config.js";
import type { BrowserSession } from "./browser.js";
import { emptyUsage, type Model, type ToolCall, type Turn } from "./llm.js";

let ids = 0;
const nextId = () => `toolu_fake_${String(++ids).padStart(4, "0")}`;
const c = (action: string, input: Dict = {}): ToolCall => ({ id: nextId(), kind: "computer", action, input, toolset: true });
const t = (name: string, input: Dict = {}): ToolCall => ({ id: nextId(), kind: "custom", action: name, input, toolset: false });

export class ScriptedModel implements Model {
  step = 0;
  constructor(readonly b: BrowserSession) {}

  private async box(selector: string) {
    const b = await this.b.page.locator(selector).first().boundingBox();
    if (!b) throw new Error(`no box for ${selector}`);
    return b;
  }
  private async xy(selector: string) { const b = await this.box(selector); return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)]; }
  private async region(selector: string, pad = 10) {
    const b = await this.box(selector);
    return [Math.max(0, Math.round(b.x - pad)), Math.max(0, Math.round(b.y - pad)), Math.round(b.x + b.width + pad), Math.round(b.y + b.height + pad)];
  }

  async create(_system: string, _messages: Dict[], _tools: Dict[]): Promise<Turn> {
    const s = ++this.step;
    let calls: ToolCall[];
    if (s === 1) calls = [c("left_click", { coordinate: await this.xy("#start") }), c("screenshot")];
    else if (s === 2) calls = [c("left_click", { coordinate: await this.xy("#rego") }), c("type", { text: "ZZZ999" }),
      c("left_click", { coordinate: await this.xy("#lookup") }), c("wait", { duration: 0.5 }), c("screenshot")];
    else if (s === 3) calls = [t("report_finding", { title: "Unknown rego shows raw error code", severity: "minor", category: "usability",
      step: "vehicle lookup", observed: "'Error ERR_VEH_404' with no guidance", expected: "Plain-language message and a manual car selection option", confidence: 0.9 }),
      c("triple_click", { coordinate: await this.xy("#rego") }), c("type", { text: "TEST001" }),
      c("key", { text: "Tab" }), c("key", { text: "Return" }), c("wait", { duration: 0.5 }), c("screenshot")];
    else if (s === 4) calls = [c("left_click", { coordinate: await this.xy("#dob") }), c("type", { text: "14/03/2004" }),
      c("left_click", { coordinate: await this.xy("#postcode") }), c("type", { text: "4059" }),
      c("left_click", { coordinate: await this.xy("#go") }), c("screenshot")];
    else if (s === 5) calls = [t("page_signals"), c("zoom", { region: await this.region("#c1") }),
      c("scroll", { scroll_direction: "down", scroll_amount: 2 }), c("scroll", { scroll_direction: "up", scroll_amount: 2 })];
    else if (s === 6) calls = [c("left_click", { coordinate: await this.xy("#d1") }), c("screenshot"), t("read_page_text")];
    else if (s === 7) calls = [t("report_finding", { title: "Premium on card ($1,234) differs from details ($1,284)", severity: "major",
      category: "data", step: "results", observed: "Card $1,234/yr, details modal $1,284", expected: "Same annual premium in both places",
      confidence: 0.95, repro_steps: ["Get quote", "Results: Koala Insure card", "Click Details"] }),
      c("left_click", { coordinate: await this.xy("#modal button") }), c("left_click", { coordinate: await this.xy("text=Buy now") }), c("screenshot")];
    else if (s === 8) calls = [t("navigate", { url: "https://www.google.com/" })]; // external navigation must be blocked too
    else calls = [t("finish_mission", { outcome: "stopped_by_guardrail", summary: "Dry run complete.", furthest_step: "results",
      would_persona_continue: false, persona_verdict: "The price changed when I opened details, so I don't trust it.",
      coverage_notes: "Scripted plumbing test only." })];
    const text = `(scripted step ${s})`;
    const content = [{ type: "text", text }, ...calls.map((x) => ({ type: "tool_use", id: x.id, name: x.action, input: x.input, ...(x.toolset ? { toolset_name: "computer" } : {}) }))];
    return { content, toolCalls: calls, text, stopReason: "tool_use", usage: emptyUsage() };
  }
}
