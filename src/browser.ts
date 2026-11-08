/**
 * Headless browser that Claude drives through computer-use actions.
 *
 * Claude sees only screenshots and sends pixel actions; Playwright's low-level mouse and keyboard execute them,
 * so the bot behaves like a person looking at the screen: no selectors, no page objects. The same class enforces
 * guardrails (host allowlist, stop pages, blocked requests, synthetic-traffic tag), applies persona conditions
 * (network/CPU throttling, typing speed), records the journey map, runs axe-core and collects telemetry.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import type { Dict } from "./config.js";

const require = createRequire(import.meta.url);
let AXE_SOURCE: string | null = null;
const axeSource = () => (AXE_SOURCE ??= readFileSync(require.resolve("axe-core/axe.min.js"), "utf8"));

const KEY_MAP: Record<string, string> = {
  return: "Enter", enter: "Enter", kp_enter: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
  backspace: "Backspace", delete: "Delete", space: "Space", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft",
  right: "ArrowRight", page_up: "PageUp", prior: "PageUp", page_down: "PageDown", next: "PageDown", home: "Home",
  end: "End", ctrl: "Control", control: "Control", alt: "Alt", shift: "Shift", super: "Meta", cmd: "Meta", meta: "Meta",
};

export function toPwKey(combo: string): string {
  return combo.replace(/ /g, "+").split("+").filter(Boolean).map((p) => {
    const m = KEY_MAP[p.toLowerCase()];
    if (m) return m;
    if (/^[Ff]\d{1,2}$/.test(p)) return p.toUpperCase();
    return p;
  }).join("+");
}

export class GuardrailStop extends Error {
  constructor(public readonly url: string) { super(url); }
}

const now = () => Date.now() / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Telemetry {
  consoleErrors: Dict[] = [];
  failedRequests: Dict[] = [];
  slowRequests: Dict[] = [];
  guardrailEvents: Dict[] = [];
  private cursor = { console: 0, failed: 0, slow: 0 };

  sinceLast(): Dict {
    const c = this.cursor;
    const out = {
      console_errors: this.consoleErrors.slice(c.console),
      failed_requests: this.failedRequests.slice(c.failed),
      slow_requests: this.slowRequests.slice(c.slow),
    };
    this.cursor = { console: this.consoleErrors.length, failed: this.failedRequests.length, slow: this.slowRequests.length };
    return out;
  }
}

const OPTIONS_JS = `() => {
  const root = document.querySelector('main') || document.body;
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const txt = el => (el.innerText || el.getAttribute('aria-label') || (el.tagName === 'BUTTON' ? el.value : '') || '')
    .replace(/\\s+/g, ' ').trim().slice(0, 60);
  const out = new Set();
  root.querySelectorAll('button,[role=button],[role=radio],[role=option],a,input,select,textarea,label').forEach(el => {
    if (el.closest('footer') || !vis(el)) return;
    if (el.tagName === 'LABEL' && el.control) return;
    const t = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
      ? 'field:' + (el.labels && el.labels[0] ? el.labels[0].innerText.trim() : (el.placeholder || el.name || el.type))
      : txt(el);
    if (t && t.length > 1) out.add(t.slice(0, 60));
  });
  const h = document.querySelector('h1,h2');
  return { heading: h ? h.innerText.replace(/\\s+/g, ' ').trim().slice(0, 120) : document.title, options: [...out].slice(0, 60) };
}`;

// Never reads an input's .value: that is what the persona typed.
const POINT_JS = `([x, y]) => {
  const el = document.elementFromPoint(x, y); if (!el) return null;
  const c = el.closest('button,[role=button],[role=radio],[role=option],a,input,select,textarea,label,li') || el;
  const tag = c.tagName.toLowerCase();
  let t;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    t = (c.labels && c.labels[0] ? c.labels[0].innerText : '') || c.placeholder || c.getAttribute('aria-label') || c.name || c.type;
  } else {
    t = c.innerText || c.getAttribute('aria-label') || (tag === 'button' ? c.value : '') || tag;
  }
  return { tag, label: (t || '').replace(/\\s+/g, ' ').trim().slice(0, 60) };
}`;

export class BrowserSession {
  static NETWORK: Record<string, [number, number, number]> = { // DevTools presets: down B/s, up B/s, latency ms
    "fast-3g": [(1.6 * 1024 * 1024) / 8, (750 * 1024) / 8, 150],
    "slow-3g": [(500 * 1024) / 8, (500 * 1024) / 8, 400],
  };
  static TYPING: Record<string, number> = { slow: 110, normal: 25, fast: 4 };

  readonly allowed: string[];
  readonly stopPatterns: RegExp[];
  readonly blocked: [string, RegExp][];
  readonly slowMs: number;
  readonly telemetry = new Telemetry();
  readonly tag: Record<string, string>;
  readonly typeDelay: number;
  readonly a11yCfg: Dict;
  untaggedSteps = new Set<string>();
  a11y: Dict[] = [];
  events: Dict[] = [];
  cursor: [number, number] = [0, 0];
  step: Dict | null = null;
  private scanned = new Set<string>();
  private stopHit: string | null = null;
  browser!: Browser;
  context!: BrowserContext;
  page!: Page;

  constructor(readonly target: Dict, readonly cfg: Dict, readonly device = "desktop", readonly interaction: Dict = {}) {
    this.allowed = (target.allowed_hosts ?? []).map((h: string) => String(h).toLowerCase());
    this.stopPatterns = (target.stop_url_patterns ?? []).map((p: string) => new RegExp(p, "i"));
    this.blocked = (target.blocked_request_patterns ?? []).map((b: Dict) => [String(b.method ?? "*").toUpperCase(), new RegExp(b.url, "i")]);
    this.slowMs = cfg.slow_request_ms ?? 3000;
    this.tag = Object.fromEntries(Object.entries(target.synthetic_query ?? {}).map(([k, v]) => [String(k), String(v)]));
    this.typeDelay = BrowserSession.TYPING[interaction.typing_speed] ?? cfg.type_delay_ms ?? 25;
    this.a11yCfg = cfg.accessibility ?? { axe: true };
  }

  get viewport(): [number, number] {
    const d = this.cfg.devices[this.device];
    return [d.width, d.height];
  }

  // ---- lifecycle ------------------------------------------------------
  async start(): Promise<this> {
    const launch: Dict = { headless: this.cfg.headless ?? true };
    if (this.cfg.channel) launch.channel = this.cfg.channel;
    this.browser = await chromium.launch(launch);
    const d = this.cfg.devices[this.device];
    const ctx: Dict = {
      viewport: { width: d.width, height: d.height },
      deviceScaleFactor: 2, // normal screenshots at CSS scale (cheap); zoom crops at device scale (sharp)
      isMobile: !!d.mobile, hasTouch: !!d.mobile,
      locale: this.cfg.locale ?? "en-AU", timezoneId: this.cfg.timezone ?? "Australia/Brisbane",
    };
    let ua: string | undefined = d.user_agent;
    if (this.target.user_agent_suffix) {
      if (!ua) {
        const tmp = await this.browser.newContext();
        ua = (await (await tmp.newPage()).evaluate(() => navigator.userAgent)).replace("HeadlessChrome", "Chrome");
        await tmp.close();
      }
      ua += this.target.user_agent_suffix;
    }
    if (ua) ctx.userAgent = ua;
    if (this.target.basic_auth_user) {
      ctx.httpCredentials = { username: this.target.basic_auth_user, password: this.target.basic_auth_password ?? "" };
    }
    this.context = await this.browser.newContext(ctx);
    await this.context.route("**/*", (route) => this.route(route));
    if (Object.keys(this.tag).length && this.target.tag_spa_routes) {
      const pairs = JSON.stringify(this.tag);
      await this.context.addInitScript(`(() => { const tag = ${pairs};
        const add = (u) => { try { const x = new URL(u, location.href); if (x.origin !== location.origin) return u;
          for (const [k, v] of Object.entries(tag)) if (!x.searchParams.has(k)) x.searchParams.set(k, v);
          return x.pathname + x.search + x.hash; } catch (e) { return u; } };
        for (const fn of ['pushState', 'replaceState']) { const orig = history[fn].bind(history);
          history[fn] = (s, t, u) => orig(s, t, u == null ? u : add(u)); } })();`);
    }
    this.attach(await this.context.newPage());
    await this.applyConditions(this.page);
    this.context.on("page", (p) => void this.onNewPage(p));
    return this;
  }

  async close() {
    try { await this.context?.close(); } catch { /* ignore */ }
    try { await this.browser?.close(); } catch { /* ignore */ }
  }

  private attach(page: Page) {
    this.page = page;
    page.on("console", (m) => {
      if (m.type() === "error") this.telemetry.consoleErrors.push({ t: now(), url: page.url(), page: BrowserSession.stepKey(page.url()), text: m.text().slice(0, 500) });
    });
    page.on("pageerror", (e) => this.telemetry.consoleErrors.push({ t: now(), url: page.url(), page: BrowserSession.stepKey(page.url()), text: `Uncaught: ${String(e).slice(0, 500)}` }));
    page.on("response", (r) => {
      try {
        if (!this.hostOk(r.url())) return;
        const dur = r.request().timing().responseEnd;
        if (r.status() >= 400) this.telemetry.failedRequests.push({ t: now(), page: BrowserSession.stepKey(this.page.url()), method: r.request().method(), url: r.url().slice(0, 300), status: r.status() });
        if (dur > this.slowMs && ["document", "xhr", "fetch"].includes(r.request().resourceType())) {
          this.telemetry.slowRequests.push({ t: now(), page: BrowserSession.stepKey(this.page.url()), url: r.url().slice(0, 300), ms: Math.round(dur) });
        }
      } catch { /* ignore */ }
    });
    page.on("requestfailed", (r) => {
      if (this.hostOk(r.url())) this.telemetry.failedRequests.push({ t: now(), page: BrowserSession.stepKey(page.url()), method: r.method(), url: r.url().slice(0, 300), status: null, error: (r.failure()?.errorText ?? "failed").slice(0, 200) });
    });
  }

  private async onNewPage(page: Page) {
    try { await page.waitForURL((u) => !u.href.startsWith("about:"), { timeout: 10000 }); } catch { /* ignore */ }
    if (this.hostOk(page.url())) { this.attach(page); await this.applyConditions(page); }
    else { this.telemetry.guardrailEvents.push({ t: now(), type: "popup_closed", url: page.url() }); await page.close(); }
  }

  /** Real-world conditions through the DevTools protocol: slow network, slow device. */
  private async applyConditions(page: Page) {
    const net = BrowserSession.NETWORK[this.interaction.network];
    const cpu = Number(this.interaction.cpu_slowdown ?? 1);
    if (!net && cpu <= 1) return;
    try {
      const cdp = await this.context.newCDPSession(page);
      if (net) {
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", { offline: false, downloadThroughput: net[0], uploadThroughput: net[1], latency: net[2] });
      }
      if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    } catch (e) {
      this.telemetry.guardrailEvents.push({ t: now(), type: "conditions_not_applied", url: String(e).slice(0, 200) });
    }
  }

  // ---- guardrails + tagging -------------------------------------------
  hostOk(url: string): boolean {
    let host = "";
    try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
    return this.allowed.some((h) => host === h || host.endsWith("." + h));
  }

  tagUrl(url: string): string {
    if (!Object.keys(this.tag).length || !this.hostOk(url)) return url;
    const u = new URL(url);
    for (const [k, v] of Object.entries(this.tag)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
    return u.toString();
  }

  isTagged(url: string): boolean {
    if (!Object.keys(this.tag).length) return true;
    try {
      const q = new URL(url).searchParams;
      return Object.entries(this.tag).every(([k, v]) => q.get(k) === v);
    } catch { return false; }
  }

  /** CTM reads ?automated-test=true on landing and sets an `automated-test=true` cookie that rides along with every
   *  later request, so the journey stays tagged even when its URLs drop the parameter. */
  async tagCookieOk(): Promise<boolean> {
    try {
      const jar = Object.fromEntries((await this.context.cookies(this.page.url())).map((c) => [c.name, c.value]));
      return Object.entries(this.tag).every(([k, v]) => jar[k] === v);
    } catch { return false; }
  }

  private async route(route: Route) {
    const req = route.request();
    const url = req.url();
    for (const [method, rx] of this.blocked) {
      if ((method === "*" || method === req.method()) && rx.test(url)) {
        this.telemetry.guardrailEvents.push({ t: now(), type: "request_blocked", method: req.method(), url: url.slice(0, 300) });
        return route.abort("blockedbyclient");
      }
    }
    const frame = req.frame();
    const isMain = req.isNavigationRequest() && frame === frame.page().mainFrame();
    if (isMain) {
      if (url.startsWith("about:") || url.startsWith("data:")) return route.continue();
      if (!this.hostOk(url)) {
        this.telemetry.guardrailEvents.push({ t: now(), type: "navigation_blocked", url: url.slice(0, 300) });
        return route.abort("blockedbyclient");
      }
      for (const rx of this.stopPatterns) {
        if (rx.test(url)) {
          this.stopHit = url;
          this.telemetry.guardrailEvents.push({ t: now(), type: "stop_page", url: url.slice(0, 300) });
          return route.abort("blockedbyclient");
        }
      }
      if (req.method() === "GET" && !this.isTagged(url)) {
        // Full-page navigation without the tag (a link, a redirect, location.href): bounce to the tagged URL.
        return route.fulfill({ status: 302, headers: { location: this.tagUrl(url) }, body: "" });
      }
    }
    // Extra headers only on our hosts: on third-party requests they would trigger CORS preflights.
    const extra = this.target.extra_headers_same_origin ?? {};
    if (Object.keys(extra).length && this.hostOk(url)) return route.continue({ headers: { ...req.headers(), ...extra } });
    return route.continue();
  }

  async checkStop() {
    if (!this.stopHit) return;
    const url = this.stopHit;
    this.stopHit = null;
    if (this.page.url().startsWith("chrome-error:")) {
      try { await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }); } catch { /* ignore */ }
    }
    throw new GuardrailStop(url);
  }

  // ---- journey map + accessibility --------------------------------------
  static stepKey(url: string): string {
    let path = "/";
    try { path = new URL(url).pathname.replace(/\/+$/, "") || "/"; } catch { /* ignore */ }
    return path.replace(/\/\d{4,}(?=\/|$)/g, "/{id}");
  }

  private async snapshot(): Promise<Dict> {
    try { return (await this.page.evaluate(`(${OPTIONS_JS})()`)) as Dict ?? {}; } catch { return {}; }
  }

  /** Called after every action: opens/updates the current step, closes the previous one on change. */
  async trackStep() {
    let url: string;
    try { url = this.page.url(); } catch { return; }
    if (url.startsWith("about:") || url.startsWith("chrome-error:")) return;
    const key = BrowserSession.stepKey(url);
    if (Object.keys(this.tag).length && this.hostOk(url) && !this.isTagged(url) && !(await this.tagCookieOk())) {
      this.untaggedSteps.add(key);
    }
    if (this.step && this.step.step === key) {
      const snap = await this.snapshot();
      this.step.options = [...new Set([...this.step.options, ...(snap.options ?? [])])].sort();
      if (snap.heading && !this.step.heading) this.step.heading = snap.heading;
      return;
    }
    const prev = this.closeStep();
    const snap = await this.snapshot();
    await this.scanAccessibility(key);
    this.step = {
      step: key, url: url.slice(0, 300), heading: snap.heading ?? "", options: [...new Set<string>(snap.options ?? [])].sort(),
      chosen: [], typed: [], actions: 0, errors: 0, entered: now(),
      from: prev ? prev.step : null, via: prev && prev.chosen.length ? prev.chosen[prev.chosen.length - 1] : null,
    };
  }

  closeStep(): Dict | null {
    const st = this.step;
    this.step = null;
    if (st) {
      st.dwell_s = Math.round((now() - st.entered) * 100) / 100;
      delete st.entered;
      st.kind = "step";
      this.events.push(st);
    }
    return st;
  }

  private async noteTarget(coord?: number[]) {
    if (!coord || !this.step) return;
    let target: Dict | null = null;
    try { target = (await this.page.evaluate(`(${POINT_JS})(${JSON.stringify([coord[0], coord[1]])})`)) as Dict | null; } catch { /* ignore */ }
    if (target?.label) {
      const label = ["input", "textarea", "select"].includes(target.tag) ? "field:" + target.label : target.label;
      this.step.chosen.push(label);
    }
    this.step.actions += 1;
  }

  drainEvents(): Dict[] {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  /** axe-core WCAG 2.x A/AA scan, once per step per session. Results are facts, not model opinions. */
  async scanAccessibility(key: string) {
    if (this.a11yCfg.axe === false || this.scanned.has(key)) return;
    this.scanned.add(key);
    try {
      if (!(await this.page.evaluate(() => typeof (window as any).axe !== "undefined"))) {
        await this.page.addScriptTag({ content: axeSource() });
      }
      const tags = this.a11yCfg.tags ?? ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
      const disabled: string[] = this.a11yCfg.disable_rules ?? [];
      const res = (await this.page.evaluate(async ([tags, disabled]) => {
        const rules: Record<string, { enabled: boolean }> = {};
        (disabled as string[]).forEach((r) => (rules[r] = { enabled: false }));
        const r = await (window as any).axe.run(document, { runOnly: { type: "tag", values: tags }, rules, resultTypes: ["violations"] });
        return r.violations.map((v: any) => ({
          id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, description: v.description,
          tags: v.tags.filter((t: string) => t.startsWith("wcag")), count: v.nodes.length,
          nodes: v.nodes.slice(0, 3).map((n: any) => ({ target: (n.target || []).join(" ").slice(0, 160), html: (n.html || "").slice(0, 200), fix: (n.failureSummary || "").slice(0, 400) })),
        }));
      }, [tags, disabled] as const)) as Dict[];
      for (const v of res ?? []) this.a11y.push({ ...v, step: key, url: this.page.url() });
    } catch (e) {
      this.telemetry.guardrailEvents.push({ t: now(), type: "a11y_scan_failed", url: `${key}: ${String(e).slice(0, 160)}` });
    }
  }

  // ---- perception -----------------------------------------------------
  async screenshotPng(): Promise<Buffer> {
    return this.page.screenshot({ scale: "css", animations: "disabled", caret: "initial" });
  }

  async zoomPng(region: number[]): Promise<Buffer> {
    const [x0, y0, x1, y1] = region;
    return this.page.screenshot({ scale: "device", clip: { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) } });
  }

  async settle() {
    try {
      await this.page.waitForTimeout(250);
      await this.page.waitForLoadState("domcontentloaded", { timeout: 5000 });
      const slow = this.interaction.network in BrowserSession.NETWORK ? 3 : 1;
      await this.page.waitForLoadState("networkidle", { timeout: (this.cfg.settle_ms ?? 2500) * slow });
    } catch { /* ignore */ }
  }

  // ---- actions ----------------------------------------------------------
  /** Run one computer-use action. Returns PNG bytes or a short text. */
  async execute(action: string, inp: Dict): Promise<Buffer | string> {
    await this.checkStop();
    const p = this.page, m = p.mouse, k = p.keyboard;
    const coord: number[] | undefined = inp.coordinate ?? undefined;
    // For click/scroll/drag actions, `text` holds modifier keys (e.g. "shift").
    const mods = ["type", "key", "hold_key"].includes(action) ? [] : String(inp.text ?? "").split("+").filter(Boolean).map(toPwKey);
    const move = async (c?: number[]) => { if (c) { await m.move(c[0], c[1]); this.cursor = [c[0], c[1]]; } };
    const withMods = async (fn: () => Promise<void>) => {
      for (const mk of mods) await k.down(mk);
      try { await fn(); } finally { for (const mk of [...mods].reverse()) await k.up(mk); }
    };

    switch (action) {
      case "screenshot":
        await p.waitForTimeout(300);
        await this.checkStop();
        return this.screenshotPng();
      case "zoom":
        return this.zoomPng(inp.region);
      case "cursor_position":
        return `X=${this.cursor[0]}, Y=${this.cursor[1]}`;
      case "mouse_move":
        await move(coord);
        return "OK";
      case "left_click": case "right_click": case "middle_click": case "double_click": case "triple_click": {
        await this.noteTarget(coord);
        await move(coord);
        const [x, y] = this.cursor;
        if (action === "left_click" && this.cfg.devices[this.device].mobile && !mods.length) await p.touchscreen.tap(x, y);
        else {
          const button = action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
          const clickCount = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
          await withMods(() => m.click(x, y, { button, clickCount }));
        }
        await this.settle();
        await this.checkStop();
        return "OK";
      }
      case "left_click_drag": {
        const s = inp.start_coordinate, e = inp.coordinate;
        await withMods(async () => { await m.move(s[0], s[1]); await m.down(); await m.move(e[0], e[1], { steps: 12 }); await m.up(); });
        this.cursor = [e[0], e[1]];
        return "OK";
      }
      case "left_mouse_down": await m.down(); return "OK";
      case "left_mouse_up": await m.up(); await this.settle(); await this.checkStop(); return "OK";
      case "scroll": {
        if (coord) await move(coord);
        const amt = Number(inp.scroll_amount ?? 3) * 100;
        const [dx, dy] = ({ up: [0, -amt], down: [0, amt], left: [-amt, 0], right: [amt, 0] } as Record<string, number[]>)[inp.scroll_direction];
        await withMods(() => m.wheel(dx, dy));
        await p.waitForTimeout(400);
        return "OK";
      }
      case "type":
        if (this.step) { this.step.typed.push(String(inp.text).length); this.step.actions += 1; } // length only, never values
        await k.type(String(inp.text), { delay: this.typeDelay });
        return "OK";
      case "key":
        for (let i = 0; i < Number(inp.repeat ?? 1); i++) await k.press(toPwKey(String(inp.text)));
        await this.settle();
        await this.checkStop();
        return "OK";
      case "hold_key": {
        const key = toPwKey(String(inp.text));
        await k.down(key); await p.waitForTimeout(1000 * Math.min(Number(inp.duration ?? 1), 10)); await k.up(key);
        return "OK";
      }
      case "wait":
        await p.waitForTimeout(1000 * Math.min(Number(inp.duration ?? 1), 30));
        return "OK";
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  }

  async navigate(url: string): Promise<string> {
    if (!this.hostOk(url)) throw new Error(`${url} is outside the allowed hosts ${this.allowed.join(", ")}`);
    await this.page.goto(this.tagUrl(url), { waitUntil: "domcontentloaded", timeout: 45000 });
    await this.settle();
    await this.checkStop();
    return `Now at ${this.page.url()}`;
  }

  async pageSignals(): Promise<Dict> {
    let dom: Dict = {};
    try {
      dom = await this.page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
        return {
          title: document.title,
          lang: document.documentElement.lang || null,
          h1: [...document.querySelectorAll("h1")].map((h) => (h as HTMLElement).innerText.trim()).slice(0, 3),
          imgs_missing_alt: [...document.images].filter((i) => !i.hasAttribute("alt")).length,
          inputs_without_label: [...document.querySelectorAll("input:not([type=hidden]),select,textarea")].filter((el: any) =>
            !(el.labels && el.labels.length) && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby")).length,
          load_ms: nav ? Math.round(nav.loadEventEnd || nav.domContentLoadedEventEnd) : null,
          scroll_height: document.documentElement.scrollHeight,
          viewport_height: innerHeight,
        };
      });
    } catch (e) { dom = { error: String(e).slice(0, 200) }; }
    return { url: this.page.url(), ...dom, ...this.telemetry.sinceLast() };
  }

  async pageText(limit = 6000): Promise<string> {
    try { return (await this.page.evaluate(() => document.body.innerText)).slice(0, limit); }
    catch (e) { return `(could not read text: ${e})`; }
  }
}

export { sleep };
