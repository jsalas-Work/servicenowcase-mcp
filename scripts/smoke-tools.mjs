// Gate check: spawn the built server over stdio, run the MCP handshake, call
// tools/list, and assert the surface is EXACTLY the 10 approved tools — no more,
// no less. No browser needed for this test.
//
// Was 7 until 2026-07-31, when sn_launch_browser was added so Claude Desktop
// users (who have no terminal, and so cannot run launch-debug-chrome.ps1) can
// start the debug Chrome at all.
//
// Became 9 on 2026-08-03 with sn_status, so that "are we connected?" can be
// ANSWERED without being ACTED ON — sn_launch_browser starts a browser when one
// is absent, so it can never be a safe way to ask. sn_status starts nothing,
// navigates nothing, and reads no ServiceNow data.
//
// Became 10 with sn_case_bundle, which adds no capability: it runs tools 3-7
// in a fixed server-authored order so a whole case costs one call, not ~13.
//
// Any OTHER new tool appearing here is still a security failure — the point of
// this gate is that the surface never grows silently.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

const EXPECTED = [
  "sn_search",
  "sn_find_cases",
  "sn_open_case",
  "sn_read_case",
  "sn_open_panel",
  "sn_read_panel",
  "sn_open_record",
  "sn_launch_browser",
  "sn_status",
  "sn_case_bundle",
];

const child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
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

function send(obj) { child.stdin.write(JSON.stringify(obj) + "\n"); }
function request(id, method, params) {
  return new Promise((resolve) => { pending.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
}

try {
  await request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const res = await request(2, "tools/list", {});
  const tools = (res.result?.tools ?? []).map((t) => t.name).sort();
  const expected = [...EXPECTED].sort();

  const missing = expected.filter((t) => !tools.includes(t));
  const extra = tools.filter((t) => !expected.includes(t));

  console.log("Tools exposed:", tools.join(", "));
  if (missing.length || extra.length) {
    if (missing.length) console.error("MISSING:", missing.join(", "));
    if (extra.length) console.error("UNEXPECTED (SECURITY FAIL):", extra.join(", "));
    console.error("\nGATE FAILED — surface does not match the approved 10 tools.");
    child.kill();
    process.exit(1);
  }
  console.log(`\nGATE PASSED — exactly ${tools.length} tools, matching the approved surface.`);
  child.kill();
  process.exit(0);
} catch (e) {
  console.error("Smoke test error:", e);
  child.kill();
  process.exit(1);
}
