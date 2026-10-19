/**
 * Debug-Chrome launcher (tool 8).
 *
 * WHY THIS EXISTS: Claude Desktop has no terminal, so a Desktop-only user could
 * never run scripts/launch-debug-chrome.ps1 — which made the whole MCP unusable
 * for them, not merely inconvenient. This is the ONLY tool that starts a
 * process, and it is deliberately the narrowest possible one.
 *
 * SECURITY INVARIANTS (all enforced structurally, not by prompt):
 *   - The tool takes NO PARAMETERS. The model cannot influence the executable,
 *     the flags, the profile directory, or the start URL. Everything below is
 *     server-authored or comes from environment variables the USER controls.
 *   - It starts Chrome ONLY, with a DEDICATED debug profile, at the ServiceNow
 *     host from CONFIG. It cannot be pointed at another program or another site.
 *   - It NEVER kills, closes, or modifies an existing browser. If a debug Chrome
 *     is already running it launches nothing and just reports the state.
 *   - It cannot sign anyone in. Credentials are only ever entered by the human
 *     in the browser window.
 *   - Still no egress: the only network call is to the localhost debug port,
 *     the same one the server already talks to.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Repo root = parent of dist/, so the profile matches the launch script's default. */
function repoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function profileDir(): string {
  return process.env.SNC_CHROME_PROFILE ?? join(repoRoot(), ".chrome-debug-profile");
}

/** FIXED candidate list — never model-supplied. SNC_CHROME_PATH lets the USER override. */
function findChrome(): string | null {
  const override = process.env.SNC_CHROME_PATH;
  if (override) return existsSync(override) ? override : null;
  const candidates =
    process.platform === "win32"
      ? [
          `${process.env["ProgramFiles"] ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env["LOCALAPPDATA"] ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

function debugPort(): number {
  try {
    const p = new URL(CONFIG.browserDebugURL).port;
    return p ? Number(p) : 9222;
  } catch {
    return 9222;
  }
}

/** Ask the debug port what tabs exist. null = port not answering as Chrome. */
async function probe(): Promise<{ urls: string[] } | null> {
  try {
    const res = await fetch(`${CONFIG.browserDebugURL}/json/list`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const list = (await res.json()) as Array<{ type?: string; url?: string }>;
    return { urls: list.filter((t) => t.type === "page").map((t) => t.url ?? "") };
  } catch {
    return null;
  }
}

function describeTabs(urls: string[]): string {
  const sn = urls.filter((u) => {
    try {
      return new URL(u).hostname === CONFIG.serviceNowHost;
    } catch {
      return false;
    }
  });
  if (sn.length) {
    return `A ServiceNow tab is open (${sn[0]}). You are ready — use sn_open_case next.`;
  }
  const auth = urls.find(
    (u) => u.includes("okta.com") || u.includes("SAMLRequest=") || u.includes("login.microsoftonline.com"),
  );
  if (auth) {
    return (
      `The browser is on a SIGN-IN page. ACTION NEEDED: complete Okta/SSO sign-in in ` +
      `that Chrome window, then retry. Nothing can be read until you do.`
    );
  }
  return (
    `No ${CONFIG.serviceNowHost} tab is open yet. ACTION NEEDED: in that Chrome window, ` +
    `go to https://${CONFIG.serviceNowHost} and complete Okta/SSO sign-in, then retry.`
  );
}

/** Does this tab list contain a ServiceNow tab? */
function hasServiceNowTab(urls: string[]): boolean {
  return urls.some((u) => {
    try {
      return new URL(u).hostname === CONFIG.serviceNowHost;
    } catch {
      return false;
    }
  });
}

/**
 * Report the connection state WITHOUT starting, closing, or changing anything.
 *
 * This exists so "are we connected to ServiceNow?" can be answered honestly
 * before anything happens. sn_launch_browser cannot answer it, because when the
 * browser is absent that tool's whole job is to start it — asking the question
 * would perform the action. Connecting must stay something the user asks for.
 *
 * The only thing this touches is the localhost debug port the server already
 * talks to. It cannot see a page, navigate, or read ServiceNow data.
 */
export async function connectionStatus(): Promise<string> {
  const port = debugPort();
  const seen = await probe();

  if (!seen) {
    return (
      `NOT CONNECTED — the debug Chrome is not running (nothing is listening on ` +
      `port ${port}).\n` +
      `Nothing was started. To connect, ask to connect to ServiceNow and the ` +
      `browser will be opened for sign-in.`
    );
  }

  if (hasServiceNowTab(seen.urls)) {
    return (
      `CONNECTED — the debug Chrome is running on port ${port} and a ` +
      `${CONFIG.serviceNowHost} tab is open. Ready to read cases.\n` +
      `(Note: this confirms a ServiceNow tab exists. If the sign-in session has ` +
      `lapsed, the first read will say so explicitly rather than return empty data.)`
    );
  }

  const auth = seen.urls.find(
    (u) =>
      u.includes("okta.com") ||
      u.includes("SAMLRequest=") ||
      u.includes("login.microsoftonline.com"),
  );
  if (auth) {
    return (
      `NOT CONNECTED — the debug Chrome is running on port ${port}, but it is ` +
      `sitting on a SIGN-IN page. Complete the Okta/SSO sign-in in that Chrome ` +
      `window; no one else can do it for you.`
    );
  }

  return (
    `NOT CONNECTED — the debug Chrome is running on port ${port}, but no ` +
    `${CONFIG.serviceNowHost} tab is open (closing the Chrome window does not stop ` +
    `Chrome, so this state is common).\n` +
    `Nothing was started. To connect, ask to connect to ServiceNow and the ` +
    `ServiceNow tab will be reopened in that same browser.`
  );
}

/**
 * The FIXED command line. Server-authored in full — no caller, and certainly no
 * model, contributes any part of it. Reused by both the cold launch and the
 * reopen-a-tab path so the two can never drift apart.
 */
function chromeArgs(profile: string, port: number): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    // ServiceNow will not render its SEARCH RESULTS page while Chrome believes
    // the tab is hidden, and Chrome treats a fully covered window as hidden.
    // These remove that failure mode at the source.
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    // The workspace collapses the Details form in a small window (a 640x487
    // window left 13 fields unreadable). Without this flag a new debug window
    // opens at Chrome's small default size. The server still enlarges a window
    // below 1360x660 before reading a case.
    "--window-size=1400,900",
    "--no-first-run",
    "--no-default-browser-check",
    `https://${CONFIG.serviceNowHost}/now/cwf/agent/home`,
  ];
}

/**
 * Detached + unref'd so the browser keeps running after this server exits. The
 * user's browser must never die because an MCP host restarted.
 * Returns an error string, or null on success.
 */
function spawnChrome(chrome: string, args: string[]): string | null {
  try {
    const child = spawn(chrome, args, { detached: true, stdio: "ignore" });
    child.unref();
    return null;
  } catch (e) {
    return `Failed to start Chrome (${chrome}): ${(e as Error).message}`;
  }
}

/**
 * Reopen the ServiceNow tab in the ALREADY-RUNNING debug Chrome.
 *
 * Closing the Chrome window does not stop Chrome: the process keeps the debug
 * port open with no ServiceNow tab, which used to be a dead end — the port
 * answers, so nothing will start a browser, but there is no tab to read.
 *
 * Running chrome.exe again with the SAME --user-data-dir makes Chrome hand the
 * URL to the running instance as a new tab and exit, rather than starting a
 * second browser. Nothing is closed, killed or replaced. If the profile turns
 * out NOT to be the running instance's, this starts a correctly-configured
 * browser instead — which is why the full arg list is used, not a bare URL.
 */
async function openServiceNowTab(): Promise<string> {
  const chrome = findChrome();
  if (!chrome) {
    return (
      `ACTION NEEDED: no ServiceNow tab is open, and Chrome could not be found to ` +
      `reopen one. In the debug Chrome window, go to https://${CONFIG.serviceNowHost} ` +
      `yourself, or set SNC_CHROME_PATH.`
    );
  }

  const err = spawnChrome(chrome, chromeArgs(profileDir(), debugPort()));
  if (err) return err;

  // Poll until the tab actually shows up, so the reply reflects reality rather
  // than what we asked for.
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    const now = await probe();
    if (now && hasServiceNowTab(now.urls)) {
      return `The ServiceNow tab was REOPENED in that browser.\n${describeTabs(now.urls)}`;
    }
  }
  const last = await probe();
  return (
    `A ServiceNow tab was requested but has not appeared after ~10s. ` +
    `${last ? describeTabs(last.urls) : "The debug port stopped responding."}\n` +
    `If a sign-in page is showing, complete Okta/SSO there and retry.`
  );
}

/**
 * Start the dedicated debug Chrome if it is not already running, then report
 * exactly what the human still has to do. Returns a human-readable status.
 */
export async function launchDebugBrowser(): Promise<string> {
  const port = debugPort();

  // Already running? Never start a second browser — two debug Chromes on one
  // profile fight over the profile lock, and killing the user's browser is never
  // acceptable. But a running Chrome with no ServiceNow tab is a dead end we CAN
  // fix: re-running chrome.exe with the SAME --user-data-dir hands the URL to the
  // already-running instance as a new tab. Nothing is closed, killed or replaced.
  const existing = await probe();
  if (existing) {
    if (hasServiceNowTab(existing.urls)) {
      return (
        `A debug Chrome is ALREADY running on port ${port} — nothing was launched.\n` +
        describeTabs(existing.urls)
      );
    }
    const reopened = await openServiceNowTab();
    return (
      `A debug Chrome is ALREADY running on port ${port} — no second browser was ` +
      `started.\n${reopened}`
    );
  }

  const chrome = findChrome();
  if (!chrome) {
    return (
      `Could not find Chrome on this machine. Install Google Chrome, or set the ` +
      `SNC_CHROME_PATH environment variable to its full path in your MCP config.`
    );
  }

  const profile = profileDir();
  const err = spawnChrome(chrome, chromeArgs(profile, port));
  if (err) return err;

  // Wait for the debug port to answer, so the reply reflects reality.
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const now = await probe();
    if (now) {
      return (
        `Debug Chrome LAUNCHED on port ${port} (dedicated profile: ${profile}).\n` +
        `ACTION NEEDED: a new Chrome window has opened — complete Okta/SSO sign-in ` +
        `there if prompted, and leave the ServiceNow tab open. This is a SEPARATE ` +
        `browser from your everyday Chrome; your normal windows cannot be used and ` +
        `are unaffected.\n` +
        describeTabs(now.urls)
      );
    }
  }
  return (
    `Chrome was started (${chrome}) but the debug port ${port} did not respond within ~20s. ` +
    `Check whether a Chrome window opened, and that no other program holds port ${port}.`
  );
}
