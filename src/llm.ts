/**
 * Model provider adapter.
 *
 *   Anthropic API  -> computer_toolset_20260801 (GA, no beta header)
 *   Amazon Bedrock -> computer_20251124 + beta header by default, or the toolset via tool_version: toolset
 *
 * The rest of the bot only sees normalised ToolCalls, so switching provider is a config change.
 */
import Anthropic from "@anthropic-ai/sdk";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import type { Dict } from "./config.js";

export const COMPUTER_MEMBERS = new Set([
  "screenshot", "zoom", "left_click", "right_click", "middle_click", "double_click", "triple_click",
  "left_click_drag", "mouse_move", "left_mouse_down", "left_mouse_up", "cursor_position", "scroll",
  "type", "key", "hold_key", "wait",
]);
export const LEGACY_BETA = "computer-use-2025-11-24";

export interface ToolCall {
  id: string;
  kind: "computer" | "custom";
  action: string;
  input: Dict;
  toolset: boolean; // result must echo toolset_name
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface Turn {
  content: Dict[];
  toolCalls: ToolCall[];
  text: string;
  stopReason: string | null;
  usage: Usage;
}

export interface Model {
  create(system: string, messages: Dict[], customTools: Dict[]): Promise<Turn>;
}

export const emptyUsage = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

export class ModelClient implements Model {
  readonly model: string;
  readonly toolVersion: string;
  readonly client: any;

  constructor(readonly provider: string, readonly settings: Dict, readonly display: [number, number], readonly maxTokens = 4096) {
    this.model = settings.model;
    this.toolVersion = settings.tool_version ?? (provider === "anthropic" ? "toolset" : "legacy");
    if (provider === "anthropic") this.client = new Anthropic(); // ANTHROPIC_API_KEY from env
    else if (provider === "bedrock") {
      // Credentials from the standard AWS chain (GitHub OIDC role, SSO, instance role). No keys in config.
      this.client = new AnthropicBedrock({ awsRegion: settings.region || process.env.AWS_REGION || "ap-southeast-2" });
    } else throw new Error(`Unknown provider: ${provider}`);
  }

  computerTool(): Dict {
    if (this.toolVersion === "toolset") return { type: "computer_toolset_20260801", cache_control: { type: "ephemeral" } };
    const [w, h] = this.display;
    return { type: "computer_20251124", name: "computer", display_width_px: w, display_height_px: h, enable_zoom: true };
  }

  async create(system: string, messages: Dict[], customTools: Dict[]): Promise<Turn> {
    const params: Dict = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      tools: [this.computerTool(), ...customTools],
    };
    let resp: Dict;
    if (this.toolVersion === "toolset" && this.provider === "anthropic") {
      resp = await this.client.messages.create(params);
    } else {
      const betas = this.toolVersion === "legacy" ? [LEGACY_BETA] : (this.settings.betas ?? []);
      resp = await this.client.beta.messages.create({ ...params, betas });
    }
    return this.normalise(resp);
  }

  /** Text-only call (persona design, evolve). */
  async complete(prompt: string, maxTokens = 3000): Promise<string> {
    const resp = await this.client.messages.create({ model: this.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] });
    return (resp.content as Dict[]).filter((b) => b.type === "text").map((b) => b.text).join("");
  }

  normalise(resp: Dict): Turn {
    const content: Dict[] = [];
    const calls: ToolCall[] = [];
    const text: string[] = [];
    for (const raw of resp.content as Dict[]) {
      const d = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null && v !== undefined));
      content.push(d);
      if (d.type === "text") text.push(d.text);
      if (d.type !== "tool_use") continue;
      const name: string = d.name;
      const input: Dict = d.input ?? {};
      if (d.toolset_name === "computer" || (this.toolVersion === "toolset" && COMPUTER_MEMBERS.has(name))) {
        calls.push({ id: d.id, kind: "computer", action: name, input, toolset: true });
      } else if (name === "computer") {
        const { action, ...rest } = input;
        calls.push({ id: d.id, kind: "computer", action, input: rest, toolset: false });
      } else {
        calls.push({ id: d.id, kind: "custom", action: name, input, toolset: false });
      }
    }
    const u = resp.usage ?? {};
    return {
      content, toolCalls: calls, text: text.join("\n"), stopReason: resp.stop_reason ?? null,
      usage: {
        input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

export function toolResult(call: ToolCall, content: unknown, isError = false): Dict {
  const r: Dict = { type: "tool_result", tool_use_id: call.id, content };
  if (isError) r.is_error = true;
  if (call.toolset) r.toolset_name = "computer";
  return r;
}

export const imageBlock = (b64png: string): Dict => ({ type: "image", source: { type: "base64", media_type: "image/png", data: b64png } });
