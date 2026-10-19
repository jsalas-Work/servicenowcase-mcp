/**
 * Bundle compaction: pure string work on an assembled sn_case_bundle text.
 * No page access and no I/O, so it can be tested offline on saved bundles
 * (scripts/compact-check.mjs).
 *
 *   compactBundleText(bundle) -> { text, stats }
 *   compactBundle(bundle)     -> { text, stats, edits }   (edits: the audit log)
 *
 * Two kinds of edit, and the rule that makes each one safe:
 *
 *   PATTERN edits remove only text that matches an explicit pattern:
 *     T3  the "Engineer X is Currently Unavailable" auto-reply template (its
 *         "Next scheduled shift:" line is kept);
 *     T5  exact boilerplate from BOILERPLATE (support footers, external-mail
 *         banners, legal disclaimers, signature lines, RMA template lines), and
 *         a notification's first line / a resolved mail's greeting when every
 *         value in them is the email's own (case number, subject, contact);
 *     T6  Emails columns identical on every row, stated once above the rows;
 *     T7  the same for SLA columns that are neither rubric nor time/stage;
 *     T8  "Openable records" navigation lists in panel sections;
 *     T10 residual HTML/CSS in email text (a <style>/<!-- block or a tag cut
 *         off by the preview), [cid:] image references, UI labels;
 *     T1  (pattern part) re-pointing an email post that the old activity
 *         trim already cut, or that never loaded ("Loading last reply").
 *
 *   DEDUPE edits remove a span only when every word of it is still in the
 *   OUTPUT, and leave a pointer to where it is:
 *     T1  the same email as an activity post and an Emails row (matched on send
 *         time + subject, recipients as tie-break); any email body shown
 *         elsewhere (e.g. a received email that is also its comment);
 *     T2  comments replayed inside notification emails (new comment, history,
 *         resolution summary);
 *     T4  quoted reply text that another email in the bundle holds;
 *     T9  Field changes text (the cumulative Plan of action) shown earlier.
 *   Each span is checked when it is removed (most of its distinctive text must
 *   sit in the one place the pointer names) and again against the final text;
 *   a span that is no longer covered is put back and the pass is re-run.
 *
 * Never changed: the preamble's lines (a one-line legend is added after them),
 * every section header / STATUS, every line that starts with "[" (notes,
 * warnings, [read: ...]), anything containing "!!", the "Declared but NOT
 * readable" list, the Details form, SHI note sections, Dispatch Orders rows,
 * Logs and Work notes posts, every "--- post N ---" line, the author / type /
 * date / Subject / From / To / Cc header of every email post, the Created /
 * Type / Recipients / Subject / User ID cells of every email row, and the
 * rubric and time/stage columns of every SLA row. CRLF input is read as LF.
 */

export type TransformId = "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "T8" | "T9" | "T10";
export const TRANSFORMS: TransformId[] = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10"];

/** One applied edit. `removed` / `inserted` are exact strings, so the log fully
 *  explains the difference between input and output. */
export interface CompactEdit {
  t: TransformId;
  kind: "pattern" | "dedupe";
  /** pattern id (BOILERPLATE id, T10 rule, ...) or dedupe rule */
  rule: string;
  /** where the edit happened, e.g. "Case > post 3", "Emails > row 5" */
  where: string;
  removed: string;
  inserted: string;
  /** dedupe edits: where the removed text can still be read */
  source?: string;
}

export interface CompactResult {
  text: string;
  stats: Record<string, number>;
  edits: CompactEdit[];
}

// =================================================================== text ==

/** Placeholders stand in for inserted markers until the very end, so that a
 *  marker's words can never be mistaken for case text by the coverage check. */
const PH_OPEN = "\u0001";
const PH_CLOSE = "\u0002";
const PH_ONE = /^\u0001(\d+)\u0002$/;
const PH_ALL = /\u0001(\d+)\u0002/g;
const ph = (id: number) => `${PH_OPEN}${id}${PH_CLOSE}`;
const BARRIER = "\u0000";

/** Normalized word tokens: lowercase; link annotations a mail client adds
 *  after the visible text ("<https://…>", "<mailto:…>", "<tel:…>", "<+91%20…>",
 *  and "<a@b.c>" right after the same a@b.c) and [cid:] image references are
 *  ignored; punctuation-only runs are ignored. Placeholders become BARRIER
 *  tokens that never match, so no run can cross a marker. */
const TOKEN_RE =
  /\u0001\d+\u0002|<(?:https?|mailto|tel):[^>\s]*>|<\+[\d%]+>|<\s?[^<>\s@]+@[^<>\s]+\s?>|\[cid:[^\]\s]*\]|[\p{L}\p{N}](?:[\p{L}\p{N}@._%+\-'’&/:#]*[\p{L}\p{N}])?/giu;

export interface Tok {
  w: string;
  s: number;
  e: number;
}

/** Coverage tokenizer, exported so callers can reproduce the check. */
export function coverageTokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0];
    const s = m.index ?? 0;
    if (t.charCodeAt(0) === 1) {
      out.push({ w: BARRIER, s, e: s + t.length });
      continue;
    }
    if (t[0] === "<" && t.includes("@") && !/^<(?:mailto|https?):/i.test(t)) {
      // "<a@b.c>": an annotation only when it repeats the address just before
      const lead = t[1] === " " ? 2 : 1;
      const trail = t[t.length - 2] === " " ? 2 : 1;
      const addr = t.slice(lead, t.length - trail).toLowerCase();
      if (out.length && out[out.length - 1].w === addr) continue;
      out.push({ w: addr, s: s + lead, e: s + t.length - trail });
      continue;
    }
    if (t[0] === "<" || t[0] === "[") continue;
    out.push({ w: t.toLowerCase().replace(/’/g, "'"), s, e: s + t.length });
  }
  return out;
}

/** Whitespace-delimited raw tokens (used for pattern matching and for keeping
 *  every edit aligned to token boundaries). */
interface Raw {
  t: string;
  s: number;
  e: number;
  /** word: comparable text; skip: punctuation / separators / annotations; ph: a marker */
  kind: "word" | "skip" | "ph";
  w: string;
}

function normWord(t: string): string {
  return t
    .replace(/<(?:https?|mailto|tel):[^>]*>|<\+[\d%]+>|<[^<>\s@]+@[^<>\s]+>/gi, "")
    .replace(/\[cid:[^\]]*\]/gi, "")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function rawTokens(text: string): Raw[] {
  const out: Raw[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const t = m[0];
    const s = m.index ?? 0;
    if (PH_ONE.test(t)) {
      out.push({ t, s, e: s + t.length, kind: "ph", w: "" });
      continue;
    }
    const w = normWord(t);
    out.push({ t, s, e: s + t.length, kind: w ? "word" : "skip", w });
  }
  return out;
}

/** Expand [s, e) to whole whitespace-delimited tokens (an end that already
 *  sits on a token boundary stays where it is). */
function alignToTokens(text: string, s: number, e: number): [number, number] {
  const ws = (c: string | undefined) => c === undefined || /\s/.test(c);
  if (!ws(text[s - 1]) && !ws(text[s])) while (s > 0 && !ws(text[s - 1])) s--;
  if (!ws(text[e - 1]) && !ws(text[e])) while (e < text.length && !ws(text[e])) e++;
  return [s, e];
}

// ============================================================ boilerplate ==

/**
 * T5: exact boilerplate, collected from real bundles. A phrase matches word for
 * word (case-insensitive; spaces, " / " line breaks and punctuation-only tokens
 * between words are free). `{...}` marks words that a quoted copy may lack
 * (link text that a reply client dropped). At the very end of a truncated body
 * ("..."), a cut-off prefix of at least 5 words also matches.
 */
export const BOILERPLATE: { id: string; phrases: string[] }[] = [
  {
    id: "pure-support-footer",
    phrases: [
      "24/7 Support Review our Documents Pure1 Community If this is an urgent request, please feel free to contact our 24/7 Support Team at 1(866)244-7121 or +1(650)729-4088 (local US number), or via one of our Local Support Regions ( {See Phone #'s} ) Our Knowledge Base has a wealth of articles, user guides, best practice documentation, and tools. Knowledge Base can be found at {support.purestorage.com} . Great place to connect with other customers and partners. It's another place to get your questions answered. Pure1 Community can be found at {Community} .",
    ],
  },
  {
    id: "external-source-warning",
    phrases: ["WARNING: This email came from external source. Please treat this message with additional caution."],
  },
  { id: "pure1-login-line", phrases: ["In order to view this case please log in to Pure1 here ."] },
  {
    id: "do-not-reply-banner",
    phrases: [
      "CAUTION : DO NOT REPLY to this email Please reach out to Support via Pure1 or follow the original email thread with Technical Services for further communication with Support.",
    ],
  },
  {
    id: "accept-reject-notice",
    phrases: [
      "If you accept/reject the solution, click on this link Thank you for choosing Pure support. Please note that once the solution is accepted the case cannot be reopened and if no action is taken, this case will be marked closed in 5 days. Once closed, if additional assistance is needed a new case will need to be opened.",
    ],
  },
  { id: "closed-contact-line", phrases: ["Please contact the customer service if you have any questions."] },
  { id: "sig-assistance-phones", phrases: ["For assistance, please call +1 (866)-244-7121 or +1 (650)-729-4088 (local US number)"] },
  {
    id: "sig-international-numbers",
    phrases: [
      "International numbers can be found at https://www.purestorage.com/support/",
      "International numbers can be found at http://www.purestorage.com/support/",
      "International numbers can be found at https://www.Everpure.com/support/",
    ],
  },
  {
    id: "sig-nda",
    phrases: [
      "Pure Storage Confidential Information - Covered by NDA",
      "Everpure Confidential Information - Covered by NDA",
      "Everpure Confidential Information - Covered by NDAn",
    ],
  },
  {
    id: "sig-support-urls",
    phrases: [
      "support@purestorage.com | https://support.purestorage.com",
      "support@Everpure.com | https://support.Everpure.com",
      "support@purestorage.com | https://everpuredata.com",
    ],
  },
  { id: "sig-phone-domain", phrases: ["1-800-976-6494 | everpuredata.com"] },
  { id: "sig-title-company", phrases: ["Technical Services Associate || Everpure, Inc. (formerly Pure Storage)"] },
  { id: "unsubscribe-line", phrases: ["Unsubscribe | Notification Preferences"] },
  {
    id: "rma-assistance",
    phrases: [
      "Need assistance right away? You can contact our dedicated Everpure RMA Admin team 24/7 at 844-291-1243 (US Toll-Free). Whether it's questions or changes to your dispatch order, we're here to support you. Simply reply to this email or give us a call.",
    ],
  },
  {
    id: "rma-primary-contact",
    phrases: [
      "Please reach out to Everpure's RMA Administration team as your primary contact for any Dispatch inquiries or rescheduling needs. Contacting the assigned FE or UPS directly can lead to unintended disruptions in your support, and we value your cooperation in this matter.",
    ],
  },
  {
    id: "rma-monitoring",
    phrases: [
      "Everpure's Technical Support team will continue to monitor the health of your equipment and will perform any necessary follow-up actions to ensure continued system performance.",
    ],
  },
  {
    id: "rma-returns",
    phrases: [
      "Returns : If you have defective equipment to return, instructions should have been provided with this delivery. For any questions, please contact our Asset Recovery team ( ssc_everpureRTN@ssc.accenture.com ).",
    ],
  },
  {
    id: "rma-site-contact",
    phrases: [
      "Pure requires a site contact to be available to coordinate receiving any part shipments and provide any assistance with field engineer onsite access as needed. We strongly encourage a secondary site contact to mitigate delays.",
    ],
  },
  {
    id: "rma-delivery-window",
    phrases: ["Typically, parts delivery occurs prior to 2PM and Pure schedules any onsite activities between 2-4PM."],
  },
  {
    id: "pure-confidentiality-notice",
    phrases: [
      "Confidentiality Notice: This message may contain information that is confidential or otherwise protected from disclosure. If you are not the intended recipient, you are hereby notified that any use, disclosure, dissemination, distribution, or copying of this message, or any attachments, is strictly prohibited. If you have received this message in error, please advise the sender by reply e-mail, and delete the message and any attachments. Thank you.",
    ],
  },
  {
    id: "customer-disclaimer-options-it",
    phrases: [
      "CONFIDENTIAL: The information transmitted is intended only for the person(s) or entity to which it is addressed and may contain confidential and/or privileged material. Any review, retransmission, dissemination or other use of, or taking of any action in reliance upon, this information by persons or entities other than the intended recipient is prohibited. If you received this in error, please contact the sender and delete the material from any computer. Whilst we take reasonable precautions to minimise risk, you must carry out your own virus checks before opening attachments or reading e-mails and we do not accept liability for any damage or loss in this respect. This e-mail and its attachments may be subject to copyright protection and you should not retransmit or reproduce these without the consent of the author. http://www.options-it.com",
    ],
  },
  {
    id: "customer-signature-options-it",
    phrases: ["Explore our Press Releases to stay informed about our latest updates and news."],
  },
  {
    id: "customer-disclaimer-tcs",
    phrases: [
      "=====-----=====-----===== Notice: The information contained in this e-mail message and/or attachments to it may contain confidential or privileged information. If you are not the intended recipient, any dissemination, use, review, distribution, printing or copying of the information contained in this e-mail message and/or attachments to it are strictly prohibited. If you have received this communication in error, please notify us by reply e-mail or telephone and immediately and permanently delete the message and any attachments. Thank you",
    ],
  },
  {
    id: "customer-disclaimer-lineage",
    phrases: [
      'The information contained in this message and any accompanying documents is confidential, may be attorney-client privileged, and is intended only for the use of the intended recipient. It is the property of Lineage ("Lineage"). Unauthorized use, disclosure or copying of this message, or any part of it, is strictly prohibited and may be unlawful. If you have received this message in error, please notify the sender immediately by replying to the message and destroying the message and all copies of it, including all attachments. Electronic communication may be susceptible to data corruption, interception and unauthorized tampering and Lineage disclaims all liability of any kind for such actions or any consequences that may arise directly or indirectly there from.',
    ],
  },
  {
    id: "customer-banner-phhc",
    phrases: [
      "CAUTION : This email originated from outside of Premier Home Health Care. Do not click links or open attachments from unknown senders.",
    ],
  },
  {
    id: "customer-banner-onegas",
    phrases: [
      "WARNING: This email was sent from an EXTERNAL source. Use extreme caution when clicking links or opening attachments. Please forward suspicious email to phishingreport@onegas.com .",
    ],
  },
  { id: "customer-banner-tcs", phrases: ["External Email: Be cautious while opening any links or attachments."] },
  {
    // the escalation matrix in every TCS signature (the sender's own name and
    // duty number come before it and are kept)
    id: "customer-signature-tcs-escalation",
    phrases: [
      "1st Level Escalation : Tower Lead : Ravi K, Email : kaliappan.ravi@tcs.com Phone: +919600069795 2nd Level Escalation : Service Delivery Manager : Srikanth R, Email : srikanth.r@tcs.com {Phone: +918925309005} 3rd Level Escalation: Service Delivery Manager-Onsite: DICHU SANKER P | dichusanker.p@tcs.com | +49 15124921887 4th Level Escalation: Business Relationship Manager-Onsite:: Avrendu Saha, Email: avrendu.saha@tcs.com , Phone: +49 15214480207.",
    ],
  },
];

interface PItem {
  words: string[];
  opt: boolean;
}
interface Phrase {
  id: string;
  items: PItem[];
}

function compilePhrase(id: string, p: string): Phrase {
  const items: PItem[] = [];
  for (const m of p.matchAll(/\{([^}]*)\}|(\S+)/g)) {
    if (m[1] !== undefined) {
      const words = m[1].split(/\s+/).map(normWord).filter(Boolean);
      if (words.length) items.push({ words, opt: true });
    } else {
      const w = normWord(m[2]);
      if (w) items.push({ words: [w], opt: false });
    }
  }
  return { id, items };
}

const PHRASES: Phrase[] = BOILERPLATE.flatMap((b) => b.phrases.map((p) => compilePhrase(b.id, p)));
const PHRASES_BY_FIRST = new Map<string, Phrase[]>();
for (const p of PHRASES) {
  const first = p.items[0].words[0];
  PHRASES_BY_FIRST.set(first, [...(PHRASES_BY_FIRST.get(first) ?? []), p]);
}
const MIN_PREFIX_WORDS = 5;

/** Match one phrase at raw token i. Returns the index after the last matched
 *  token, or -1. With `truncAt` set, the text may end mid-phrase (a cut-off
 *  preview) once MIN_PREFIX_WORDS words matched; the last word may be cut. */
function matchPhrase(raw: Raw[], i: number, p: Phrase, truncAt: number): { end: number; prefix: boolean } | null {
  const limit = truncAt >= 0 ? truncAt : raw.length;
  const lastWord = (() => {
    for (let k = limit - 1; k >= 0; k--) if (raw[k].kind === "word") return k;
    return -1;
  })();
  const rec = (k: number, j: number, matched: number, lastEnd: number): { end: number; prefix: boolean } | null => {
    if (k === p.items.length) return { end: lastEnd, prefix: false };
    const it = p.items[k];
    let jj = j;
    let m = matched;
    let le = lastEnd;
    let ok = true;
    for (const w of it.words) {
      while (jj < limit && raw[jj].kind === "skip") jj++;
      if (jj >= limit) {
        if (truncAt >= 0 && m >= MIN_PREFIX_WORDS) return { end: le, prefix: true };
        ok = false;
        break;
      }
      const r = raw[jj];
      if (r.kind === "word" && r.w === w) {
        jj++;
        m++;
        le = jj;
        continue;
      }
      // a word cut by the truncation itself ("b..." for "be")
      if (truncAt >= 0 && jj === lastWord && r.kind === "word" && w.startsWith(r.w) && m >= MIN_PREFIX_WORDS) {
        return { end: jj + 1, prefix: true };
      }
      ok = false;
      break;
    }
    if (ok) {
      const r = rec(k + 1, jj, m, le);
      if (r) return r;
    }
    if (it.opt) return rec(k + 1, j, matched, lastEnd);
    return null;
  };
  return rec(0, i, 0, i);
}

/** A boilerplate match: char range, whether it is a cut-off copy, and whether
 *  it is only the tail of a line ("Name | <title>"), not a whole line. */
export interface BoilerplateHit {
  id: string;
  start: number;
  end: number;
  prefix: boolean;
  midLine: boolean;
}

/** Find all boilerplate matches in a body. */
export function findBoilerplate(text: string): BoilerplateHit[] {
  const raw = rawTokens(text);
  const truncated = /(?:\.\.\.|…)$/.test(text.trimEnd());
  // a cut-off preview: the last token is "..." or ends with it
  let truncAt = -1;
  if (truncated && raw.length) {
    const last = raw[raw.length - 1];
    truncAt = /^(?:\.\.\.|…)$/.test(last.t) ? raw.length - 1 : raw.length;
  }
  const out: { id: string; start: number; end: number; prefix: boolean; midLine: boolean }[] = [];
  let i = 0;
  while (i < raw.length) {
    const r = raw[i];
    if (r.kind !== "word") {
      i++;
      continue;
    }
    let hit: { id: string; end: number; prefix: boolean } | null = null;
    for (const p of PHRASES_BY_FIRST.get(r.w) ?? []) {
      const m = matchPhrase(raw, i, p, truncAt);
      if (m && (!hit || m.end > hit.end)) hit = { id: p.id, ...m };
    }
    if (!hit) {
      i++;
      continue;
    }
    let end = hit.end;
    // trailing punctuation-only tokens (" ." after "Community") belong to it;
    // a cut-off copy also takes the stray punctuation up to the final "..."
    while (end < raw.length && raw[end].kind === "skip" && /^[.,;:!?)]+$/.test(raw[end].t)) end++;
    if (hit.prefix) while (end < truncAt && raw[end].kind === "skip") end++;
    // "Name | <boilerplate title>" at the end of a line: take the "|" too, so
    // the name is not left with a dangling separator
    let start = i;
    const midLine =
      start > 0 && /^\|{1,2}$/.test(raw[start - 1].t) && (end >= raw.length || /^(?:\/|\|{1,2})$/.test(raw[end].t));
    if (midLine) start--;
    out.push({ id: hit.id, start, end, prefix: hit.prefix, midLine });
    i = end;
  }
  return out.map((m) => ({ id: m.id, start: raw[m.start].s, end: raw[m.end - 1].e, prefix: m.prefix, midLine: m.midLine }));
}

// ================================================================= model ==

interface Line {
  text: string;
  deleted?: boolean;
  after?: string[];
}

interface Cell {
  label: string;
  value: string;
}

type UnitKind = "post" | "erow" | "srow" | "static";

interface EmailMeta {
  kind: "sent" | "received";
  ts: string;
  subject: string;
  /** post: To (+ Cc for received); row: Recipients */
  recipients: string[];
  type?: string;
}

class Unit {
  toks?: Tok[];
  head = "";
  bodyText = "";
  cells?: Cell[];
  bodyCell = -1;
  num = 0;
  line?: Line;
  staticLines: Line[] = [];
  /** posts: "Email sent", "Additional comments", ... */
  postType = "";
  email?: EmailMeta;
  partner?: Unit;
  /** a system notification email (see isNotification) */
  notification = false;
  editable = false;

  constructor(
    public key: string,
    public label: string,
    public where: string,
    public order: number,
    public kind: UnitKind,
  ) {}

  get body(): string {
    return this.cells ? this.cells[this.bodyCell]?.value ?? "" : this.bodyText;
  }
  set body(v: string) {
    if (this.cells) this.cells[this.bodyCell].value = v;
    else this.bodyText = v;
    this.toks = undefined;
  }
  text(): string {
    if (this.kind === "static") {
      const out: string[] = [];
      for (const l of this.staticLines) {
        if (!l.deleted) out.push(l.text);
        if (l.after) out.push(...l.after);
      }
      return out.join("\n");
    }
    if (this.cells) return rowText(this.num, this.cells);
    return this.head + this.bodyText;
  }
  bodyOffset(): number {
    if (this.cells) {
      const before = this.cells.slice(0, this.bodyCell).map((c) => `${c.label}: ${c.value}`);
      return `${this.num}. `.length + (before.length ? before.join(" | ").length + 3 : 0) +
        this.cells[this.bodyCell].label.length + 2;
    }
    return this.head.length;
  }
  tokens(): Tok[] {
    return (this.toks ??= coverageTokens(this.text()));
  }
  invalidate(): void {
    this.toks = undefined;
  }
  get subject(): string {
    return this.email?.subject ?? "";
  }
}

function rowText(num: number, cells: Cell[]): string {
  return `${num}. ${cells.map((c) => `${c.label}: ${c.value}`).join(" | ")}`;
}

const HEADER_RE = /^=== (.+) — STATUS: (.*) ===$/;

const EMAIL_LABELS = ["Created", "Target", "Recipients", "Subject", "Type", "Notification type", "User ID", "Body"];
const SLA_LABELS = [
  "Created", "State", "Caller", "Short description", "Assignment group", "Assigned to", "SLA definition", "Type",
  "Target", "Stage", "Business time left", "Business elapsed time", "Business elapsed percentage", "Start time",
  "Stop time", "Has breached", "Breach time", "Actual elapsed time", "Actual elapsed percentage", "Actual time left",
  "Pause duration", "Pause time", "Business pause duration", "Original breach time", "Planned end time",
];

/** Split "N. a: x | b: y | Body: ..." into cells, splitting only at known (or
 *  frequently seen) labels; everything after "Body: " is the body. */
function splitRow(line: string, labels: string[]): { num: number; cells: Cell[] } | null {
  const m = /^(\d+)\. (.*)$/.exec(line);
  if (!m) return null;
  const rest = m[2];
  const cuts: { at: number; label: string }[] = [];
  const first = labels.find((l) => rest.startsWith(`${l}: `));
  if (!first) return null;
  cuts.push({ at: 0, label: first });
  const used = new Set([first]);
  let pos = 0;
  while (true) {
    if (cuts[cuts.length - 1].label === "Body") break;
    let best: { at: number; label: string } | null = null;
    for (const l of labels) {
      if (used.has(l)) continue;
      const at = rest.indexOf(` | ${l}: `, pos);
      if (at >= 0 && (!best || at < best.at)) best = { at, label: l };
    }
    if (!best) break;
    used.add(best.label);
    cuts.push({ at: best.at + 3, label: best.label });
    pos = best.at + 3;
  }
  const cells: Cell[] = cuts.map((c, k) => {
    const end = k + 1 < cuts.length ? cuts[k + 1].at - 3 : rest.length;
    return { label: c.label, value: rest.slice(c.at + c.label.length + 2, end) };
  });
  if (rowText(Number(m[1]), cells) !== line) return null;
  return { num: Number(m[1]), cells };
}

/** Labels that appear (after " | ") in at least half the rows of a section. */
function discoverLabels(rows: string[], known: string[]): string[] {
  const count = new Map<string, number>();
  for (const r of rows) {
    const meta = r.split(" | Body: ")[0];
    const seen = new Set<string>();
    for (const m of meta.matchAll(/(?:^\d+\. | \| )([A-Z][A-Za-z#()/ -]{0,40}?): /g)) seen.add(m[1]);
    for (const l of seen) count.set(l, (count.get(l) ?? 0) + 1);
  }
  const extra = [...count].filter(([l, n]) => !known.includes(l) && n * 2 >= rows.length).map(([l]) => l);
  return [...known, ...extra];
}

const POST_TYPES =
  "Email sent|Email received|Additional comments|Work notes|Field changes|Remote Assist Logs|Logs|Attachment|Image";
const POST_HEAD_RE = new RegExp(`^(.*?) (${POST_TYPES}) (\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d)(?= |$)`);
/** Header of an email post. The From group is lazy-optional (`??`): automated
 *  mail has an empty From ("From To x"), and a greedy group would run into the
 *  body as soon as the body contains "To " ("To ensure the best level ..."). */
const EMAIL_HEAD_RE =
  /^(.*?) (Email sent|Email received) (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) Subject (.*?) From (?:(.*?) )??To (.*?)(?: Cc (.*?))?(?= Show less(?: |$)| \[… full text: Emails section, row \d+\]$|$)/;
const OLD_POINTER_RE = /^\[… full text: Emails section, row (\d+)\]$/;
const LIFECYCLE_ROW_BODY = "[automated lifecycle email — body omitted; subject/recipients above]";
const UNAVAILABLE_SUBJECT = /\bis Currently Unavailable\b/i;

/** Top-level Details form labels, used only to name pointer targets. */
const DETAIL_FIELDS = new Set([
  "Comments", "Jira Issue", "Number", "Audience", "Channel", "Alert code", "Internal initiative ID", "Asset",
  "Software Version", "Support status", "Dark site level", "Account", "Contact Responsibility (Blank to search all)",
  "Contact", "Internal User", "Contact Local Time", "Product Line", "Product", "Entitlement", "Customer Segment",
  "Incident type", "Category", "Subcategory", "Parent", "Action status", "Priority", "Urgency",
  "Technical Severity Level", "Assignment group", "Assigned to", "Correlation ID", "Correlation display",
  "Service Delivery Manager", "Short description", "Description", "Plan of action", "Watch list", "Work notes list",
  "Closed by", "Resolved by", "Corrective Actions", "Resolution code", "RCA requested", "Root Cause", "Cause",
  "Resolution notes", "Close notes", "Alert PN", "Alert SN", "Alert Vendor PN", "Created", "Engineer scheduled start",
  "Follow up", "Opened", "Closed", "Resolved", "SLA Time Days", "SLA Time Hours", "SLA Time Minutes",
  "SLA Time Seconds", "Additional comments (Customer visible)", "Work notes (Private)",
]);

interface Section {
  name: string;
  status: string;
  start: number;
  end: number;
}

interface Doc {
  lines: Line[];
  sections: Section[];
  units: Unit[];
  posts: Unit[];
  erows: Unit[];
  srows: Unit[];
  /** the "Rows (N):" line of the Emails / SLAs sections */
  emailRowsLine?: Line;
  slaRowsLine?: Line;
  /** "CASE BUNDLE — CS..." and the Header's "Contact:" (to verify template lines) */
  caseNumber: string;
  contact: string;
}

function parseDoc(text: string): Doc {
  const lines: Line[] = text.split("\n").map((t) => ({ text: t }));
  const sections: Section[] = [];
  lines.forEach((l, i) => {
    const m = HEADER_RE.exec(l.text);
    if (m) sections.push({ name: m[1], status: m[2], start: i, end: lines.length });
  });
  for (let k = 0; k + 1 < sections.length; k++) sections[k].end = sections[k + 1].start;
  const caseNumber = /^CASE BUNDLE — (CS\d+)/.exec(lines[0]?.text ?? "")?.[1] ?? "";
  const hdr = lines.findIndex((l) => l.text === "== Header ==");
  let contact = "";
  for (let i = hdr + 1; hdr >= 0 && i < lines.length && lines[i].text !== ""; i++) {
    const m = /^Contact: (.+)$/.exec(lines[i].text);
    if (m) contact = m[1];
  }
  const doc: Doc = { lines, sections, units: [], posts: [], erows: [], srows: [], caseNumber, contact };
  let order = 0;
  const addStatic = (key: string, label: string, where: string, from: number, to: number) => {
    if (to <= from) return;
    const u = new Unit(key, label, where, order++, "static");
    u.staticLines = lines.slice(from, to);
    doc.units.push(u);
  };
  addStatic("preamble", "the bundle preamble", "preamble", 0, sections[0]?.start ?? lines.length);

  for (const sec of sections) {
    const isCase = sec.name === "Case";
    const isEmails = sec.name === "Emails";
    const isSlas = sec.name === "SLAs";
    let staticFrom = sec.start;
    const flush = (to: number) => {
      addStatic(`static:${sec.start}:${staticFrom}`, `the ${sec.name} section`, sec.name, staticFrom, to);
    };
    if (isCase) {
      // Details form fields, each its own unit so pointers can name the field.
      let i = sec.start;
      while (i < sec.end) {
        const t = lines[i].text;
        if (t === "== Details form ==") {
          flush(i + 1);
          let j = i + 1;
          while (j < sec.end && !lines[j].text.startsWith("== ")) {
            const fm = /^([^:]{1,60}): /.exec(lines[j].text);
            const name = fm && DETAIL_FIELDS.has(fm[1]) ? fm[1] : "";
            let k = j + 1;
            while (k < sec.end && !lines[k].text.startsWith("== ")) {
              const nm = /^([^:]{1,60}): /.exec(lines[k].text) ?? /^([^:]{1,60}):$/.exec(lines[k].text);
              if (nm && DETAIL_FIELDS.has(nm[1])) break;
              k++;
            }
            addStatic(`details:${j}`, name ? `the Details form (${name})` : "the Details form", "Case > Details form", j, k);
            j = k;
          }
          i = j;
          staticFrom = j;
          continue;
        }
        const pm = /^--- post (\d+) ---$/.exec(t);
        if (pm && i + 1 < sec.end) {
          flush(i + 1);
          const n = Number(pm[1]);
          const line = lines[i + 1];
          const u = new Unit(`post:${n}`, `activity post ${n}`, `Case > post ${n}`, order++, "post");
          u.line = line;
          parsePost(u, line.text);
          doc.units.push(u);
          doc.posts.push(u);
          i += 2;
          staticFrom = i;
          continue;
        }
        i++;
      }
      flush(sec.end);
      continue;
    }
    if (isEmails || isSlas) {
      const rowsAt = lines.findIndex((l, i) => i > sec.start && i < sec.end && /^Rows \(\d+\):$/.test(l.text));
      if (rowsAt < 0) {
        flush(sec.end);
        continue;
      }
      if (isEmails) doc.emailRowsLine = lines[rowsAt];
      else doc.slaRowsLine = lines[rowsAt];
      flush(rowsAt + 1);
      let j = rowsAt + 1;
      const rowLines: number[] = [];
      while (j < sec.end && /^\d+\. /.test(lines[j].text)) rowLines.push(j++);
      const labels = discoverLabels(rowLines.map((k) => lines[k].text), isEmails ? EMAIL_LABELS : SLA_LABELS);
      for (const k of rowLines) {
        const parsed = splitRow(lines[k].text, labels);
        const n = Number(/^(\d+)\./.exec(lines[k].text)?.[1] ?? 0);
        if (!parsed) {
          addStatic(`row:${sec.name}:${n}`, `${sec.name} row ${n}`, `${sec.name} > row ${n}`, k, k + 1);
          continue;
        }
        const u = new Unit(
          `${isEmails ? "erow" : "srow"}:${n}`,
          `${isEmails ? "Emails" : "SLAs"} row ${n}`,
          `${sec.name} > row ${n}`,
          order++,
          isEmails ? "erow" : "srow",
        );
        u.line = lines[k];
        u.num = parsed.num;
        u.cells = parsed.cells;
        if (isEmails) {
          u.bodyCell = parsed.cells.findIndex((c) => c.label === "Body");
          const get = (l: string) => parsed.cells.find((c) => c.label === l)?.value ?? "";
          const type = get("Type");
          u.email = {
            kind: type === "received" ? "received" : "sent",
            ts: get("Created"),
            subject: get("Subject"),
            recipients: splitAddresses(get("Recipients")),
            type,
          };
          u.editable = u.bodyCell >= 0;
          doc.erows.push(u);
        } else {
          doc.srows.push(u);
        }
        doc.units.push(u);
      }
      staticFrom = j;
      flush(sec.end);
      continue;
    }
    flush(sec.end);
  }
  return doc;
}

function splitAddresses(s: string): string[] {
  return s
    .split(/[;,]/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.includes("@"));
}

function parsePost(u: Unit, text: string): void {
  const em = EMAIL_HEAD_RE.exec(text);
  if (em) {
    let head = em[0];
    let rest = text.slice(head.length);
    if (rest.startsWith(" Show less ")) {
      head += " Show less ";
      rest = rest.slice(" Show less ".length);
    } else if (rest === " Show less") {
      head += rest;
      rest = "";
    } else if (rest.startsWith(" ")) {
      head += " ";
      rest = rest.slice(1);
    }
    u.head = head;
    u.bodyText = rest;
    u.postType = em[2];
    const kind = em[2] === "Email received" ? "received" : "sent";
    const to = splitAddresses(em[6] ?? "");
    const cc = splitAddresses(em[7] ?? "");
    u.email = { kind, ts: em[3], subject: em[4], recipients: kind === "received" ? [...to, ...cc] : to };
    u.editable = true;
    return;
  }
  const pm = POST_HEAD_RE.exec(text);
  if (pm) {
    const head = text.length > pm[0].length ? `${pm[0]} ` : pm[0];
    u.head = head;
    u.bodyText = text.slice(head.length);
    u.postType = pm[2];
    u.editable = ["Additional comments", "Field changes"].includes(pm[2]);
    return;
  }
  u.head = text;
  u.bodyText = "";
}

// ================================================================ markers ==

type MarkerData =
  | { kind: "text"; text: string }
  | { kind: "body"; target: Unit; same: boolean }
  | { kind: "comment"; target: Unit }
  | { kind: "history"; count: number; targets: Unit[] }
  | { kind: "summary"; target: Unit }
  | { kind: "quoted"; target: Unit }
  | { kind: "same"; target: Unit | null };

interface Marker {
  id: number;
  data: MarkerData;
  /** the unit the marker sits in */
  host: Unit | null;
}

// ============================================================== coverage ==
//
// "Covered" means: every word of the removed span is still in the output.
//   1. The span is aligned, in order, against the unit its pointer names
//      (longest common subsequence; only runs of 2+ words count). This is
//      what absorbs the activity stream's habit of dropping repeated text
//      (it de-duplicates identical text nodes inside a post).
//   2. Whatever is left must be found elsewhere as runs of MIN_RUN+ words;
//      a few shorter runs (weakAllowance) are tolerated.
// The pointer target must hold most of the span's DISTINCTIVE text: shares
// are weighted by 1 / (number of units containing the word), so a subject
// line or a signature repeated everywhere cannot outvote the one sentence
// that is actually new.

const MIN_RUN = 4;
const weakAllowance = (n: number) => (n <= 3 ? 0 : Math.min(4, Math.max(1, Math.floor(n * 0.15))));

class Index {
  toks: Tok[][];
  tri = new Map<string, number[]>();
  bi = new Map<string, number[]>();
  uni = new Map<string, number[]>();
  df = new Map<string, number>();
  constructor(public units: Unit[]) {
    this.toks = units.map((u) => u.tokens());
    const add = (m: Map<string, number[]>, k: string, v: number) => {
      const a = m.get(k);
      if (a) a.push(v);
      else m.set(k, [v]);
    };
    this.toks.forEach((t, ui) => {
      const seen = new Set<string>();
      for (let i = 0; i < t.length; i++) {
        const a = t[i].w;
        if (a === BARRIER) continue;
        if (!seen.has(a)) {
          seen.add(a);
          this.df.set(a, (this.df.get(a) ?? 0) + 1);
        }
        const code = ui * 1_000_000 + i;
        add(this.uni, a, code);
        const b = t[i + 1]?.w;
        if (b === undefined || b === BARRIER) continue;
        add(this.bi, `${a}\u0003${b}`, code);
        const c = t[i + 2]?.w;
        if (c === undefined || c === BARRIER) continue;
        add(this.tri, `${a}\u0003${b}\u0003${c}`, code);
      }
    });
  }
  weight(w: string): number {
    return 1 / Math.max(1, this.df.get(w) ?? 1);
  }
  /** Is there a word in the index that starts with `p` (and is longer)? */
  hasPrefix(p: string): boolean {
    for (const w of this.uni.keys()) if (w.length > p.length && w.startsWith(p)) return true;
    return false;
  }
}

type Allow = (ui: number, ti: number) => boolean;

interface Run {
  i: number;
  len: number;
  ui: number;
  seg: number;
}

/** Greedy longest runs over the span positions where `todo[i]` is true. */
function greedyRuns(
  span: string[],
  todo: boolean[],
  ix: Index,
  allow: Allow,
  prefer?: (ui: number) => number,
): { runs: Run[]; uncovered: number[] } {
  const runs: Run[] = [];
  const uncovered: number[] = [];
  let i = 0;
  while (i < span.length) {
    if (!todo[i] || span[i] === BARRIER) {
      i++;
      continue;
    }
    let segEnd = i;
    while (segEnd < span.length && todo[segEnd] && span[segEnd] !== BARRIER) segEnd++;
    const segLen = segEnd - i;
    let j = i;
    while (j < segEnd) {
      let best = 0;
      let bestU = -1;
      let bestPref = -Infinity;
      const tryList = (list?: number[]) => {
        if (!list) return;
        for (const code of list) {
          const ui = Math.floor(code / 1_000_000);
          const ti = code % 1_000_000;
          if (!allow(ui, ti)) continue;
          const t = ix.toks[ui];
          let L = 0;
          while (j + L < segEnd && ti + L < t.length && t[ti + L].w === span[j + L] && (L === 0 || allow(ui, ti + L))) L++;
          const pref = prefer ? prefer(ui) : 0;
          if (L > best || (L === best && L > 0 && pref > bestPref)) {
            best = L;
            bestU = ui;
            bestPref = pref;
          }
        }
      };
      if (segEnd - j >= 3) tryList(ix.tri.get(`${span[j]}\u0003${span[j + 1]}\u0003${span[j + 2]}`));
      if (best < 3 && segEnd - j >= 2) tryList(ix.bi.get(`${span[j]}\u0003${span[j + 1]}`));
      if (best < 2) tryList(ix.uni.get(span[j]));
      if (best === 0) {
        uncovered.push(j);
        j++;
        continue;
      }
      runs.push({ i: j, len: best, ui: bestU, seg: segLen });
      j += best;
    }
    i = segEnd;
  }
  return { runs, uncovered };
}

const NO_MATCH = "\u0000\u0000";

/**
 * In-order alignment of the span against one unit (LCS; runs of 2+ words).
 *
 * `foreign` reports a SUBSTITUTION: between two aligned stretches, both the
 * span and the target hold different words, and some of the span's words are
 * nowhere in the target. That is a different message in the same template
 * (two replies with the same subject line, greeting and signature), not a copy
 * of it: the activity stream's de-duplication only ever DELETES repeated text.
 * Such a target must not be named as the place where the span's text is.
 */
function align(span: string[], ix: Index, ui: number, allow: Allow): { at: boolean[]; foreign: boolean } {
  const n = span.length;
  const out = new Array<boolean>(n).fill(false);
  const none = { at: out, foreign: false };
  if (ui < 0) return none;
  const t = ix.toks[ui];
  const m = t.length;
  if (!n || !m) return none;
  const tw = t.map((x, k) => (x.w !== BARRIER && allow(ui, k) ? x.w : NO_MATCH));
  // only the window of the target that shares words with the span matters
  const words = new Set(span);
  let lo = 0;
  let hi = m;
  while (lo < m && !words.has(tw[lo])) lo++;
  while (hi > lo && !words.has(tw[hi - 1])) hi--;
  const w = hi - lo;
  if (w <= 0 || n * w > 6_000_000) return none;
  const W = w + 1;
  const L = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    const si = span[i];
    for (let j = w - 1; j >= 0; j--) {
      const k = i * W + j;
      if (si !== BARRIER && si === tw[lo + j]) L[k] = L[(i + 1) * W + j + 1] + 1;
      else {
        const a = L[(i + 1) * W + j];
        const b = L[i * W + j + 1];
        L[k] = a > b ? a : b;
      }
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < w) {
    if (span[i] !== BARRIER && span[i] === tw[lo + j] && L[i * W + j] === L[(i + 1) * W + j + 1] + 1) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++;
    else j++;
  }
  // keep runs that are contiguous on both sides and at least 2 words long
  const runs: [number, number, number, number][] = []; // span [s0, s1), target [t0, t1)
  for (let k = 0; k < pairs.length; ) {
    let e = k + 1;
    while (e < pairs.length && pairs[e][0] === pairs[e - 1][0] + 1 && pairs[e][1] === pairs[e - 1][1] + 1) e++;
    if (e - k >= 2 || n === 1) {
      for (let q = k; q < e; q++) out[pairs[q][0]] = true;
      runs.push([pairs[k][0], pairs[e - 1][0] + 1, pairs[k][1], pairs[e - 1][1] + 1]);
    }
    k = e;
  }
  // substitutions between consecutive kept runs. Only real words count (3+
  // characters, or a 2+ digit number): a mail client re-rendering a signature
  // ("3rd" as "3 rd", a Wingdings bullet as "ÿ") is the same message.
  const targetWords = new Set(tw);
  let foreign = false;
  for (let k = 1; k < runs.length && !foreign; k++) {
    const [, s1, , t1] = runs[k - 1];
    const [s0b, , t0b] = runs[k];
    if (!(s0b > s1 && t0b > t1)) continue;
    const gap = tw.slice(lo + t1, lo + t0b);
    for (let q = s1; q < s0b && !foreign; q++) {
      const word = span[q];
      if (word === BARRIER || targetWords.has(word)) continue;
      if (word.length < 3 && !/\d\d/.test(word)) continue;
      // "3rd" in one copy, "3 rd" in the other
      if (gap.some((g, x) => x + 1 < gap.length && g + gap[x + 1] === word)) continue;
      foreign = true;
    }
  }
  return { at: out, foreign };
}

interface Verdict {
  /** every word is still in the output */
  ok: boolean;
  /** weighted share of the span held by the pointer target */
  share: number;
  /** unit index of the pointer target (-1 when there was nothing to cover) */
  top: number;
  n: number;
  weak: number;
  uncovered: number;
  /** span positions that are covered (aligned to the target or found elsewhere) */
  coveredAt: boolean[];
  alignedAt: boolean[];
}

/**
 * Is `span` covered? `target` is the unit the pointer will name; when null, the
 * unit holding the largest weighted share is chosen.
 */
function judge(
  span: string[],
  ix: Index,
  allow: Allow,
  target: number | null,
  prefer?: (ui: number) => number,
): Verdict {
  const n = span.filter((w) => w !== BARRIER).length;
  const none = span.map(() => false);
  if (!n) return { ok: true, share: 1, top: target ?? -1, n: 0, weak: 0, uncovered: 0, coveredAt: none, alignedAt: none };
  let top = target ?? -1;
  if (target === null) {
    const g = greedyRuns(span, span.map(() => true), ix, allow, prefer);
    const byUnit = new Map<number, number>();
    for (const r of g.runs) {
      let wsum = 0;
      for (let q = r.i; q < r.i + r.len; q++) wsum += ix.weight(span[q]);
      byUnit.set(r.ui, (byUnit.get(r.ui) ?? 0) + wsum);
    }
    let best = -1;
    for (const [u, v] of byUnit) {
      if (v > best + 1e-9 || (Math.abs(v - best) <= 1e-9 && prefer && prefer(u) > prefer(top))) {
        top = u;
        best = v;
      }
    }
  }
  const { at: alignedAt, foreign } = align(span, ix, top, allow);
  const rest = greedyRuns(span, alignedAt.map((a) => !a), ix, allow, prefer);
  const coveredAt = alignedAt.slice();
  let weak = 0;
  for (const r of rest.runs) {
    if (!(r.len >= MIN_RUN || r.len === r.seg)) weak += r.len;
    for (let q = r.i; q < r.i + r.len; q++) coveredAt[q] = true;
  }
  let total = 0;
  let mine = 0;
  for (let q = 0; q < span.length; q++) {
    if (span[q] === BARRIER) continue;
    const w = ix.weight(span[q]);
    total += w;
    if (alignedAt[q]) mine += w;
  }
  for (const r of rest.runs) {
    if (r.ui !== top) continue;
    for (let q = r.i; q < r.i + r.len; q++) mine += ix.weight(span[q]);
  }
  const ok = rest.uncovered.length === 0 && weak <= weakAllowance(n);
  // a target holding a different message in the same template is no pointer target
  const share = foreign ? 0 : total ? mine / total : 1;
  return { ok, share, top, n, weak, uncovered: rest.uncovered.length, coveredAt, alignedAt };
}

const DOMINANCE = 0.75;
/** A pointer must save at least this many characters over its own length. */
const MIN_SAVING = 20;
/** Joins the keys of edits merged into one (e.g. a group of replayed
 *  comments); a control character, so it can never occur inside a key. */
const KEY_JOIN = "\u0003";
const MAX_ROUNDS = 60;

// =============================================================== engine ==

interface PendingEdit {
  t: TransformId;
  kind: "pattern" | "dedupe";
  rule: string;
  unit: Unit | null;
  where: string;
  removedRaw: string;
  insertedRaw: string;
  markerId: number;
  key: string;
  source?: Unit;
}

class Ctx {
  markers = new Map<number, Marker>();
  nextId = 1;
  edits: PendingEdit[] = [];
  private ix?: Index;
  constructor(public doc: Doc, public banned: Set<string>) {}

  get index(): Index {
    return (this.ix ??= new Index(this.doc.units));
  }
  dirty(): void {
    this.ix = undefined;
  }
  marker(data: MarkerData, host: Unit | null): number {
    const id = this.nextId++;
    this.markers.set(id, { id, data, host });
    return id;
  }
  /** Replace body[s, e) (token-aligned) of a unit. */
  edit(
    u: Unit,
    s: number,
    e: number,
    insert: string | MarkerData,
    t: TransformId,
    kind: "pattern" | "dedupe",
    rule: string,
    key: string,
    source?: Unit,
  ): boolean {
    const body = u.body;
    [s, e] = alignToTokens(body, s, e);
    const removedRaw = body.slice(s, e);
    // a dedupe pointer must be shorter than what it replaces
    if (kind === "dedupe" && typeof insert !== "string") {
      const cost = renderMarker(this, { id: 0, data: insert, host: u }).length + MIN_SAVING;
      if (removedRaw.replace(PH_ALL, "#".repeat(40)).length <= cost) return false;
    }
    let insertedRaw = "";
    let markerId = 0;
    if (typeof insert === "string") insertedRaw = insert;
    else {
      markerId = this.marker(insert, u);
      insertedRaw = ph(markerId);
    }
    u.body = body.slice(0, s) + insertedRaw + body.slice(e);
    // collapse whitespace left behind when nothing was inserted
    if (!insertedRaw) u.body = collapseGap(u.body, s);
    this.edits.push({ t, kind, rule, unit: u, where: u.where, removedRaw, insertedRaw, markerId, key, source });
    this.dirty();
    return true;
  }
  /** Remove raw-token range [a, b) together with ONE adjacent " / " separator
   *  and the whitespace in front of it, so "x / phrase / y" becomes "x / y". */
  removeTokens(u: Unit, raw: Raw[], a: number, b: number, t: TransformId, rule: string, key: string, keepSeparators = false): void {
    if (keepSeparators) {
      // only part of a line goes: its " / " neighbours stay
    } else if (a > 0 && raw[a - 1].t === "/") a--;
    else if (b < raw.length && raw[b].t === "/") b++;
    const body = u.body;
    let s: number;
    let e: number;
    if (a > 0) {
      s = raw[a - 1].e;
      e = raw[b - 1].e;
    } else {
      s = 0;
      e = b < raw.length ? raw[b].s : body.length;
    }
    const removedRaw = body.slice(s, e);
    u.body = body.slice(0, s) + body.slice(e);
    this.edits.push({ t, kind: "pattern", rule, unit: u, where: u.where, removedRaw, insertedRaw: "", markerId: 0, key });
    this.dirty();
  }
}

/** After deleting at position s, make sure the neighbours stay separated by
 *  exactly the whitespace that was already there. (Edits are token-aligned,
 *  so this only ever trims a doubled space at s.) */
function collapseGap(body: string, s: number): string {
  if (s > 0 && s < body.length && body[s - 1] === " " && body[s] === " ") return body.slice(0, s) + body.slice(s + 1);
  if (s === 0 && body.startsWith(" ")) return body.slice(1);
  if (s >= body.length && body.endsWith(" ")) return body.slice(0, -1);
  return body;
}

/** The coverage tokens of body[s, e) of unit u (barriers for markers). With an
 *  index, a word cut by a truncated preview is dropped (see dropCutWord). */
function spanTokens(u: Unit, s: number, e: number, ix?: Index): string[] {
  const off = u.bodyOffset();
  const words = u
    .tokens()
    .filter((t) => t.s >= off + s && t.e <= off + e)
    .map((t) => t.w);
  return ix ? dropCutWord(words, u.body.slice(s, e), ix) : words;
}

/** A preview cut mid-word ("... provide any si...") leaves a fragment that
 *  matches nothing. The fragment is no information of its own: it counts as
 *  covered when some word in the bundle starts with it. */
function dropCutWord(words: string[], text: string, ix: Index): string[] {
  if (!/[\p{L}\p{N}](?:\.\.\.|…)\s*$/u.test(text)) return words;
  let k = words.length - 1;
  while (k >= 0 && words[k] === BARRIER) k--;
  if (k < 0 || !ix.hasPrefix(words[k])) return words;
  const out = words.slice();
  out[k] = BARRIER;
  return out;
}

/** Allow-function that hides body[s, e) of u, plus any extra exclusion. */
function hiding(ctx: Ctx, u: Unit, s: number, e: number, extra?: (unit: Unit, tok: Tok) => boolean): Allow {
  const units = ctx.doc.units;
  const ui0 = units.indexOf(u);
  const off = u.bodyOffset();
  const toks = ctx.index.toks;
  return (ui, ti) => {
    const tok = toks[ui][ti];
    if (ui === ui0 && tok.s >= off + s && tok.e <= off + e) return false;
    return extra ? !extra(units[ui], tok) : true;
  };
}

function isWhollyMarker(body: string): number {
  const m = PH_ONE.exec(body.trim());
  return m ? Number(m[1]) : 0;
}

// =========================================================== T8 T6 T7 ==

function applyT8(ctx: Ctx): void {
  const { lines, sections } = ctx.doc;
  for (const sec of sections) {
    if (sec.name === "Case" || sec.name.startsWith("SHI note")) continue;
    for (let i = sec.start; i < sec.end; i++) {
      if (!lines[i].text.startsWith("Openable records (")) continue;
      let j = i;
      while (j < sec.end && j < i + 4 && !lines[j].text.endsWith("):")) j++;
      j++;
      while (j < sec.end && /^\d+\. /.test(lines[j].text)) j++;
      let from = i;
      if (from - 1 > sec.start && lines[from - 1].text === "" && (j >= sec.end || lines[j].text === "")) from--;
      const removed = lines.slice(from, j).map((l) => l.text).join("\n");
      for (let k = from; k < j; k++) lines[k].deleted = true;
      ctx.edits.push({
        t: "T8", kind: "pattern", rule: "openable-records", unit: null, where: sec.name,
        removedRaw: removed, insertedRaw: "", markerId: 0, key: `T8:${sec.name}`,
      });
      i = j - 1;
    }
  }
}

const EMAIL_KEEP_COLS = new Set(["Created", "Type", "Recipients", "Subject", "User ID", "Body"]);
/** SLA columns that are rubric evidence or time/stage related: never dropped. */
export const SLA_KEEP_COLUMN = /^(?:Target|Stage|SLA definition|Has breached|Breached)$|time|elapsed|left|stage|breach|pause|target|percentage|definition|duration|created|start|stop|end|due|schedule/i;

function applyConstantColumns(ctx: Ctx, rows: Unit[], rowsLine: Line | undefined, t: TransformId, keep: (l: string) => boolean): void {
  if (rows.length < 2 || !rowsLine) return;
  const first = rows[0].cells ?? [];
  const constants: Cell[] = [];
  for (const c of first) {
    if (keep(c.label)) continue;
    if (rows.every((r) => r.cells?.some((x) => x.label === c.label && x.value === c.value))) constants.push({ ...c });
  }
  if (!constants.length) return;
  for (const r of rows) {
    for (const c of constants) {
      const cells = r.cells!;
      const k = cells.findIndex((x) => x.label === c.label);
      const removed = k === 0 ? `${c.label}: ${c.value} | ` : ` | ${c.label}: ${c.value}`;
      cells.splice(k, 1);
      if (r.bodyCell > k) r.bodyCell--;
      r.invalidate();
      ctx.edits.push({
        t, kind: "pattern", rule: "constant-column", unit: r, where: r.where,
        removedRaw: removed, insertedRaw: "", markerId: 0, key: `${t}:${r.key}:${c.label}`,
      });
    }
  }
  const line = `(same on every row, shown once: ${constants.map((c) => `${c.label}: ${c.value}`).join(" | ")})`;
  rowsLine.after = [...(rowsLine.after ?? []), line];
  ctx.edits.push({
    t, kind: "pattern", rule: "constant-header", unit: null, where: rows[0].where.split(" > ")[0],
    removedRaw: "", insertedRaw: line, markerId: 0, key: `${t}:header`,
  });
  ctx.dirty();
}

// ================================================================== T10 ==

export const T10_RULES = [
  "unclosed-comment",
  "truncated-tag",
  "truncated-entity",
  "image-reference",
  "zero-width",
  "ui-chrome",
] as const;

function isEmailBody(u: Unit): boolean {
  return u.editable && !!u.email;
}

function applyT10(ctx: Ctx, u: Unit): void {
  const key = (r: string) => `T10:${u.key}:${r}`;
  const truncated = () => /(?:\.\.\.|…)$/.test(u.body.trimEnd());
  // 1. an HTML comment (Outlook's <style> block) cut off before "-->"
  {
    const b = u.body;
    const at = b.indexOf("<!--");
    if (at >= 0 && b.indexOf("-->", at) < 0) {
      const wasCut = truncated();
      const [s] = alignToTokens(b, at, at);
      const keepInToken = b.slice(s, at);
      if (!b.slice(0, s).trim() && !keepInToken) {
        ctx.edit(u, s, b.length, { kind: "text", text: "[no readable text: this preview held only formatting markup]" }, "T10", "pattern", "unclosed-comment", key("comment"));
      } else {
        const insert = [keepInToken, wasCut ? "..." : ""].filter(Boolean).join(" ");
        ctx.edit(u, s, b.length, insert, "T10", "pattern", "unclosed-comment", key("comment"));
      }
    }
  }
  // 2. a tag / 3. an entity cut off by the preview's "..."
  if (truncated()) {
    const b = u.body.trimEnd();
    const core = b.replace(/(?:\.\.\.|…)$/, "");
    const tag = /<[A-Za-z!/][^<>]*$/.exec(core);
    const ent = /&[#\w]{1,10}$/.exec(core);
    const hit = tag ?? ent;
    if (hit) {
      const [s] = alignToTokens(b, hit.index, hit.index);
      const keep = b.slice(s, hit.index);
      ctx.edit(u, s, b.length, `${keep}${keep ? " " : ""}...`, "T10", "pattern", tag ? "truncated-tag" : "truncated-entity", key("cut"));
    }
  }
  // 4. inline image references, 5. zero-width-only tokens, 6. UI text
  applyMarkupTokens(ctx, u);
  applyUiChrome(ctx, u);
}

/** [cid:] image references (with the link a mail client attaches) and tokens
 *  made only of zero-width characters: no text of their own. */
function applyMarkupTokens(ctx: Ctx, u: Unit): void {
  const raw = rawTokens(u.body);
  for (let k = raw.length - 1; k >= 0; k--) {
    const t = raw[k].t;
    let rule = "";
    if (/^\[cid:[^\]\s]*\](?:<(?:https?|mailto):[^>\s]*>)*$/i.test(t)) rule = "image-reference";
    else if (/^[\u200b-\u200d\u2060\ufeff]+$/.test(t)) rule = "zero-width";
    if (rule) ctx.removeTokens(u, raw, k, k + 1, "T10", rule, `T10:${u.key}:${rule}:${k}`);
  }
}

/** The activity stream's own control labels at the end of a post body. */
function applyUiChrome(ctx: Ctx, u: Unit): void {
  if (u.kind !== "post" || !u.editable) return;
  for (const [re, n] of [[/(?:^| )Show full conversation$/, 3], [/(?:^| )Show less$/, 2]] as const) {
    if (!re.test(u.body)) continue;
    const raw = rawTokens(u.body);
    if (raw.length >= n) ctx.removeTokens(u, raw, raw.length - n, raw.length, "T10", "ui-chrome", `T10:${u.key}:ui:${n}`);
  }
}

// =================================================================== T3 ==

/** T3: the "Engineer X is Currently Unavailable" auto-reply is a fixed
 *  template. Its body becomes a marker; the one case-specific line, the
 *  engineer's "Next scheduled shift: ...", is kept as it was. */
function applyT3(ctx: Ctx, u: Unit): void {
  if (!UNAVAILABLE_SUBJECT.test(u.subject)) return;
  const b = u.body;
  if (!/currently unavailable/i.test(b) || OLD_POINTER_RE.test(b.trim())) return;
  const marker: MarkerData = { kind: "text", text: '[auto-reply "engineer currently unavailable": template text omitted]' };
  const shift = /Next scheduled shift: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC - \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/.exec(b);
  if (!shift) {
    ctx.edit(u, 0, b.length, marker, "T3", "pattern", "unavailable-auto-reply", `T3:${u.key}`);
    return;
  }
  const end = shift.index + shift[0].length;
  if (end < b.trimEnd().length) ctx.edit(u, end, b.length, "", "T3", "pattern", "unavailable-auto-reply", `T3:${u.key}:tail`);
  let headEnd = shift.index;
  while (headEnd > 0 && /[\s/]/.test(b[headEnd - 1])) headEnd--;
  ctx.edit(u, 0, headEnd, marker, "T3", "pattern", "unavailable-auto-reply", `T3:${u.key}`);
}

// =================================================================== T5 ==

function applyT5(ctx: Ctx, u: Unit): void {
  const hits = findBoilerplate(u.body);
  for (let k = hits.length - 1; k >= 0; k--) {
    const h = hits[k];
    const raw = rawTokens(u.body);
    const a = raw.findIndex((r) => r.s === h.start);
    const b = raw.findIndex((r) => r.e === h.end) + 1;
    if (a < 0 || b <= a) continue;
    ctx.removeTokens(u, raw, a, b, "T5", h.prefix ? `${h.id} (cut-off copy)` : h.id, `T5:${u.key}:${k}`, h.midLine);
  }
}

export const NOTIFICATION_PREAMBLE = /^Case (CS\d+) - (.+?) - has a new comment added by(?: (.+?))?(?= (?:\/ )?Comments:)/;
export const RESOLVED_GREETING = /^Dear (.+?), Your Pure Storage ticket (CS\d+) - (.+?) - has been resolved\./;

/**
 * T5, template lines: a notification's first line ("Case CS1 - <short
 * description> - has a new comment added by <name>"; "Comments:" stays) and a
 * resolved mail's greeting ("Dear <contact>, Your Pure Storage ticket CS1 -
 * <short description> - has been resolved.") only restate what the email's
 * own header already says. Removed only when every value checks out: the case
 * number is this bundle's, the short description is in the email's subject,
 * the name appears again in the same email, the contact is the case contact.
 */
function applyT5Templates(ctx: Ctx, u: Unit): void {
  const { caseNumber, contact } = ctx.doc;
  const subject = u.subject;
  // the body's own first line, and the first line of every notification
  // quoted in it (right after "... wrote:"), so both copies stay comparable
  const starts = [u.body.length - u.body.trimStart().length];
  for (const m of u.body.matchAll(/ wrote: (?:\/ )?/g)) starts.push((m.index ?? 0) + m[0].length);
  for (const at of starts.sort((a, b) => b - a)) {
    const body = u.body;
    const text = body.slice(at);
    const n = NOTIFICATION_PREAMBLE.exec(text);
    const r = RESOLVED_GREETING.exec(text);
    let len = 0;
    let rule = "";
    if (n && n[1] === caseNumber && subject.includes(n[2]) && (!n[3] || text.slice(n[0].length).includes(n[3].trim()))) {
      len = n[0].length;
      rule = "notification-preamble";
    } else if (r && r[2] === caseNumber && subject.includes(r[3]) && r[1] === contact) {
      len = r[0].length;
      rule = "resolved-greeting";
    }
    if (!len) continue;
    const raw = rawTokens(body);
    const a = raw.findIndex((t) => t.s === at);
    const b = raw.findIndex((t) => t.e === at + len) + 1;
    if (a >= 0 && b > a) ctx.removeTokens(u, raw, a, b, "T5", rule, `T5:${u.key}:${rule}:${at}`);
  }
}

// ======================================================== email pairing ==

/** Pair every email activity post with its Emails row: same send time AND
 *  same subject (two emails can share a second), recipients as tie-break. */
function pairEmails(doc: Doc): void {
  const used = new Set<Unit>();
  for (const p of doc.posts) {
    if (!p.email) continue;
    const cands = doc.erows.filter(
      (r) =>
        !used.has(r) &&
        r.email &&
        r.email.ts === p.email!.ts &&
        r.email.subject === p.email!.subject &&
        (r.email.kind === "received") === (p.email!.kind === "received"),
    );
    if (!cands.length) continue;
    const score = (r: Unit) => {
      const a = new Set(r.email!.recipients);
      const b = new Set(p.email!.recipients);
      let inter = 0;
      for (const x of a) if (b.has(x)) inter++;
      return inter * 2 - Math.abs(a.size - b.size) + (a.size === b.size && inter === a.size ? 100 : 0);
    };
    const best = cands.reduce((x, y) => (score(y) > score(x) ? y : x));
    used.add(best);
    p.partner = best;
    best.partner = p;
  }
}

/** Coverage tokens of a unit's body, with body-relative offsets. */
function bodyToks(u: Unit): Tok[] {
  const off = u.bodyOffset();
  return u
    .tokens()
    .filter((t) => t.s >= off)
    .map((t) => ({ w: t.w, s: t.s - off, e: t.e - off }));
}

const unitIndex = (ctx: Ctx, u: Unit) => ctx.doc.units.indexOf(u);
const preferIn = (ctx: Ctx) => (ui: number) => preferCanonical(ctx.doc.units[ui]);

/** Tie-break for sources: comment posts, then email rows, then the rest. */
function preferCanonical(u: Unit): number {
  if (!u) return -1;
  if (u.kind === "post" && u.postType === "Additional comments") return 3;
  if (u.kind === "erow") return 2;
  if (u.kind === "static") return 1;
  return 0;
}

const NOTIFICATION_BODY =
  /^\s*(?:Case CS\d+\b[^\n]{0,400}?\bhas a new comment added by\b|Dear [^\n]{0,160}?\bYour Pure Storage ticket CS\d+\b|Your case CS\d+ has been closed\b)/;

/** A system notification (new comment / resolved / closed), judged by its
 *  template text, not its subject: an engineer's reply keeps the subject.
 *  Decided once during the pattern stages, before T5 trims the template's
 *  first line (see markNotifications). */
function isNotification(u: Unit): boolean {
  return u.notification;
}

function markNotifications(doc: Doc): void {
  for (const u of doc.units) u.notification = !!u.email && u.editable && NOTIFICATION_BODY.test(u.body);
}

// =================================================================== T4 ==

interface QuoteSpan {
  /** the reply header ("On ... wrote:", an Outlook "From: / Sent: / To: ..."
   *  block, "-----Original Message-----"); stable across edits, so it keys
   *  the decision */
  header: string;
  /** where the header (or the "_____" line in front of it) starts */
  blockStart: number;
  /** the "_____" separator in front of the header, if any */
  sep: [number, number] | null;
  /** quoted text of this level: [s, e); everything after it: [s, tail) */
  s: number;
  e: number;
  tail: number;
}

/** The reply levels of an email body, outermost first. */
function quoteSpans(body: string): QuoteSpan[] {
  const end = tailEnd(body, 0);
  const marks: { at: number; end: number }[] = [];
  for (const m of body.matchAll(/\bOn [A-Z][a-z]{2,9}\b[^\n]{4,170}? wrote:/g)) {
    marks.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  for (const m of body.matchAll(/(?:^|\s)From: [^/\n]{3,200}? \/ Sent: [^/\n]{5,80}? \/ To: /g)) {
    const at = (m.index ?? 0) + (m[0].startsWith("From") ? 0 : 1);
    const subj = body.indexOf(" / Subject: ", at);
    if (subj < 0 || subj - at > 1500) continue;
    let e = body.indexOf(" / ", subj + 3);
    if (e < 0) e = body.length;
    const imp = /^ \/ Importance: \w+/.exec(body.slice(e));
    if (imp) e += imp[0].length;
    marks.push({ at, end: e });
  }
  for (const m of body.matchAll(/-{3,}\s*Original Message\s*-{3,}/gi)) {
    marks.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  marks.sort((a, b) => a.at - b.at);
  // drop a header that sits inside another one
  const kept = marks.filter((m, i) => !marks.some((o, j) => j < i && m.at < o.end));
  const out: QuoteSpan[] = [];
  kept.forEach((mk, i) => {
    let s = mk.end;
    while (s < body.length && /[\s/]/.test(body[s])) s++;
    let sep: [number, number] | null = null;
    const before = body.slice(0, mk.at);
    const sm = /(?:^|\s)(_{10,})(?:\s\/)?\s*$/.exec(before);
    if (sm) {
      const at = before.lastIndexOf(sm[1]);
      sep = [at, at + sm[1].length];
    }
    out.push({ header: body.slice(mk.at, mk.end), blockStart: sep ? sep[0] : mk.at, sep, s, e: end, tail: end });
    void i;
  });
  // a level's own text ends where the next level's block begins
  for (let i = 0; i < out.length; i++) {
    let e = i + 1 < out.length ? out[i + 1].blockStart : out[i].tail;
    while (e > out[i].s && /[\s/]/.test(body[e - 1])) e--;
    out[i].e = Math.max(out[i].s, e);
  }
  return out.filter((q) => q.s < q.tail);
}

/** End of real text: before trailing "...", separators and Ref:MSG ids. */
function tailEnd(body: string, from: number): number {
  const raw = rawTokens(body);
  let k = raw.length;
  while (k > 0 && raw[k - 1].s >= from && /^(?:\/|\.\.\.|…|Ref:MSG\w+|_+)$/.test(raw[k - 1].t)) k--;
  return k > 0 ? Math.max(from, raw[k - 1].e) : from;
}

/**
 * T4: cut quoted reply text that is already in the bundle. Try the whole
 * quoted tail from the outermost level inward; when no tail is covered (a
 * nested reply header with its own date is new information), cut level by
 * level and keep the headers.
 *
 * Pass 1 accepts only an email's OWN text as the source (never another quote
 * of it), so the pointer names the email that wrote the text. Pass 2 then
 * de-duplicates quotes whose original is not in the bundle, newest first, so
 * the oldest copy is the one kept.
 */
function stageT4(ctx: Ctx): void {
  const emails = ctx.doc.units.filter((u) => isEmailBody(u) && !isNotification(u) && !UNAVAILABLE_SUBJECT.test(u.subject));
  const cache = new Map<Unit, { body: string; range: [number, number] | null }>();
  const quotedRange = (u: Unit): [number, number] | null => {
    const hit = cache.get(u);
    if (hit && hit.body === u.body) return hit.range;
    const q = quoteSpans(u.body)[0];
    const off = u.bodyOffset();
    const range: [number, number] | null = q ? [off + q.s, off + q.tail] : null;
    cache.set(u, { body: u.body, range });
    return range;
  };
  const emailSet = new Set(emails);
  const isQuoted = (unit: Unit, tok: Tok) => {
    if (!emailSet.has(unit)) return false;
    const r = quotedRange(unit);
    return !!r && tok.s >= r[0] && tok.e <= r[1];
  };
  for (const pass of [1, 2]) {
    const order = pass === 1 ? [...emails].reverse() : emails;
    for (const u of order) {
      const done = new Set<string>();
      for (let guard = 0; guard < 25; guard++) {
        let progressed = false;
        for (const q of quoteSpans(u.body)) {
          for (const [mode, s, e] of [["tail", q.s, q.tail], ["level", q.s, q.e]] as const) {
            if (mode === "level" && q.e >= q.tail) continue; // same as the tail
            const key = `T4:${u.key}:${mode}:${q.header}`;
            if (done.has(key) || ctx.banned.has(key)) continue;
            done.add(key);
            const toks = spanTokens(u, s, e, ctx.index);
            if (!toks.some((w) => w !== BARRIER)) continue;
            const partner = u.partner;
            const allow = hiding(ctx, u, s, e, (x, tok) => x === partner || (pass === 1 && isQuoted(x, tok)));
            const v = judge(toks, ctx.index, allow, null, preferIn(ctx));
            if (!v.ok || v.share < DOMINANCE) continue;
            const src = ctx.doc.units[v.top];
            if (!ctx.edit(u, s, e, { kind: "quoted", target: src }, "T4", "dedupe", "quoted-reply", key, src)) continue;
            if (mode === "tail" && q.sep) {
              const raw = rawTokens(u.body);
              const k = raw.findIndex((r) => r.s === q.sep![0]);
              if (k >= 0 && /^_+$/.test(raw[k].t)) ctx.removeTokens(u, raw, k, k + 1, "T4", "quote-separator", `${key}:sep`);
            }
            progressed = true;
            break;
          }
          if (progressed) break; // offsets moved: re-read the levels
        }
        if (!progressed) break;
      }
    }
  }
}

// =================================================================== T1 ==

/** The same email as activity post AND Emails row: show it once. */
function stageT1Pairs(ctx: Ctx): void {
  const { doc } = ctx;
  for (const p of doc.posts) {
    const r = p.partner;
    if (!p.email || !r || !r.editable) continue;
    const key = `T1:${p.key}`;
    const pb = p.body.trim();
    // a body already cut by the old activity-stream trim: re-point it
    if (OLD_POINTER_RE.test(pb)) {
      ctx.edit(p, 0, p.body.length, { kind: "body", target: r, same: false }, "T1", "pattern", "pointer-rewrite", `${key}:ptr`);
      continue;
    }
    // the activity stream never loaded this body
    if (/^Loading last reply\.*$/i.test(pb)) {
      ctx.edit(p, 0, p.body.length, { kind: "body", target: r, same: false }, "T1", "pattern", "not-loaded-placeholder", `${key}:ph`);
      continue;
    }
    if (r.body.trim() === LIFECYCLE_ROW_BODY) continue;
    // both copies are already the same marker
    if (isWhollyMarker(p.body) && isWhollyMarker(r.body)) {
      if (!ctx.banned.has(key)) ctx.edit(p, 0, p.body.length, { kind: "body", target: r, same: false }, "T1", "dedupe", "duplicate-body", key, r);
      continue;
    }
    if (isWhollyMarker(r.body) || isWhollyMarker(p.body)) continue;
    const ix = ctx.index;
    const pi = unitIndex(ctx, p);
    const ri = unitIndex(ctx, r);
    // A: point the post at the row, up to the last word the row also has (a
    //    row cut off by its preview leaves the post's remainder visible), and
    //    on over any following words that are also elsewhere in the bundle.
    // (each variant has its own key: if the final re-check rejects the
    // extended prefix, the next round falls back to the plain one)
    let saveA = 0;
    let endA = 0;
    let keyA = "";
    {
      const pt = bodyToks(p);
      const words = dropCutWord(pt.map((t) => t.w), p.body, ix);
      const v0 = judge(words, ix, hiding(ctx, p, 0, p.body.length), ri);
      let lastAligned = -1;
      v0.alignedAt.forEach((a, q) => {
        if (a) lastAligned = q;
      });
      let last = lastAligned;
      while (last >= 0 && last + 1 < words.length && (words[last + 1] === BARRIER || v0.coveredAt[last + 1])) last++;
      const variants: [number, string][] =
        last > lastAligned ? [[last, `${key}:A-extended`], [lastAligned, `${key}:A`]] : [[lastAligned, `${key}:A`]];
      for (const [end, k] of variants) {
        if (end < 0 || ctx.banned.has(k)) continue;
        const prefix = words.slice(0, end + 1);
        const v = judge(prefix, ix, hiding(ctx, p, 0, pt[end].e), ri);
        const n = prefix.filter((w) => w !== BARRIER).length;
        if (v.ok && v.share >= DOMINANCE && n >= 6) {
          endA = end === words.length - 1 ? p.body.length : pt[end].e;
          saveA = endA;
          keyA = k;
          break;
        }
      }
    }
    // B: point the row at the post (only when the whole row is covered)
    let saveB = 0;
    if (!ctx.banned.has(`${key}:B`)) {
      const v = judge(dropCutWord(bodyToks(r).map((t) => t.w), r.body, ix), ix, hiding(ctx, r, 0, r.body.length), pi);
      if (v.ok && v.share >= DOMINANCE) saveB = r.body.length;
    }
    // A keeps the Emails row, the faithful copy (the activity stream drops
    // repeated text). It is preferred unless B saves clearly more; for a
    // notification it is always preferred, so its comments are reduced once.
    const notification = isNotification(r) || isNotification(p);
    if (saveA && (notification || !saveB || saveB <= 1.3 * saveA)) {
      ctx.edit(p, 0, endA, { kind: "body", target: r, same: false }, "T1", "dedupe", "duplicate-body", keyA, r);
    } else if (saveB) {
      ctx.edit(r, 0, r.body.length, { kind: "body", target: p, same: false }, "T1", "dedupe", "duplicate-body", `${key}:B`, p);
    }
  }
}

/** Any email body still shown whose text is already in the bundle: a received
 *  email that is also its "##### EMAIL #####" comment, two emails with the
 *  same text, a notification whose comments are all shown elsewhere. */
function stageT1Elsewhere(ctx: Ctx): void {
  const { doc } = ctx;
  for (const u of doc.units) {
    if (!isEmailBody(u) || isWhollyMarker(u.body) || u.body.trim() === LIFECYCLE_ROW_BODY) continue;
    const key = `T1x:${u.key}`;
    if (ctx.banned.has(key)) continue;
    if (u.body.replace(PH_ALL, "").trim().length < 80) continue;
    const toks = spanTokens(u, 0, u.body.length, ctx.index);
    const v = judge(toks, ctx.index, hiding(ctx, u, 0, u.body.length), null, preferIn(ctx));
    if (!v.ok || v.share < DOMINANCE || v.n < 8) continue;
    const src = doc.units[v.top];
    ctx.edit(u, 0, u.body.length, { kind: "body", target: src, same: true }, "T1", "dedupe", "body-shown-elsewhere", key, src);
  }
}

// =================================================================== T2 ==

interface Entry {
  hs: number;
  textStart: number;
  e: number;
  ts: string;
}

/** A replayed comment's header: "2026-09-25 04:44:47 PDT - Name ...". Not
 *  the signature's "Next scheduled shift: <ts> UTC - <ts> UTC". */
const ENTRY_RE = /(?<!shift: )\b(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ([A-Z]{2,4}) - (?!\d{4}-\d\d-\d\d)/g;
const TITLE_RE =
  /((?:[A-Z][\p{L}'.-]+ ){1,4})(?:(?:Senior|Sr\.?|Lead|Principal|Staff) )?(?:Technical Services (?:Associate|Engineer)(?: Representative)?|Technical Services Engineer, Field Support|Technical Support Engineer|Support Dispatch Management|Field Support Engineer|Field Support|Escalation Engineer|Support Engineer|RMA Admin)\s*$/u;

/** Start of the signature trailer ("Name / Title / Next scheduled shift: ..."). */
function trailerStart(body: string, from: number): number {
  const p = body.lastIndexOf("Next scheduled shift:");
  if (p < from) return tailEnd(body, from);
  if (body.slice(from, p).includes(" / ")) {
    let q = p;
    for (let t = 0; t < 2; t++) {
      if (body.slice(q - 3, q) !== " / ") break;
      const prev = body.lastIndexOf(" / ", q - 4);
      const segStart = prev < from ? from : prev + 3;
      const seg = body.slice(segStart, q - 3).trim();
      if (!seg || seg.length > 60 || /[\d@]|http|\u0001/.test(seg)) break;
      q = segStart;
    }
    return q;
  }
  const m = TITLE_RE.exec(body.slice(from, p).trimEnd());
  return m ? from + m.index : p;
}

function parseNotification(body: string): { entries: Entry[]; summary: [number, number] | null } {
  const entries: Entry[] = [];
  const c = body.search(/\bComments:(?=\s)/);
  if (c >= 0) {
    const re = new RegExp(ENTRY_RE.source, "g");
    re.lastIndex = c;
    const heads: { hs: number; after: number; ts: string }[] = [];
    for (let m = re.exec(body); m; m = re.exec(body)) heads.push({ hs: m.index, after: m.index + m[0].length, ts: `${m[1]} ${m[2]}` });
    heads.forEach((h, k) => {
      const look = body.slice(h.after, h.after + 100);
      const lab = /\b(?:Additional comments|Work notes)\b/.exec(look);
      let textStart = lab ? h.after + lab.index + lab[0].length : h.after;
      while (textStart < body.length && /[\s/]/.test(body[textStart])) textStart++;
      let e = k + 1 < heads.length ? heads[k + 1].hs : trailerStart(body, textStart);
      while (e > textStart && /[\s/]/.test(body[e - 1])) e--;
      if (e > textStart) entries.push({ hs: h.hs, textStart, e, ts: h.ts });
    });
  }
  let summary: [number, number] | null = null;
  const sm = /\bCase Resolution Summary:\s*/.exec(body);
  if (sm) {
    const s = sm.index + sm[0].length;
    let e = trailerStart(body, s);
    while (e > s && /[\s/]/.test(body[e - 1])) e--;
    if (e > s) summary = [s, e];
  }
  return { entries, summary };
}

function stageT2(ctx: Ctx): void {
  const notifs = ctx.doc.units.filter((u) => isEmailBody(u) && isNotification(u));
  const notifSet = new Set(notifs);
  // history ranges (index-text coordinates) per unit, cached per body text
  const cache = new Map<Unit, { body: string; ranges: [number, number][] }>();
  const historyRanges = (u: Unit): [number, number][] => {
    const hit = cache.get(u);
    if (hit && hit.body === u.body) return hit.ranges;
    const off = u.bodyOffset();
    const ranges = parseNotification(u.body).entries.slice(1).map((x): [number, number] => [off + x.hs, off + x.e]);
    cache.set(u, { body: u.body, ranges });
    return ranges;
  };
  const isHistoryTok = (unit: Unit, tok: Tok) =>
    notifSet.has(unit) && historyRanges(unit).some(([s, e]) => tok.s >= s && tok.e <= e);
  const prefer = preferIn(ctx);

  // B. the newest comment of each notification, and the resolution summary
  for (const u of notifs) {
    const { entries, summary } = parseNotification(u.body);
    const jobs: { s: number; e: number; key: string; data: (src: Unit) => MarkerData; rule: string }[] = [];
    if (entries[0]) {
      jobs.push({
        s: entries[0].textStart, e: entries[0].e, key: `T2c:${u.key}:${entries[0].ts}`,
        data: (t) => ({ kind: "comment", target: t }), rule: "newest-comment",
      });
    }
    if (summary) {
      jobs.push({
        s: summary[0], e: summary[1], key: `T2s:${u.key}`,
        data: (t) => ({ kind: "summary", target: t }), rule: "resolution-summary",
      });
    }
    for (const j of jobs.sort((a, b) => b.s - a.s)) {
      if (ctx.banned.has(j.key)) continue;
      const toks = spanTokens(u, j.s, j.e, ctx.index);
      const allow = hiding(ctx, u, j.s, j.e, (x, tok) => x === u.partner || isHistoryTok(x, tok));
      const v = judge(toks, ctx.index, allow, null, prefer);
      if (!v.ok || v.share < DOMINANCE) continue;
      const src = ctx.doc.units[v.top];
      ctx.edit(u, j.s, j.e, j.data(src), "T2", "dedupe", j.rule, j.key, src);
    }
  }

  // A. earlier comments replayed under "Comments:". Pass 1 accepts only copies
  // found outside any replayed history; pass 2 de-duplicates comments older
  // than everything else in the bundle, keeping one copy.
  for (const pass of [1, 2]) {
    for (const u of notifs) {
      const entries = parseNotification(u.body).entries.slice(1);
      const accepted: { k: number; src: Unit; key: string }[] = [];
      for (let k = 0; k < entries.length; k++) {
        const x = entries[k];
        const key = `T2h:${u.key}:${x.ts}`;
        if (ctx.banned.has(key)) continue;
        const off = u.bodyOffset();
        const mine = (tok: Tok) =>
          accepted.some((a) => tok.s >= off + entries[a.k].hs && tok.e <= off + entries[a.k].e);
        const allow = hiding(ctx, u, x.hs, x.e, (unit, tok) =>
          unit === u.partner || (unit === u && mine(tok)) || (pass === 1 && isHistoryTok(unit, tok)));
        const htoks = spanTokens(u, x.hs, x.e, ctx.index);
        const v = judge(htoks, ctx.index, allow, null, prefer);
        if (v.ok && v.share >= DOMINANCE) accepted.push({ k, src: ctx.doc.units[v.top], key });
      }
      // consecutive accepted entries share one marker
      const groups: { s: number; e: number; srcs: Unit[]; keys: string[]; last: number }[] = [];
      for (const a of accepted) {
        const g = groups[groups.length - 1];
        if (g && g.last === a.k - 1) {
          g.e = entries[a.k].e;
          g.last = a.k;
          if (!g.srcs.includes(a.src)) g.srcs.push(a.src);
          g.keys.push(a.key);
        } else groups.push({ s: entries[a.k].hs, e: entries[a.k].e, srcs: [a.src], keys: [a.key], last: a.k });
      }
      for (const g of groups.reverse()) {
        // a history marker left right next to this group by pass 1 joins it,
        // so a reader sees one "[N earlier comments ...]" instead of two
        let { s, e } = g;
        let count = g.keys.length;
        const srcs = [...g.srcs];
        const absorb = (id: string | undefined, at: number, len: number, side: "before" | "after") => {
          const mk = id ? ctx.markers.get(Number(id)) : undefined;
          if (!mk || mk.data.kind !== "history") return;
          count += mk.data.count;
          for (const t of mk.data.targets) if (!srcs.includes(t)) (side === "before" ? srcs.unshift(t) : srcs.push(t));
          if (side === "before") s = at;
          else e = at + len;
        };
        const before = /\u0001(\d+)\u0002[\s/]*$/.exec(u.body.slice(0, s));
        if (before) absorb(before[1], before.index, before[0].length, "before");
        const after = /^[\s/]*\u0001(\d+)\u0002/.exec(u.body.slice(e));
        if (after) absorb(after[1], e, after[0].length, "after");
        ctx.edit(u, s, e, { kind: "history", count, targets: srcs }, "T2", "dedupe",
          "comment-history", g.keys.join(KEY_JOIN), srcs[0]);
      }
    }
  }
}

// =================================================================== T9 ==

const T9_MIN_RUN = 25;

/** Tokens of a Details-form unit's own "Label:" (a T9 run must not eat it). */
function labelToks(u: Unit): number {
  if (u.kind !== "static" || !u.key.startsWith("details:")) return 0;
  const first = u.text().split("\n")[0];
  const m = /^([^:]{1,60}):/.exec(first);
  return m ? coverageTokens(m[1]).length : 0;
}

function stageT9(ctx: Ctx): void {
  const { doc } = ctx;
  const labels = new Map<number, number>();
  doc.units.forEach((u, i) => labels.set(i, labelToks(u)));
  for (const u of doc.posts) {
    if (u.postType !== "Field changes" || !u.editable) continue;
    const ui0 = unitIndex(ctx, u);
    const ix = ctx.index;
    const toks = ix.toks[ui0];
    const off = u.bodyOffset();
    const first = toks.findIndex((t) => t.s >= off);
    if (first < 0) continue;
    const planned: { a: number; b: number; src: number }[] = [];
    let k = first;
    while (k < toks.length) {
      if (toks[k].w === BARRIER || k + 2 >= toks.length) {
        k++;
        continue;
      }
      // longest run starting here, from text BEFORE this point in reading order
      let best = 0;
      let bestU = -1;
      for (const code of ix.tri.get(`${toks[k].w}\u0003${toks[k + 1].w}\u0003${toks[k + 2].w}`) ?? []) {
        const vu = Math.floor(code / 1_000_000);
        const vi = code % 1_000_000;
        const before = vu < ui0 || (vu === ui0 && vi < k && !planned.some((p) => vi >= p.a && vi < p.b));
        if (!before || vi < (labels.get(vu) ?? 0)) continue;
        const vt = ix.toks[vu];
        let L = 0;
        while (k + L < toks.length && vi + L < vt.length && vt[vi + L].w === toks[k + L].w && toks[k + L].w !== BARRIER && (vu !== ui0 || vi + L < k)) L++;
        if (L > best) {
          best = L;
          bestU = vu;
        }
      }
      if (best >= T9_MIN_RUN) {
        planned.push({ a: k, b: k + best, src: bestU });
        k += best;
      } else k++;
    }
    // adjacent runs from the same place become one marker
    const merged: { a: number; b: number; src: number }[] = [];
    for (const p of planned) {
      const prev = merged[merged.length - 1];
      if (prev && prev.src === p.src && prev.b === p.a) prev.b = p.b;
      else merged.push({ ...p });
    }
    for (const p of merged.reverse()) {
      const key = `T9:${u.key}:${toks[p.a].s}`;
      if (ctx.banned.has(key)) continue;
      const src = p.src === ui0 ? null : doc.units[p.src];
      ctx.edit(u, toks[p.a].s - off, toks[p.b - 1].e - off, { kind: "same", target: src ?? u }, "T9", "dedupe", "repeated-field-text", key, src ?? u);
    }
  }
}

// ============================================================= rendering ==

function finalTarget(ctx: Ctx, u: Unit, seen = new Set<Unit>()): Unit {
  if (seen.has(u)) return u;
  seen.add(u);
  const id = u.kind === "static" ? 0 : isWhollyMarker(u.body);
  const m = id ? ctx.markers.get(id) : undefined;
  if (m && m.data.kind === "body") return finalTarget(ctx, m.data.target, seen);
  return u;
}

function renderMarker(ctx: Ctx, m: Marker): string {
  const d = m.data;
  const name = (u: Unit | null) => (u ? finalTarget(ctx, u).label : "earlier in this post");
  switch (d.kind) {
    case "text":
      return d.text;
    case "body":
      return d.same ? `[body: same text as ${name(d.target)}]` : `[body: see ${name(d.target)}]`;
    case "comment":
      return `[comment text: see ${name(d.target)}]`;
    case "history": {
      const where = [...new Set(d.targets.map((t) => name(t)))].join("; ");
      return `[${d.count} earlier comment${d.count > 1 ? "s" : ""}, already in this bundle: see ${where}]`;
    }
    case "summary":
      return `[resolution summary: same text as ${name(d.target)}]`;
    case "quoted":
      return `[quoted text: see ${name(d.target)}]`;
    case "same":
      return d.target && d.target === m.host ? "[same text as earlier in this post]" : `[same text as ${name(d.target)}]`;
  }
}

function render(s: string, rendered: Map<number, string>): string {
  return s.replace(PH_ALL, (_, id: string) => rendered.get(Number(id)) ?? "");
}

// ================================================================= main ==

const LEGEND =
  "Compacted: repeated text is shown once; a marker such as [body: see Emails row 3] says where it is. " +
  "Support footers, banners and disclaimers are removed.";

function runPatternStages(ctx: Ctx): void {
  const { doc } = ctx;
  applyT8(ctx);
  for (const u of doc.units) if (isEmailBody(u)) applyT10(ctx, u);
  for (const u of doc.units) if (isEmailBody(u)) applyT3(ctx, u);
  for (const u of doc.units) {
    if (isEmailBody(u) || (u.kind === "post" && u.postType === "Additional comments")) applyT5(ctx, u);
  }
  markNotifications(doc);
  for (const u of doc.units) if (isEmailBody(u)) applyT5Templates(ctx, u);
  for (const u of doc.posts) {
    if (isEmailBody(u)) continue;
    // a comment is often an email posted as text ("##### EMAIL #####")
    if (u.postType === "Additional comments") applyMarkupTokens(ctx, u);
    applyUiChrome(ctx, u);
  }
  applyConstantColumns(ctx, doc.erows, doc.emailRowsLine, "T6", (l) => EMAIL_KEEP_COLS.has(l));
  applyConstantColumns(ctx, doc.srows, doc.slaRowsLine, "T7", (l) => SLA_KEEP_COLUMN.test(l));
}

/** Order matters: quoted tails first (they are the weakest copies), then the
 *  post/row pairs (so a notification is reduced once, in its Emails row),
 *  then the comment replays inside what is left, then whole bodies that are
 *  shown elsewhere, then Field changes. */
function runDedupeStages(ctx: Ctx): void {
  stageT4(ctx);
  stageT1Pairs(ctx);
  stageT2(ctx);
  stageT1Elsewhere(ctx);
  stageT9(ctx);
}

/** Expand a removed span: inner dedupe markers become the text they replaced
 *  (forCover) or that text too (forLog); pattern markers become nothing
 *  (forCover) or their rendered text (forLog). */
function expand(raw: string, byMarker: Map<number, PendingEdit>, rendered: Map<number, string>, forCover: boolean): string {
  return raw.replace(PH_ALL, (_, id: string) => {
    const e = byMarker.get(Number(id));
    if (e && e.kind === "dedupe") return expand(e.removedRaw, byMarker, rendered, forCover);
    return forCover ? ` ${PH_OPEN}0${PH_CLOSE} ` : rendered.get(Number(id)) ?? "";
  });
}

export function compactBundle(bundle: string): CompactResult {
  const input = bundle.replace(/\r\n/g, "\n");
  if (!input.split("\n").some((l) => HEADER_RE.test(l))) {
    // not an assembled bundle (e.g. a sign-in failure): leave it exactly as is
    return { text: input, stats: { chars_in: input.length, chars_out: input.length }, edits: [] };
  }
  const banned = new Set<string>();
  let rounds = 0;
  let restored = 0;
  // Every round bans at least one key that was applied (and so not banned
  // before), so the loop ends. Past MAX_ROUNDS, dedupe is switched off
  // entirely: the pattern-only result needs no coverage proof.
  let noDedupe = false;
  for (;;) {
    rounds++;
    const doc = parseDoc(input);
    const ctx = new Ctx(doc, banned);
    runPatternStages(ctx);
    const patternEdits = ctx.edits.length;
    pairEmails(doc);
    if (!noDedupe) runDedupeStages(ctx);

    // ----- render markers (after every stage, so pointers can follow chains)
    const rendered = new Map<number, string>();
    for (const m of ctx.markers.values()) rendered.set(m.id, renderMarker(ctx, m));
    const byMarker = new Map<number, PendingEdit>();
    for (const e of ctx.edits) if (e.markerId) byMarker.set(e.markerId, e);
    // a dedupe edit whose marker sits inside a later removal is subsumed by it
    const live = new Set<number>();
    for (const u of doc.units) {
      if (u.kind === "static") continue;
      for (const m of u.text().matchAll(PH_ALL)) live.add(Number(m[1]));
    }

    // ----- verify every surviving dedupe removal against the FINAL text
    const finalIx = new Index(doc.units);
    const failed: string[] = [];
    const dedupe = ctx.edits.slice(patternEdits).filter((e) => e.kind === "dedupe" && live.has(e.markerId));
    let verifiedWords = 0;
    let weakWords = 0;
    for (const e of dedupe) {
      const removedText = expand(e.removedRaw, byMarker, rendered, true);
      const toks = dropCutWord(coverageTokens(removedText).map((t) => t.w), removedText, finalIx);
      const target = e.source ? finalIx.units.indexOf(finalTarget(ctx, e.source)) : -1;
      const v = judge(toks, finalIx, () => true, target >= 0 ? target : null);
      verifiedWords += v.n;
      weakWords += v.weak;
      if (!v.ok) failed.push(e.key);
    }
    if (failed.length) {
      for (const k of failed) for (const part of k.split(KEY_JOIN)) banned.add(part);
      restored += failed.length;
      if (rounds >= MAX_ROUNDS) noDedupe = true;
      continue;
    }

    // ----- assemble
    for (const u of doc.units) if (u.line) u.line.text = render(u.text(), rendered);
    const withLegend =
      ctx.edits.length > 0 && /^Read-only\./.test(doc.lines[1]?.text ?? "") && doc.lines[2]?.text !== LEGEND;
    const linesOut: string[] = [];
    doc.lines.forEach((l, i) => {
      if (!l.deleted) linesOut.push(l.text);
      if (l.after) linesOut.push(...l.after);
      if (i === 1 && withLegend) linesOut.push(LEGEND);
    });
    const text = linesOut.join("\n");

    // ----- the audit log: pattern edits as applied, dedupe edits outermost only
    const edits: CompactEdit[] = [];
    for (const e of ctx.edits) {
      if (e.kind === "dedupe" && !live.has(e.markerId)) continue; // subsumed by a later removal
      edits.push({
        t: e.t,
        kind: e.kind,
        rule: e.rule,
        where: e.where,
        removed: e.kind === "dedupe" ? expand(e.removedRaw, byMarker, rendered, false) : render(e.removedRaw, rendered),
        inserted: render(e.insertedRaw, rendered),
        ...(e.source ? { source: finalTarget(ctx, e.source).label } : {}),
      });
    }
    if (withLegend) edits.push({ t: "T1", kind: "pattern", rule: "legend", where: "preamble", removed: "", inserted: LEGEND });

    // ----- stats: per-transform savings, measured edit by edit
    const stats: Record<string, number> = { chars_in: input.length, chars_out: text.length };
    for (const t of TRANSFORMS) {
      stats[`${t}_chars`] = 0;
      stats[`${t}_edits`] = 0;
    }
    for (const e of ctx.edits) {
      stats[`${e.t}_chars`] += render(e.removedRaw, rendered).length - render(e.insertedRaw, rendered).length;
      stats[`${e.t}_edits`] += 1;
    }
    stats.legend_chars = withLegend ? LEGEND.length + 1 : 0;
    stats.dedupe_spans_verified = dedupe.length;
    stats.dedupe_words_verified = verifiedWords;
    stats.dedupe_words_weak = weakWords;
    stats.dedupe_spans_restored = restored;
    stats.rounds = rounds;
    return { text, stats, edits };
  }
}

export function compactBundleText(bundle: string): { text: string; stats: Record<string, number> } {
  const { text, stats } = compactBundle(bundle);
  return { text, stats };
}
