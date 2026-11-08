/** Tiny mock car-quote journey with planted defects, for plumbing tests.
 *  Run: npm run mock   (serves http://localhost:8765/car-insurance/) */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES: Record<string, string> = { "/car-insurance/": "landing.html", "/car-insurance/quote": "quote.html",
  "/car-insurance/results": "results.html", "/checkout/pay": "landing.html" };
const JSON_T = "application/json";

createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  const send = (code: number, body: string, ctype = "text/html; charset=utf-8") => {
    res.writeHead(code, { "Content-Type": ctype, "Content-Length": Buffer.byteLength(body) }).end(body);
  };
  if (PAGES[u.pathname]) return send(200, readFileSync(join(HERE, PAGES[u.pathname]), "utf8"));
  if (u.pathname === "/api/vehicle") {
    const rego = (u.searchParams.get("rego") ?? "").toUpperCase();
    if (rego.startsWith("ZZZ")) return send(404, JSON.stringify({ error: "ERR_VEH_404" }), JSON_T);
    return send(200, JSON.stringify({ make: "Mazda", model: "3", year: 2015, variant: "Neo" }), JSON_T);
  }
  if (u.pathname === "/api/promo") return send(500, JSON.stringify({ error: "boom" }), JSON_T); // planted defect
  send(404, "not found");
}).listen(8765, "127.0.0.1", () => console.log("mock site on http://localhost:8765/car-insurance/"));
