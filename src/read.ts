/**
 * Read + navigation logic, all via the Chrome DevTools Accessibility tree
 * (validated in Phase 0 to read shadow-DOM fields, tabbed panels, and iframed
 * rich text). Clicking is done precisely by the node's backendDOMNodeId, never
 * by injecting arbitrary scripts on the model's behalf.
 *
 * The ONLY write action in this whole server is typing into the search box
 * (`typeInSearch`). Everything else is read/navigation and is ServiceNow-locked
 * by the caller (see browser.ts).
 */
import type { Page, CDPSession } from "puppeteer-core";
import { isAllowedUrl } from "./config.js";
import { authPageReason, SIGN_IN_HINT } from "./browser.js";

export type AXNode = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  properties?: { name: string; value?: { value?: unknown } }[];
  backendDOMNodeId?: number;
  childIds?: string[];
};

const rl = (n?: AXNode) => (n?.role?.value ?? "").toString();
const nm = (n?: AXNode) => (n?.name?.value ?? "").toString().trim();
const vl = (n?: AXNode) => (n?.value?.value ?? "").toString();
const prop = (n: AXNode, p: string): unknown =>
  n.properties?.find((x) => x.name === p)?.value?.value;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Strip the a11y helper suffix from a field label ("Number. This field…" -> "Number"). */
function cleanLabel(label: string): string {
  return label.split(/\.\s/)[0].replace(/\s+/g, " ").trim();
}

/** Labels we never treat as case data (nav search box + email composer chrome). */
const SKIP_LABELS = new Set([
  "search",
  "choose search context",
  "select a search resource",
  "reply to",
  "to recipient",
  "cc recipient",
]);

async function openSession(page: Page): Promise<CDPSession> {
  const client = await page.createCDPSession();
  await client.send("Accessibility.enable");
  await client.send("DOM.enable").catch(() => {});
  return client;
}

async function fullTree(client: CDPSession): Promise<AXNode[]> {
  const { nodes } = (await client.send("Accessibility.getFullAXTree")) as unknown as {
    nodes: AXNode[];
  };
  return nodes;
}

/** Click an element identified by its accessibility backend node id. */
async function clickBackend(client: CDPSession, backendNodeId: number): Promise<void> {
  const { object } = (await client.send("DOM.resolveNode", { backendNodeId })) as unknown as {
    object: { objectId?: string };
  };
  if (!object.objectId) throw new Error("Could not resolve node to click.");
  await client.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration:
      "function(){ this.scrollIntoView({block:'center'}); this.click(); }",
    awaitPromise: false,
  });
  await client.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
}

function buildMaps(nodes: AXNode[]) {
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);
  const parentOf = new Map<string, string>();
  for (const n of nodes) for (const c of n.childIds ?? []) parentOf.set(c, n.nodeId);
  return { byId, parentOf };
}

const CLICKABLE = new Set([
  "link",
  "button",
  "listitem",
  "menuitem",
  "tab",
  "row",
  "gridcell",
  "option",
  "cell",
]);

/** Walk up from a node to the nearest clickable, backend-resolvable ancestor. */
function climbToClickable(
  node: AXNode,
  byId: Map<string, AXNode>,
  parentOf: Map<string, string>,
): AXNode | undefined {
  let cur: AXNode | undefined = node;
  for (let hops = 0; cur && hops < 12; hops++) {
    if (CLICKABLE.has(rl(cur)) && cur.backendDOMNodeId != null) return cur;
    const pid = parentOf.get(cur.nodeId);
    cur = pid ? byId.get(pid) : undefined;
  }
  return undefined;
}

/** Find a clickable element whose own text (or a child's) contains `text`. */
function findClickableByText(nodes: AXNode[], text: string): AXNode | undefined {
  const { byId, parentOf } = buildMaps(nodes);
  const lower = text.toLowerCase();
  const scored = nodes
    .map((n) => ({ n, s: `${nm(n)} ${vl(n)}`.toLowerCase().trim() }))
    .filter((x) => x.s.includes(lower));
  // Prefer result-row summaries ("Number: CS…"), then the shortest match.
  scored.sort((a, b) => {
    const aRow = a.s.startsWith("number:") ? 0 : 1;
    const bRow = b.s.startsWith("number:") ? 0 : 1;
    return aRow !== bRow ? aRow - bRow : a.s.length - b.s.length;
  });
  for (const { n } of scored) {
    const target = climbToClickable(n, byId, parentOf);
    if (target) return target;
  }
  return undefined;
}

/**
 * From a global-search results page, open the case matching `caseNumber`.
 * The results list renders asynchronously, so we poll for it rather than
 * snapshotting once and giving up.
 */
/**
 * sn_open_case end to end: search for the number, then either follow the
 * typeahead's direct jump to the record or click the matching result row.
 * Wrapped so the tab counts as visible for the whole operation — otherwise the
 * results page never renders and there is nothing to click.
 */
export async function openCaseByNumber(page: Page, caseNumber: string): Promise<string> {
  return withVisibleTab(page, async () => {
    await typeInSearch(page, caseNumber);
    return openCaseFromSearch(page, caseNumber);
  });
}

export async function openCaseFromSearch(page: Page, caseNumber: string): Promise<string> {
  const want = caseNumber.trim().toUpperCase();
  const client = await openSession(page);
  try {
    let hit: AXNode | undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      // ServiceNow's typeahead often skips the results page entirely: for an exact
      // case-number match it navigates STRAIGHT to that record. That is a success,
      // not a failure — check for it before hunting for a result row to click,
      // otherwise a case that is already open gets reported as "not found".
      if (onCaseRecordUrl(page) && (await selectedCaseNumber(page)) === want) {
        return `${want} is open (the search went straight to the record). Read it with sn_read_case.`;
      }
      const nodes = await fullTree(client);
      hit = findClickableByText(nodes, caseNumber);
      if (hit && hit.backendDOMNodeId != null) break;
      hit = undefined;
      await sleep(1200);
    }
    if (!hit || hit.backendDOMNodeId == null) {
      const hidden = await isHidden(page);
      return (
        `Could not find a clickable search result for ${caseNumber} after ~14s.` +
        (hidden ? `\n${HIDDEN_TAB_NOTE}` : "")
      );
    }
    await clickBackend(client, hit.backendDOMNodeId);
    await page.waitForNetworkIdle({ idleTime: 600, timeout: 8000 }).catch(() => {});
    await sleep(800);
    const url = page.url();
    if (/\/record\/ps_customerservice_ts_case\//.test(url)) {
      return `Opened ${caseNumber}. Use sn_read_case to read it.\nURL: ${url}`;
    }
    return `Clicked a result for ${caseNumber} but landed on: ${url}`;
  } finally {
    await client.detach().catch(() => {});
  }
}

/**
 * Opening a case pops a "Special Handling Note" modal that scopes the a11y
 * tree to itself. We CAPTURE its text (bonus SHI read) and close it with the
 * benign "Close dialog" button ONLY. We NEVER touch "Dismiss note", because
 * dismissing acknowledges the note = a write. Returns captured text, or "".
 */
export async function handleShiPopup(page: Page): Promise<string> {
  const client = await openSession(page);
  try {
    const nodes = await fullTree(client);
    const dialog = nodes.find((n) => rl(n) === "dialog");
    const closeBtn = nodes.find((n) => rl(n) === "button" && nm(n).toLowerCase() === "close dialog");
    if (!dialog || !closeBtn) return "";
    const note = nodes
      .filter((n) => rl(n) === "StaticText" && nm(n))
      .map((n) => nm(n))
      .filter((t) => t.toLowerCase() !== "close dialog")
      .join("\n")
      .trim();
    if (closeBtn.backendDOMNodeId != null) {
      // SAFETY: only ever the benign close — never "Dismiss note".
      await clickBackend(client, closeBtn.backendDOMNodeId);
      await sleep(500);
    }
    return note;
  } finally {
    await client.detach().catch(() => {});
  }
}

/** One snapshot of currently-rendered field label -> value pairs. */
async function snapshotFields(page: Page): Promise<Map<string, string>> {
  const client = await openSession(page);
  try {
    const nodes = await fullTree(client);
    const m = new Map<string, string>();
    for (const n of nodes) {
      const r = rl(n);
      if (r !== "textbox" && r !== "combobox") continue;
      const raw = nm(n);
      if (!raw) continue;
      const label = cleanLabel(raw);
      if (!label || SKIP_LABELS.has(label.toLowerCase())) continue;
      const val = vl(n).trim();
      // Keep first non-empty value we ever see for a label.
      if (!m.has(label) || (!m.get(label) && val)) m.set(label, val);
    }
    return m;
  } finally {
    await client.detach().catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * Full Details-form reading.
 *
 * The Configurable Workspace renders the Details form inside
 * `now-record-form-section-column-layout` (a shadow-DOM scroll pane) and only
 * materialises a field's control while it is near the viewport — the field
 * *shells* (`sn-record-input-connected[name]`) always exist but are empty until
 * scrolled to. So a single snapshot can never see the whole form; we walk the
 * pane's scrollTop and accumulate.
 *
 * These helpers use `Runtime.evaluate` with FIXED, server-authored expressions.
 * The model cannot supply or influence the JavaScript — no eval tool exists in
 * the tool surface. Everything read here is attribute/property reading; the only
 * mutation is `scrollTop` (and `.click()` on the Details tab), which is
 * client-side view state and changes no record data.
 * ------------------------------------------------------------------ */

/**
 * Shadow-piercing element walker, prepended to every extraction expression.
 *
 * `deepWalk(visit, root)` defaults to the whole document, but callers that read
 * FIELD VALUES must pass a scoped root. The workspace keeps every previously
 * opened case's DOM alive in its background tabs, so a document-wide walk will
 * happily return the *previous* case's field values. `visibleFormPane()` returns
 * the form pane that is actually on screen, which is the only safe root.
 */
const DEEP_WALK = `
function deepWalk(visit, root){
  const seen = new Set();
  (function rec(node, depth){
    if(!node || depth > 60) return;
    let els;
    try { els = node.querySelectorAll('*'); } catch(_) { return; }
    for(const el of els){
      if(seen.has(el)) continue;
      seen.add(el);
      visit(el);
      if(el.shadowRoot) rec(el.shadowRoot, depth + 1);
    }
  })(root || document, 0);
}
function isVisible(el){
  try {
    const r = el.getBoundingClientRect();
    if(r.width < 60 || r.height < 20) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  } catch(_) { return false; }
}
function visibleFormPane(){
  let best = null;
  deepWalk(el => {
    if(el.tagName.toLowerCase() !== 'now-record-form-section-column-layout') return;
    if(!isVisible(el)) return;
    let sh = 0;
    try { sh = el.scrollHeight; } catch(_) {}
    if(!best || sh > best.sh) best = { el: el, sh: sh };
  });
  return best ? best.el : null;
}
`;

/** Run a fixed, server-authored read expression in the page. */
async function evalRead<T>(page: Page, body: string): Promise<T | null> {
  const client = await page.createCDPSession();
  try {
    const res = (await client.send("Runtime.evaluate", {
      expression: `(function(){${DEEP_WALK}\n${body}\n})()`,
      returnByValue: true,
      awaitPromise: true,
    })) as unknown as { result?: { value?: T }; exceptionDetails?: unknown };
    if (res.exceptionDetails) return null;
    return res.result?.value ?? null;
  } finally {
    await client.detach().catch(() => {});
  }
}

/** Field names/labels that belong to page chrome, not to the case record. */
const SKIP_FIELD = /^(sn-aa-search-box|input-EmailTemplate|sncwsgs-typeahead-input)$/i;
const SKIP_FIELD_LABEL = new Set([
  "search",
  "reply to",
  "to recipient",
  "cc recipient",
  "compose your email here",
  "side by side",
]);

/** "u_purity_version" -> "Purity Version" (fallback when no label renders). */
function humanize(name: string): string {
  return name
    .replace(/^u_/, "")
    .replace(/-date$/, "")
    .replace(/\./g, " ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

type FieldRow = [name: string, label: string, value: string, tag: string];

/**
 * Harvest every currently-materialised form control. Each control is a `now-*`
 * component carrying the ServiceNow field `name`; its value is on the `value`
 * attribute (or the native control inside), its label in its shadow root.
 */
const HARVEST_FIELDS = `
  const pane = visibleFormPane();
  if(!pane) return [];
  const rows = [];
  deepWalk(el => {
    const tag = el.tagName.toLowerCase();
    if(!/^now-(input|select|textarea|choice|record-reference|rich-text|html)/.test(tag)) return;
    const name = el.getAttribute('name') || '';
    if(!name) return;
    let value = el.getAttribute('value');
    if(value == null) value = '';
    let label = el.getAttribute('label') || '';
    const findLabel = (root, d) => {
      if(!root || d > 4 || label) return;
      let els;
      try { els = root.querySelectorAll('label,[class*=label]'); } catch(_) { return; }
      for(const x of els){
        const tx = (x.innerText || x.textContent || '').replace(/\\s+/g,' ').trim();
        if(tx && tx.length < 45){ label = tx; return; }
      }
      let all;
      try { all = root.querySelectorAll('*'); } catch(_) { return; }
      for(const x of all) if(x.shadowRoot) findLabel(x.shadowRoot, d + 1);
    };
    findLabel(el.shadowRoot, 0);
    if(!label){
      // Climb to the field shell and look for a label anywhere inside it.
      let host = el;
      for(let i=0;i<8 && host;i++){
        if(host.tagName && host.tagName.toLowerCase() === 'sn-record-input-connected'){ findLabel(host, 0); break; }
        host = host.parentElement || (host.getRootNode && host.getRootNode().host) || null;
      }
    }
    if(!value){
      const scan = (root, d) => {
        if(!root || d > 6 || value) return;
        let els;
        try { els = root.querySelectorAll('input,textarea,select'); } catch(_) { return; }
        for(const x of els){
          if(x.getAttribute('type') === 'checkbox'){ value = x.checked ? 'true' : 'false'; return; }
          const v = (x.value || '').toString().trim();
          if(v){ value = v; return; }
        }
        let all;
        try { all = root.querySelectorAll('*'); } catch(_) { return; }
        for(const x of all) if(x.shadowRoot) scan(x.shadowRoot, d + 1);
      };
      scan(el.shadowRoot || el, 0);
      if(!value) scan(el, 0);
    }
    rows.push([name, label.replace(/\\s*\\*\\s*$/,'').trim(), (value || '').toString().slice(0, 400), tag]);
  }, pane);
  return rows;
`;

/** Every field shell the form declares, whether or not its control is rendered. */
const LIST_SHELLS = `
  const collect = (root) => {
    const names = [];
    deepWalk(el => {
      if(el.tagName.toLowerCase() !== 'sn-record-input-connected') return;
      const n = el.getAttribute('name');
      if(n) names.push(n);
    }, root);
    return names;
  };
  const pane = visibleFormPane();
  let names = pane ? collect(pane) : [];
  // Fall back to a document-wide scan: in the accessibility-rendered mode there
  // is no visible component pane, and losing this list would silently drop the
  // "declared but unreadable" warning. Names carry no values, so a wider scan
  // cannot leak another case's DATA — at worst it over-reports what is unread,
  // which is the safe direction.
  if(!names.length) names = collect(document);
  return [...new Set(names)];
`;

/**
 * The workspace collapses the whole Details form when the window is narrow —
 * a ~800px-wide window yields only a handful of fields. Enlarge the real window
 * if it is too small. View state only; we never shrink it, and we only report a
 * change that actually took effect (the OS caps this at the screen size).
 */
async function ensureWindowSize(page: Page, minW = 1360, minH = 660): Promise<string> {
  const client = await page.createCDPSession();
  try {
    const { windowId, bounds } = (await client.send("Browser.getWindowForTarget")) as unknown as {
      windowId: number;
      bounds: { width?: number; height?: number; windowState?: string };
    };
    const w = bounds.width ?? 0;
    const h = bounds.height ?? 0;
    if (w >= minW && h >= minH) return "";
    if (bounds.windowState && bounds.windowState !== "normal") {
      await client
        .send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } })
        .catch(() => {});
    }
    await client
      .send("Browser.setWindowBounds", {
        windowId,
        bounds: { width: Math.max(w, minW), height: Math.max(h, minH) },
      })
      .catch(() => {});
    await sleep(1500);
    const after = (await client.send("Browser.getWindowForTarget")) as unknown as {
      bounds: { width?: number; height?: number };
    };
    const nw = after.bounds.width ?? w;
    const nh = after.bounds.height ?? h;
    if (nw === w && nh === h) {
      return (
        `[note: browser window is ${w}x${h}, smaller than the ${minW}x${minH} the Details form ` +
        `needs, and the screen will not allow it to grow. Some fields may not lay out.]`
      );
    }
    return `[window enlarged ${w}x${h} -> ${nw}x${nh} so the Details form lays out]`;
  } catch {
    return "";
  } finally {
    await client.detach().catch(() => {});
  }
}

/**
 * Which case is the workspace ACTUALLY displaying, per its own tab strip.
 *
 * This is the trustworthy answer to "which case is on screen", and it is what
 * the stale-read guard cross-checks the form against. It must NOT come from
 * `page.title()`: on this instance a case tab's title is
 * "<short description> | CSM/FSM Configurable Workspace | ServiceNow", which
 * contains no case number at all, so a title-derived check silently never runs.
 *
 * The workspace tab strip exposes the open cases as `tab` nodes named exactly
 * "CS1234567", with `selected` true on the visible one.
 */
async function selectedCaseNumber(page: Page): Promise<string | undefined> {
  const client = await openSession(page);
  try {
    const nodes = await fullTree(client);
    const caseTabs = nodes.filter(
      (n) => rl(n) === "tab" && /^CS\d{6,}$/i.test(cleanLabel(nm(n)).trim()),
    );
    const sel = caseTabs.find((t) => prop(t, "selected") === true);
    return sel ? cleanLabel(nm(sel)).trim().toUpperCase() : undefined;
  } catch {
    return undefined;
  } finally {
    await client.detach().catch(() => {});
  }
}

/** True when the browser is on a case-record URL (not a search/list page). */
function onCaseRecordUrl(page: Page): boolean {
  return /\/record\/ps_customerservice_ts_case\//.test(page.url());
}

/** Select the "Details" tab if it exists and isn't already the active one. */
async function ensureDetailsTab(page: Page): Promise<void> {
  const client = await openSession(page);
  try {
    const nodes = await fullTree(client);
    const tabs = nodes.filter((n) => rl(n) === "tab" && nm(n));
    const details = tabs.find((t) => nm(t).toLowerCase() === "details");
    if (!details || details.backendDOMNodeId == null) return;
    if (prop(details, "selected") === true) return;
    await clickBackend(client, details.backendDOMNodeId);
    await sleep(900);
  } catch {
    /* best effort */
  } finally {
    await client.detach().catch(() => {});
  }
}

/**
 * Wait until the active case's form pane is actually laid out. Opening a case
 * (especially behind a Special Handling Note popup) leaves the pane in the DOM
 * with zero geometry for a few seconds — harvesting then yields nothing, or
 * worse, another tab's values. Poll instead of guessing a sleep.
 */
async function waitForForm(
  page: Page,
  expected: string | undefined,
  timeoutMs = 30000,
): Promise<{ ok: boolean; waitedMs: number; ax: Map<string, string>; why: string }> {
  const started = Date.now();
  let ax = new Map<string, string>();
  let why = "no form fields ever rendered";
  while (Date.now() - started < timeoutMs) {
    ax = await snapshotFields(page);
    const num = (ax.get("Number") ?? "").trim();
    const hasDepth = ax.has("Priority") || ax.has("Assigned to") || ax.has("Short description");
    if (num && hasDepth) {
      // If we know which case the page is on, wait until the form agrees.
      if (!expected || num.toUpperCase() === expected.toUpperCase()) {
        return { ok: true, waitedMs: Date.now() - started, ax, why: "" };
      }
      why = `form still showing ${num} while the page is on ${expected}`;
    } else if (num) {
      why = "form rendered only its top fields";
    }
    // The DOM-component rendering mode is also acceptable readiness.
    const dom = await evalRead<{ controls: number }>(
      page,
      `
      const pane = visibleFormPane();
      if(!pane) return { controls: 0 };
      let c = 0;
      deepWalk(el => {
        const t = el.tagName.toLowerCase();
        if(/^now-(input|select|textarea|choice)/.test(t) && el.getAttribute('name')) c++;
      }, pane);
      return { controls: c };
      `,
    );
    if ((dom?.controls ?? 0) > 3 && ax.size > 3) {
      return { ok: true, waitedMs: Date.now() - started, ax, why: "" };
    }
    await sleep(1000);
  }
  return { ok: false, waitedMs: Date.now() - started, ax, why };
}

/** How many case tabs (CS…) the workspace currently has open. */
async function countCaseTabs(page: Page): Promise<number> {
  const client = await openSession(page);
  try {
    const nodes = await fullTree(client);
    const names = new Set<string>();
    for (const n of nodes) {
      if (rl(n) !== "tab") continue;
      const m = /^(CS\d{6,})$/.exec(nm(n));
      if (m) names.add(m[1].toUpperCase());
    }
    return names.size;
  } catch {
    return 0;
  } finally {
    await client.detach().catch(() => {});
  }
}

/** Header card fields, read as DescriptionList term/definition pairs. */
async function readHeaderPairs(page: Page): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const client = await openSession(page);
  try {
    const nodes = await fullTree(client);
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const textOf = (n: AXNode): string => {
      const own = nm(n);
      if (own) return own;
      const parts: string[] = [];
      const rec = (id: string, d: number) => {
        if (d > 8) return;
        const x = byId.get(id);
        if (!x) return;
        if (rl(x) === "StaticText" && nm(x)) parts.push(nm(x));
        for (const c of x.childIds ?? []) rec(c, d + 1);
      };
      for (const c of n.childIds ?? []) rec(c, 0);
      return parts.join(" ").replace(/\s+/g, " ").trim();
    };
    // The first DescriptionList in document order is the record header card.
    const list = nodes.find((n) => rl(n) === "DescriptionList");
    if (!list) return out;
    const kids: AXNode[] = [];
    const rec = (id: string, d: number) => {
      if (d > 6) return;
      const x = byId.get(id);
      if (!x) return;
      const r = rl(x);
      if (r === "term" || r === "definition") kids.push(x);
      for (const c of x.childIds ?? []) rec(c, d + 1);
    };
    for (const c of list.childIds ?? []) rec(c, 0);
    for (let i = 0; i < kids.length; i++) {
      if (rl(kids[i]) !== "term") continue;
      const next = kids[i + 1];
      if (!next || rl(next) !== "definition") continue;
      const k = textOf(kids[i]);
      if (k) out.set(k, textOf(next));
    }
    return out;
  } finally {
    await client.detach().catch(() => {});
  }
}

/**
 * Read the open case's Details form in full.
 *
 * Strategy (validated live against a known-good case):
 *   1. close the SHI popup benignly (never "Dismiss note")
 *   2. make sure the window is wide enough for the form to exist at all
 *   3. select the Details tab
 *   4. read the header card (Account/Contact/Priority/State/...)
 *   5. walk the form pane's scrollTop, harvesting controls as they materialise
 *   6. report any declared field whose control never rendered, rather than
 *      silently dropping it
 */
export async function readCase(page: Page): Promise<string> {
  // A panel row opened in place is a different record with a different layout.
  // Handle it explicitly instead of failing the case-form gate and then
  // misblaming the open case tabs.
  const sub = subRecordInfo(page);
  if (sub) return readSubRecord(page, sub);

  const popup = await handleShiPopup(page);
  const resized = await ensureWindowSize(page);
  await ensureDetailsTab(page);

  // Which case is the page actually on? Used both to wait for the right form and
  // to refuse a stale read of a background tab.
  // Which case is on screen? The workspace tab strip is authoritative; the page
  // title is only a fallback (on this instance it carries no case number, so a
  // title-only check leaves the stale-read guard permanently disarmed).
  const title = await page.title().catch(() => "");
  const tabCase = await selectedCaseNumber(page);
  const expected = tabCase ?? /\b(CS\d{6,})\b/.exec(title)?.[1];
  const expectedFrom = tabCase ? "workspace tab" : expected ? "page title" : "";

  const ready = await waitForForm(page, expected);
  const header = await readHeaderPairs(page);

  const fields = new Map<string, { label: string; value: string }>();
  const merge = (rows: FieldRow[] | null) => {
    for (const [name, label, value, _tag] of rows ?? []) {
      if (SKIP_FIELD.test(name)) continue;
      if (SKIP_FIELD_LABEL.has(label.toLowerCase())) continue;
      const prev = fields.get(name);
      if (!prev || (!prev.value && value) || (!prev.label && label)) {
        fields.set(name, {
          label: label || prev?.label || "",
          value: value || prev?.value || "",
        });
      }
    }
  };

  const shells = (await evalRead<string[]>(page, LIST_SHELLS)) ?? [];

  // Locate the form scroll pane and park a reference on it for the walk.
  const pane = await evalRead<{ ok: boolean; max: number; step: number } | null>(
    page,
    `
    const el = visibleFormPane();
    if(!el) return null;
    let sh = 0, ch = 0;
    try { sh = el.scrollHeight; ch = el.clientHeight; } catch(_) { return null; }
    window.__snFormPane = el;
    if(sh <= ch + 20) return { ok: true, max: 0, step: 0 };
    return { ok: true, max: sh - ch, step: Math.max(140, Math.floor(ch * 0.7)) };
    `,
  );

  merge(await evalRead<FieldRow[]>(page, HARVEST_FIELDS));

  // Accumulated accessibility-tree rows. The a11y tree only contains what is
  // currently rendered, so when the form pane is clipped we must re-snapshot at
  // each scroll position — otherwise everything below the fold is lost (this is
  // what limited one validated case to its top 20 fields).
  const axAccum = new Map<string, string>();
  const mergeAx = (m: Map<string, string>) => {
    for (const [k, v] of m) if (!axAccum.has(k) || (!axAccum.get(k) && v)) axAccum.set(k, v);
  };
  mergeAx(ready.ax);

  let steps = 0;
  if (pane?.ok && pane.step > 0) {
    for (let top = 0; top <= pane.max + pane.step; top += pane.step) {
      await evalRead(
        page,
        `const e = window.__snFormPane; if(e) e.scrollTop = ${top}; return true;`,
      );
      await sleep(300);
      merge(await evalRead<FieldRow[]>(page, HARVEST_FIELDS));
      mergeAx(await snapshotFields(page));
      steps++;
      if (steps > 40) break;
    }
    // Leave the pane back at the top, as we found it.
    await evalRead(page, `const e = window.__snFormPane; if(e) e.scrollTop = 0; return true;`);
    await sleep(300);
    mergeAx(await snapshotFields(page));
  }

  /*
   * The workspace has two rendering modes for the Details form and which one you
   * get varies by case/state:
   *   A. live `now-*` web components  -> read above, gives ServiceNow field names
   *   B. read-only fields exposed straight to the accessibility tree -> read here
   * Mode B is the richer of the two (it exposes Short description, Description,
   * Plan of action, Resolution notes, ...), so both are merged and neither is
   * treated as authoritative on its own.
   */
  const axFields = await snapshotFields(page);
  for (const [k, v] of axAccum) if (!axFields.has(k) || !axFields.get(k)) axFields.set(k, v);

  /** label(lowercased) -> ServiceNow field name, for annotating the a11y rows. */
  const nameByLabel = new Map<string, string>();
  for (const [name, f] of fields) {
    if (f.label) nameByLabel.set(f.label.toLowerCase(), name);
    nameByLabel.set(humanize(name).toLowerCase(), name);
  }

  const out: string[] = [];
  if (popup) {
    out.push(
      "[Special Handling Note popup captured & closed (benign close; note NOT dismissed)]",
      popup,
      "",
      "---",
    );
  }
  if (resized) out.push(resized, "");
  out.push(`URL: ${page.url()}`, "");

  // Guard against reading a background tab's form. The workspace keeps every
  // previously opened case in the DOM, so a stale read is a real failure mode:
  // cross-check the form's own Number against the case the page is showing.
  const readNumber = (fields.get("number")?.value || axFields.get("Number") || "").trim();
  if (expected && readNumber && expected.toUpperCase() !== readNumber.toUpperCase()) {
    return (
      out.join("\n") +
      `\n!! STALE READ ABORTED !!\n` +
      `The page is showing ${expected} but the form fields read back as ` +
      `${readNumber} — that is another case still open in a workspace tab. ` +
      `No field values are reported, because they would be the wrong case's. ` +
      `Re-open ${expected} with sn_open_case and read again.\n`
    );
  }
  if (expected && !readNumber) {
    out.push(
      `[warning: could not confirm the form belongs to ${expected} — its Number ` +
        `field did not render. Treat the fields below with caution.]`,
      "",
    );
  }

  if (header.size) {
    out.push("== Header ==");
    for (const [k, v] of header) out.push(`${k}: ${v || "—"}`);
    out.push("");
  }

  if (!ready.ok) {
    const tabs = await countCaseTabs(page);
    const nothing = header.size === 0 && axFields.size === 0 && fields.size === 0;
    out.push(
      `[warning: the Details form did not fully render (waited ` +
        `${Math.round(ready.waitedMs / 1000)}s — ${ready.why}). Fields below may ` +
        `be incomplete; anything absent must be treated as unread, not empty.]`,
    );
    if (nothing && tabs >= 3) {
      out.push(
        `[likely cause: ${tabs} case tabs are open in the workspace. With several ` +
          `case tabs open ServiceNow stops laying out the record forms and NOTHING ` +
          `is readable — observed with 3 tabs. Close the case tabs you don't need ` +
          `in the browser (or reload the workspace), then read again. No values are ` +
          `being guessed in the meantime.]`,
      );
    } else if (nothing) {
      out.push(
        `[nothing at all rendered — the workspace may still be loading or needs a ` +
          `reload. Retry before drawing any conclusion; do not treat this as an ` +
          `empty case.]`,
      );
    }
    out.push("");
  }

  // One merged Details-form listing: a11y rows (mode B) plus any component rows
  // (mode A) that the a11y tree did not already cover.
  out.push("== Details form ==");
  const seenLabels = new Set<string>();
  for (const [label, value] of axFields) {
    if (SKIP_FIELD_LABEL.has(label.toLowerCase())) continue;
    seenLabels.add(label.toLowerCase());
    const fname = nameByLabel.get(label.toLowerCase());
    out.push(`${label}${fname ? ` (${fname})` : ""}: ${value || "—"}`);
  }
  for (const [name, f] of fields) {
    const label = f.label || humanize(name);
    if (seenLabels.has(label.toLowerCase())) continue;
    seenLabels.add(label.toLowerCase());
    out.push(`${label} (${name}): ${f.value || "—"}`);
  }

  const missing = shells.filter(
    (n) =>
      !fields.has(n) &&
      !seenLabels.has(humanize(n).toLowerCase()) &&
      !seenLabels.has(n.toLowerCase()),
  );
  if (missing.length) {
    out.push(
      "",
      `== Declared but NOT readable from this form (${missing.length}) ==`,
      "The form declares these fields but the workspace never instantiates their",
      "controls in this layout, so NO value was read. They are NOT known to be",
      "empty — treat them as unread. Verified: this is independent of window size",
      "and scroll position. Read them from the panels/activity stream instead",
      "(work notes & comments appear as activity-stream posts; short description",
      "is the record title in the header).",
      missing.map((n) => `  - ${humanize(n)} (${n})`).join("\n"),
    );
  }

  // Work notes / comments live here, not on the form.
  const activity = await readActivity(page);
  if (activity.posts.length) {
    out.push("", `== Activity stream (${activity.posts.length} posts) ==`);
    if (activity.warning) out.push(activity.warning);
    activity.posts.forEach((p, i) => out.push(`--- post ${i + 1} ---`, p));
  } else {
    out.push(
      "",
      "== Activity stream ==",
      activity.warning ||
        "(No activity posts were read. Do NOT conclude the case has no work notes — " +
          "read again; the stream may not have rendered.)",
    );
  }

  out.push(
    "",
    `[read: ${seenLabels.size} form fields (${axFields.size} via accessibility tree, ` +
      `${fields.size} via form components, ${steps} scroll steps); ` +
      `${header.size} header fields; ${activity.posts.length} activity posts; ` +
      `${missing.length} declared-but-unreadable` +
      // Be precise about what was actually verified: matching the form's Number
      // against the workspace's own tab strip is a real cross-check; reading the
      // Number field alone only says the form claims to be that case.
      (readNumber && expected
        ? `; form cross-checked as ${readNumber} against the ${expectedFrom}`
        : readNumber
          ? `; form reports ${readNumber} (NOT cross-checked — no case tab or title ` +
            `to compare against)`
          : "") +
      `]`,
  );
  return out.join("\n");
}

/* ------------------------------------------------------------------ *
 * Global search results (Phase 3).
 *
 * Structure, mapped live on 2026-07-29:
 *   - a heading "N results for \"query\""
 *   - one heading per record-type facet, e.g. "GTS Cases (10 of 105608)",
 *     "Knowledge (10 of 10)", "Exact Match (1 of 1)"
 *   - one `listitem` per result: leading StaticText = the record title, then a
 *     DescriptionList of term/definition pairs. For cases those pairs are
 *     Number / Account / Assigned to / Updated / Follow up / Priority.
 *   - trailing `listitem`s whose text starts "Navigate search results" are the
 *     skip-links, not results.
 * A case can appear twice (once under "Exact Match", once under "GTS Cases"),
 * so rows are de-duplicated by Number.
 * ------------------------------------------------------------------ */

export type SearchRow = {
  category: string;
  title: string;
  fields: Map<string, string>;
};

export type SearchResults = {
  total: string;
  facets: { name: string; shown: string; total: string }[];
  rows: SearchRow[];
};

const FACET_RE = /^(.+?)\s*\((\d[\d,]*)\s+of\s+(\d[\d,]*)\)$/;
const TOTAL_RE = /^([\d,]+)\s+results?\s+for\s+/i;

/**
 * A result row's text also contains a flattened "Number: X, Account: Y, ..."
 * summary of the very same fields. Cut the title at the first field key so the
 * title stays the record title and the fields aren't printed twice.
 */
function cutTitle(lead: string, fields: Map<string, string>): string {
  let cut = lead.length;
  for (const key of fields.keys()) {
    const i = lead.indexOf(`${key}`);
    if (i > 0 && i < cut) cut = i;
  }
  return lead.slice(0, cut).replace(/[\s,|]+$/, "").trim() || lead.trim();
}

/** Parse the current search-results page out of the accessibility tree. */
async function readSearchResults(page: Page): Promise<SearchResults> {
  const client = await openSession(page);
  try {
    const nodes = await fullTree(client);
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));

    /** All StaticText under a node, in order, optionally stopping at DescriptionList. */
    const textUnder = (n: AXNode, stopAtDl: boolean): string[] => {
      const parts: string[] = [];
      const rec = (node: AXNode, d: number) => {
        if (d > 12) return;
        for (const cid of node.childIds ?? []) {
          const c = byId.get(cid);
          if (!c) continue;
          if (stopAtDl && rl(c) === "DescriptionList") return;
          if (rl(c) === "StaticText" && nm(c)) parts.push(nm(c));
          rec(c, d + 1);
        }
      };
      rec(n, 0);
      return parts;
    };

    /** term/definition pairs inside a node. */
    const pairsUnder = (n: AXNode): Map<string, string> => {
      const flat: AXNode[] = [];
      const rec = (node: AXNode, d: number) => {
        if (d > 12) return;
        for (const cid of node.childIds ?? []) {
          const c = byId.get(cid);
          if (!c) continue;
          const r = rl(c);
          if (r === "term" || r === "definition") flat.push(c);
          rec(c, d + 1);
        }
      };
      rec(n, 0);
      const out = new Map<string, string>();
      for (let i = 0; i < flat.length; i++) {
        if (rl(flat[i]) !== "term") continue;
        const next = flat[i + 1];
        if (!next || rl(next) !== "definition") continue;
        const k = (nm(flat[i]) || textUnder(flat[i], false).join(" ")).trim();
        const v = (nm(next) || textUnder(next, false).join(" ")).trim();
        if (k) out.set(k, v);
      }
      return out;
    };

    // DFS in document order so each listitem can be attributed to the facet
    // heading that precedes it.
    const root = nodes.find((n) => rl(n) === "RootWebArea") ?? nodes[0];
    let total = "";
    const facets: { name: string; shown: string; total: string }[] = [];
    const rows: SearchRow[] = [];
    let currentFacet = "";

    const walk = (n: AXNode, depth: number) => {
      if (depth > 60) return;
      const role = rl(n);
      if (role === "heading") {
        const h = (nm(n) || textUnder(n, false).join(" ")).trim();
        const t = TOTAL_RE.exec(h);
        if (t) {
          total = t[1];
        } else {
          const f = FACET_RE.exec(h);
          if (f) {
            currentFacet = f[1].trim();
            facets.push({ name: currentFacet, shown: f[2], total: f[3] });
          }
        }
      } else if (role === "listitem") {
        const lead = textUnder(n, true).join(" ").replace(/\s+/g, " ").trim();
        if (!/^Navigate search results/i.test(lead)) {
          const fields = pairsUnder(n);
          if (fields.size) {
            rows.push({ category: currentFacet, title: cutTitle(lead, fields), fields });
          }
        }
      }
      for (const cid of n.childIds ?? []) {
        const c = byId.get(cid);
        if (c) walk(c, depth + 1);
      }
    };
    if (root) walk(root, 0);

    return { total, facets, rows };
  } finally {
    await client.detach().catch(() => {});
  }
}

/** Wait until the results page has rendered a total or at least one facet. */
async function waitForResults(page: Page, timeoutMs = 20000): Promise<SearchResults> {
  const started = Date.now();
  let last: SearchResults = { total: "", facets: [], rows: [] };
  while (Date.now() - started < timeoutMs) {
    last = await readSearchResults(page);
    if (last.rows.length || last.facets.length || last.total) return last;
    await sleep(1000);
  }
  return last;
}

function renderRow(r: SearchRow): string {
  const num = r.fields.get("Number");
  const rest = [...r.fields]
    .filter(([k]) => k !== "Number")
    .map(([k, v]) => `${k}: ${v || "—"}`)
    .join(" | ");
  return `${num ? `${num} — ` : ""}${r.title || "(untitled)"}${rest ? `\n    ${rest}` : ""}`;
}

/**
 * Run a global search and return the results. Typing the query into the global
 * search box is the ONE sanctioned write in this server; everything after it is
 * reading the results page.
 */
export async function searchAndRead(page: Page, query: string): Promise<string> {
  return withVisibleTab(page, () => searchAndReadInner(page, query));
}

async function searchAndReadInner(page: Page, query: string): Promise<string> {
  await typeInSearch(page, query);
  const res = await waitForResults(page);
  const out: string[] = [`Search: ${JSON.stringify(query)}`];
  if (res.total) out.push(`Total matches reported by ServiceNow: ${res.total}`);
  if (res.facets.length) {
    out.push("", "Categories:");
    for (const f of res.facets) out.push(`  ${f.name}: showing ${f.shown} of ${f.total}`);
  }
  if (!res.rows.length) {
    out.push(
      "",
      "No result rows could be read. Either the search returned nothing, or the",
      "results had not rendered. Nothing is being inferred — re-run if unexpected.",
    );
    if (await isHidden(page)) out.push("", HIDDEN_TAB_NOTE);
    return out.join("\n");
  }
  out.push("", `Results (${res.rows.length} rows read):`);
  let facet = "";
  for (const r of res.rows) {
    if (r.category !== facet) {
      facet = r.category;
      out.push("", `-- ${facet || "(uncategorised)"} --`);
    }
    out.push(`  ${renderRow(r)}`);
  }
  out.push(
    "",
    "[Only the rows ServiceNow rendered on this page were read. Category totals",
    "above show how many more exist; narrow the query to see different ones.]",
  );
  return out.join("\n");
}

/** True if a search row looks like a case record. */
function isCaseRow(r: SearchRow): boolean {
  const num = (r.fields.get("Number") ?? "").trim();
  if (/^CS\d{6,}$/i.test(num)) return true;
  return /case/i.test(r.category);
}

/**
 * Case-scoped search. Same single write (the search box), then keeps only rows
 * that are actual case records, de-duplicated by case number — the global search
 * lists a case twice when it is also an "Exact Match".
 */
export async function findCases(page: Page, query: string): Promise<string> {
  return withVisibleTab(page, () => findCasesInner(page, query));
}

async function findCasesInner(page: Page, query: string): Promise<string> {
  await typeInSearch(page, query);

  // An exact case-number query makes the typeahead jump straight to that record
  // instead of rendering a results page. Say so plainly — the old code read the
  // record page, found no facets, and wrongly reported "no case rows found".
  if (onCaseRecordUrl(page)) {
    const open = await selectedCaseNumber(page);
    return [
      `Case search: ${JSON.stringify(query)}`,
      "",
      `The query matched a single case exactly, so ServiceNow opened it directly ` +
        `instead of listing results${open ? `: ${open}` : ""}.`,
      `That case is now the open one — read it with sn_read_case.`,
      "",
      `[No result list exists to read in this case. To get a LIST of related cases ` +
        `instead, search something broader — an asset/array name works best.]`,
    ].join("\n");
  }

  const res = await waitForResults(page);

  const seen = new Set<string>();
  const cases: SearchRow[] = [];
  for (const r of res.rows) {
    if (!isCaseRow(r)) continue;
    const key = (r.fields.get("Number") ?? r.title).trim().toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push(r);
  }

  const caseFacets = res.facets.filter((f) => /case/i.test(f.name));
  const out: string[] = [`Case search: ${JSON.stringify(query)}`];
  if (caseFacets.length) {
    for (const f of caseFacets) {
      out.push(`${f.name}: ServiceNow reports ${f.total} matching; ${f.shown} rendered.`);
    }
  }
  if (!cases.length) {
    const others = res.facets.map((f) => `${f.name} (${f.total})`).join(", ");
    out.push(
      "",
      "No case rows found.",
      others
        ? `The search did match other record types: ${others}. Global search only ` +
            `returns cases when the query hits indexed case fields — try a case ` +
            `number, account name, asset/array name, or the exact short description.`
        : "The search returned no categories at all.",
    );
    if (await isHidden(page)) out.push("", HIDDEN_TAB_NOTE);
    return out.join("\n");
  }
  out.push("", `Cases found (${cases.length}, de-duplicated by number):`);
  for (const r of cases) out.push(`  ${renderRow(r)}`);
  out.push(
    "",
    "[Open any of these with sn_open_case using its CS number, then sn_read_case.",
    "Only rendered rows were read — the totals above show how many more exist.]",
  );
  return out.join("\n");
}

/** Open a related tab on the current case by (fuzzy) label. */
export async function openPanel(page: Page, wanted: string): Promise<string> {
  const client = await openSession(page);
  try {
    // Tabs carry their row count in two different shapes: "Emails, 6" and
    // "Special Handling Notes List  (1)". Strip both before comparing.
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/,\s*\d+\s*$/, "")
        .replace(/\s*\(\s*\d+\s*\)\s*$/, "")
        .replace(/\s+/g, " ")
        .trim();
    const target = norm(wanted);

    /**
     * Match BOTH directions. The caller's label is often longer or shorter than
     * ServiceNow's ("Special Handling Notes List" vs a tab named "Special
     * handling notes"), and a one-directional startsWith/includes silently
     * reported such a panel as "not found".
     */
    const findHit = (tabs: AXNode[]) =>
      tabs.find((t) => norm(nm(t)) === target) ??
      tabs.find((t) => norm(nm(t)).startsWith(target)) ??
      tabs.find((t) => target.startsWith(norm(nm(t))) && norm(nm(t)).length >= 4) ??
      tabs.find((t) => norm(nm(t)).includes(target)) ??
      tabs.find((t) => target.includes(norm(nm(t))) && norm(nm(t)).length >= 4);

    let nodes = await fullTree(client);
    let tabs = nodes.filter((n) => rl(n) === "tab" && nm(n));
    let hit = findHit(tabs);

    // The panel strip OVERFLOWS: tabs that don't fit hide behind a "More tabs"
    // menu and are absent from the accessibility tree entirely, so "not found"
    // was never trustworthy. Expand it once and look again. This is a disclosure
    // click — same category as selecting the Details tab, no record data touched.
    let expanded = false;
    if (!hit) {
      const more = nodes.find(
        (n) => rl(n) === "button" && /^(more tabs|more)$/i.test(cleanLabel(nm(n)).trim()),
      );
      if (more?.backendDOMNodeId != null) {
        await clickBackend(client, more.backendDOMNodeId);
        await sleep(900);
        nodes = await fullTree(client);
        expanded = true;
        // Overflowed panels surface as menuitems rather than tabs.
        const menuish = nodes.filter((n) => ["tab", "menuitem"].includes(rl(n)) && nm(n));
        tabs = menuish;
        hit = findHit(menuish);
      }
    }

    if (!hit) {
      // Leave the UI as we found it. An open "More tabs" menu covers the strip,
      // and every later read then sees zero tabs — one failed lookup would
      // silently break the next ones.
      if (expanded) {
        await page.keyboard.press("Escape").catch(() => {});
        await sleep(400);
      }
      return (
        `Panel "${wanted}" not found. Available tabs${expanded ? " (incl. the \"More tabs\" overflow)" : ""}: ` +
        tabs.map((t) => nm(t)).join(" | ")
      );
    }
    if (hit.backendDOMNodeId == null) return `Found tab "${nm(hit)}" but it is not clickable.`;
    await clickBackend(client, hit.backendDOMNodeId);
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }).catch(() => {});
    await sleep(600);
    return `Opened panel "${nm(hit)}". Use sn_read_panel to read it.`;
  } finally {
    await client.detach().catch(() => {});
  }
}

/** Walk up the a11y parent chain: is `ancestorId` an ancestor of `n`? */
function hasAncestor(n: AXNode, ancestorId: string, parentOf: Map<string, string>): boolean {
  let cur: string | undefined = n.nodeId;
  for (let hops = 0; cur && hops < 80; hops++) {
    if (cur === ancestorId) return true;
    cur = parentOf.get(cur);
  }
  return false;
}

/**
 * Inline-edit affordance text ServiceNow appends to EVERY editable grid cell.
 * It is pure UI noise that made a 4-row Emails panel ~10x longer than its data.
 */
const CELL_NOISE = /\s*⫶?\s*Press and hold Shift then press Enter to edit\s*/g;

/** All visible text under a node, in order — for grid cells and list rows. */
function subtreeText(rootId: string, byId: Map<string, AXNode>): string {
  const parts: string[] = [];
  const rec = (id: string, d: number) => {
    if (d > 12) return;
    const n = byId.get(id);
    if (!n) return;
    if (rl(n) === "StaticText" && nm(n)) parts.push(nm(n));
    for (const c of n.childIds ?? []) rec(c, d + 1);
  };
  rec(rootId, 0);
  const own = byId.get(rootId);
  if (!parts.length && own && nm(own)) parts.push(nm(own));
  return [...new Set(parts)]
    .join(" ")
    .replace(CELL_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The ACTIVITY STREAM — where work notes and customer comments actually live.
 *
 * The Details form never instantiates `work_notes` / `comments` / `close_notes`
 * (they sit in the declared-but-unreadable list on every case), so without this
 * the QA form's Q5 and Q13 are unanswerable and Q2/Q4/Q10 lose "what the TSA
 * actually did". Posts render as `article` tiles.
 *
 * We click "Expand all activity posts" first: collapsed tiles truncate their text,
 * and a truncated work note would be scored as an incomplete one. That is a
 * DISCLOSURE click — it reveals existing text and writes nothing. (This
 * deliberately supersedes the earlier note to keep "Show more" expanders out of
 * the tool surface: correctness of the QA evidence needs the full text.)
 */
async function readActivity(page: Page): Promise<{ posts: string[]; warning: string }> {
  const client = await openSession(page);
  try {
    let nodes = await fullTree(client);
    const expand = nodes.find(
      (n) =>
        rl(n) === "button" && /^expand all activity posts$/i.test(cleanLabel(nm(n)).trim()),
    );
    if (expand?.backendDOMNodeId != null) {
      await clickBackend(client, expand.backendDOMNodeId);
      await sleep(1400);
      nodes = await fullTree(client);
    }

    const { byId, parentOf } = buildMaps(nodes);
    const main = nodes.find((n) => rl(n) === "main");
    const articles = nodes.filter((n) => rl(n) === "article");
    // Keep the LEAF tiles: an outer article that contains other articles would
    // repeat all of their text as one blob.
    const isContainer = (a: AXNode) =>
      articles.some((other) => other !== a && hasAncestor(other, a.nodeId, parentOf));

    const posts: string[] = [];
    const seen = new Set<string>();
    for (const a of articles) {
      if (main && !hasAncestor(a, main.nodeId, parentOf)) continue;
      if (isContainer(a)) continue;
      const t = subtreeText(a.nodeId, byId);
      if (!t || t.length < 3 || seen.has(t)) continue;
      seen.add(t);
      posts.push(t);
    }

    const stillCollapsed = nodes.filter(
      (n) => rl(n) === "button" && /^show more$/i.test(cleanLabel(nm(n)).trim()),
    ).length;
    const warning = stillCollapsed
      ? `[${stillCollapsed} post(s) still show a "Show more" control, so their text may be ` +
        `TRUNCATED. Treat anything missing as unread, not absent.]`
      : "";
    return { posts, warning };
  } catch {
    return { posts: [], warning: "[activity stream could not be read — treat as unread.]" };
  } finally {
    await client.detach().catch(() => {});
  }
}

/** `…/sub/record/<table>/<sysId>` — a panel row opened in place, not the case. */
function subRecordInfo(page: Page): { table: string; sysId: string } | null {
  const m = /\/sub\/record\/([a-z0-9_]+)\/([0-9a-f]{32})/i.exec(page.url());
  return m ? { table: m[1], sysId: m[2] } : null;
}

/**
 * Read an open SUB-RECORD (a Special Handling note, a sent email, an SLA row).
 *
 * `readCase` cannot do this: it waits for the CASE gate fields (Number +
 * Priority/Short description) which a sub-record does not have, so it burned 30s
 * and reported 0 fields — and then blamed the open case tabs, which was the wrong
 * diagnosis entirely. Sub-records also keep their rich text (an SHI note's
 * instructions, an email body) inside an IFRAME, which no field harvest reaches.
 *
 * The accessibility tree exposes the iframe's document as a child subtree, so the
 * body is read from there. Read-only: nothing here clicks or types.
 */
async function readSubRecord(
  page: Page,
  info: { table: string; sysId: string },
): Promise<string> {
  const started = Date.now();
  let fields = new Map<string, string>();
  let bodies: string[] = [];
  // Both of these SURVIVE across poll attempts. The sub-record pane is
  // transient: it renders right after navigation and then re-renders, so a later
  // snapshot can legitimately come back empty. Anything captured is kept, which
  // is what makes it safe to keep polling for the slower iframe body.
  const captured: string[] = [];
  const capturedFields = new Map<string, string>();

  for (let attempt = 0; attempt < 12; attempt++) {
    fields = await snapshotFields(page);
    for (const [k, v] of fields) {
      if (!capturedFields.has(k) || (!capturedFields.get(k) && v)) capturedFields.set(k, v);
    }
    const client = await openSession(page);
    try {
      const nodes = await fullTree(client);
      const { byId, parentOf } = buildMaps(nodes);
      const main = nodes.find((n) => rl(n) === "main");
      // Rich text lives in an iframe; fall back to paragraphs inside main.
      const frames = nodes.filter((n) => rl(n) === "Iframe");
      bodies = frames
        .map((f) => subtreeText(f.nodeId, byId))
        .filter((t) => t && t.length > 2);
      if (!bodies.length) {
        const paras = nodes
          .filter(
            (n) =>
              rl(n) === "paragraph" && (!main || hasAncestor(n, main.nodeId, parentOf)),
          )
          .map((p) => subtreeText(p.nodeId, byId))
          .filter(Boolean);
        if (paras.length) bodies = [paras.join("\n")];
      }
    } finally {
      await client.detach().catch(() => {});
    }
    /*
     * The accessibility tree stops at the iframe boundary here — it yielded only
     * the field LABEL ("Message"), not the note text — so read the iframe's own
     * document. `innerText` is a FIXED, server-authored expression (there is no
     * eval tool), and frames are restricted to the locked ServiceNow host;
     * about:blank / srcdoc frames are the rich-text editors themselves and are
     * allowed because they carry no third-party origin.
     */
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const url = frame.url();
      if (url && /^https?:/i.test(url) && !isAllowedUrl(url)) continue;

      /*
       * ONLY frames that are actually on screen. The workspace keeps every
       * previously opened record alive in the DOM, so a hidden iframe leaks
       * another record's text: reading a sent email picked up the Special
       * Handling note opened moments earlier, which would look like the SHI had
       * been quoted in the email. Same failure class as the stale-read bug.
       */
      const el = await frame.frameElement().catch(() => null);
      const box = el ? await el.boundingBox().catch(() => null) : null;
      if (el) await el.dispose().catch(() => {});
      if (!box || box.width < 5 || box.height < 5) continue;

      const text = await frame
        .evaluate(() => document.body?.innerText ?? "")
        .catch(() => "");
      const clean = text.replace(CELL_NOISE, " ").replace(/\n{3,}/g, "\n\n").trim();
      if (clean && !bodies.some((b) => b.includes(clean))) bodies.push(clean);
    }
    bodies = bodies.filter((b) => b && b.trim().toLowerCase() !== "message");
    // NOTE: `bodies` ACCUMULATES across attempts on purpose. A later poll can
    // find the iframe momentarily gone, and reassigning would throw away text
    // already captured — which is exactly how a note with a real body came back
    // as "0 rich-text blocks".
    //
    // Collapse by CONTAINMENT, not exact equality. The pane is transient, so one
    // attempt can catch the iframe MID-RENDER and capture a partial body while a
    // later attempt captures the finished one. Those two strings are not equal,
    // so exact-match dedupe kept BOTH and the read reported a spurious second
    // "rich-text block" — which trips the leak guard on a count, with no leak.
    //
    // This does NOT weaken that guard: text bled in from a DIFFERENT record is
    // not a substring of this record's body, so it is still kept and still
    // reported. Only prefixes of what we already have are dropped.
    for (const b of bodies) {
      const t = b.trim();
      if (!t) continue;
      if (captured.some((c) => c.includes(t))) continue;
      for (let i = captured.length - 1; i >= 0; i--) {
        if (t.includes(captured[i])) captured.splice(i, 1);
      }
      captured.push(t);
    }
    bodies = captured;

    /*
     * Do NOT stop as soon as fields appear. A note's fields (Priority, Applies
     * To, Expires) render immediately while its iframe body arrives later, so
     * breaking on `fields.size` returned a note with NO instructions text and
     * looked like an empty note. Wait for the body, but give up after ~6s so a
     * genuinely empty one does not stall the read.
     */
    if (bodies.length) break;
    /*
     * Return quickly once fields exist. MEASURED, not reasoned: waiting longer
     * makes the body LESS likely to be captured, not more — raising this to 6
     * passes (~7s) took SHI bodies from "fails ~1 run in 4" to "fails on both
     * cases". Something about repeatedly re-snapshotting the transient pane
     * costs us the iframe, so the fast path wins. Do not raise this again
     * without diagnosing the frame lifecycle first.
     *
     * KNOWN LIMITATION: an SHI note body still occasionally comes back empty.
     * The read reports it as UNREAD (never as "empty"), and reading again has
     * always worked. See the README troubleshooting entry.
     */
    if (capturedFields.size && attempt >= 2) break;
    await sleep(1200);
  }
  fields = capturedFields;

  const out = [
    `Sub-record: ${info.table} / ${info.sysId}`,
    `URL: ${page.url()}`,
    "",
  ];
  if (fields.size) {
    out.push("== Fields ==");
    for (const [k, v] of fields) out.push(`${k}: ${v || "—"}`);
  }
  if (bodies.length) {
    out.push("", "== Body / rich text ==", ...bodies);
  } else if (fields.size) {
    out.push(
      "",
      "== Body / rich text ==",
      "(No rich text found after waiting. This record may genuinely have an empty " +
        "body — but treat it as UNREAD, not as confirmed empty.)",
    );
  }
  if (!fields.size && !bodies.length) {
    out.push(
      `[nothing readable after ${Math.round((Date.now() - started) / 1000)}s. The ` +
        `record may still be loading — read again. No values are being guessed.]`,
    );
  }
  out.push(
    "",
    `[sub-record read: ${fields.size} fields, ${bodies.length} rich-text block(s). ` +
      `This is NOT the case form — use sn_open_case to go back to the case.]`,
  );
  return out.join("\n");
}

/**
 * The record's OWN related-panel tab strip, and which panel is open.
 *
 * The workspace nests several tablists — the app strip (Home/List/Inbox), the
 * open-cases strip (CS…), and the record's related-panel strip — and EACH has its
 * own selected tab. So "the first selected tab in the document" is wrong: it
 * returns "Home", which is what made readPanel report the wrong panel entirely.
 * The record's strip is the one that also contains a "Details" tab.
 */
function panelStrip(nodes: AXNode[]): { tabs: AXNode[]; selected?: AXNode } {
  const { parentOf } = buildMaps(nodes);
  const allTabs = nodes.filter((n) => rl(n) === "tab" && nm(n));
  for (const tl of nodes.filter((n) => rl(n) === "tablist")) {
    const tabs = allTabs.filter((t) => hasAncestor(t, tl.nodeId, parentOf));
    if (tabs.some((t) => cleanLabel(nm(t)).trim().toLowerCase() === "details")) {
      return { tabs, selected: tabs.find((t) => prop(t, "selected") === true) };
    }
  }
  // Fallback: of several selected tabs the LAST is the innermost, i.e. the most
  // specific — never the app-level "Home".
  const sel = allTabs.filter((t) => prop(t, "selected") === true);
  return { tabs: allTabs, selected: sel[sel.length - 1] };
}

/** Page furniture that is a link but never a record. */
const CHROME_LINK =
  /^(skip to main content|open accessibility preferences|cxone agent for servicenow)$/i;

/**
 * Enumerate the openable record links of the OPEN PANEL, in order.
 *
 * Scoped to the `main` region: the old version collected every link in the
 * document, so it offered "Skip to main content" as record #1 — and
 * sn_open_record would have clicked it.
 */
type PanelItem = { node: AXNode; label: string; column?: string };

function listItems(nodes: AXNode[]): PanelItem[] {
  const { parentOf } = buildMaps(nodes);
  const main = nodes.find((n) => rl(n) === "main");

  /*
   * Scope to the panel's OWN grid when there is one, and always exclude the
   * record header card (the first DescriptionList).
   *
   * Why: an EMPTY Dispatch Orders panel used to list the account name and
   * `Storage Support` as "openable records" — those are the case header's Account
   * and Contact reference links, not dispatch rows. During the QA-form fill that
   * was one misreading away from flipping Q3 from N/A to a 9-point question.
   */
  const grid = nodes.find((n) => ["grid", "table", "treegrid"].includes(rl(n)));
  const headerCard = nodes.find((n) => rl(n) === "DescriptionList");
  const scope = grid ?? main;

  // Which grid COLUMN each link sits in. A related list's row is mostly
  // reference links (Account, Contact, Assigned to…) and only one of them is the
  // panel's own record, so an unlabelled "1., 2., 3." list is a trap: index 1 of
  // an SLA row is the Account, and opening it navigates to an account record.
  const colOf = new Map<string, string>();
  if (grid) {
    const headers = nodes
      .filter((n) => rl(n) === "columnheader" && hasAncestor(n, grid.nodeId, parentOf))
      .map((h) => cleanLabel(nm(h)).trim());
    const links = nodes.filter((n) => rl(n) === "link" && nm(n));
    for (const row of nodes.filter(
      (n) => rl(n) === "row" && hasAncestor(n, grid.nodeId, parentOf),
    )) {
      const cells = nodes.filter(
        (c) => ["gridcell", "cell"].includes(rl(c)) && hasAncestor(c, row.nodeId, parentOf),
      );
      cells.forEach((c, i) => {
        for (const l of links) {
          if (hasAncestor(l, c.nodeId, parentOf)) colOf.set(l.nodeId, headers[i] || `col${i + 1}`);
        }
      });
    }
  }

  const out: PanelItem[] = [];
  const seen = new Set<string>();
  for (const l of nodes) {
    if (rl(l) !== "link" || !nm(l)) continue;
    const label = cleanLabel(nm(l)).trim();
    if (CHROME_LINK.test(label)) continue;
    if (scope && !hasAncestor(l, scope.nodeId, parentOf)) continue;
    if (headerCard && hasAncestor(l, headerCard.nodeId, parentOf)) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ node: l, label, column: colOf.get(l.nodeId) });
  }
  return out;
}

/**
 * Rows of the open panel. ServiceNow renders related lists as an a11y GRID
 * (columnheader + gridcell), NOT as links — reading only links reported an
 * SLA panel holding one row as "empty except page chrome".
 */
/**
 * Optional per-row rewrite, used only by sn_case_bundle (e.g. email HTML ->
 * plain text). Runs in Node on text already read — it can't touch the page.
 * The single-panel tools never pass it, so their output is unchanged.
 */
export type RowTransform = (cells: [label: string, value: string][]) => [string, string][];

function readGridRows(nodes: AXNode[], transform?: RowTransform): string[] {
  const { byId, parentOf } = buildMaps(nodes);
  const grid = nodes.find((n) => ["grid", "table", "treegrid"].includes(rl(n)));
  if (!grid) return [];
  const headers = nodes
    .filter((n) => rl(n) === "columnheader" && hasAncestor(n, grid.nodeId, parentOf))
    .map((h) => cleanLabel(nm(h)).trim() || subtreeText(h.nodeId, byId));
  const out: string[] = [];
  for (const row of nodes.filter((n) => rl(n) === "row" && hasAncestor(n, grid.nodeId, parentOf))) {
    const cells = nodes.filter(
      (c) => ["gridcell", "cell"].includes(rl(c)) && hasAncestor(c, row.nodeId, parentOf),
    );
    if (!cells.length) continue; // the header row itself
    let pairs: [string, string][] = cells
      .map((c, i): [string, string] => [headers[i] || `col${i + 1}`, subtreeText(c.nodeId, byId)])
      .filter(([, v]) => Boolean(v));
    if (transform) pairs = transform(pairs);
    if (pairs.length) out.push(pairs.map(([label, v]) => `${label}: ${v}`).join(" | "));
  }
  return out;
}

/** Read the currently open panel: its records, or report empty. */
export async function readPanel(page: Page, transform?: RowTransform): Promise<string> {
  const client = await openSession(page);
  try {
    const nodes = await fullTree(client);
    const { byId, parentOf } = buildMaps(nodes);
    const { selected } = panelStrip(nodes);
    const panelLabel = selected ? cleanLabel(nm(selected)).trim() : "(unknown)";
    const header = `Open panel: ${panelLabel}`;
    // The tab label carries its row count in either shape: "Emails, 4" or
    // "Special Handling Notes List  (1)". No count means the panel has no rows —
    // which is how an empty panel is told apart from one that failed to render.
    const declared =
      /,\s*(\d+)\s*$/.exec(panelLabel)?.[1] ?? /\(\s*(\d+)\s*\)\s*$/.exec(panelLabel)?.[1];
    const declaredCount = declared != null ? Number(declared) : null;

    const rows = readGridRows(nodes, transform);
    const main = nodes.find((n) => rl(n) === "main");
    const listRows = nodes
      .filter((n) => rl(n) === "listitem" && (!main || hasAncestor(n, main.nodeId, parentOf)))
      .map((n) => subtreeText(n.nodeId, byId))
      .filter((t) => t && !CHROME_LINK.test(t));
    const items = listItems(nodes);

    const out = [header];
    if (rows.length) {
      out.push("", `Rows (${rows.length}):`);
      rows.forEach((r, i) => out.push(`${i + 1}. ${r}`));
    } else if (listRows.length) {
      out.push("", `Entries (${listRows.length}):`);
      listRows.forEach((r, i) => out.push(`${i + 1}. ${r}`));
    }
    if (items.length) {
      out.push(
        "",
        "Openable records (use sn_open_record with the LABEL, not the number, unless",
        "you mean that exact position — most of these are reference fields pointing at",
        "other records, not this panel's own rows):",
        ...items.map((it, i) => `${i + 1}. ${it.label}${it.column ? `   [column: ${it.column}]` : ""}`),
      );
    }
    if (!rows.length && !listRows.length) {
      if (declaredCount && declaredCount > 0) {
        out.push(
          "",
          `[!! The panel tab says it holds ${declaredCount} row(s), but NONE rendered. ` +
            `This is NOT an empty panel — the rows had not loaded. Read it again. ` +
            `Do not record this as "no records".]`,
        );
      } else {
        out.push(
          "",
          `This panel is EMPTY — it has no rows. (Its tab carries no row count, which ` +
            `is how ServiceNow shows an empty related list.) For QA purposes that is a ` +
            `real answer: e.g. an empty "Dispatch Orders" means no part was dispatched.`,
        );
      }
    } else if (declaredCount != null && rows.length && declaredCount !== rows.length) {
      out.push(
        "",
        `[note: the tab claims ${declaredCount} row(s) but ${rows.length} rendered — ` +
          `the rest are unread, not absent.]`,
      );
    }
    return out.join("\n");
  } finally {
    await client.detach().catch(() => {});
  }
}

/** Open a record listed in the current panel, by 1-based index or link label. */
export async function openRecord(page: Page, target: number | string): Promise<string> {
  const client = await openSession(page);
  try {
    const nodes = await fullTree(client);
    const items = listItems(nodes);
    let hit: PanelItem | undefined;
    if (typeof target === "number") {
      hit = items[target - 1];
    } else {
      const t = target.toLowerCase();
      hit =
        items.find((l) => l.label.toLowerCase() === t) ??
        items.find((l) => l.label.toLowerCase().includes(t));
    }
    if (!hit) {
      return (
        `No listed record matched "${target}". Items: ` +
        (items.map((l, i) => `${i + 1}. ${l.label}`).join(" | ") || "(none)")
      );
    }
    if (hit.node.backendDOMNodeId == null) return `Matched "${hit.label}" but it is not clickable.`;

    /*
     * DRAFT GUARD. Reading an already-SENT email is sanctioned; opening a draft
     * is not — a draft row opens the email COMPOSER, and the composer is out of
     * bounds for this tool (one careless keystroke there is a real write, and the
     * user may have half-written customer mail in it). The Emails panel exposes a
     * "Type" column whose value is `sent` for sent mail, so refuse anything whose
     * own row is not sent.
     */
    const { byId, parentOf } = buildMaps(nodes);
    const row = nodes.find(
      (n) => rl(n) === "row" && hasAncestor(hit!.node, n.nodeId, parentOf),
    );
    const rowText = row ? subtreeText(row.nodeId, byId) : "";
    const typeMatch = /\btype:\s*([a-z-]+)/i.exec(rowText);
    if (typeMatch && !/^sent$/i.test(typeMatch[1])) {
      return (
        `REFUSED: "${hit.label}" is on a row whose Type is "${typeMatch[1]}", not "sent". ` +
        `Opening a non-sent email would open the email COMPOSER, which this tool must ` +
        `never touch. Only already-sent emails can be opened. Nothing was clicked.`
      );
    }

    await clickBackend(client, hit.node.backendDOMNodeId);
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }).catch(() => {});
    await sleep(600);
    return (
      `Opened record "${hit.label}"` +
      (hit.column ? ` (from the "${hit.column}" column)` : "") +
      `. Use sn_read_case (fields) or sn_read_panel to read it.` +
      (hit.column && /account|contact|assigned|group|company|user/i.test(hit.column)
        ? `\n[note: that column is a REFERENCE field, so this is a ${hit.column} record, ` +
          `not one of the panel's own rows. It opened in a new workspace tab — close ` +
          `that tab in the browser when done. Re-open the case with sn_open_case.]`
        : "")
    );
  } finally {
    await client.detach().catch(() => {});
  }
}

/**
 * Fixed, server-authored check that the element genuinely holding focus is the
 * ServiceNow global search input. Asserted BEFORE any keystroke is sent.
 *
 * Why this exists: `typeInSearch` clears the box with keyboard Ctrl+A + Delete,
 * which acts on whatever is focused, not on a node we hold a handle to. If
 * `focus()` ever silently failed, those keystrokes would land on some other
 * field. The post-type value check below catches a wrong query before it RUNS,
 * but only after the keystrokes were already delivered. So we gate on focus
 * first and refuse to type at all unless the search input owns it.
 *
 * Identity is confirmed live: the a11y "Search" combobox resolves straight to
 * `<input id="sncwsgs-typeahead-input" class="sn-global-typeahead-input">`.
 * Any of id/name, class, or aria-label="Search" is accepted, and the element
 * must also be a real text input — so a record field can never satisfy it.
 */
export const ACTIVE_SEARCH_INPUT = `
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if(!el) return { ok: false, what: "(nothing focused)" };
  const at = (n) => (el.getAttribute ? (el.getAttribute(n) || "") : "");
  const tag = (el.tagName || "").toLowerCase();
  const id = el.id || "", name = at("name"), cls = at("class"), aria = at("aria-label");
  const isTextInput = /^(input|textarea)$/.test(tag);
  const isSearch =
    /sncwsgs-typeahead-input|sn-aa-search-box/.test(id + " " + name) ||
    /sn-global-typeahead-input/.test(cls) ||
    aria.trim().toLowerCase() === "search";
  return {
    ok: isTextInput && isSearch,
    what: tag + (id ? "#" + id : "") + (name ? "[name=" + name + "]" : "") +
          (aria ? ' aria-label="' + aria + '"' : ""),
  };
`;

/**
 * ServiceNow renders the search RESULTS page only while its tab is VISIBLE.
 *
 * Proven live (2026-07-29): the identical query returns "no case rows found"
 * with `document.visibilityState === "hidden"` and 3 cases immediately after
 * `bringToFront()`. Record reads are unaffected — a already-loaded case form
 * reads fine while hidden (58 fields) — this hits only freshly rendered search
 * results. Left unhandled it is the project's worst failure mode: a silent
 * "no results" that reads like "no such cases exist".
 *
 * `bringToFront()` activates the tab the user already has open. It is view state
 * only: no resize, no reload, no navigation, no record data touched.
 */
async function isVisible(page: Page): Promise<boolean> {
  return (await evalRead<string>(page, `return document.visibilityState;`)) === "visible";
}

/**
 * Run a search operation with the tab guaranteed to count as visible.
 *
 * Two escalating steps, both view state only:
 *   1. `bringToFront()` — activates the tab inside its window. Enough when the
 *      window is merely inactive.
 *   2. `Emulation.setFocusEmulationEnabled` — needed when the window is
 *      MINIMISED or fully COVERED by another app, which Chrome's native
 *      occlusion detection reports as `visibilityState: "hidden"`. No CDP call
 *      can raise a window above another application, but focus emulation makes
 *      the renderer treat the page as focused/visible, which is what ServiceNow
 *      actually gates rendering on. Verified: flips "hidden" -> "visible" and
 *      turns an empty result into the full 23-match set for the same query.
 *
 * The emulation is held only for this operation and always turned back off —
 * a LEFTOVER Emulation override is exactly what once collapsed the Details form
 * to a handful of fields, so it is never left enabled.
 */
async function withVisibleTab<T>(page: Page, fn: () => Promise<T>): Promise<T> {
  await page.bringToFront().catch(() => {});
  await sleep(300);
  let client: CDPSession | null = null;
  let emulating = false;
  try {
    if (!(await isVisible(page))) {
      client = await page.createCDPSession().catch(() => null);
      if (client) {
        try {
          await client.send("Emulation.setFocusEmulationEnabled", { enabled: true });
          emulating = true;
          await sleep(600);
        } catch {
          /* older Chrome without the domain — fall through to the honest note */
        }
      }
    }
    return await fn();
  } finally {
    if (client) {
      if (emulating) {
        await client
          .send("Emulation.setFocusEmulationEnabled", { enabled: false })
          .catch(() => {});
      }
      await client.detach().catch(() => {});
    }
  }
}

/** True when the tab is still hidden — used to explain empty search results. */
async function isHidden(page: Page): Promise<boolean> {
  return !(await isVisible(page));
}

/** Appended to any empty search result while the tab is hidden. */
const HIDDEN_TAB_NOTE =
  "[!! The ServiceNow tab is HIDDEN (window minimised or fully covered), and " +
  "ServiceNow does not render its search results page while hidden. This empty " +
  "result therefore means NOTHING about whether matching cases exist — do not " +
  "read it as 'no such cases'. Restore/raise the Chrome window and search again.]";

/**
 * Type text into the global search box — THE ONLY WRITE in this server.
 * Presses Enter to run the search. Returns nothing itself; callers read after.
 */
export async function typeInSearch(page: Page, text: string): Promise<void> {
  const client = await openSession(page);
  try {
    // The global search box reports as combobox, searchbox or textbox depending
    // on how far the workspace shell has booted — accept any of them.
    const SEARCH_ROLES = new Set(["combobox", "searchbox", "textbox"]);
    const isSearch = (n: AXNode) =>
      SEARCH_ROLES.has(rl(n)) && cleanLabel(nm(n)).toLowerCase() === "search";

    // POLL, don't snapshot once. Navigating to a non-case record (e.g. following
    // a reference link out of a related list) re-mounts the workspace shell, and
    // for a few seconds there is no search box at all. Failing immediately made
    // sn_open_case a dead end from there — the user could not get back to a case.
    let nodes: AXNode[] = [];
    let box: AXNode | undefined;
    for (let attempt = 0; attempt < 10; attempt++) {
      nodes = await fullTree(client);
      box = nodes.find((n) => rl(n) === "combobox" && isSearch(n)) ?? nodes.find(isSearch);
      if (box && box.backendDOMNodeId != null) break;
      box = undefined;
      await sleep(1200);
    }
    if (!box || box.backendDOMNodeId == null) {
      // Before blaming the workspace, rule out the two causes that need a
      // completely different action. Reporting "reload the workspace tab" when
      // the user is actually signed out (or the browser is gone) sends them
      // hunting for a problem that doesn't exist — observed 2026-07-30.
      if (page.isClosed()) {
        throw new Error(
          `The ServiceNow tab has been closed. Reopen it in the debug Chrome window ` +
            `and retry. ${SIGN_IN_HINT}`,
        );
      }
      const urlAuth = authPageReason(page.url());
      if (urlAuth) throw new Error(`Not signed in — ${urlAuth}. ${SIGN_IN_HINT}`);
      // A soft-expired session can keep the ServiceNow URL while rendering a
      // login form. A password/username field is the unambiguous tell, and the
      // a11y tree is already in hand so this costs nothing.
      const looksLikeLogin = nodes.some((n) => {
        const label = cleanLabel(nm(n)).toLowerCase();
        return (
          SEARCH_ROLES.has(rl(n)) &&
          /\b(password|user\s?name|username|sign in|email address)\b/.test(label)
        );
      });
      if (looksLikeLogin) {
        throw new Error(
          `Not signed in — the ServiceNow tab is showing a sign-in form. ${SIGN_IN_HINT}`,
        );
      }
      const cands = nodes
        .filter((n) => SEARCH_ROLES.has(rl(n)) && nm(n))
        .map((n) => `${rl(n)}:"${cleanLabel(nm(n))}"`)
        .slice(0, 10);
      // Zero inputs of any kind means nothing is rendering at all — far more
      // likely a lapsed session or a still-loading shell than a record page
      // that merely hides the search box.
      const nothingRendered = cands.length === 0;
      throw new Error(
        "Could not find the ServiceNow search box after ~12s. " +
          (nothingRendered
            ? `NOTHING rendered on the page (no text inputs at all), which usually means ` +
              `the session has lapsed or the workspace never loaded. Check you are still ` +
              `signed in first. ${SIGN_IN_HINT}`
            : `The workspace may still be loading, or the tab is on a record that does ` +
              `not show it — reload the workspace tab. Text inputs seen: ${cands.join(", ")}`),
      );
    }
    const { object } = (await client.send("DOM.resolveNode", {
      backendNodeId: box.backendDOMNodeId,
    })) as unknown as { object: { objectId?: string } };
    if (!object.objectId) throw new Error("Could not focus the search box.");
    // Focus the box. Note we do NOT clear by assigning `.value` here: the node
    // the a11y tree points at is the web-component host, so setting its `value`
    // leaves the real <input> untouched and the new query gets APPENDED to the
    // previous one (observed: "drive failure" + a case number searched as
    // one concatenated string). Clearing is done via the keyboard below, which
    // acts on whatever is genuinely focused.
    await client.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: "function(){ this.focus(); }",
      awaitPromise: false,
    });
    await client.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
  } finally {
    await client.detach().catch(() => {});
  }
  // GATE: send nothing until the search input provably owns focus. Fails closed
  // — if the check itself cannot run (null), we refuse rather than assume.
  const focused = await evalRead<{ ok: boolean; what: string }>(page, ACTIVE_SEARCH_INPUT);
  if (!focused?.ok) {
    throw new Error(
      "Refusing to type: focus is not in the ServiceNow search box (focused element: " +
        `${focused?.what ?? "could not be determined"}). NO keystrokes were sent. ` +
        "Click the search box in the browser, then retry.",
    );
  }

  // Select-all + delete, then type. Keyboard-only, so it works through the
  // shadow DOM and stays within "typing into the search box".
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Delete");
  await page.keyboard.type(text, { delay: 20 });

  // Verify the box holds exactly what we asked for before committing the search.
  const actual = await readSearchBoxValue(page);
  if (actual != null && actual.trim() !== text.trim()) {
    throw new Error(
      `Refusing to search: the search box holds ${JSON.stringify(actual)} but the ` +
        `query is ${JSON.stringify(text)}. The box did not clear — retry.`,
    );
  }

  await page.keyboard.press("Enter");
  await page.waitForNetworkIdle({ idleTime: 600, timeout: 8000 }).catch(() => {});
  await sleep(700);
}

/** Current text in the global search box, or null if it can't be determined. */
async function readSearchBoxValue(page: Page): Promise<string | null> {
  const client = await openSession(page);
  try {
    const nodes = await fullTree(client);
    const box = nodes.find(
      (n) =>
        ["combobox", "searchbox", "textbox"].includes(rl(n)) &&
        cleanLabel(nm(n)).toLowerCase() === "search",
    );
    return box ? vl(box) : null;
  } catch {
    return null;
  } finally {
    await client.detach().catch(() => {});
  }
}
