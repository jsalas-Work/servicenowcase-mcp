/**
 * sn_case_bundle — everything about one case in ONE tool call.
 *
 * It composes the existing read-only functions in a fixed, server-authored
 * order (case → SLAs → Dispatch Orders → Emails → Special handling notes, then
 * back to the case). It adds no new capability: no click, navigation or write
 * that the single-step tools can't already do. What it does add is the
 * retry discipline a model otherwise has to be taught: re-read a stale or
 * unrendered case, re-read a panel whose rows hadn't loaded, and re-read an SHI
 * note body that came back unread (~1 read in 4).
 *
 * Why it exists: gathering a case step by step took ~13 round-trips, and each
 * one re-sent the whole conversation to the model. One call is far cheaper.
 *
 * Token trims happen ONLY here, never in the single-step tools:
 *   - email Body cells are converted from raw HTML to plain text (in Node);
 *   - automated lifecycle mail ("has been created/resolved/closed") drops its
 *     body — the subject, recipients and type stay;
 *   - "Email sent" activity posts whose email was read in full in the Emails
 *     section are cut to their header, with a pointer to that row.
 *
 * Every section header carries an explicit STATUS so a reader never has to
 * guess whether "nothing" means empty or unread.
 */
import type { Page } from "puppeteer-core";
import { getServiceNowPage } from "./browser.js";
import {
  openCaseByNumber,
  readCase,
  openPanel,
  readPanel,
  openRecord,
  handleShiPopup,
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

/** Run one step; any output or error that says "sign in" stops the bundle. */
async function step(fn: (p: Page) => Promise<string>): Promise<string> {
  let out: string;
  try {
    out = await fn(await page());
  } catch (e) {
    if (e instanceof AuthStop) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (AUTH_RE.test(msg)) throw new AuthStop(msg);
    return `Error: ${msg}`;
  }
  if (AUTH_RE.test(out)) throw new AuthStop(out);
  return out;
}

// ---------------------------------------------------------------- text ---

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", hellip: "...",
};

/** Raw email HTML -> readable plain text. Pure string work, no page access. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
      const hex = e[1].toLowerCase() === "x";
      const cp = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    })
    .replace(/[\u200b\u2060\ufeff]/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
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

function panelStatus(out: string): string {
  if (/^Error:/.test(out)) return "ERROR";
  if (/This panel is EMPTY/.test(out)) return "EMPTY";
  if (/This is NOT an empty panel/.test(out)) return "UNREAD (rows never rendered)";
  const partial = /tab claims (\d+) row\(s\) but (\d+) rendered/.exec(out);
  if (partial) return `OK (partial: ${partial[2]} of ${partial[1]} rows read — the rest are unread, not absent)`;
  return "OK";
}

function caseStatus(out: string): string {
  if (/^Error:/.test(out)) return "ERROR";
  if (/!! STALE READ ABORTED !!/.test(out)) return "UNREAD (stale read of another case, after retries)";
  if (!/\[read: [1-9]\d* form fields/.test(out)) return "UNREAD (no form fields rendered, after retries)";
  if (/Details form did not fully render/.test(out)) return "PARTIAL (form did not fully render)";
  return "OK";
}

function section(name: string, status: string, body: string): string {
  return `\n=== ${name} — STATUS: ${status} ===\n${body.trim()}\n`;
}

// ----------------------------------------------------------- the steps ---

async function openCase(number: string): Promise<string> {
  const out = await step((p) => openCaseByNumber(p, number));
  if (!/is open|^Opened /m.test(out)) throw new Error(`Could not open ${number}: ${out}`);
  return out;
}

/** Read the case, retrying a stale / empty read by re-opening it (max 3 reads). */
async function readTheCase(number: string): Promise<string> {
  let out = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await openCase(number);
      await sleep(1500);
    }
    out = await step((p) => readCase(p));
    if (caseStatus(out) === "OK" || /^PARTIAL/.test(caseStatus(out))) break;
  }
  return out;
}

/** Open a panel and read it, re-reading rows that hadn't loaded (max 3 reads). */
async function readThePanel(
  label: string,
  transform?: RowTransform,
): Promise<{ status: string; body: string }> {
  const opened = await step((p) => openPanel(p, label));
  if (/not found/i.test(opened)) return { status: "NOT FOUND", body: opened };
  if (!/^Opened panel/.test(opened)) return { status: "ERROR", body: opened };
  let out = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1500);
    out = await step((p) => readPanel(p, transform));
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

/** Read every SHI note's body, re-reading an unread body (max 3 reads per note). */
async function readShiNotes(number: string, panelOut: string): Promise<string> {
  const notes = panelLinks(panelOut).filter((l) => /short description/i.test(l.column));
  if (!notes.length) return "";
  const parts: string[] = [];
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    if (i > 0) {
      // Back to the case and its SHI panel before opening the next note.
      await openCase(number);
      await step(async (p) => (await handleShiPopup(p), "ok"));
      await step((p) => openPanel(p, "Special handling notes"));
      await step((p) => readPanel(p));
    }
    const opened = await step((p) => openRecord(p, note.label));
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
  return parts.join("");
}

// ------------------------------------------------ activity-stream trim ---

/**
 * Cut "Email sent" activity posts to their header when that same email's full
 * text is in the Emails section. Matched by the exact send timestamp against
 * the row's Created value, so an unmatched post is always left whole.
 */
function trimEmailPosts(caseOut: string, emailsOut: string, emailsStatus: string): string {
  if (emailsStatus !== "OK") return caseOut;
  const created = new Map<string, number>();
  for (const m of emailsOut.matchAll(/^(\d+)\. .*?Created: (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/gm)) {
    created.set(m[2], Number(m[1]));
  }
  if (!created.size) return caseOut;
  return caseOut.replace(/(^--- post \d+ ---\n)(.*)$/gm, (whole, head: string, post: string) => {
    const hdr = post.slice(0, 160);
    if (!/\bEmail sent\b/.test(hdr)) return whole;
    const ts = /Email sent (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(hdr)?.[1];
    const row = ts ? created.get(ts) : undefined;
    if (row == null) return whole;
    const cut = post.indexOf(" Show less");
    const keep = cut > 0 && cut < 600 ? post.slice(0, cut) : post.slice(0, 300);
    return `${head}${keep} [… full text: Emails section, row ${row}]`;
  });
}

// ------------------------------------------------------------ the tool ---

export async function caseBundle(number: string, progress: Progress): Promise<string> {
  const want = number.trim().toUpperCase();
  const TOTAL = 6;
  const started = Date.now();
  try {
    await progress(1, TOTAL, `Opening ${want}`);
    await openCase(want);
    const caseOut = await readTheCase(want);
    const cStatus = caseStatus(caseOut);

    await progress(2, TOTAL, "Reading SLAs");
    const slas = await readThePanel("SLAs");

    await progress(3, TOTAL, "Reading Dispatch Orders");
    const dispatch = await readThePanel("Dispatch Orders");

    await progress(4, TOTAL, "Reading Emails");
    const emails = await readThePanel("Emails", emailRows);

    await progress(5, TOTAL, "Reading Special handling notes");
    const shi = await readThePanel("Special handling notes");
    const notes = shi.status.startsWith("OK") ? await readShiNotes(want, shi.body) : "";

    const out = [
      `CASE BUNDLE — ${want}`,
      "Read-only. Sections: Case (fields + activity stream), SLAs, Dispatch Orders, Emails, " +
        "Special handling notes (+ each note's body). STATUS on every section: OK = read; " +
        "EMPTY = genuinely no rows; UNREAD = could not be read, which is NOT the same as empty; " +
        "NOT FOUND = the case has no such panel.",
      section("Case", cStatus, trimEmailPosts(caseOut, emails.body, emails.status)),
      section("SLAs", slas.status, slas.body),
      section("Dispatch Orders", dispatch.status, dispatch.body),
      section("Emails", emails.status, emails.body),
      section("Special handling notes", shi.status, shi.body),
      notes,
    ];
    await progress(6, TOTAL, "Returning to the case");
    out.push(`\n[bundle finished in ${Math.round((Date.now() - started) / 1000)}s]`);
    return out.join("\n");
  } catch (e) {
    if (e instanceof AuthStop) {
      return (
        `${e.message}\n\n[sn_case_bundle stopped: NOTHING further was read. This is a ` +
        `sign-in / connection problem, not evidence about the case.]`
      );
    }
    throw e;
  } finally {
    // Always leave the user on the case, not on a sub-record or a panel.
    try {
      const p = await getServiceNowPage();
      if (/\/sub\/record\//.test(p.url())) {
        await openCaseByNumber(p, want);
        await handleShiPopup(p);
      }
    } catch {
      /* best effort — never mask the real result */
    }
  }
}
