// Packaging check (Phase 4): drive the SERVER the way a teammate's Claude Code
// will — spawn dist/index.js over stdio with only the documented env vars, do the
// MCP handshake, and call a real tool. This validates the README config snippet
// end to end, not just the internal read functions.
//
// Usage:
//   node scripts/mcp-call.mjs sn_read_case
//   node scripts/mcp-call.mjs sn_open_case '{"number":"CS1234567"}'
//   node scripts/mcp-call.mjs sn_find_cases '{"query":"ARRAY-01-SERIAL"}'
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "dist", "index.js");

const toolName = process.argv[2];
if (!toolName) {
  console.error("usage: node scripts/mcp-call.mjs <tool> [jsonArgs]");
  process.exit(2);
}
let toolArgs = {};
if (process.argv[3]) {
  // Join the remaining argv: PowerShell 5.1 splits a quoted JSON argument on
  // spaces, so {"name":"Special handling notes"} arrives as several arguments.
  const raw = process.argv.slice(3).join(" ").trim();
  const eq = raw.indexOf("=");
  if (!raw.startsWith("{") && eq > 0) {
    // Shell-proof form: name=Special handling notes  (PowerShell 5.1 eats quotes)
    const key = raw.slice(0, eq).trim();
    const val = raw.slice(eq + 1).trim();
    toolArgs = { [key]: /^\d+$/.test(val) ? Number(val) : val };
  } else {
    try {
      toolArgs = JSON.parse(raw);
    } catch {
      // PowerShell strips the quotes out of JSON, leaving {name:Some value}.
      // Repair unquoted keys and unquoted string values, then retry.
      const repaired = raw
        .replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":')
        .replace(/:\s*([^",{}\[\]]+?)\s*([,}])/g, (_m, v, end) =>
          /^(true|false|null|-?\d+(\.\d+)?)$/.test(v.trim()) ? `:${v.trim()}${end}` : `:"${v.trim()}"${end}`,
        );
      try {
        toolArgs = JSON.parse(repaired);
      } catch (e) {
        console.error(`could not parse arguments (got: ${raw}):`, e.message);
        console.error(`tip: use the shell-proof form, e.g.  name=Special handling notes`);
        process.exit(2);
      }
    }
  }
}

// Exactly the env the README tells teammates to configure — nothing else.
const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    SNC_HOST: process.env.SNC_HOST ?? "pure.service-now.com",
    SNC_BROWSER_URL: process.env.SNC_BROWSER_URL ?? "http://127.0.0.1:9222",
  },
});

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

const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const request = (id, method, params) =>
  new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

const t0 = Date.now();
try {
  const init = await request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-call", version: "0.0.0" },
  });
  console.log(`server: ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  console.log(`calling ${toolName} ${JSON.stringify(toolArgs)} ...\n`);
  const res = await request(2, "tools/call", { name: toolName, arguments: toolArgs });

  if (res.error) {
    console.error("PROTOCOL ERROR:", JSON.stringify(res.error, null, 2));
    child.kill();
    process.exit(1);
  }
  for (const part of res.result?.content ?? []) {
    if (part.type === "text") console.log(part.text);
  }
  console.log(`\n[tools/call completed in ${((Date.now() - t0) / 1000).toFixed(1)}s]`);
  child.kill();
  process.exit(0);
} catch (e) {
  console.error("mcp-call error:", e);
  child.kill();
  process.exit(1);
}
