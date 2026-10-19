#!/usr/bin/env node
// Offline check of the bundle compaction (src/compact.ts -> dist/compact.js).
//
//   node scripts/compact-check.mjs [IN_DIR] [OUT_DIR]
//
// Runs compactBundle over every *.txt bundle in IN_DIR, writes the compacted
// text (and its edit log) to OUT_DIR, prints per-case sizes, per-transform
// savings and per-section sizes, and checks every invariant. Exits 1 on any
// violation. No browser, no network: it only reads and writes files.
//
// The checks are deliberately independent of the module's own bookkeeping:
// sections, posts and rows are re-parsed here, coverage of removed text is
// re-computed here, and the edit log must account for every word of the
// difference between input and output.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";

const mod = await import(new URL("../dist/compact.js", import.meta.url));
const { compactBundle, compactBundleText, BOILERPLATE } = mod;
// The server returns a bundle over PART_LIMIT chars in parts (bundle.ts).
const { splitBundle, PART_LIMIT } = await import(new URL("../dist/bundle.js", import.meta.url));

const DEFAULT_IN =
  "D:/Users/jsalas/AppData/Local/Temp/claude/D--Users-jsalas-Desktop-AI-project-QA-Form-AI/" +
  "1a16d37d-ec03-46a7-89e1-bad07ade1c18/scratchpad/bundles-v1";
const inDir = (process.argv[2] ?? DEFAULT_IN).replace(/[\\/]+$/, "");
const outDir = process.argv[3] ?? join(dirname(inDir), `${basename(inDir)}-compacted`);
const TARGET = 30_000;
const TRANSFORMS = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10"];

// ------------------------------------------------------------- parsing --

const HEADER = /^=== (.+) — STATUS: (.*) ===$/;

function sections(text) {
  const lines = text.split("\n");
  const out = [];
  let cur = { name: "(preamble)", status: "", lines: [] };
  for (const l of lines) {
    const m = HEADER.exec(l);
    if (m) {
      out.push(cur);
      cur = { name: m[1], status: m[2], header: l, lines: [l] };
    } else cur.lines.push(l);
  }
  out.push(cur);
  for (const s of out) s.text = s.lines.join("\n");
  return out;
}

function posts(text) {
  const map = new Map();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const m = /^--- post (\d+) ---$/.exec(lines[i]);
    if (m) map.set(Number(m[1]), lines[i + 1]);
  }
  return map;
}

/** The numbered rows of a panel section: only the "Rows (N):" block (the
 *  "Openable records" list that may follow is numbered too and is NOT rows). */
function rowsOf(sectionText) {
  const map = new Map();
  const lines = sectionText.split("\n");
  let i = lines.findIndex((l) => /^Rows \(\d+\):$/.test(l));
  if (i < 0) return map;
  i++;
  if (lines[i]?.startsWith("(same on every row, shown once: ")) i++;
  for (; i < lines.length; i++) {
    const m = /^(\d+)\. (.*)$/.exec(lines[i]);
    if (!m) break;
    map.set(Number(m[1]), lines[i]);
  }
  return map;
}

const POST_HEAD = /^(.*?) (Email sent|Email received|Additional comments|Work notes|Field changes|Remote Assist Logs|Logs|Attachment|Image) (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/;

/** The header of an email post that must survive verbatim: author, type,
 *  date, Subject, From, To and Cc, up to " Show less" / the old pointer. */
function emailHeader(post) {
  if (!/ Email (?:sent|received) \d{4}-\d\d-\d\d \d\d:\d\d:\d\d Subject /.test(post)) return null;
  const sl = post.indexOf(" Show less");
  if (sl >= 0) return post.slice(0, sl + " Show less".length);
  const ptr = post.search(/ \[… full text: Emails section, row \d+\]$/);
  return ptr >= 0 ? post.slice(0, ptr) : post;
}

function cellValue(row, label) {
  const re = new RegExp(`(?:^\\d+\\. | \\| )${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (.*?)(?= \\| [A-Z][A-Za-z ()#/-]{0,40}: |$)`);
  return re.exec(row)?.[1];
}

const RUBRIC_SLA = ["Target", "Stage", "Business elapsed percentage", "SLA definition", "Business elapsed time",
  "Business time left", "Start time", "Stop time"];
const SLA_TIMEISH = /time|elapsed|left|stage|breach|pause|target|percentage|definition|duration|created|start|stop|end|due|schedule/i;
const EMAIL_META = ["Created", "Type", "Recipients", "Subject", "User ID"];

function slaLabels(row) {
  return [...row.matchAll(/(?:^\d+\. | \| )([A-Z][A-Za-z ()#/-]{0,40}?): /g)].map((m) => m[1]);
}

// ----------------------------------------------------------- coverage --
// Independent re-implementation: a removed span is covered when its words
// align in order with the unit its pointer names (runs of 2+ words), and every
// remaining word sits in a run of 4+ words found anywhere in the output (a few
// shorter runs are tolerated, as in the module).

const TOKEN_RE =
  /\u0000|<(?:https?|mailto|tel):[^>\s]*>|<\+[\d%]+>|<\s?[^<>\s@]+@[^<>\s]+\s?>|\[cid:[^\]\s]*\]|[\p{L}\p{N}](?:[\p{L}\p{N}@._%+\-'’&/:#]*[\p{L}\p{N}])?/giu;
const BAR = "\u0000";

function words(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = m[0];
    if (t === BAR) out.push(BAR);
    else if (t[0] === "<" && t.includes("@") && !/^<(?:mailto|https?):/i.test(t)) {
      // "<a@b.c>" right after a@b.c is the mail client repeating the address
      const addr = t.replace(/^<\s?/, "").replace(/\s?>$/, "").toLowerCase();
      if (out[out.length - 1] !== addr) out.push(addr);
    } else if (t[0] !== "<" && t[0] !== "[") out.push(t.toLowerCase().replace(/’/g, "'"));
  }
  return out;
}

function indexWords(ws) {
  const tri = new Map();
  for (let i = 0; i + 2 < ws.length; i++) {
    if (ws[i] === BAR || ws[i + 1] === BAR || ws[i + 2] === BAR) continue;
    const k = `${ws[i]} ${ws[i + 1]} ${ws[i + 2]}`;
    const a = tri.get(k);
    if (a) a.push(i);
    else tri.set(k, [i]);
  }
  const uni = new Map();
  ws.forEach((w, i) => {
    if (w === BAR) return;
    const a = uni.get(w);
    if (a) a.push(i);
    else uni.set(w, [i]);
  });
  return { ws, tri, uni };
}

function lcsAligned(span, src) {
  const n = span.length;
  const out = new Array(n).fill(false);
  const m = src.length;
  if (!n || !m || n * m > 8_000_000) return out;
  const W = m + 1;
  const L = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const k = i * W + j;
      if (span[i] !== BAR && span[i] === src[j]) L[k] = L[(i + 1) * W + j + 1] + 1;
      else L[k] = Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (span[i] !== BAR && span[i] === src[j] && L[i * W + j] === L[(i + 1) * W + j + 1] + 1) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++;
    else j++;
  }
  for (let k = 0; k < pairs.length; ) {
    let e = k + 1;
    while (e < pairs.length && pairs[e][0] === pairs[e - 1][0] + 1 && pairs[e][1] === pairs[e - 1][1] + 1) e++;
    if (e - k >= 2 || n === 1) for (let q = k; q < e; q++) out[pairs[q][0]] = true;
    k = e;
  }
  return out;
}

const VERBOSE = process.env.COMPACT_CHECK_VERBOSE === "1";

function coverage(span, ix, sourceWords) {
  const aligned = sourceWords ? lcsAligned(span, sourceWords) : span.map(() => false);
  const misses = [];
  let n = 0;
  let uncovered = 0;
  let weak = 0;
  let long = 0;
  for (let q = 0; q < span.length; q++) if (span[q] !== BAR) n++;
  for (let q = 0; q < span.length; q++) if (aligned[q]) long++;
  let i = 0;
  while (i < span.length) {
    if (aligned[i] || span[i] === BAR) {
      i++;
      continue;
    }
    let segEnd = i;
    while (segEnd < span.length && !aligned[segEnd] && span[segEnd] !== BAR) segEnd++;
    const seg = segEnd - i;
    let j = i;
    while (j < segEnd) {
      let best = 0;
      const cands = segEnd - j >= 3 ? ix.tri.get(`${span[j]} ${span[j + 1]} ${span[j + 2]}`) : ix.uni.get(span[j]);
      for (const p of cands ?? ix.uni.get(span[j]) ?? []) {
        let L = 0;
        while (j + L < segEnd && p + L < ix.ws.length && ix.ws[p + L] === span[j + L]) L++;
        if (L > best) best = L;
      }
      if (best < 3 && segEnd - j >= 3) {
        for (const p of ix.uni.get(span[j]) ?? []) {
          let L = 0;
          while (j + L < segEnd && p + L < ix.ws.length && ix.ws[p + L] === span[j + L]) L++;
          if (L > best) best = L;
        }
      }
      if (!best) {
        uncovered++;
        if (VERBOSE) misses.push(`missing "${span[j]}"`);
        j++;
        continue;
      }
      if (best >= 8) long += best;
      if (!(best >= 4 || best === seg)) {
        weak += best;
        if (VERBOSE) misses.push(`short run "${span.slice(j, j + best).join(" ")}"`);
      }
      j += best;
    }
    i = segEnd;
  }
  const allowance = n <= 3 ? 0 : Math.min(4, Math.max(1, Math.floor(n * 0.15)));
  return { n, uncovered, weak, long, ok: uncovered === 0 && weak <= allowance, misses };
}

// ------------------------------------------------- pattern validation --

function normWord(t) {
  return t
    .replace(/<(?:https?|mailto|tel):[^>]*>|<\+[\d%]+>|<[^<>\s@]+@[^<>\s]+>/gi, "")
    .replace(/\[cid:[^\]]*\]/gi, "")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

const PHRASES = BOILERPLATE.flatMap((b) =>
  b.phrases.map((p) => ({
    id: b.id,
    items: [...p.matchAll(/\{([^}]*)\}|(\S+)/g)]
      .map((m) =>
        m[1] !== undefined
          ? { words: m[1].split(/\s+/).map(normWord).filter(Boolean), opt: true }
          : { words: [normWord(m[2])].filter(Boolean), opt: false },
      )
      .filter((it) => it.words.length),
  })),
);

/** Does `text` consist of exactly one boilerplate phrase (or, when `prefix`,
 *  a cut-off start of one, at least 5 words)? Word-by-word, optional groups
 *  may be absent; nothing else may be present. */
function isBoilerplate(text, id, prefix) {
  const ws = text.split(/\s+/).map(normWord).filter(Boolean);
  for (const p of PHRASES.filter((x) => x.id === id)) {
    const rec = (k, j, matched) => {
      if (j === ws.length) {
        // text exhausted: a full match if only optional words remain
        if (p.items.slice(k).every((it) => it.opt)) return true;
        return prefix && matched >= 5;
      }
      if (k === p.items.length) return false;
      const it = p.items[k];
      let jj = j;
      let m = matched;
      let ok = true;
      for (const w of it.words) {
        if (jj === ws.length) return prefix && m >= 5;
        if (ws[jj] === w || (prefix && jj === ws.length - 1 && w.startsWith(ws[jj]) && m >= 5)) {
          jj++;
          m++;
        } else {
          ok = false;
          break;
        }
      }
      if (ok && rec(k + 1, jj, m)) return true;
      return it.opt ? rec(k + 1, j, matched) : false;
    };
    if (rec(0, 0, 0)) return true;
  }
  return false;
}

const MARKER_RE =
  /^\[(?:body: (?:see|same text as) .+|comment text: see .+|\d+ earlier comments?, already in this bundle: see .+|resolution summary: same text as .+|quoted text: see .+|same text as .+|auto-reply "engineer currently unavailable": template text omitted|no readable text: this preview held only formatting markup)\]$/;
const STATUS_WORDS = /ACTION NEEDED|Not signed in|\bstopped\b|UNREAD|EMPTY|NOT FOUND|\bpartial\b|declared but NOT readable/;

function validatePattern(e, outText, lineOf) {
  const r = e.removed.trim();
  switch (e.t) {
    case "T5": {
      const core = r.replace(/^\/\s*|\s*\/$/g, "").trim();
      if (e.rule === "notification-preamble" || e.rule === "resolved-greeting") {
        // a template line that only restates the email's own header: every
        // value in it must be the bundle's case number, part of the email's
        // Subject, a name repeated in the same email, or the case contact
        const line = lineOf(e.where) ?? "";
        const subject = /Subject:? (.*?)(?: From | \| Type: )/.exec(line)?.[1] ?? "";
        const caseNo = /^CASE BUNDLE — (CS\d+)/.exec(outText)?.[1];
        const contact = /\n== Header ==\n[\s\S]*?\nContact: (.+)\n/.exec(outText)?.[1];
        // The same email may hold its body in its pair, behind a pointer such as
        // "[body: see Emails row 23]" (a full read pairs every email post with
        // its row); the name may repeat there rather than in this line.
        const pair = /\[body: (?:see|same text as) (?:Emails row (\d+)|activity post (\d+))\]/.exec(line);
        const pairLine = pair ? (lineOf(pair[1] ? `Emails > row ${pair[1]}` : `Case > post ${pair[2]}`) ?? "") : "";
        let m = /^Case (CS\d+) - (.+?) - has a new comment added by(?: (.+?))?$/.exec(core);
        if (e.rule === "notification-preamble" && m && m[1] === caseNo && subject.includes(m[2]) && (!m[3] || line.includes(m[3]) || pairLine.includes(m[3]))) return null;
        m = /^Dear (.+?), Your Pure Storage ticket (CS\d+) - (.+?) - has been resolved\.$/.exec(core);
        if (e.rule === "resolved-greeting" && m && m[2] === caseNo && subject.includes(m[3]) && m[1] === contact) return null;
        return `T5 template line does not check out (${e.rule}): ${core.slice(0, 120)}`;
      }
      const prefix = / \(cut-off copy\)$/.test(e.rule);
      const id = e.rule.replace(/ \(cut-off copy\)$/, "");
      return isBoilerplate(core, id, prefix) ? null : `T5 removal is not boilerplate "${id}": ${core.slice(0, 120)}`;
    }
    case "T3":
      if (!/(?:Subject|Subject:) Engineer .+ is Currently Unavailable\b/.test(lineOf(e.where) ?? "")) {
        return "T3 edit outside an \"is Currently Unavailable\" auto-reply";
      }
      if (/Next scheduled shift: \d{4}/.test(e.removed)) return "T3 removed the engineer's shift line";
      if (!/currently unavailable|24\/7 Support|Ref:MSG|^\s*\/?\s*$/i.test(e.removed)) return `T3 removed non-template text: ${r.slice(0, 120)}`;
      return null;
    case "T6":
    case "T7": {
      if (e.rule === "constant-header") {
        return /^\(same on every row, shown once: .+\)$/.test(e.inserted) && outText.includes(e.inserted) ? null : "constant header missing";
      }
      const m = /^(?:\| )?([A-Z][A-Za-z ()#/-]{0,40}?): (.*?)(?: \|)?$/.exec(r);
      if (!m) return `${e.t} removal is not one cell: ${r.slice(0, 80)}`;
      if (e.t === "T7" && (RUBRIC_SLA.includes(m[1]) || SLA_TIMEISH.test(m[1]))) return `T7 dropped a rubric/time column: ${m[1]}`;
      if (e.t === "T6" && EMAIL_META.includes(m[1])) return `T6 dropped an email metadata column: ${m[1]}`;
      const header = outText.split("\n").filter((l) => l.startsWith("(same on every row, shown once: "));
      return header.some((h) => h.includes(`${m[1]}: ${m[2]}`)) ? null : `${e.t} constant not stated once: ${m[1]}`;
    }
    case "T8": {
      const lines = e.removed.split("\n").filter((l) => l !== "");
      if (!lines[0]?.startsWith("Openable records (use sn_open_record")) return "T8 removed something other than an Openable records block";
      const bad = lines.slice(1).filter((l) => !/^\d+\. /.test(l) && !/^(you mean that exact position|other records, not this panel)/.test(l));
      return bad.length ? `T8 removed a non-link line: ${bad[0].slice(0, 80)}` : null;
    }
    case "T10": {
      const ok = {
        "unclosed-comment": () => /<!--/.test(e.removed) && !/-->/.test(e.removed),
        "truncated-tag": () => /<[A-Za-z!/][^<>]*(?:\.\.\.)?$/.test(e.removed) && e.removed.replace(/<[A-Za-z!/][^<>]*(?:\.\.\.)?$/, "").trim() === e.inserted.replace(/\s*\.\.\.$/, "").trim(),
        "truncated-entity": () => /&[#\w]{1,10}(?:\.\.\.)?$/.test(e.removed),
        "image-reference": () => /^(?:\/\s*)?\[cid:[^\]\s]*\](?:<[^>\s]*>)*(?:\s*\/)?$/i.test(r),
        "zero-width": () => /^(?:\/\s*)?[\u200b-\u200d\u2060\ufeff]+(?:\s*\/)?$/.test(r),
        "ui-chrome": () => /^(?:Show full conversation|Show less)$/.test(r),
      }[e.rule];
      return ok && ok() ? null : `T10 "${e.rule}" removed unexpected text: ${r.slice(0, 120)}`;
    }
    case "T1":
      if (e.rule === "pointer-rewrite") return /^\[… full text: Emails section, row \d+\]$/.test(r) ? null : "bad T1 pointer rewrite";
      if (e.rule === "not-loaded-placeholder") return /^Loading last reply\.*$/i.test(r) ? null : "bad T1 placeholder";
      if (e.rule === "legend") return e.removed === "" ? null : "legend removed text";
      return `unknown T1 pattern rule ${e.rule}`;
    case "T4":
      return e.rule === "quote-separator" && /^[\s/]*_+[\s/]*$/.test(e.removed) ? null : `bad T4 pattern edit ${e.rule}`;
    default:
      return `pattern edit with unexpected transform ${e.t}`;
  }
}

// -------------------------------------------------------- the checks --

function tokenCounts(text, sign, into) {
  for (const t of text.split(/\s+/)) if (t) into.set(t, (into.get(t) ?? 0) + sign);
}

/** Resolve a pointer label ("Emails row 6", "activity post 12", "the Details
 *  form (Plan of action)", 'the SHI note "X" section') to output text. */
function resolve(label, outText, outSecs, outPosts) {
  let m = /^activity post (\d+)$/.exec(label);
  if (m) return outPosts.get(Number(m[1])) ?? null;
  m = /^(Emails|SLAs) row (\d+)$/.exec(label);
  if (m) return rowsOf(outSecs.find((s) => s.name === m[1])?.text ?? "").get(Number(m[2])) ?? null;
  if (label.startsWith("the Details form")) {
    const c = outSecs.find((s) => s.name === "Case")?.text ?? "";
    const d = /== Details form ==\n([\s\S]*?)(?=\n== )/.exec(c);
    return d ? d[1] : null;
  }
  m = /^the (.+) section$/.exec(label);
  if (m) return outSecs.find((s) => s.name === m[1])?.text ?? null;
  if (label === "the bundle preamble") return outSecs[0].text;
  return null;
}

function checkCase(file, input, r) {
  const v = [];
  const out = r.text;
  const inSecs = sections(input);
  const outSecs = sections(out);

  if (compactBundleText(input).text !== out) v.push("compactBundleText and compactBundle disagree");
  // size: what the tool returns is the parts; every part must fit, and the
  // parts together must still hold every line of the compacted bundle
  const parts = splitBundle(out, "\n[bundle finished in 0s]", /^CASE BUNDLE — (CS\d+)/.exec(out)?.[1] ?? "CS?");
  parts.forEach((p, i) => {
    if (p.length > PART_LIMIT) v.push(`part ${i + 1} of ${parts.length} is ${p.length} chars, over the ${PART_LIMIT} part limit`);
  });
  const joined = parts.join("\n");
  const lost = out.split("\n").find((l) => !joined.includes(l));
  if (lost !== undefined) v.push(`a line of the bundle is in no part: ${lost.slice(0, 100)}`);
  r.parts = parts.length;

  // 1. section headers and STATUS text, in order
  const hin = inSecs.slice(1).map((s) => s.header);
  const hout = outSecs.slice(1).map((s) => s.header);
  if (JSON.stringify(hin) !== JSON.stringify(hout)) v.push("section headers / STATUS changed");

  // 2. every [note: ...] / [warning: ...] / [!! ...] (any line starting with "[") and every "!!" line
  const outLines = new Map();
  for (const l of out.split("\n")) outLines.set(l, (outLines.get(l) ?? 0) + 1);
  const need = new Map();
  for (const l of input.split("\n")) if (/^\s*\[/.test(l) || l.includes("!!")) need.set(l, (need.get(l) ?? 0) + 1);
  for (const [l, n] of need) if ((outLines.get(l) ?? 0) < n) v.push(`bracket/!! line lost: ${l.slice(0, 100)}`);

  // 3. declared-but-not-readable list
  const decl = (t) => /== Declared but NOT readable[\s\S]*?(?=\n\n)/.exec(t)?.[0] ?? "";
  if (decl(input) !== decl(out)) v.push("Declared-but-NOT-readable block changed");

  // 4. SHI note sections byte-identical; 5. Dispatch rows unchanged (T8 aside)
  const openable = /\n\nOpenable records \(use sn_open_record[\s\S]*?(?=\n\n|\n?$)/;
  for (const s of inSecs.slice(1)) {
    const o = outSecs.find((x) => x.header === s.header);
    if (!o) continue;
    if (s.name.startsWith("SHI note") && o.text !== s.text) v.push(`${s.name} section changed`);
    if ((s.name === "Dispatch Orders" || s.name === "Special handling notes") && o.text !== s.text.replace(openable, "")) {
      v.push(`${s.name} changed beyond the Openable records list`);
    }
  }

  // 6. post headers kept; post author/type/date kept; email To/Cc headers kept
  const pin = posts(input);
  const pout = posts(out);
  const seq = (t) => t.split("\n").filter((l) => /^--- post \d+ ---$/.test(l)).join("|");
  if (seq(input) !== seq(out)) v.push('"--- post N ---" headers changed');
  for (const [n, p] of pin) {
    const o = pout.get(n) ?? "";
    const head = POST_HEAD.exec(p)?.[0];
    if (head && !o.startsWith(head)) v.push(`post ${n}: author/type/date line changed`);
    const eh = emailHeader(p);
    if (eh && !o.startsWith(eh)) v.push(`post ${n}: email header (Subject/From/To/Cc) changed`);
  }

  // 7. email rows keep their metadata; SLA rows keep rubric + time columns
  const rin = rowsOf(inSecs.find((s) => s.name === "Emails")?.text ?? "");
  const rout = rowsOf(outSecs.find((s) => s.name === "Emails")?.text ?? "");
  for (const [n, row] of rin) {
    for (const l of EMAIL_META) {
      const val = cellValue(row, l);
      if (val !== undefined && cellValue(rout.get(n) ?? "", l) !== val) v.push(`Emails row ${n}: ${l} changed`);
    }
  }
  const sin = rowsOf(inSecs.find((s) => s.name === "SLAs")?.text ?? "");
  const sout = rowsOf(outSecs.find((s) => s.name === "SLAs")?.text ?? "");
  for (const [n, row] of sin) {
    for (const l of slaLabels(row)) {
      if (!RUBRIC_SLA.includes(l) && !SLA_TIMEISH.test(l)) continue;
      const val = cellValue(row, l);
      if (cellValue(sout.get(n) ?? "", l) !== val) v.push(`SLAs row ${n}: ${l} changed`);
    }
  }

  // 8. the edit log accounts for every word: input - removed + inserted = output
  const bal = new Map();
  tokenCounts(input, 1, bal);
  for (const e of r.edits) {
    tokenCounts(e.removed, -1, bal);
    tokenCounts(e.inserted, 1, bal);
  }
  tokenCounts(out, -1, bal);
  const off = [...bal].filter(([, n]) => n !== 0);
  if (off.length) v.push(`edit log does not account for ${off.length} word(s), e.g. ${JSON.stringify(off.slice(0, 4))}`);

  // 9. markers are well-formed and never look like a status word
  const markers = new Set();
  for (const e of r.edits) {
    if (e.inserted.startsWith("[") && e.rule !== "legend") {
      if (!MARKER_RE.test(e.inserted)) v.push(`unexpected marker text: ${e.inserted.slice(0, 100)}`);
      markers.add(e.inserted);
    }
    if (STATUS_WORDS.test(e.inserted)) v.push(`inserted text contains a status word: ${e.inserted.slice(0, 100)}`);
  }

  // 10. pattern edits remove only what their pattern matches
  const lineOf = (where) => {
    let m = /^Case > post (\d+)$/.exec(where);
    if (m) return pout.get(Number(m[1]));
    m = /^Emails > row (\d+)$/.exec(where);
    return m ? rout.get(Number(m[1])) : undefined;
  };
  for (const e of r.edits.filter((x) => x.kind === "pattern")) {
    const err = validatePattern(e, out, lineOf);
    if (err) v.push(`${e.where}: ${err}`);
  }

  // 11. dedupe edits: every removed word is still in the output
  let blank = out;
  for (const mk of markers) blank = blank.split(mk).join(` ${BAR} `);
  const legend = r.edits.find((e) => e.rule === "legend")?.inserted;
  if (legend) blank = blank.split(legend).join(` ${BAR} `);
  const ix = indexWords(words(blank));
  const blankSecs = sections(blank);
  const blankPosts = posts(blank);
  const cov = { spans: 0, words: 0, long: 0, weak: 0 };
  for (const e of r.edits.filter((x) => x.kind === "dedupe")) {
    if (!e.source) {
      v.push(`${e.where}: dedupe edit without a source`);
      continue;
    }
    const srcText = resolve(e.source, blank, blankSecs, blankPosts);
    if (srcText === null) v.push(`${e.where}: pointer target "${e.source}" not found in the output`);
    if (!e.inserted.includes(e.source) && !/earlier in this post/.test(e.inserted)) {
      v.push(`${e.where}: marker does not name its source "${e.source}": ${e.inserted}`);
    }
    let removed = e.removed;
    for (const mk of markers) removed = removed.split(mk).join(` ${BAR} `);
    const span = words(removed);
    // a word cut by a truncated preview ("... any si...") is only a fragment:
    // it is accepted when some output word starts with it
    if (/[\p{L}\p{N}](?:\.\.\.|…)\s*$/u.test(removed)) {
      let k = span.length - 1;
      while (k >= 0 && span[k] === BAR) k--;
      if (k >= 0 && [...ix.uni.keys()].some((w) => w.length > span[k].length && w.startsWith(span[k]))) span[k] = BAR;
    }
    const c = coverage(span, ix, srcText === null ? null : words(srcText));
    cov.spans++;
    cov.words += c.n;
    cov.long += c.long;
    cov.weak += c.weak;
    if (!c.ok) {
      v.push(`${e.where}: ${e.t} removed text that is NOT in the output (${c.uncovered} word(s) missing, ${c.weak} weak): ${e.removed.slice(0, 160)}`);
      if (VERBOSE) v.push(`   details (source ${e.source}): ${c.misses.join("; ")}`);
    }
  }
  return { v, cov, inSecs, outSecs };
}

// --------------------------------------------------------------- main --

mkdirSync(outDir, { recursive: true });
const files = readdirSync(inDir).filter((f) => f.endsWith(".txt")).sort();
if (!files.length) {
  console.error(`no *.txt bundles in ${inDir}`);
  process.exit(1);
}

const pad = (s, n) => String(s).padStart(n);
const totals = { in: 0, out: 0, under: 0, spans: 0, words: 0, long: 0, weak: 0, restored: 0 };
const perT = Object.fromEntries(TRANSFORMS.map((t) => [t, 0]));
const byRule = new Map();
let violations = 0;
const sectionRows = [];

console.log(`compact-check: ${files.length} bundle(s) from ${inDir}`);
console.log(`compacted text + edit logs -> ${outDir}\n`);
console.log(
  `${"case".padEnd(12)}${pad("before", 7)}${pad("after", 7)}${pad("saved", 7)}  ` +
    TRANSFORMS.map((t) => pad(t, 6)).join("") + "  check",
);
for (const f of files) {
  const raw = readFileSync(join(inDir, f), "utf8");
  const input = raw.replace(/\r\n/g, "\n"); // bundles are LF; saved copies may be CRLF
  const r = compactBundle(input);
  writeFileSync(join(outDir, f), r.text);
  writeFileSync(join(outDir, f.replace(/\.txt$/, ".edits.json")), JSON.stringify(r.edits, null, 1));
  const { v, cov, inSecs, outSecs } = checkCase(f, input, r);
  violations += v.length;
  totals.in += input.length;
  totals.out += r.text.length;
  if (r.text.length < TARGET) totals.under++;
  totals.spans += cov.spans;
  totals.words += cov.words;
  totals.long += cov.long;
  totals.weak += cov.weak;
  totals.restored += r.stats.dedupe_spans_restored ?? 0;
  for (const t of TRANSFORMS) perT[t] += r.stats[`${t}_chars`] ?? 0;
  for (const e of r.edits) {
    const k = `${e.t} ${e.kind} ${e.rule}`;
    const a = byRule.get(k) ?? { n: 0, chars: 0 };
    a.n++;
    a.chars += e.removed.length - e.inserted.length;
    byRule.set(k, a);
  }
  const saved = `${Math.round((100 * (input.length - r.text.length)) / input.length)}%`;
  console.log(
    `${f.replace(/\.txt$/, "").padEnd(12)}${pad(input.length, 7)}${pad(r.text.length, 7)}${pad(saved, 7)}  ` +
      TRANSFORMS.map((t) => pad(r.stats[`${t}_chars`] ?? 0, 6)).join("") +
      `  ${v.length ? `FAIL (${v.length})` : "ok"}${r.text.length >= TARGET ? "  [>= 30k]" : ""}${r.parts > 1 ? `  [${r.parts} parts]` : ""}`,
  );
  for (const x of v.slice(0, 25)) console.log(`    !! ${x}`);
  if (v.length > 25) console.log(`    !! ... ${v.length - 25} more`);
  const secs = new Map();
  for (const s of inSecs.slice(1)) {
    const name = s.name.startsWith("SHI note") ? "SHI notes" : s.name;
    const o = outSecs.find((x) => x.header === s.header);
    const cur = secs.get(name) ?? [0, 0];
    secs.set(name, [cur[0] + s.text.length, cur[1] + (o?.text.length ?? 0)]);
  }
  sectionRows.push([f.replace(/\.txt$/, ""), secs]);
}

const pct = (a, b) => `${Math.round((100 * (a - b)) / a)}%`;
console.log(
  `${"TOTAL".padEnd(12)}${pad(totals.in, 7)}${pad(totals.out, 7)}${pad(pct(totals.in, totals.out), 7)}  ` +
    TRANSFORMS.map((t) => pad(perT[t], 6)).join(""),
);
console.log(`\nper-section chars (before > after)`);
const secNames = ["Case", "SLAs", "Dispatch Orders", "Emails", "Special handling notes", "SHI notes"];
console.log(`${"case".padEnd(12)}${secNames.map((s) => s.slice(0, 14).padStart(16)).join("")}`);
for (const [c, secs] of sectionRows) {
  console.log(
    `${c.padEnd(12)}${secNames.map((s) => (secs.has(s) ? `${secs.get(s)[0]}>${secs.get(s)[1]}` : "-").padStart(16)).join("")}`,
  );
}
console.log(`\nedits by rule (count, net chars removed)`);
for (const [k, a] of [...byRule].sort((x, y) => y[1].chars - x[1].chars)) console.log(`  ${k.padEnd(52)} ${pad(a.n, 5)} ${pad(a.chars, 8)}`);
console.log(
  `\ncoverage of dedupe removals: ${totals.spans} spans, ${totals.words} words; ` +
    `${totals.words ? ((100 * totals.long) / totals.words).toFixed(1) : "100"}% of them in-order with the named source ` +
    `or in runs of 8+ words, ${totals.weak} word(s) only in short runs; ${totals.restored} span(s) restored by the module's own re-check`,
);
console.log(`size: ${totals.under} of ${files.length} under ${TARGET} chars; every part at most ${PART_LIMIT}`);
console.log(violations ? `\nFAILED: ${violations} violation(s)` : "\nall invariants hold");
process.exit(violations ? 1 : 0);
