/**
 * Central config + hard security invariants for the ServiceNowCase MCP.
 *
 * Security model (see README): safety comes from the ABSENCE of dangerous
 * tools, reinforced by two hard locks enforced here:
 *   1. Navigation is locked to a single ServiceNow host.
 *   2. The MCP makes NO outbound network calls of its own — it only drives a
 *      browser that is already connected. Nothing here phones home.
 *
 * Everything is overridable by environment variable so each teammate can point
 * it at their own browser without editing code.
 */
export const CONFIG = {
  /** The ONLY host this MCP is ever allowed to navigate to or read from. */
  serviceNowHost: process.env.SNC_HOST ?? "pure.service-now.com",

  /**
   * How to reach the user's already-running, already-logged-in Chrome.
   * Prefer an explicit ws endpoint; otherwise discover it from the debug URL
   * (Chrome launched with --remote-debugging-port).
   */
  browserWSEndpoint: process.env.SNC_BROWSER_WS ?? "",
  browserDebugURL: process.env.SNC_BROWSER_URL ?? "http://127.0.0.1:9222",

  /** Accepted case-number shape, e.g. CS1234567. */
  caseNumberPattern: /^CS\d{6,}$/i,

  /** ServiceNow table names we understand (recon, Phase 0). */
  tables: {
    case: "ps_customerservice_ts_case",
    specialHandling: "sn_shn_notes",
  },
} as const;

/** True only for https URLs on the one allowed ServiceNow host. */
export function isAllowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === CONFIG.serviceNowHost;
  } catch {
    return false;
  }
}
