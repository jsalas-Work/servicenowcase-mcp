// Live Phase 2 test: attach to the debug Chrome (9222) and exercise the read
// functions directly against whatever ServiceNow case is open.
// Usage: node scripts/live-test.mjs [step]
//   probe        -> show the current ServiceNow tab url/title
//   read         -> sn_read_case
//   panel <name> -> sn_open_panel then sn_read_panel
//   record <t>   -> sn_open_record (index or label) then sn_read_case
import { getServiceNowPage } from "../dist/browser.js";
import { readCase, openPanel, readPanel, openRecord, typeInSearch, openCaseFromSearch, openCaseByNumber, handleShiPopup, searchAndRead, findCases } from "../dist/read.js";

const [, , step = "probe", ...rest] = process.argv;

const page = await getServiceNowPage();

if (step === "probe") {
  console.log("URL:", page.url());
  console.log("Title:", await page.title());
} else if (step === "opencase") {
  // Same path sn_open_case uses (visibility-wrapped search + open).
  console.log(await openCaseByNumber(page, rest.join(" ")));
  console.log("URL now:", page.url());
} else if (step === "clickresult") {
  console.log(await openCaseFromSearch(page, rest.join(" ")));
} else if (step === "fields1") {
  const t0 = Date.now();
  const client = await page.createCDPSession();
  await client.send("Accessibility.enable");
  const { nodes } = await client.send("Accessibility.getFullAXTree");
  await client.detach().catch(() => {});
  const fields = [];
  for (const n of nodes) {
    const role = n.role?.value ?? "";
    if (role !== "textbox" && role !== "combobox") continue;
    const name = (n.name?.value ?? "").toString().split(/\.\s/)[0].trim();
    if (!name) continue;
    fields.push(`${name} = ${(n.value?.value ?? "").toString().slice(0, 50)}`);
  }
  console.log(`nodes=${nodes.length} fields=${fields.length} in ${Date.now() - t0}ms`);
  console.log(fields.join("\n"));
} else if (step === "tallread") {
  const h = Number(rest[0] || 3000);
  await page.setViewport({ width: 1500, height: h }).catch((e) => console.log("viewport err", e.message));
  await new Promise((r) => setTimeout(r, 1500));
  const t0 = Date.now();
  const client = await page.createCDPSession();
  await client.send("Accessibility.enable");
  const { nodes } = await client.send("Accessibility.getFullAXTree");
  await client.detach().catch(() => {});
  const fields = [];
  for (const n of nodes) {
    const role = n.role?.value ?? "";
    if (role !== "textbox" && role !== "combobox") continue;
    const name = (n.name?.value ?? "").toString().split(/\.\s/)[0].trim();
    if (!name) continue;
    fields.push(`${name} = ${(n.value?.value ?? "").toString().slice(0, 50)}`);
  }
  console.log(`viewportH=${h} nodes=${nodes.length} fields=${fields.length} in ${Date.now() - t0}ms`);
  console.log(fields.join("\n"));
} else if (step === "formread") {
  const client = await page.createCDPSession();
  await client.send("Accessibility.enable");
  await client.send("DOM.enable");
  const merged = new Map();
  const grab = async () => {
    const { nodes } = await client.send("Accessibility.getFullAXTree");
    for (const n of nodes) {
      const role = n.role?.value ?? "";
      if (role !== "textbox" && role !== "combobox") continue;
      const name = (n.name?.value ?? "").toString().split(/\.\s/)[0].trim();
      if (!name) continue;
      const val = (n.value?.value ?? "").toString().trim();
      if (!merged.has(name) || (!merged.get(name) && val)) merged.set(name, val);
    }
    return nodes;
  };
  const nodes = await grab();
  const numNode = nodes.find(
    (n) => n.role?.value === "textbox" && (n.name?.value || "").startsWith("Number"),
  );
  if (!numNode) { console.log("no Number field found"); process.exit(0); }
  const { object } = await client.send("DOM.resolveNode", { backendNodeId: numNode.backendDOMNodeId });
  const contRes = await client.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration:
      "function(){let e=this;while(e){try{if(e.scrollHeight>e.clientHeight+30)return e;}catch(_){}"+
      "e=e.parentElement||(e.getRootNode&&e.getRootNode().host)||null;}return null;}",
    returnByValue: false,
  });
  const contId = contRes.result?.objectId;
  console.log("scroll container found:", !!contId);
  if (contId) {
    for (let top = 0; top < 9000; top += 500) {
      await client.send("Runtime.callFunctionOn", { objectId: contId, functionDeclaration: `function(){this.scrollTop=${top};}` });
      await new Promise((r) => setTimeout(r, 170));
      await grab();
    }
  }
  await client.detach().catch(() => {});
  console.log(`fields=${merged.size}`);
  console.log([...merged].map(([k, v]) => `${k}: ${v}`).join("\n"));
} else if (step === "freshopen") {
  // A record sys_id identifies a real case, so none is committed. Pass one:
  //   node scripts/live-test.mjs freshopen <sys_id>
  //   SNC_TEST_SYS_ID=<sys_id> node scripts/live-test.mjs freshopen
  const sysId = (process.argv[3] ?? process.env.SNC_TEST_SYS_ID ?? "").trim();
  if (!/^[0-9a-f]{32}$/i.test(sysId)) {
    console.error(
      "freshopen needs a record sys_id (32 hex chars). None is committed in this repo.
" +
        "  node scripts/live-test.mjs freshopen <sys_id>
" +
        "  SNC_TEST_SYS_ID=<sys_id> node scripts/live-test.mjs freshopen",
    );
    process.exit(2);
  }
  const url = `https://${process.env.SNC_HOST ?? "pure.service-now.com"}/now/cwf/agent/record/ps_customerservice_ts_case/${sysId}`;
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch((e) => console.log("goto err", e.message));
  console.log("waiting for SPA render...");
  await new Promise((r) => setTimeout(r, 9000));
  const popup = await handleShiPopup(page);
  console.log("popup:", popup ? `${popup.length} chars captured` : "none");
  await new Promise((r) => setTimeout(r, 1500));
  const client = await page.createCDPSession();
  await client.send("Accessibility.enable");
  const { nodes } = await client.send("Accessibility.getFullAXTree");
  await client.detach().catch(() => {});
  const fields = [];
  const tabs = [];
  for (const n of nodes) {
    const role = n.role?.value ?? "";
    const name = (n.name?.value ?? "").toString().split(/\.\s/)[0].trim();
    if ((role === "textbox" || role === "combobox") && name)
      fields.push(`${name} = ${(n.value?.value ?? "").toString().slice(0, 45)}`);
    if (role === "tab" && name) tabs.push(name);
  }
  console.log(`nodes=${nodes.length} fields=${fields.length} tabs=${tabs.length}`);
  console.log("TABS:", tabs.join(" | "));
  console.log("FIELDS:\n" + fields.join("\n"));
} else if (step === "cleanread") {
  const c0 = await page.createCDPSession();
  await c0.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await c0.detach().catch(() => {});
  await page.reload({ waitUntil: "domcontentloaded" }).catch((e) => console.log("reload err", e.message));
  await new Promise((r) => setTimeout(r, 4000));
  const popup = await handleShiPopup(page);
  console.log("popup captured:", popup ? `${popup.length} chars` : "none");
  await new Promise((r) => setTimeout(r, 1000));
  const client = await page.createCDPSession();
  await client.send("Accessibility.enable");
  const { nodes } = await client.send("Accessibility.getFullAXTree");
  await client.detach().catch(() => {});
  const fields = [];
  for (const n of nodes) {
    const role = n.role?.value ?? "";
    if (role !== "textbox" && role !== "combobox") continue;
    const name = (n.name?.value ?? "").toString().split(/\.\s/)[0].trim();
    if (!name) continue;
    fields.push(`${name} = ${(n.value?.value ?? "").toString().slice(0, 45)}`);
  }
  console.log(`after clean reload: nodes=${nodes.length} fields=${fields.length}`);
  console.log(fields.join("\n"));
} else if (step === "controls") {
  const client = await page.createCDPSession();
  await client.send("Accessibility.enable");
  const { nodes } = await client.send("Accessibility.getFullAXTree");
  for (const n of nodes) {
    const role = n.role?.value ?? "";
    if (["button", "link", "menuitem", "tab", "dialog"].includes(role)) {
      console.log(`${role}: ${(n.name?.value ?? "").toString().slice(0, 80)}`);
    }
  }
  await client.detach().catch(() => {});
} else if (step === "dump") {
  // Diagnostic: role histogram + any node mentioning the query, across all frames.
  const q = (rest.join(" ") || "1290739").toLowerCase();
  await new Promise((r) => setTimeout(r, 2000));
  const frames = page.frames();
  console.log("frames:", frames.length);
  for (const fr of frames) {
    let nodes = [];
    try {
      const client = await page.createCDPSession();
      await client.send("Accessibility.enable");
      // Target this frame's tree if possible; fall back to default.
      const res = await client.send("Accessibility.getFullAXTree").catch(() => ({ nodes: [] }));
      nodes = res.nodes || [];
      await client.detach().catch(() => {});
    } catch {}
    if (!nodes.length) continue;
    const hist = {};
    const hits = [];
    for (const n of nodes) {
      const role = n.role?.value ?? "";
      hist[role] = (hist[role] || 0) + 1;
      const name = (n.name?.value ?? "").toString();
      if (name.toLowerCase().includes(q)) hits.push(`${role}: ${name.slice(0, 90)}`);
    }
    console.log(`\n[frame ${fr.url().slice(0, 70)}] nodes=${nodes.length}`);
    console.log("roles:", Object.entries(hist).sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r}:${c}`).join(" "));
    if (hits.length) console.log("MATCHES:\n" + hits.slice(0, 15).join("\n"));
  }
} else if (step === "search") {
  console.log(await searchAndRead(page, rest.join(" ")));
} else if (step === "findcases") {
  console.log(await findCases(page, rest.join(" ")));
} else if (step === "read") {
  console.log(await readCase(page));
} else if (step === "panel") {
  console.log(await openPanel(page, rest.join(" ")));
  console.log("----");
  console.log(await readPanel(page));
} else if (step === "record") {
  const t = rest.join(" ");
  const target = /^\d+$/.test(t) ? Number(t) : t;
  console.log(await openRecord(page, target));
  console.log("----");
  console.log(await readCase(page));
}

process.exit(0);
