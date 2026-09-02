/**
 * Browser attachment layer.
 *
 * This connects to a Chrome that is ALREADY RUNNING and ALREADY LOGGED IN to
 * ServiceNow (launched by the user with --remote-debugging-port). We never
 * launch a fresh browser and never handle credentials — we borrow the user's
 * existing session, exactly like the validated manual workflow.
 *
 * Phase 1: connection helpers only. Read/extract logic arrives in Phase 2.
 */
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { CONFIG, isAllowedUrl } from "./config.js";

let browser: Browser | null = null;

/**
 * The one thing a returning user must usually do. Kept as a single constant so
 * every code path gives the SAME actionable instruction instead of guessing at
 * workspace problems.
 */
export const SIGN_IN_HINT =
  `ACTION NEEDED: sign in to ServiceNow again. In the debug Chrome window ` +
  `(dedicated profile .chrome-debug-profile), open https://${CONFIG.serviceNowHost} ` +
  `and complete Okta/SSO sign-in, leave the workspace tab open, then retry. ` +
  `Only you can complete the sign-in — no tool here can do it for you. ` +
  `If the window is missing, ASK TO CONNECT TO SERVICENOW and it will be reopened. ` +
  `Do NOT treat this as "no data" — nothing was read.`;

// Deliberately phrased as an OFFER, not an instruction to run a script: Claude
// Desktop users have no terminal and cannot run launch-debug-chrome.ps1 at all,
// so pointing them at it was a dead end for exactly the people most likely to
// hit this. Connecting stays user-initiated — nothing is started automatically.
export const NO_BROWSER_HINT =
  `NOT CONNECTED: the debug Chrome is not running (or is on a different port). ` +
  `Nothing was started. ASK TO CONNECT TO SERVICENOW and the browser will be ` +
  `opened for sign-in. Do NOT treat this as "no data" — nothing was read.`;

/**
 * Is this URL an authentication page rather than real ServiceNow content?
 *
 * URL-only on purpose: a false positive here would refuse to work on a valid
 * page, which is worse than missing a case, so only unambiguous markers count.
 */
export function authPageReason(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  if (host.endsWith("okta.com")) return `the tab is on the Okta sign-in flow (${host})`;
  if (host.endsWith("login.microsoftonline.com")) return `the tab is on a Microsoft sign-in page`;
  if (u.search.includes("SAMLRequest=")) return "the tab is mid-SAML sign-in redirect";
  for (const p of ["/login.do", "/logout.do", "/ssologin", "/my_sso.do", "/welcome.do"]) {
    if (path.startsWith(p)) return `the ServiceNow tab is on a sign-in page (${u.pathname})`;
  }
  return null;
}

async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;
  // defaultViewport MUST be null. Puppeteer otherwise forces an 800x600
  // Emulation override on the user's real window, which makes the ServiceNow
  // Configurable Workspace collapse its Details form to a handful of fields.
  // null = "use the actual window size", i.e. leave the user's browser alone.
  const opts = { defaultViewport: null } as const;
  try {
    if (CONFIG.browserWSEndpoint) {
      browser = await puppeteer.connect({ browserWSEndpoint: CONFIG.browserWSEndpoint, ...opts });
    } else {
      browser = await puppeteer.connect({ browserURL: CONFIG.browserDebugURL, ...opts });
    }
  } catch (e) {
    // Puppeteer's raw message ("Failed to fetch browser webSocket URL from
    // http://127.0.0.1:9222/json/version: fetch failed") reads like an internal
    // fault. It almost always just means the debug Chrome isn't running — and a
    // vague error here previously got misreported downstream as a workspace
    // problem, sending the user to reload a tab that did not exist.
    browser = null;
    throw new Error(`${NO_BROWSER_HINT} (underlying: ${(e as Error).message})`);
  }
  return browser;
}

/**
 * Return the tab that is on the ServiceNow host. We deliberately refuse to
 * operate on any other tab, so this MCP can never read a non-ServiceNow page.
 */
export async function getServiceNowPage(): Promise<Page> {
  const b = await getBrowser();
  const pages = await b.pages();
  const sn = pages.find((p) => {
    try {
      return new URL(p.url()).hostname === CONFIG.serviceNowHost;
    } catch {
      return false;
    }
  });
  if (!sn) {
    // Distinguish "signed out" from "never opened a ServiceNow tab". A returning
    // user whose Okta session lapsed lands on an okta.com / SAML tab, so the
    // ServiceNow host simply isn't present — reporting that as "open a tab"
    // buries the real instruction, which is: sign in again.
    const authTab = pages.map((p) => authPageReason(p.url())).find((r) => r !== null);
    if (authTab) throw new Error(`Not signed in — ${authTab}. ${SIGN_IN_HINT}`);
    throw new Error(
      `No ${CONFIG.serviceNowHost} tab found in the connected browser. ` +
        `Closing the Chrome window does not stop Chrome, so this often just means ` +
        `the tab was closed — ASK TO CONNECT TO SERVICENOW and it will be reopened ` +
        `in that same browser. If you were signed in earlier, the session may also ` +
        `have lapsed. ${SIGN_IN_HINT}`,
    );
  }
  // The host can match while the page is still a login/SSO screen. Left
  // undetected this is the worst failure mode available: reads succeed
  // structurally and return NOTHING, which looks like "this case has no data".
  const snAuth = authPageReason(sn.url());
  if (snAuth) throw new Error(`Not signed in — ${snAuth}. ${SIGN_IN_HINT}`);
  // Drop any leftover viewport emulation (from an older session or another
  // tool) so the workspace lays out at the window's real size. A stale override
  // is not cosmetic: it makes ServiceNow collapse the Details form, which is
  // what made early reads return only a handful of fields. We only ever CLEAR
  // an override here — we never impose one.
  //
  // Both steps are needed: setViewport(null) drops the override puppeteer is
  // managing for this connection, and the CDP clear removes one left behind by
  // a previous connection (a clear issued from a different session does not
  // reliably take effect on its own).
  await sn.setViewport(null).catch(() => {});
  const client = await sn.createCDPSession().catch(() => null);
  if (client) {
    await client.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await client.detach().catch(() => {});
  }
  return sn;
}

/** Hard navigation guard — throws unless the URL is https on the SN host. */
export function assertAllowed(url: string): void {
  if (!isAllowedUrl(url)) {
    throw new Error(
      `Blocked: this tool is locked to https://${CONFIG.serviceNowHost}. Refused URL: ${url}`,
    );
  }
}
