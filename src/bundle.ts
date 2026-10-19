/**
 * sn_case_bundle — everything about one case in ONE tool call.
 *
 * It composes the read-only functions in a fixed, server-authored order (case →
 * SLAs → Dispatch Orders → Emails → Special handling notes, then back to the
 * case) and adds the retry discipline a model otherwise has to be taught:
 * wait until the case has actually rendered, re-read a stale or unrendered
 * case, re-read a panel whose rows hadn't loaded, and re-read an SHI note body
 * that came back unread (~1 read in 4).
 *
 * It reads MORE than the single-step tools, never anything they could not
 * reach: every activity post (the stream renders only ~20 until scrolled),
 * every row of a paged related list ("Next page", then "First page"), and it
 * steps back through the tab's history from an SHI note to its case. Those are
 * view-state actions only — scrolling, paging and Back — and they are not
 * exposed as tools. Nothing is written; the only thing typed is the case
 * number, into the search box.
 *
 * Why it exists: gathering a case step by step took ~13 round-trips, and each
 * one re-sent the whole conversation to the model. One call is far cheaper.
 *
 * Token trims happen ONLY here, never in the single-step tools:
 *   - email Body cells are converted from raw HTML to plain text (in Node);
 *   - automated lifecycle mail ("has been created/resolved/closed") drops its
 *     body — the subject, recipients and type stay;
 *   - the assembled text is compacted (compact.ts): repeated text is shown
 *     once with a pointer to where it is, boilerplate is removed;
 *   - a bundle still over PART_LIMIT chars is returned in parts (part 2, ... are
 *     served from an in-memory copy), so a host never spills it to a file.
 *
 * Every section header carries an explicit STATUS so a reader never has to
 * guess whether "nothing" means empty or unread.
 */
import type { Page } from "puppeteer-core";
import { getServiceNowPage } from "./browser.js";
import { compactBundleText } from "./compact.js";
import {
  openCaseByNumber,
  readCase,
  openPanel,
  readPanel,
  openRecord,
  handleShiPopup,
  waitCaseReady,
  caseSeenInPage,
  backToCase,
  type CaseReady,
  type RowTransform,
} from "./read.js";

export type Progress = (step: number, total: number, message: string) => Promise<void>;

/** A sign-in / no-browser failure: stop the whole bundle, report verbatim. */
class AuthStop extends Error {}
const AUTH_RE = /ACTION NEEDED|Not signed in/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Get the ServiceNow page, turning an auth failure into AuthStop. */
async function page(): Promise<Page> {
  try {
    return await getServiceNowPage();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (AUTH_RE.test(msg)) throw new AuthStop(msg);
    throw e;
  }
}

/**
 * Run one page action. A thrown sign-in error stops the bundle. So does a
 * sign-in message in the search step's own status text (scanText) — but never
 * in what was READ, or in labels taken from the page: a customer email or an
 * SHI note titled "ACTION NEEDED" is evidence, not a lapsed session.
 * getServiceNowPage() still catches a lapsed session on every step.
 */
async function run<T>(fn: (p: Page) => Promise<T>, scanText = false): Promise<T> {
  let out: T;
  try {
    out = await fn(await page());
  } catch (e) {
    if (e instanceof AuthStop) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (AUTH_RE.test(msg)) throw new AuthStop(msg);
    throw e;
  }
  if (scanText && typeof out === "string" && AUTH_RE.test(out)) throw new AuthStop(out);
  return out;
}

/** A step whose result is text; any non-auth error becomes "Error: ..." text. */
async function step(fn: (p: Page) => Promise<string>, scanText = false): Promise<string> {
  try {
    return await run(fn, scanText);
  } catch (e) {
    if (e instanceof AuthStop) throw e;
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------------------------------------------------------------- text ---

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", hellip: "...",
};

/**
 * Raw email HTML -> readable plain text. Pure string work, no page access.
 *
 * The Emails list holds a PREVIEW: the raw HTML cut at a fixed length with
 * "..." appended. So a <style> block or an HTML comment (Outlook puts its CSS
 * in one) can be cut before its end, and the last tag or entity can be cut
 * mid-way; left alone they leak CSS rules and "<span style=..." into the
 * text. They are dropped, and the "..." is kept so a reader still sees that
 * the preview was cut.
 */
export function htmlToText(html: string): string {
  const cut = /(?:\.\.\.|…)\s*$/.test(html);
  let s = html;
  if (cut) {
    s = s
      .replace(/(?:\.\.\.|…)\s*$/, "")
      .replace(/&[#\w]{0,10}$/, "") // an entity cut off at the end ("&nbs")
      .replace(/<[^<>]*$/, ""); // a tag cut off at the end ("<span style=...")
  }
  const text = s
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(style|script|head)\b[\s\S]*$/i, " ") // a block cut off before its end tag
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<!--[\s\S]*$/, " ") // a comment cut off before "-->"
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
      const hex = e[1].toLowerCase() === "x";
      const cp = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    })
    .replace(/[​⁠﻿]/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (!cut) return text;
  return text ? `${text} ...` : "...";
}

const LIFECYCLE_SUBJECT = /has been (created|resolved|closed)\s*\.?\s*$/i;

/** Emails panel rows: HTML body -> text; lifecycle mail -> body omitted. */
const emailRows: RowTransform = (cells) => {
  const subject = cells.find(([l]) => /^subject$/i.test(l))?.[1] ?? "";
  const lifecycle = LIFECYCLE_SUBJECT.test(subject.trim());
  return cells.map(([l, v]): [string, string] => {
    if (!/^body$/i.test(l)) return [l, v];
    if (lifecycle) return [l, "[automated lifecycle email — body omitted; subject/recipients above]"];
    return [l, /<[a-z!/]/i.test(v) ? htmlToText(v).replace(/\n/g, " / ") : v];
  });
};

// ------------------------------------------------------------- statuses ---

export function panelStatus(out: string): string {
  if (/^Error:/.test(out)) return "ERROR";
  const notRead = /\[!! PANEL NOT READ: (.*?), not "/.exec(out);
  if (notRead) return `UNREAD (${notRead[1]})`;
  if (/This panel is EMPTY/.test(out)) return "EMPTY";
  if (/This is NOT an empty panel/.test(out)) return "UNREAD (rows never rendered)";
  const partial = /tab claims (\d+) row\(s\) but (\d+) rendered/.exec(out);
  if (partial) return `OK (partial: ${partial[2]} of ${partial[1]} rows read — the rest are unread, not absent)`;
  return "OK";
}

/** What readCase(allActivity) said about the activity stream. */
function activityOf(out: string): { kind: "complete" | "partial" | "unknown" | "none"; read: number; total: number | null } {
  if (/\[activity stream: (?:all \d+ posts read|the case has 0 activities)\]/.test(out)) {
    return { kind: "complete", read: 0, total: null };
  }
  const p = /\[warning: activity stream: (\d+) of (\d+) posts rendered/.exec(out);
  if (p) return { kind: Number(p[1]) ? "partial" : "none", read: Number(p[1]), total: Number(p[2]) };
  const u = /\[warning: activity stream: (\d+) posts read, but the stream's total count/.exec(out);
  if (u) return { kind: Number(u[1]) ? "unknown" : "none", read: Number(u[1]), total: null };
  return { kind: "none", read: 0, total: null }; // "could not be read", or no stream at all
}

export function caseStatus(out: string, ready?: CaseReady): string {
  if (/^Error:/.test(out)) return "ERROR";
  if (/!! STALE READ ABORTED !!/.test(out)) return "UNREAD (stale read of another case, after retries)";
  if (!/\[read: [1-9]\d* form fields/.test(out)) return "UNREAD (no form fields rendered, after retries)";
  const a = activityOf(out);
  if (a.kind === "none") {
    return `UNREAD (activity stream not rendered: 0${a.total != null ? ` of ${a.total}` : ""} posts read, after retries)`;
  }
  // Never OK for a page that did not settle, unless the read proves itself complete.
  if (ready && !ready.ok && a.kind !== "complete") {
    return `UNREAD (the case page never finished rendering: ${ready.why})`;
  }
  const act =
    a.kind === "partial"
      ? `${a.read} of ${a.total} activity posts read — older posts not loaded; unread, not absent`
      : a.kind === "unknown"
        ? `${a.read} activity posts read — the stream's total is unknown; anything missing is unread, not absent`
        : "";
  if (/Details form did not fully render/.test(out)) {
    return act ? `PARTIAL (form did not fully render; ${act})` : "PARTIAL (form did not fully render)";
  }
  return act ? `OK (partial: ${act})` : "OK";
}

function section(name: string, status: string, body: string): string {
  return `\n=== ${name} — STATUS: ${status} ===\n${body.trim()}\n`;
}

// ----------------------------------------------------------- the steps ---

/**
 * Open the case by search, then wait until it has really rendered (and its
 * SHI popup, if any, is closed). One re-open if it never settles.
 */
async function openCase(number: string): Promise<CaseReady> {
  let ready: CaseReady | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Checked BEFORE the open: a case not yet rendered in this page will pop its SHI note.
    const firstRender = !(await run((p) => caseSeenInPage(p, number)));
    const out = await step((p) => openCaseByNumber(p, number), true);
    if (!/is open|^Opened /m.test(out)) throw new Error(`Could not open ${number}: ${out}`);
    ready = await run((p) => waitCaseReady(p, number, { firstRender }));
    if (ready.ok) break;
  }
  return ready!;
}

/** Read the case (every activity post), retrying a stale / empty read by re-opening it (max 3 reads). */
async function readTheCase(number: string, first: CaseReady): Promise<{ out: string; status: string }> {
  let ready = first;
  let popup = first.popup;
  let out = "";
  let status = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      ready = await openCase(number);
      popup = ready.popup || popup;
      await sleep(500);
    }
    out = await step((p) => readCase(p, { allActivity: true, popup }));
    status = caseStatus(out, ready);
    if (/^(OK|PARTIAL)\b/.test(status)) break;
  }
  return { out, status };
}

/** openPanel's "not found" lists the tabs it saw; a rendered record strip always has "Details". */
function stripWasRendered(notFound: string): boolean {
  const list = /Available tabs[^:]*: (.*)$/s.exec(notFound)?.[1] ?? "";
  return list.split(" | ").some((t) => t.trim().toLowerCase() === "details");
}

/**
 * Open a panel and read it (every page with allPages), re-reading rows that
 * hadn't loaded. A "not found" from a strip that had not rendered (empty tab
 * list, or a popup covering it) is retried, and never reported as NOT FOUND.
 */
async function readThePanel(
  number: string,
  label: string,
  transform?: RowTransform,
  allPages = false,
): Promise<{ status: string; body: string }> {
  let opened = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await run((p) => waitCaseReady(p, number, { requireActivity: false, timeoutMs: 10000 }));
    }
    opened = await step((p) => openPanel(p, label));
    if (!/not found/i.test(opened) || stripWasRendered(opened)) break;
  }
  if (/not found/i.test(opened)) {
    return stripWasRendered(opened)
      ? { status: "NOT FOUND", body: opened }
      : {
          status: "UNREAD (the record's panel strip never rendered — NOT the same as no such panel)",
          body: opened,
        };
  }
  if (!/^Opened panel/.test(opened)) return { status: "ERROR", body: opened };
  const tab = /^Opened panel "(.+)"\./.exec(opened)?.[1] ?? label;
  let out = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1500);
    out = await step((p) => readPanel(p, transform, { allPages, expect: tab }));
    if (/\[!! PANEL NOT READ:/.test(out)) {
      // The tab click may have landed while the page was busy: click it again.
      if (!/^Opened panel/.test(await step((p) => openPanel(p, label)))) break;
      continue;
    }
    if (!/This is NOT an empty panel/.test(out)) break;
  }
  return { status: panelStatus(out), body: out };
}

/** "Openable records" links of a panel read, with their column. */
function panelLinks(panelOut: string): { label: string; column: string }[] {
  const block = panelOut.split(/^Openable records.*$/m)[1] ?? "";
  return [...block.matchAll(/^\d+\. (.+?)(?:   \[column: (.+?)\])?$/gm)].map((m) => ({
    label: m[1].trim(),
    column: (m[2] ?? "").trim(),
  }));
}

const SHI_PANEL = "Special handling notes";

/** Make sure the SHI panel is the open one (it is, after a history step back). */
async function ensureShiPanel(): Promise<void> {
  const cur = await step((p) => readPanel(p));
  if (!/^Open panel: Special Handling/i.test(cur)) await step((p) => openPanel(p, SHI_PANEL));
}

/**
 * From an SHI note back to its case: one step back in the tab's history
 * (~1-2 s). Falls back to re-opening the case by search (~11 s) whenever that
 * is not provably the way back to this case.
 */
async function backFromNote(number: string): Promise<string> {
  const back = await run((p) => backToCase(p, number));
  if (back.ok) return back.how;
  await openCase(number);
  return `search (${back.how})`;
}

/** Open one note from the SHI panel, waiting briefly for the list to render. */
async function openShiNote(label: string): Promise<string> {
  let out = "";
  for (let k = 0; k < 4; k++) {
    if (k > 0) {
      await run(async (p) => (await handleShiPopup(p), "")); // a popup may hide the list
      await sleep(800);
      if (k >= 2) await ensureShiPanel();
    }
    out = await step((p) => openRecord(p, label));
    if (!/^No listed record matched/.test(out)) return out;
  }
  return out;
}

/** Read every SHI note's body, re-reading an unread body (max 3 reads per note). */
async function readShiNotes(number: string, panelOut: string): Promise<{ text: string; count: number }> {
  const notes = panelLinks(panelOut).filter((l) => /short description/i.test(l.column));
  if (!notes.length) return { text: "", count: 0 };
  const parts: string[] = [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (i > 0) {
      // Back to the case and its SHI panel before opening the next note.
      await backFromNote(number);
      await ensureShiPanel();
    }
    const opened = await openShiNote(note.label);
    if (!/^Opened record/.test(opened)) {
      parts.push(section(`SHI note "${note.label}"`, "UNREAD (could not open)", opened));
      continue;
    }
    let body = "";
    let tries = 0;
    let blocks = 0;
    for (; tries < 3; tries++) {
      if (tries > 0) await sleep(1200);
      body = await step((p) => readCase(p));
      blocks = Number(/(\d+) rich-text block/.exec(body)?.[1] ?? "0");
      if (blocks > 0) break;
    }
    const table = /^Sub-record: (\S+)/m.exec(body)?.[1] ?? "";
    let status = blocks > 0 ? "OK" : `UNREAD after ${tries} tries (body not captured — NOT confirmed empty)`;
    if (table && table !== "sn_shn_notes") status = `UNREAD (opened ${table}, not an SHI note)`;
    if (blocks > 1) status += " — WARNING: more than one rich-text block; one may belong to another record";
    parts.push(section(`SHI note "${note.label}"`, status, body));
  }
  return { text: parts.join(""), count: notes.length };
}

/** Leave the user on the case, not on a sub-record (and never behind an open popup). */
async function returnToCase(number: string): Promise<void> {
  const p = await page();
  if (!/\/sub\/record\//.test(p.url())) return;
  const back = await run((pg) => backToCase(pg, number));
  if (back.ok) return;
  await run((pg) => openCaseByNumber(pg, number));
  // Wait for the popup: it mounts late, and left open it blocks the next search.
  await run((pg) => handleShiPopup(pg, 5000));
}

// ---------------------------------------------------------------- parts ---

/** Above this many characters a bundle is returned in parts (hosts spill ~50k+ to a file). */
export const PART_LIMIT = 42_000;
/** How long the parts of the last read of a case are kept for part=2, ... */
const CACHE_MS = 15 * 60 * 1000;
const CACHE_MAX = 12;

const HEADER_RE = /^=== (.+) — STATUS: (.*) ===$/;
const POST_RE = /^--- post (\d+) ---$/;
const ROW_RE = /^(\d+)\. /;

type Unit = { kind: "ehead" | "erow" | "etail" | "post"; text: string; n: number };

function joinRange(ns: number[]): string {
  return ns.length ? (ns[0] === ns[ns.length - 1] ? `${ns[0]}` : `${ns[0]}–${ns[ns.length - 1]}`) : "";
}

/** What a continuation part holds, for the PART lines. `lastEmail` = the Emails section's last unit. */
function describePart(units: Unit[], lastEmail: Unit | undefined): string {
  const out: string[] = [];
  const rows = units.filter((u) => u.kind === "erow").map((u) => u.n);
  const head = units.some((u) => u.kind === "ehead");
  const end = !!lastEmail && units.includes(lastEmail);
  if (head && end) out.push("the Emails section");
  else if (head) out.push(`the Emails section (rows ${joinRange(rows)})`);
  else if (rows.length) out.push(`Emails rows ${joinRange(rows)}${end ? " (the end of the Emails section)" : ""}`);
  else if (end) out.push("the end of the Emails section");
  const posts = units.filter((u) => u.kind === "post").map((u) => u.n);
  if (posts.length) out.push(`activity posts ${joinRange(posts)}`);
  return out.join(" and ");
}

/**
 * Split a bundle over `limit` chars into parts that each fit.
 *
 * Part 1 holds the Case section (header, Details form, the newest activity
 * posts that fit), SLAs, Dispatch Orders, Special handling notes and every
 * SHI note body, plus the timing footer. Part 2 holds the Emails section.
 * Only when part 1 would still be too long do the oldest activity posts move
 * on, after the Emails (filling part 2, then part 3, ...). Every part but the
 * last ends with a "[PART k of n — call sn_case_bundle again ... part=k+1 ...]"
 * line; post and row numbers are never changed, so pointers such as
 * "[body: see Emails row 3]" stay valid across parts. Pure string work.
 */
export function splitBundle(body: string, footer: string, number: string, limit = PART_LIMIT): string[] {
  const whole = `${body}\n${footer}`;
  if (whole.length <= limit) return [whole];

  const lines = body.split("\n");
  const heads = lines.flatMap((l, i) => {
    const m = HEADER_RE.exec(l);
    return m ? [{ name: m[1], at: i }] : [];
  });
  const e = heads.findIndex((h) => h.name === "Emails");
  const eStart = e >= 0 ? heads[e].at : lines.length;
  const eEnd = e >= 0 ? (heads[e + 1]?.at ?? lines.length) : lines.length;
  const main = [...lines.slice(0, eStart), ...lines.slice(eEnd)];
  const emails = lines.slice(eStart, eEnd);

  // ---- the Emails section as units: its head, each row, its tail
  const units: Unit[] = [];
  if (emails.length) {
    const rowsAt = emails.findIndex((l) => /^Rows \(\d+\):$/.test(l));
    let i = rowsAt >= 0 ? rowsAt + 1 : emails.length;
    if (rowsAt >= 0 && emails[i]?.startsWith("(same on every row")) i++;
    units.push({ kind: "ehead", text: emails.slice(0, i).join("\n"), n: 0 });
    let j = i;
    while (j < emails.length && ROW_RE.test(emails[j])) {
      units.push({ kind: "erow", text: emails[j], n: Number(ROW_RE.exec(emails[j])![1]) });
      j++;
    }
    if (j < emails.length) units.push({ kind: "etail", text: emails.slice(j).join("\n"), n: 0 });
  }

  const lastEmail = units[units.length - 1];

  // ---- activity posts in part 1: keep the newest that fit
  const posts = main.flatMap((l, i) => {
    const m = POST_RE.exec(l);
    return m && i + 1 < main.length ? [{ at: i, n: Number(m[1]), size: l.length + main[i + 1].length + 2 }] : [];
  });
  const RESERVE_1 = 450; // part 1: its PART line and the "posts are in part k" marker
  const RESERVE_N = 600; // parts 2..n: header line, continuation markers, PART line
  const mainLen = main.join("\n").length + footer.length + 1;
  let keep = posts.length;
  let moved = 0;
  while (keep > 0 && mainLen - moved + RESERVE_1 > limit) {
    keep--;
    moved += posts[keep].size;
  }
  const overflow = posts.slice(keep);
  for (const p of overflow) units.push({ kind: "post", text: `${main[p.at]}\n${main[p.at + 1]}`, n: p.n });

  // ---- pack the continuation units into parts 2..n
  const packs: Unit[][] = [];
  let cur: Unit[] = [];
  let len = 0;
  for (const u of units) {
    if (cur.length && len + u.text.length + 1 > limit - RESERVE_N) {
      packs.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(u);
    len += u.text.length + 1;
  }
  if (cur.length) packs.push(cur);
  const n = 1 + packs.length;
  const partLine = (k: number) =>
    k < n
      ? `[PART ${k} of ${n} — call sn_case_bundle again with the same number and part=${k + 1} for ` +
        `${describePart(packs[k - 1], lastEmail)}]`
      : `[PART ${k} of ${n} — the last part: this bundle is complete]`;

  // ---- part 1
  const p1 = [...main];
  if (overflow.length) {
    const first = overflow[0];
    const last = posts[posts.length - 1];
    const where = packs.map((pk, i) => (pk.some((u) => u.kind === "post") ? i + 2 : 0)).filter(Boolean);
    const list = where.length > 1 ? `parts ${where.slice(0, -1).join(", ")} and ${where[where.length - 1]}` : `part ${where[0]}`;
    const marker =
      `[activity posts ${first.n}–${last.n} of this stream are in ${list} of this bundle — ` +
      `see the PART line at the end]`;
    p1.splice(first.at, last.at + 2 - first.at, marker);
  }
  const parts = [`${p1.join("\n")}\n${footer}\n${partLine(1)}`];

  // ---- parts 2..n
  packs.forEach((pk, i) => {
    const k = i + 2;
    const out: string[] = [`CASE BUNDLE — ${number} — PART ${k} of ${n} (${describePart(pk, lastEmail)})`];
    pk.forEach((u, j) => {
      const prev = pk[j - 1];
      if ((u.kind === "erow" || u.kind === "etail") && !prev) {
        const rows = pk.filter((x) => x.kind === "erow").map((x) => x.n);
        out.push("", `[Emails section, continued${rows.length ? `: rows ${joinRange(rows)}` : ""}]`);
      }
      if (u.kind === "post" && (!prev || prev.kind !== "post")) {
        const ps = pk.filter((x) => x.kind === "post").map((x) => x.n);
        out.push("", `[Case section — activity stream, continued: posts ${joinRange(ps)}]`);
      }
      out.push(u.text);
    });
    out.push("", partLine(k));
    parts.push(out.join("\n"));
  });
  return parts;
}

type Cached = { at: number; parts: string[] };
const cache = new Map<string, Cached>();

function remember(number: string, parts: string[]): Cached {
  const entry = { at: Date.now(), parts };
  cache.delete(number);
  cache.set(number, entry);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return entry;
}

function servePart(number: string, entry: Cached, part: number, fresh: boolean): string {
  const n = entry.parts.length;
  const note = fresh
    ? `[re-read: no copy of an earlier read of ${number} was kept (copies last 15 minutes, in ` +
      `this server process only), so this comes from a fresh read made just now]\n`
    : "";
  if (part <= n) return note + entry.parts[part - 1];
  if (fresh && n === 1) {
    return note + `[the fresh read fits in ONE part, so here is the whole bundle]\n` + entry.parts[0];
  }
  return n === 1
    ? `[sn_case_bundle ${number}: this bundle fits in ONE part — part 1 already holds every ` +
        `section, including Emails. There is no part ${part}.]`
    : `[sn_case_bundle ${number}: there is no part ${part} — this bundle has ${n} parts.]`;
}

// ------------------------------------------------------------ the tool ---

/**
 * The whole case. part=1 (default) always reads afresh and keeps the parts for
 * CACHE_MS; part=k>1 is served from that copy, or from a fresh read if none.
 */
export async function caseBundle(number: string, progress: Progress, part = 1): Promise<string> {
  const want = number.trim().toUpperCase();
  const k = Math.max(1, Math.floor(part));
  if (k > 1) {
    const hit = cache.get(want);
    if (hit && Date.now() - hit.at < CACHE_MS) return servePart(want, hit, k, false);
  }
  const res = await readBundle(want, progress);
  if (res.stopped) return res.stopped;
  const entry = remember(want, splitBundle(res.body, res.footer, want));
  return k > 1 ? servePart(want, entry, k, true) : entry.parts[0];
}

async function readBundle(
  want: string,
  progress: Progress,
): Promise<{ body: string; footer: string; stopped?: string }> {
  const TOTAL = 7;
  const started = Date.now();
  let last = started;
  const laps: Record<string, number> = {};
  const lap = (name: string) => {
    const now = Date.now();
    laps[name] = (laps[name] ?? 0) + (now - last);
    last = now;
  };
  let done = false;
  try {
    await progress(1, TOTAL, `Opening ${want}`);
    const ready = await openCase(want);
    lap("open");

    await progress(2, TOTAL, "Reading the case and its whole activity stream");
    const { out: caseOut, status: cStatus } = await readTheCase(want, ready);
    lap("case");

    await progress(3, TOTAL, "Reading SLAs");
    const slas = await readThePanel(want, "SLAs", undefined, true);
    lap("SLAs");

    await progress(4, TOTAL, "Reading Dispatch Orders");
    const dispatch = await readThePanel(want, "Dispatch Orders", undefined, true);
    lap("dispatch");

    await progress(5, TOTAL, "Reading Emails (every page)");
    const emails = await readThePanel(want, "Emails", emailRows, true);
    lap("emails");

    await progress(6, TOTAL, "Reading Special handling notes");
    const shi = await readThePanel(want, SHI_PANEL);
    const notes = shi.status.startsWith("OK") ? await readShiNotes(want, shi.body) : { text: "", count: 0 };
    lap("SHI");

    await progress(7, TOTAL, "Returning to the case");
    await returnToCase(want);
    done = true;
    lap("return");

    const raw = [
      `CASE BUNDLE — ${want}`,
      "Read-only. Sections: Case (fields + activity stream), SLAs, Dispatch Orders, Emails, " +
        "Special handling notes (+ each note's body). STATUS on every section: OK = read; " +
        "EMPTY = genuinely no rows; UNREAD = could not be read, which is NOT the same as empty; " +
        "NOT FOUND = the case has no such panel.",
      section("Case", cStatus, caseOut),
      section("SLAs", slas.status, slas.body),
      section("Dispatch Orders", dispatch.status, dispatch.body),
      section("Emails", emails.status, emails.body),
      section("Special handling notes", shi.status, shi.body),
      notes.text,
    ].join("\n");
    let body: string;
    try {
      body = compactBundleText(raw).text;
    } catch (e) {
      body = `${raw}\n[note: compaction failed (${e instanceof Error ? e.message : String(e)}); the bundle is shown uncompacted]`;
    }
    lap("compact");

    const s = (name: string) => `${Math.round((laps[name] ?? 0) / 1000)}s`;
    const footer =
      `\n[bundle finished in ${Math.round((Date.now() - started) / 1000)}s: open ${s("open")}, ` +
      `case ${s("case")}, SLAs ${s("SLAs")}, dispatch ${s("dispatch")}, emails ${s("emails")}, ` +
      `SHI ${s("SHI")} (${notes.count} note${notes.count === 1 ? "" : "s"}), return ${s("return")}, ` +
      `compact ${s("compact")}]`;
    return { body, footer };
  } catch (e) {
    if (e instanceof AuthStop) {
      return {
        body: "",
        footer: "",
        stopped:
          `${e.message}\n\n[sn_case_bundle stopped: NOTHING further was read. This is a ` +
          `sign-in / connection problem, not evidence about the case.]`,
      };
    }
    throw e;
  } finally {
    // After a failure part-way through: still leave the user on the case.
    if (!done) {
      try {
        const p = await getServiceNowPage();
        if (/\/sub\/record\//.test(p.url())) {
          const back = await backToCase(p, want);
          if (!back.ok) {
            await openCaseByNumber(p, want);
            await handleShiPopup(p, 5000);
          }
        }
      } catch {
        /* best effort — never mask the real result */
      }
    }
  }
}
