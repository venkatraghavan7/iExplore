/**
 * Propose new personas whose real-life situation naturally takes the branches nobody has tested yet.
 * Proposals land in personas/<vertical>/proposed/ for a human to review; they are never used until moved.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { ROOT, listPersonas, loadPersona, type BotConfig, type Dict } from "./config.js";
import type { Knowledge } from "./knowledge.js";
import { ModelClient } from "./llm.js";

export const FICTIONAL_MOBILES = ["0491570110", "0491570313", "0491570737", "0491571266", "0491571491", "0491571804",
  "0491572549", "0491572665", "0491572983", "0491573770"];
export const TEST_EMAIL = "iexplore+{run_id}@example.com";
const REQUIRED = ["id", "name", "vertical", "device", "summary", "traits", "behaviours", "test_data"];
export const YAML_BLOCK = /```(?:yaml)?\s*\n([\s\S]*?)```/g;
export const dumpYaml = (o: unknown) => YAML.stringify(o, { lineWidth: 0 });

export function buildPrompt(kb: Knowledge, vertical: string, n: number): string {
  const untried = kb.gaps().untried.slice(0, 40);
  const existing = listPersonas(vertical).map((p) => loadPersona(vertical, p));
  const example = existing.length ? dumpYaml(existing[0]) : "";
  const roster = existing.map((p) => `- ${p.id}: ${String(p.summary ?? "").trim().slice(0, 160)}`).join("\n");
  const gaps = untried.map((u: Dict) => `- [${u.step}] ${u.heading} -> "${u.option}"`).join("\n");
  return `You design realistic customer personas for exploratory testing of an Australian ${vertical} insurance
comparison journey. Existing personas already cover common paths:
${roster}

These answers have been SHOWN to testers but never chosen:
${gaps}

Invent ${n} new, distinct, realistic people whose genuine situation would lead them to choose several of these
untried answers. Each must be believable as a real Australian customer (not a test-case list), with a reason
for each unusual answer. Mix devices (desktop/mobile) and abilities (e.g. low vision, keyboard-only, English as
a second language) where it fits.

Use exactly the same YAML schema as this example, plus a \`covers:\` list naming the untried answers this
persona is meant to exercise. Test data must be clearly fictional: last_name "Testpersona", email
${TEST_EMAIL}. Never include a vehicle rego.

Example:
\`\`\`yaml
${example}\`\`\`

Return each persona in its own \`\`\`yaml block and nothing else.`;
}

export function parsePersonas(text: string, vertical: string): Dict[] {
  const out: Dict[] = [];
  [...text.matchAll(YAML_BLOCK)].forEach((m, i) => {
    let p: Dict;
    try { p = YAML.parse(m[1]); } catch { return; }
    if (!p || typeof p !== "object" || !REQUIRED.every((k) => k in p)) return;
    p.vertical = vertical;
    p.id = String(p.id).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || `proposed-${i}`;
    const td = (p.test_data ??= {}); // enforce fictional data, whatever the model wrote
    Object.assign(td, { last_name: "Testpersona", email: TEST_EMAIL, mobile: FICTIONAL_MOBILES[i % FICTIONAL_MOBILES.length] });
    if (p.vehicle && typeof p.vehicle === "object") delete p.vehicle.rego;
    p.status = "proposed";
    out.push(p);
  });
  return out;
}

export function writeProposals(personas: Dict[], vertical: string): string[] {
  const folder = join(ROOT, "personas", vertical, "proposed");
  mkdirSync(folder, { recursive: true });
  return personas.map((p) => {
    const path = join(folder, `${p.id}.yaml`);
    writeFileSync(path, "# PROPOSED by iExplore. Review before moving into the persona folder.\n" + dumpYaml(p));
    return path;
  });
}

export async function proposePersonas(cfg: BotConfig, kb: Knowledge, vertical: string, n = 3): Promise<string[]> {
  const mc = new ModelClient(cfg.provider, cfg.providerSettings, [1280, 800], 6000);
  const text = await mc.complete(buildPrompt(kb, vertical, n), 6000);
  return writeProposals(parsePersonas(text, vertical), vertical);
}
