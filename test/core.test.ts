import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { accessibilityFindings, trimHistory } from "../src/agent.js";
import { Rng, sanitise } from "../src/designer.js";
import { Knowledge, branches } from "../src/knowledge.js";
import { merge, parseCsv, readRegister, writeRegister } from "../src/triage.js";

const kb = () => new Knowledge(join(mkdtempSync(join(tmpdir(), "kb-")), "k.json"), "prod", "car");

test("trimHistory keeps only the newest N screenshots", () => {
  const img = () => ({ type: "image", source: {} });
  const msgs = [1, 2, 3, 4].map(() => ({ role: "user", content: [{ type: "tool_result", content: [img()] }] }));
  trimHistory(msgs, 2);
  const kinds = msgs.map((m) => m.content[0].content[0].type);
  assert.deepEqual(kinds, ["text", "text", "image", "image"]);
});

test("axe violations group to one finding per rule across steps", () => {
  const v = (step: string) => ({ id: "color-contrast", step, url: "u", impact: "serious", help: "h", count: 2, tags: ["wcag2aa"], nodes: [{ target: "p", html: "<p>" }] });
  const f = accessibilityFindings([v("/car-insurance/journey/a"), v("/car-insurance/journey/b")]);
  assert.equal(f.length, 1);
  assert.equal(f[0].step_key, "/car-insurance/journey/*");
  assert.equal(f[0].severity, "minor");
  assert.match(f[0].title, /Text too faint .*2 steps.*1\.4\.3/);
});

test("new agent findings are candidates until seen twice; axe is confirmed at once", () => {
  const k = kb();
  const f = { title: "Premium differs between card and details", observed: "card 1234 details 1284", category: "data", severity: "major", step_key: "/r" };
  const fp = k.mergeFinding(f, "r1", "p", 1);
  assert.equal(k.data.findings[fp].status, "candidate");
  assert.equal(k.mergeFinding(f, "r2", "q", 2), fp);
  assert.equal(k.data.findings[fp].status, "open");
  const a = k.mergeFinding({ title: "x", dedup_key: "axe:label", source: "axe", severity: "minor", step_key: "/q" }, "r1", "p", 1);
  assert.equal(k.data.findings[a].status, "open");
});

test("branches ignore navigation, fields and long pick-lists", () => {
  const opts = (labels: string[]) => ({ options: Object.fromEntries(labels.map((l) => [l, { seen: 1, chosen: 0 }])) });
  assert.deepEqual(Object.keys(branches(opts(["Yes", "No", "Back", "field:DOB"]))), ["Yes", "No"]);
  assert.deepEqual(branches(opts(Array.from({ length: 20 }, (_, i) => `Make ${i}`))), {});
});

test("impact: journey-wide steps have full reach; risk words lift the score", () => {
  const k = kb();
  assert.equal(k.reach("/car-insurance/journey/*"), 1);
  assert.ok(k.risk({ category: "visual", title: "Premium shown twice" }) > k.risk({ category: "visual", title: "Logo blurry" }));
});

test("triage merge admits at most the weekly cap, keeps human decisions, and CSV round-trips", () => {
  const k = kb();
  for (let i = 0; i < 8; i++) k.mergeFinding({ title: `Issue number ${i} distinct${i}`, observed: `obs${i}`, category: "functional", severity: "minor", step_key: `/s${i}` }, "r", "p", 1, true);
  k.mergeFinding({ title: "Contrast", dedup_key: "axe:color-contrast", source: "axe", category: "accessibility", severity: "minor", step_key: "/a" }, "r", "p", 1);
  const reg = merge(k, {}, {}, 5, "2026-W45", { accessibility: 1 });
  const rows = Object.values(reg);
  assert.equal(rows.filter((r) => r.queue === "triage").length, 6); // 5 + 1 reserved accessibility slot
  assert.equal(rows.find((r) => r.category === "accessibility")!.lane, "accessibility");
  const path = join(mkdtempSync(join(tmpdir(), "tr-")), "r.csv");
  rows[0].notes = 'has "quotes", commas\nand a newline';
  rows[0].decision = "accept";
  writeRegister(path, reg);
  const back = readRegister(path);
  assert.equal(back[rows[0].fingerprint].notes, rows[0].notes);
  assert.equal(merge(k, back, {}, 5, "2026-W45")[rows[0].fingerprint].decision, "accept");
  assert.deepEqual(parseCsv('a,b\r\n"x,1",2\r\n'), [["a", "b"], ["x,1", "2"]]);
});

test("sanitise forces fictional data and bounded interaction settings", () => {
  const p = sanitise({ name: "Jo Bloggs", vehicle: { rego: "ABC123" }, test_data: { email: "real@person.com" }, interaction: { network: "5g", cpu_slowdown: 99 } }, "car", "fragility", 0);
  assert.equal(p.vehicle.rego, undefined);
  assert.equal(p.test_data.last_name, "Testpersona");
  assert.match(p.test_data.email, /@example\.com$/);
  assert.equal(p.interaction.network, "none");
  assert.equal(p.interaction.cpu_slowdown, 6);
  assert.match(p.id, /^dyn-\d{8}-jo-bloggs$/);
});

test("seeded Rng is reproducible", () => {
  assert.equal(new Rng(42).random(), new Rng(42).random());
});
