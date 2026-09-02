// Force-clear any leftover viewport emulation and confirm the page is back to
// the real window size. Read-only apart from removing an override.
import { getServiceNowPage } from "../dist/browser.js";

const page = await getServiceNowPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function metrics() {
  const c = await page.createCDPSession();
  try {
    const r = await c.send("Runtime.evaluate", {
      expression:
        "JSON.stringify({ iw: innerWidth, ih: innerHeight, sw: screen.width, sh: screen.height })",
      returnByValue: true,
    });
    return r.result.value;
  } finally {
    await c.detach().catch(() => {});
  }
}

console.log("before:", await metrics());
console.log("puppeteer viewport:", JSON.stringify(page.viewport()));

// 1. puppeteer-level: detach any viewport emulation it is managing
await page.setViewport(null).catch((e) => console.log("setViewport(null):", e.message));
// 2. CDP-level clear
const c = await page.createCDPSession();
await c.send("Emulation.clearDeviceMetricsOverride").catch((e) => console.log("clear err:", e.message));
await c.send("Emulation.setDeviceMetricsOverride", {
  width: 0, height: 0, deviceScaleFactor: 0, mobile: false,
}).catch(() => {});
await c.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
// 3. focus emulation: the search path enables this briefly (ServiceNow won't
// render search results while the tab counts as hidden) and always turns it back
// off. Clear it here too, so a killed process can't leave it on.
await c.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
await c.detach().catch(() => {});
await sleep(2500);

console.log("after: ", await metrics());
console.log("puppeteer viewport:", JSON.stringify(page.viewport()));
process.exit(0);
