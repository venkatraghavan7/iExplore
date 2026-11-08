/** Config loading: bot.yaml + personas + charters, with ${VAR:-default} env expansion. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type Dict = Record<string, any>;

const ENV_RE = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;

export function expandEnv<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(ENV_RE, (_m, name: string, def?: string) => process.env[name] ?? def ?? "") as T;
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v)])) as T;
  }
  return value;
}

export function loadYaml(path: string): Dict {
  return expandEnv(YAML.parse(readFileSync(path, "utf8")) ?? {});
}

const truthy = (v: unknown) => ["true", "1", "yes"].includes(String(v ?? false).toLowerCase());

export interface BotConfig {
  target: Dict;
  model: Dict;
  budgets: Dict;
  browser: Dict;
  raw: Dict;
  provider: string;
  providerSettings: Dict;
}

export function loadConfig(path?: string, targetName?: string): BotConfig {
  const file = path ?? process.env.IEXPLORE_CONFIG ?? join(ROOT, "config", "bot.yaml");
  const raw = loadYaml(file);
  const name = targetName ?? raw.target ?? "prod";
  const target: Dict = { ...raw.targets[name], id: name };
  for (const flag of ["allow_quote_submission", "tag_spa_routes"]) target[flag] = truthy(target[flag]);
  if (process.env.IEXPLORE_START_URL && name !== "prod") target.start_url = process.env.IEXPLORE_START_URL;
  const model = raw.model ?? {};
  const provider = process.env.IEXPLORE_PROVIDER || model.provider || "anthropic";
  return {
    target, model, budgets: raw.budgets ?? {}, browser: raw.browser ?? {}, raw,
    provider, providerSettings: model[provider] ?? {},
  };
}

export function listPersonas(vertical: string): string[] {
  const dir = join(ROOT, "personas", vertical);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, "")).sort();
}

export function loadPersona(vertical: string, id: string): Dict {
  return loadYaml(join(ROOT, "personas", vertical, `${id}.yaml`));
}

export function loadCharters(vertical: string): Record<string, Dict> {
  const data = loadYaml(join(ROOT, "charters", `${vertical}.yaml`));
  return Object.fromEntries((data.charters as Dict[]).map((c) => [c.id, c]));
}

export function allPersonas(vertical: string): Record<string, Dict> {
  return Object.fromEntries(listPersonas(vertical).map((p) => [p, loadPersona(vertical, p)]));
}
