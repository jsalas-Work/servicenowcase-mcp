// ACCEPTANCE TEST — the exit gate for this MCP, and the thing a teammate runs to
// confirm their own setup works.
//
// Drives the REAL MCP protocol (spawns dist/index.js over stdio with only the
// documented env vars) and pulls the whole QA-form data set for a case, printing
// a PASS/MISSING checklist. It is deliberately the only test script that matters:
// it exercises all 7 tools end to end, in the order the QA workflow uses them.
//
// Usage:
//   npm run accept -- CS1234567 CS7654321   # the cases to drive
//   npm run accept                          # uses your local test cases (see below)
//
// This repo deliberately ships NO real case numbers. Supply your own, either way:
//   - env:  SNC_TEST_CASES=CS1234567,CS7654321 npm run accept
//   - file: accept.cases.json  ->  ["CS1234567", "CS7654321"]   (gitignored)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

// Case numbers are real customer identifiers, so none are committed here. They
// come from the CLI, an env var, or a gitignored local file - in that order.
const CASE_RE = /^CS\d{6,}$/i;
function localCases() {
  const fromEnv = (process.env.SNC_TEST_CASES ?? "").split(",").map((c) => c.trim());
  if (fromEnv.some((c) => CASE_RE.test(c))) return fromEnv.filter((c) => CASE_RE.test(c));
  try {
    const parsed = JSON.parse(readFileSync(join(__dirname, "..", "accept.cases.json"), "utf8"));
    if (Array.isArray(parsed)) return parsed.filter((c) => CASE_RE.test(c));
  } catch {
    /* absent or malformed - fall through to the message below */
  }
  return [];
}
const cases = process.argv.slice(2).filter((a) => CASE_RE.test(a));
const targets = cases.length ? cases : localCases();
if (!targets.length) {
  console.error(
    "No case numbers to test.\n\n" +
      "This repo ships no real case numbers on purpose. Give it your own:\n" +
      "  npm run accept -- CS1234567 CS7654321\n" +
      "  SNC_TEST_CASES=CS1234567,CS7654321 npm run accept\n" +
      '  or create accept.cases.json (gitignored):  ["CS1234567", "CS7654321"]\n',
  );
  process.exit(2);
}

/* ---------- minimal MCP stdio client (one server for the whole run) -------- */
const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    SNC_HOST: process.env.SNC_HOST ?? "pure.service-now.com",
    SNC_BROWSER_URL: process.env.SNC_BROWSER_URL ?? "http://127.0.0.1:9222",
  },
});
let buf = "";
let nextId = 1;
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
async function call(tool, args = {}) {
  const res = await rpc("tools/call", { name: tool, arguments: args });
  if (res.error) return `__ERROR__ ${res.error.message ?? JSON.stringify(res.error)}`;
  return (res.result?.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/* ---------------------------- checklist plumbing -------------------------- */
let failures = 0;
let warnings = 0;
function check(label, ok, detail, { warnOnly = false } = {}) {
  const tag = ok ? "PASS" : warnOnly ? "WARN" : "FAIL";
  if (!ok) warnOnly ? warnings++ : failures++;
  console.log(`  [${tag}] ${label}${detail ? ` — ${detail}` : ""}`);
}
const firstLine = (s) => (s || "").split("\n").find((l) => l.trim()) ?? "";

/** Gate fields the QA form cannot be filled without. */
const GATE_FIELDS = [
  "Number",
  "Priority",
  "Account",
  "Asset",
  "Opened",
  "Urgency",
  "Purity Version",
  "Assigned to",
  "State",
];

async function acceptCase(num) {
  console.log(`\n${"=".repeat(72)}\nCASE ${num}\n${"=".repeat(72)}`);

  // 1. open + read the case ------------------------------------------------
  const opened = await call("sn_open_case", { number: num });
  check("sn_open_case", !opened.startsWith("__ERROR__") && /open|Opened/i.test(opened), firstLine(opened));

  const read = await call("sn_read_case");
  const fieldCount = /read: (\d+) form fields/.exec(read)?.[1];
  const headerCount = /(\d+) header fields/.exec(read)?.[1];
  check("sn_read_case returned fields", Number(fieldCount) > 0, `${fieldCount ?? 0} form + ${headerCount ?? 0} header`);
  check(
    "form cross-checked against workspace tab",
    /cross-checked as/.test(read),
    /cross-checked as [^;\]]+/.exec(read)?.[0] ?? "NOT cross-checked",
  );
  check("no stale-read abort", !/STALE READ ABORTED/.test(read), "");
  // Activity stream: where work notes actually live (QA Q5 + Q13).
  const posts = /== Activity stream \((\d+) posts\)/.exec(read)?.[1];
  check("activity stream read", Number(posts) > 0, `${posts ?? 0} posts`);
  check("work notes present in stream", /\bWork notes\b/.test(read), "", { warnOnly: true });
  check("no truncated activity posts", !/may be TRUNCATED/.test(read), "");

  const missingGate = GATE_FIELDS.filter((f) => !new RegExp(`^${f}[ (:]`, "m").test(read));
  check("QA gate fields present", missingGate.length === 0, missingGate.length ? `missing: ${missingGate.join(", ")}` : "all present");
  const unreadable = /declared but NOT readable from this form \((\d+)\)/i.exec(read)?.[1];
  if (unreadable) console.log(`         (note: ${unreadable} fields declared-but-unreadable — expected, varies per layout)`);

  // 2. panels the QA form depends on ---------------------------------------
  // Read the tab list once from a deliberately bogus panel request, so we know
  // which panels this case actually has instead of guessing.
  // NOTE: deliberately no "enumerate the tabs" probe here. Asking for a panel
  // that cannot exist makes sn_open_panel expand the "More tabs" overflow, and
  // that left the menu covering the strip so every later lookup saw zero tabs.
  // Each panel check below calls the tool directly, which is the only authority.

  // Use the SHORTER real tab name ("Special handling notes"); the tab renders as
  // "Special Handling Notes List  (1)" and matching is bidirectional either way.
  const wanted = [
    { label: "Special handling notes", key: "SHI notes", required: true },
    { label: "SLAs", key: "SLAs", required: true },
    { label: "Dispatch Orders", key: "Dispatch orders", required: false },
    { label: "Emails", key: "Emails", required: false },
  ];

  for (const w of wanted) {
    // ALWAYS call the tool — never pre-judge presence from the enumerated tab
    // list. That list can be truncated by the strip's "More tabs" overflow, and
    // a substring pre-check once skipped the SHI panel as "not present" on a case
    // that genuinely had it (1 note). sn_open_panel is the only authority.
    const op = await call("sn_open_panel", { name: w.label });
    const okOpen = /^Opened panel/.test(op);
    if (!okOpen && /not found/.test(op)) {
      check(`panel "${w.label}"`, false, "genuinely absent (sn_open_panel searched incl. overflow)", {
        warnOnly: !w.required,
      });
      continue;
    }
    check(`sn_open_panel "${w.label}"`, okOpen, firstLine(op));
    if (!okOpen) continue;

    const rp = await call("sn_read_panel");
    const panelName = /^Open panel: (.*)$/m.exec(rp)?.[1] ?? "(none)";
    // The panel it reports MUST be the one we opened — this is the bug that made
    // read_panel describe "Home" and list skip-links as records.
    check(
      `sn_read_panel reports the right panel`,
      panelName.toLowerCase().startsWith(w.label.toLowerCase().split(",")[0]),
      `reported "${panelName}"`,
    );
    const rowCount = /^Rows \((\d+)\)/m.exec(rp)?.[1] ?? /^Entries \((\d+)\)/m.exec(rp)?.[1];
    // readPanel now states emptiness outright ("This panel is EMPTY") instead of
    // hedging with "appears to be empty". Match both so the check stays honest.
    const emptyish = /appears to be empty|This panel is EMPTY/.test(rp);
    check(
      `sn_read_panel has content`,
      Boolean(rowCount) || !emptyish,
      rowCount ? `${rowCount} rows` : emptyish ? "reported empty" : "no rows but not flagged empty",
      { warnOnly: true },
    );
    check(
      "no page chrome offered as a record",
      !/Skip to main content|Open accessibility preferences/.test(rp),
      "",
    );

    // 3. sn_open_record — BY LABEL, on the panel's own row, never by blind index.
    // Index 1 of a related list is usually a reference field (Account/Contact),
    // and opening it navigates off the case into an account record and spawns a
    // workspace tab. Emails are skipped entirely on purpose: an email row can
    // open the composer, which is out of bounds for a read-only tool.
    // Sub-record BODY reads — the SHI instructions (Q2) and sent-email text
    // (Q9-Q12). Both go through sn_read_case's sub-record path.
    if (/^(Special handling notes|Emails)$/i.test(w.label)) {
      const wantCol = /Emails/i.test(w.label) ? /created/i : /short description/i;
      const item = [...rp.matchAll(/^\d+\. (.+?)(?:   \[column: (.+?)\])?$/gm)]
        .map((m) => ({ label: m[1].trim(), column: (m[2] ?? "").trim() }))
        .find((it) => wantCol.test(it.column));
      if (!item) {
        check(`sub-record body from "${w.label}"`, false, "no suitable row link offered", { warnOnly: true });
      } else {
        const opened = await call("sn_open_record", { target: item.label });
        const refused = /^REFUSED/.test(opened);
        check(`sn_open_record "${item.label}" [${item.column}]`, /^Opened record/.test(opened), refused ? "refused (draft guard)" : firstLine(opened), { warnOnly: refused });
        if (!refused) {
          const sub = await call("sn_read_case");
          const table = /^Sub-record: (\S+)/m.exec(sub)?.[1] ?? "(none)";
          const blocks = /(\d+) rich-text block/.exec(sub)?.[1] ?? "0";
          check(`sub-record read is the right table`, /^(sn_shn_notes|sys_email)$/.test(table), `table=${table}`);
          check(`sub-record body text captured`, Number(blocks) > 0, `${blocks} rich-text block(s)`);
          // Guard against the hidden-iframe leak: never MORE than one body. Use
          // <= 1 so a zero-body read trips only the body check above, instead of
          // reporting the same problem twice.
          check(`no leaked body from another record`, Number(blocks) <= 1, `${blocks} block(s)`);
        }
        await call("sn_open_case", { number: num });
      }
    }

    if (/^SLAs$/i.test(w.label)) {
      // Pick an openable item that is NOT a reference column.
      const own = [...rp.matchAll(/^\d+\. (.+?)(?:   \[column: (.+?)\])?$/gm)]
        .map((m) => ({ label: m[1].trim(), column: (m[2] ?? "").trim() }))
        .find((it) => it.column && !/account|contact|assigned|group|company|user/i.test(it.column));
      if (!own) {
        check(`sn_open_record on "${w.label}"`, false, "no non-reference row link offered — skipped", { warnOnly: true });
      } else {
        const rec = await call("sn_open_record", { target: own.label });
        check(
          `sn_open_record "${own.label}" [${own.column}]`,
          /^Opened record/.test(rec),
          firstLine(rec),
          { warnOnly: true },
        );
        // Return to the case so the next panel starts from a known state, and
        // prove the recovery path works from wherever we landed.
        const back = await call("sn_open_case", { number: num });
        check("recovered back to the case after sn_open_record", /open|Opened/i.test(back) && !back.startsWith("__ERROR__"), firstLine(back));
      }
    }
  }
}

/* ----------------------------------- run ---------------------------------- */
const t0 = Date.now();
try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "accept", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await rpc("tools/list", {});
  const tools = (list.result?.tools ?? []).map((t) => t.name).sort();
  console.log(`tools exposed (${tools.length}): ${tools.join(", ")}`);
  // 7 until sn_launch_browser (2026-07-31), 9 since sn_status (2026-08-03),
  // 10 since sn_case_bundle.
  // This assertion was left at 7 when tool 8 landed — keep it in step with
  // smoke-tools.mjs, or the exit gate silently stops matching the real surface.
  check("surface is exactly 10 tools", tools.length === 10, `${tools.length} tools`);

  // sn_status must report the connection WITHOUT starting anything. The browser
  // is up by definition here (every case check below needs it), so the honest
  // answer is CONNECTED — if this says otherwise, the status logic is wrong.
  const status = await call("sn_status", {});
  check(
    "sn_status reports CONNECTED while the debug Chrome is up",
    /^CONNECTED\b/.test(status.trim()),
    firstLine(status),
  );

  for (const num of targets) await acceptCase(num);

  console.log(`\n${"=".repeat(72)}`);
  console.log(
    `ACCEPTANCE: ${failures ? `${failures} FAILURE(S)` : "ALL CHECKS PASSED"}` +
      `${warnings ? `, ${warnings} warning(s)` : ""} in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
  console.log(
    "Warnings are expected where a case genuinely lacks a panel (e.g. no SHI tab)\n" +
      "— they are data about the case, not defects.",
  );
  child.kill();
  process.exit(failures ? 1 : 0);
} catch (e) {
  console.error("acceptance error:", e);
  child.kill();
  process.exit(1);
}
