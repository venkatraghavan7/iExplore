/**
 * Keep learned state in S3 when the bot runs on EKS (instead of the bot-knowledge git branch used by GitHub Actions).
 *
 *   s3://<bucket>/<prefix>/knowledge/...   knowledge base + coverage pages
 *   s3://<bucket>/<prefix>/triage/...      register CSV, digest, triage pack, evidence
 *   s3://<bucket>/<prefix>/runs/<run>/...  per-run reports, traces and screenshots
 *
 * Credentials come from the default AWS chain (IRSA / EKS Pod Identity on the cluster, SSO locally).
 */
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";

const TYPES: Record<string, string> = { ".json": "application/json", ".jsonl": "application/x-ndjson", ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".png": "image/png", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8", ".yaml": "text/yaml" };

export interface StateLocation { bucket: string; prefix: string; region?: string }

export function stateFromEnv(): StateLocation | null {
  const bucket = process.env.IEXPLORE_STATE_BUCKET;
  if (!bucket) return null;
  return { bucket, prefix: (process.env.IEXPLORE_STATE_PREFIX ?? "iexplore").replace(/^\/+|\/+$/g, ""), region: process.env.AWS_REGION };
}

const key = (loc: StateLocation, rel: string) => [loc.prefix, rel.split(sep).join("/")].filter(Boolean).join("/");

function walk(dir: string): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.flatMap((e) => { const p = join(dir, e); return statSync(p).isDirectory() ? walk(p) : [p]; });
}

/** Download every object under <prefix>/<sub>/ into <dest>/<sub>/. Returns the number of files. */
export async function pull(loc: StateLocation, subs: string[], dest = ".", s3 = new S3Client({ region: loc.region })): Promise<number> {
  let n = 0;
  for (const sub of subs) {
    const base = key(loc, sub);
    let token: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: loc.bucket, Prefix: base.endsWith(".csv") ? base : `${base}/`, ContinuationToken: token }));
      for (const obj of page.Contents ?? []) {
        if (!obj.Key || obj.Key.endsWith("/")) continue;
        const body = await (await s3.send(new GetObjectCommand({ Bucket: loc.bucket, Key: obj.Key }))).Body!.transformToByteArray();
        const out = join(dest, loc.prefix ? obj.Key.slice(loc.prefix.length + 1) : obj.Key);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, body);
        n++;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
  return n;
}

/** Upload every file under the given local folders, keeping their paths relative to `root`. */
export async function push(loc: StateLocation, dirs: string[], root = ".", s3 = new S3Client({ region: loc.region })): Promise<number> {
  let n = 0;
  for (const d of dirs) for (const file of walk(join(root, d))) {
    const rel = relative(root, file);
    if (/(^|[\\/])\.last-run-/.test(rel)) continue;
    await s3.send(new PutObjectCommand({ Bucket: loc.bucket, Key: key(loc, rel), Body: readFileSync(file),
      ContentType: TYPES[extname(file)] ?? "application/octet-stream" }));
    n++;
  }
  return n;
}
