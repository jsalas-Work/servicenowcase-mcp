#!/usr/bin/env node
/**
 * ServiceNowCase MCP — a read-only ServiceNow case reader with a LOCKED tool
 * surface. It exposes exactly ten tools and nothing else:
 *
 *   1. sn_search         — type into the global search box (THE ONLY ServiceNow WRITE)
 *   2. sn_find_cases     — cross-case search -> list
 *   3. sn_open_case      — open a case by number
 *   4. sn_read_case      — read the open case's fields
 *   5. sn_open_panel     — open a related panel by label
 *   6. sn_read_panel     — read the open panel (or report empty)
 *   7. sn_open_record    — open a record LISTED in the current panel (scoped)
 *   8. sn_launch_browser — connect: start the dedicated debug Chrome (no arguments)
 *   9. sn_status         — report the connection state, starting nothing
 *  10. sn_case_bundle    — tools 3-7 run in a fixed order, as ONE call
 *
 * There is deliberately NO generic click, NO fill, NO evaluate/JS, NO network
 * or cookie inspection, and NO write of any kind beyond the search box. Safety
 * is enforced by the absence of those tools, reinforced by a ServiceNow-only
 * navigation lock (see browser.ts / config.ts).
 *
 * Tool 8 is the sole process-starting tool and was added because Claude Desktop
 * has no terminal, so its users cannot run the launch script. It is parameterless
 * — the model cannot influence what runs — starts Chrome only on a dedicated
 * profile at the ServiceNow host, never closes or kills a browser, and cannot
 * sign anyone in. See launch.ts for the full invariant list.
 *
 * Tool 9 exists so that CONNECTING STAYS THE USER'S DECISION. Without it the
 * only way to find out whether we are connected is to try to connect, since
 * tool 8 acts when the browser is absent. sn_status starts nothing, opens
 * nothing, and reads no ServiceNow data — it only inspects the local debug port.
 *
 * Tool 10 adds no capability: it runs tools 3-7 in a fixed, server-authored
 * order (with their re-read rules) so a whole case costs one round-trip instead
 * of ~13. See bundle.ts.
 *
 * All ten tools are implemented.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CONFIG } from "./config.js";
import { getServiceNowPage } from "./browser.js";
import { launchDebugBrowser, connectionStatus } from "./launch.js";
import { caseBundle } from "./bundle.js";
import {
  readCase,
  openPanel,
  readPanel,
  openRecord,
  openCaseByNumber,
  searchAndRead,
  findCases,
} from "./read.js";

const server = new McpServer(
  {
    name: "servicenowcase-mcp",
    version: "0.1.0",
  },
  {
    // Sent to the host at handshake. This establishes the CONNECT ETIQUETTE, so
    // that "are we connected?" reliably answers instead of acting, and the
    // browser is only ever started because the user asked for it.
    instructions:
      "This server reads ServiceNow through a dedicated debug Chrome that the " +
      "user signs in to themselves.\n\n" +
      "CONNECT ETIQUETTE:\n" +
      "- To answer 'are we connected to ServiceNow?', call sn_status. It starts " +
      "nothing and changes nothing — it only reports the state.\n" +
      "- If sn_status reports NOT CONNECTED, tell the user and ASK whether to " +
      "connect now. Do not connect on your own initiative.\n" +
      "- Call sn_launch_browser only when the user has asked to connect (e.g. " +
      "'connect to ServiceNow', or 'yes' to your offer). It opens the browser so " +
      "they can complete Okta/SSO sign-in.\n" +
      "- If any read fails because the browser is missing or the session lapsed, " +
      "report that plainly and offer to connect — never retry silently.\n\n" +
      "Sign-in itself is always the user's action; no tool here can do it.\n\n" +
      "NEVER convert a connection failure into evidence. A read that fails for " +
      "lack of a browser or a lapsed session means NOTHING was read — it does not " +
      "mean the case is empty or that the data does not exist.",
  },
);

/** Wrap a handler so browser/ServiceNow errors surface cleanly, never crash the server. */
function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
async function guard(fn: () => Promise<string>) {
  try {
    return text(await fn());
  } catch (e) {
    return text(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 1 — sn_search: THE ONLY writable action (types into the search box).
server.registerTool(
  "sn_search",
  {
    title: "Search ServiceNow",
    description:
      "Type a query into the ServiceNow global search box (the only writable target) and return the results. No other field is ever written.",
    inputSchema: { query: z.string().min(1).describe("Text to type into the ServiceNow search box") },
  },
  async ({ query }) => guard(async () => searchAndRead(await getServiceNowPage(), query)),
);

// 2 — sn_find_cases: cross-case search.
server.registerTool(
  "sn_find_cases",
  {
    title: "Find cases",
    description:
      "Search across cases and return only the case matches (number, title, account, assigned to, priority, dates), de-duplicated. Use for cross-case analysis, then sn_open_case to drill in. Read-only apart from the search box.",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .describe(
          "Case search text: a case number, account name, asset/array name, or short description",
        ),
    },
  },
  async ({ query }) => guard(async () => findCases(await getServiceNowPage(), query)),
);

// 3 — sn_open_case.
server.registerTool(
  "sn_open_case",
  {
    title: "Open a case",
    description:
      "Open a case by its number (e.g. CS1234567). Read-only navigation, locked to the ServiceNow host.",
    inputSchema: {
      number: z
        .string()
        .regex(CONFIG.caseNumberPattern, "Must be a case number like CS1234567")
        .describe("Case number, format CS#######"),
    },
  },
  async ({ number }) => guard(async () => openCaseByNumber(await getServiceNowPage(), number)),
);

// 4 — sn_read_case.
server.registerTool(
  "sn_read_case",
  {
    title: "Read current case",
    description:
      "Return all header/detail fields of the currently open case as label -> value pairs. Read-only.",
    inputSchema: {},
  },
  async () => guard(async () => readCase(await getServiceNowPage())),
);

// 5 — sn_open_panel.
server.registerTool(
  "sn_open_panel",
  {
    title: "Open a related panel",
    description:
      'Open a related tab on the current case by its label (e.g. "Special Handling Notes List", "Dispatch Orders", "Emails", "SLAs"). Read-only.',
    inputSchema: { name: z.string().min(1).describe("The panel/tab label to open") },
  },
  async ({ name }) => guard(async () => openPanel(await getServiceNowPage(), name)),
);

// 6 — sn_read_panel.
server.registerTool(
  "sn_read_panel",
  {
    title: "Read current panel",
    description:
      "Read the currently open related panel: its rows/records, or report that it is empty. Read-only.",
    inputSchema: {},
  },
  async () => guard(async () => readPanel(await getServiceNowPage())),
);

// 7 — sn_open_record: SCOPED to items listed in the current panel.
server.registerTool(
  "sn_open_record",
  {
    title: "Open a listed record",
    description:
      "Open a record that is listed in the CURRENTLY OPEN panel (e.g. a Special Handling note, an email, a dispatch order) by its 1-based position or its link label, then read it. Scoped to the current panel — it cannot open arbitrary URLs. Read-only.",
    inputSchema: {
      target: z
        .union([z.number().int().positive(), z.string().min(1)])
        .describe("1-based index or the link label of the item in the current panel"),
    },
  },
  async ({ target }) => guard(async () => openRecord(await getServiceNowPage(), target)),
);

// 8 — sn_launch_browser: the ONLY tool that starts a process.
//
// Added because Claude Desktop has no terminal, so a Desktop user could not run
// the launch script at all — without this the MCP is unusable there, not merely
// awkward. It takes NO PARAMETERS on purpose: the model cannot choose the
// program, the flags, the profile or the URL (all server-authored in launch.ts).
// It never closes or kills a browser, and it cannot sign anyone in.
server.registerTool(
  "sn_launch_browser",
  {
    title: "Launch the debug Chrome",
    description:
      "CONNECT TO SERVICENOW. Opens the dedicated debug Chrome this MCP reads through so the user can complete Okta/SSO sign-in, and reports what they must still do. If the browser is already running but its ServiceNow tab was closed, reopens that tab in the same browser. Takes no arguments. Launches Chrome only, on a dedicated profile, at the ServiceNow host — it can start nothing else, never closes or kills a browser, and cannot sign in for you. Call this ONLY when the user has asked to connect; to merely CHECK whether you are connected, call sn_status instead, which starts nothing.",
    inputSchema: {},
  },
  async () => guard(async () => launchDebugBrowser()),
);

// 9 — sn_status: answers "are we connected?" WITHOUT acting.
//
// sn_launch_browser cannot answer that question, because when the browser is
// absent its whole job is to start it — asking would perform the action. This
// tool exists so the user is always the one who decides to connect. It starts
// nothing, navigates nothing, and cannot see a page: its only contact with the
// world is the localhost debug port the server already uses.
server.registerTool(
  "sn_status",
  {
    title: "Check the ServiceNow connection",
    description:
      "Report whether we are connected to ServiceNow: whether the debug Chrome is running, whether a ServiceNow tab is open, and whether it is sitting on a sign-in page. Use this to answer 'are we connected to ServiceNow?'. Read-only and side-effect free — it starts nothing, opens nothing and reads no case data. If it reports NOT CONNECTED, ask the user whether to connect before calling sn_launch_browser.",
    inputSchema: {},
  },
  async () => guard(async () => connectionStatus()),
);

// 10 — sn_case_bundle: the whole case in one call (composes tools 3-7).
server.registerTool(
  "sn_case_bundle",
  {
    title: "Read a whole case",
    description:
      "Open a case by number and return EVERYTHING about it in one call: header + Details fields + the full activity stream, then the SLAs, Dispatch Orders, Emails (bodies as plain text) and Special handling notes panels, including each SHI note's body. Every section carries a STATUS (OK / EMPTY / UNREAD / NOT FOUND) — UNREAD is never the same as empty. Re-reads stale or unloaded data automatically and ends back on the case. Takes 1-2 minutes. Prefer this over calling sn_open_case / sn_read_case / sn_open_panel / sn_read_panel / sn_open_record one by one. Read-only; the only thing it types into is the search box, to open the case.",
    inputSchema: {
      number: z
        .string()
        .regex(CONFIG.caseNumberPattern, "Must be a case number like CS1234567")
        .describe("Case number, format CS#######"),
    },
  },
  async ({ number }, extra) =>
    guard(async () => {
      const token = extra._meta?.progressToken;
      return caseBundle(number, async (progress, total, message) => {
        if (extra.signal.aborted) throw new Error("cancelled by the client");
        if (token === undefined) return;
        await extra
          .sendNotification({
            method: "notifications/progress",
            params: { progressToken: token, progress, total, message },
          })
          .catch(() => {});
      });
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
