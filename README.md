# ServiceNowCase MCP

A **read-only** ServiceNow case reader exposed as a standard MCP server, for use
inside Claude Code (or any local MCP host). It lets a support/QA teammate
**search and read** ServiceNow case data — enough for the QA case form and
cross-case analysis — with a deliberately tiny, locked tool surface.

It borrows the Chrome **you** are already signed in to. There is no API key, no
service account, no stored credential of any kind.

---

## Security model (the whole point)

Safety comes from the **absence of dangerous tools**, not from instructions:

- **The only write is the search box.** There is no generic fill/click, no
  Save/Submit, no field editing. Those tools do not exist, so they cannot be
  invoked — not by the model, not by a prompt injection.
- **No code execution / no snooping.** No JavaScript eval, no network/cookie/
  console inspection. Session tokens are never surfaced. The DOM-reading
  expressions are fixed and authored in `read.ts`; nothing the model says can
  add to or alter them.
- **Navigation is hard-locked to one ServiceNow host** (`config.ts`). Any URL
  off that host is refused.
- **The server has zero external egress of its own.** No telemetry, no
  analytics, no update pings. Its only outbound connections are to your local
  Chrome (`127.0.0.1:9222`) and, through that browser, ServiceNow.
- **Special Handling Note popups are closed, never dismissed.** "Close dialog"
  is a benign UI close; "Dismiss note" would acknowledge the note — a real
  persistent write — and is never clicked.
- **Nothing is auto-closed or auto-reloaded.** When a workspace problem needs a
  tab closed or a reload, the tool *tells you*; it will not do it for you,
  because that could discard an unsent email draft.
- **The browser is only ever started because you asked.** Exactly one tool starts
  a process, it takes no arguments, and nothing invokes it on your behalf — not at
  startup, not on a failed read. Checking whether you are connected is a separate,
  side-effect-free tool, so asking the question never performs the action.
- **Keystrokes are gated on focus.** Text is only typed after confirming the
  ServiceNow search input genuinely holds focus, so a clear-and-type can never
  land in some other field.
- **Sent emails only.** `sn_open_record` reads an already-sent email, but refuses
  any row whose `Type` is not `sent` — a draft row opens the email **composer**,
  which this tool must never touch. The refusal happens *before* anything is
  clicked.
- **No cross-record bleed.** Only on-screen iframes are read. The workspace keeps
  previously opened records alive, and a hidden iframe would otherwise leak
  another record's text into what you are reading (a Special Handling note once
  appeared inside an email body).

> Note on data flow: the *server* sends nothing outside your org. But the host
> that runs it (Claude Code → Anthropic) sends the case content it reads to that
> model provider to analyze — identical to the existing chrome-devtools QA
> workflow. Run it only in a host whose model provider is inside your approved
> boundary.

---

## Connecting

You never have to run anything by hand. Just talk to it:

> **"Are we connected to ServiceNow?"**
> → *"No — the debug Chrome isn't running. Should I connect now?"*
> **"Yes"**
> → a Chrome window opens on ServiceNow, and you complete Okta/SSO sign-in in it.

Or go straight there with **"connect to ServiceNow"**.

Two rules make this predictable:

- **Asking never acts.** `sn_status` reports the state and starts nothing, so the
  question can always be answered honestly before anything happens.
- **Connecting is only ever your decision.** Nothing launches a browser on its own
  — not at startup, not when a read fails. A failed read says so and *offers*.

**Signing in is always yours to do.** No tool here can enter your credentials.

If the ServiceNow tab was closed but Chrome is still running (closing the window
does *not* stop Chrome), asking to connect reopens the tab in that same browser
rather than starting a second one.

---

## The 10 tools

| Tool | Access | Purpose |
|------|--------|---------|
| `sn_search(query)` | ✏️ write (search box only) | Type into the global search box, return results across record types |
| `sn_find_cases(query)` | read | Cross-case search → de-duplicated list of case matches |
| `sn_open_case(number)` | read | Open a case by number (`CS#######`, format-enforced) |
| `sn_read_case()` | read | Read the open record: a case's header + Details fields **+ its activity stream** (work notes, comments, field changes, emails), or — when a panel row is open — that **sub-record**, including rich text held in an iframe |
| `sn_open_panel(name)` | read | Open a related panel by label |
| `sn_read_panel()` | read | Read the open panel (or report it empty) |
| `sn_open_record(target)` | read | Open a record **listed in the current panel** (scoped, not a generic click) |
| `sn_launch_browser()` | starts Chrome | **Connect.** Start the dedicated debug Chrome (or reopen its ServiceNow tab) so you can sign in. **No arguments** |
| `sn_status()` | read (local port only) | Answer "are we connected?" — reports the state and **starts nothing** |
| `sn_case_bundle(number, part?)` | read | **The whole case in one call:** fields + **every** activity post, then the SLAs, Dispatch Orders, Emails (**every** row, plain-text bodies) and Special handling notes panels incl. each note's body, compacted. Every section carries a STATUS (OK / EMPTY / UNREAD / NOT FOUND; `partial` = read but incomplete); stale or unloaded reads are retried automatically. A large case comes back in parts (`part=2`, …) |

### About `sn_case_bundle`

Reading a case step by step (open, read, open panel, read panel ×4, open each SHI
note, go back) takes about 13 tool calls, and every call re-sends the whole
conversation to the model. `sn_case_bundle` does the same reads in one call, in a
fixed server-authored order, with the re-read rules built in. **It adds no write
capability**: the only thing it types into is the search box, to open the case.

- **Complete.** It waits until the case has really rendered (and closes the Special
  Handling pop-up with "Close dialog", never "Dismiss note"), then reads **every**
  activity post — the stream renders only ~20 until it is scrolled, so the bundle
  scrolls it — and **every** Emails / SLAs / Dispatch Orders row, paging with "Next
  page" and putting the list back on page 1. If anything still could not be read,
  the STATUS says so (`OK (partial: 50 of 121 activity posts read …)`, `UNREAD (…)`);
  it never says OK for an incomplete read, and a panel that had not rendered is
  UNREAD, never NOT FOUND.
- **Compact.** Email HTML becomes plain text; automated "has been created / resolved /
  closed" mail keeps its subject and recipients but drops its body; then
  `src/compact.ts` shows repeated text once with a pointer (`[body: see Emails row 3]`)
  and drops support footers, banners and disclaimers. `node scripts/compact-check.mjs`
  checks its invariants offline on saved bundles.
- **Never spills.** A bundle over 42,000 characters comes back in parts: part 1 ends
  with `[PART 1 of N — call sn_case_bundle again with the same number and part=2 …]`.
  Part 1 holds the case, SLAs, Dispatch Orders and SHI notes; part 2 the Emails. Only
  when part 1 would still be too long do the oldest activity posts move on, after the
  Emails (into part 3 if needed). Later parts come from an in-memory copy of that read
  (15 minutes, same server process), or from a fresh read if there is none.
- It ends back on the case (one step back in the tab's history from an SHI note),
  and a footer times each step: `[bundle finished in 61s: open 7s, case 20s, …]`.

Use it for QA reviews, escalation reports and any single-case analysis; the
single-step tools remain for anything else, and their output is unchanged.

### About `sn_status`

It exists so that **connecting stays your decision**. `sn_launch_browser` cannot
answer "are we connected?", because when the browser is absent its whole job is to
start one — asking the question would perform the action.

`sn_status` is the most limited tool here: it makes a single request to the local
debug port, the same one the server already uses. It cannot see a page, cannot
navigate, and reads no ServiceNow data of any kind.

### About `sn_launch_browser`

This is the **only** tool that starts a process, and it exists because **Claude
Desktop has no terminal** — a Desktop user cannot run
`launch-debug-chrome.ps1`, which made the MCP unusable there rather than merely
awkward. Ask to connect to ServiceNow and it opens the browser for sign-in.

It runs **only when you ask to connect.** Nothing invokes it automatically — not
at startup, and not when a read fails for want of a browser. A failed read reports
that plainly and offers to connect.

It is deliberately the narrowest possible tool:

- **Takes no arguments.** The model cannot choose the program, the flags, the
  profile directory or the URL — all are server-authored in `src/launch.ts`.
- **Starts Chrome only**, on the dedicated debug profile, at your ServiceNow
  host. It cannot launch anything else or point anywhere else.
- **Never closes or kills a browser.** If a debug Chrome is already running, no
  second browser is started. If that browser has lost its ServiceNow tab, the tab
  is reopened *inside it* — nothing is closed, killed or replaced.
- **Cannot sign you in.** Credentials are only ever typed by you, in the browser.

Override the Chrome binary or profile with `SNC_CHROME_PATH` / `SNC_CHROME_PROFILE`
if yours live somewhere unusual.

### Query shapes that actually work

`sn_find_cases` is free-text on purpose — it is the cross-case half of the tool.
What works, measured live:

| Query | Result |
|-------|--------|
| Asset / array name (e.g. `ARRAY-01-SERIAL`) | **Best for cross-case work** — returns sibling cases on the same array |
| Exact case number | ServiceNow jumps *straight to that record* instead of listing; the tool says so and tells you to `sn_read_case` |
| Short-description text | Works |
| Account name | **Does not return cases** — global search only matches indexed case fields |

`sn_open_case` is the strict one: it accepts `^CS\d{6,}$` and nothing else.

---

## Setup (per teammate, ~5 minutes)

### Windows: one command

```powershell
git clone https://github.com/jsalas-Work/servicenowcase-mcp.git
cd servicenowcase-mcp
.\scripts\install.ps1
```

That builds it, runs the tool-surface gate, registers it with Claude Code and the
Claude Desktop app, **and adds the permission rules so the read-only tools stop
asking for confirmation on every call** (see below for why that matters). Then
restart Claude and say *"connect to ServiceNow"*.

It is safe to re-run: every config edit is a merge, a `.bak` is written first, and
already-present settings are left alone. Quit the Claude Desktop app before
running it — Desktop rewrites its own config while running, so the script skips
that step rather than risk clobbering it.

The rest of this section is the manual equivalent, and applies to macOS.

### 1. Install

```bash
git clone https://github.com/jsalas-Work/servicenowcase-mcp.git
cd servicenowcase-mcp
npm install
npm run build
npm run smoke      # gate: must print "exactly 10 tools"
```

### 2. Connect (sign in to ServiceNow)

**The easy way: just ask.** Say **"connect to ServiceNow"** and the browser opens for
you; say **"are we connected to ServiceNow?"** to check without starting anything. That
works in Claude Desktop too, which has no terminal. The rest of this section is the
manual equivalent, useful when you want to inspect the state yourself.

Signing in is **usually** once per working session — but the SSO session can lapse
(particularly if the debug Chrome exits uncleanly), so you may be asked to sign in again
mid-session. That is normal. The tools detect it and say
`ACTION NEEDED: sign in to ServiceNow again` rather than returning empty results, so a
lapsed session is never mistaken for "this case has no data".

> **⚠️ First-time install — do step 3 BEFORE this step.**
> Registering the MCP requires restarting Claude Code, and **restarting Claude Code can
> terminate the debug Chrome you just launched**, leaving you with a dead port and a
> `Failed to fetch browser webSocket URL from http://127.0.0.1:9222` on your first tool
> call. So on a fresh install: register the server (step 3) → restart Claude Code →
> *then* launch debug Chrome and sign in.
>
> On subsequent sessions the order doesn't matter — the server is already registered, so
> just launch Chrome and go.
>
> **If a tool reports no browser or no ServiceNow tab, just re-run the launch script** — it
> now inspects a running debug Chrome and tells you exactly which state you are in
> (ready / signed out / no ServiceNow tab):
>
> ```powershell
> .\scripts\launch-debug-chrome.ps1            # reports the state
> .\scripts\launch-debug-chrome.ps1 -OpenTab   # also reopens the ServiceNow tab for you
> ```
>
> **Closing the Chrome window does not stop Chrome.** The process keeps the debug port
> open with no ServiceNow tab, which is why the script will not start a second browser in
> that state — use `-OpenTab`, or fully quit Chrome first.

**Windows (helper script — recommended):**

```powershell
.\scripts\launch-debug-chrome.ps1
```

**Any platform (equivalent, by hand):**

```bash
# Windows
chrome.exe --remote-debugging-port=9222 ^
  --user-data-dir="D:\path\to\servicenowcase-mcp\.chrome-debug-profile" ^
  --disable-features=CalculateNativeWinOcclusion ^
  --disable-backgrounding-occluded-windows

# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$PWD/.chrome-debug-profile" \
  --disable-backgrounding-occluded-windows
```

Then **sign in to ServiceNow via SSO in that window** and leave the workspace tab
open. The MCP attaches to that tab; it never launches its own browser.

Why the dedicated `--user-data-dir`: a debugging port on your everyday profile
would expose your whole browsing session to anything that can reach the port. A
separate profile scopes it to ServiceNow.

Why the occlusion flags: ServiceNow will not render its **search results** page
while Chrome considers the tab hidden — and Chrome counts a fully-covered window
as hidden. The server already works around this per operation, so the flags are
*optional*; they simply remove the failure mode at the source. Record reads are
unaffected either way.

### 3. Point your Claude at it

Two hosts are supported, and they use **separate registries** — registering in one
does *not* register in the other. Follow the section for the host you actually use.

> **This is a local MCP server, not a connector and not a plugin.**
> It runs as a process on your own machine and talks to the Chrome on your own
> machine. Remote **connectors** run in Anthropic's cloud and cannot reach your
> `127.0.0.1:9222`, so this will never work as one — no amount of waiting on
> "installing…" will change that. If you were pointed at a `.plugin` bundle or told
> to look in the connectors list, that route is abandoned; use the config below.

#### 3a. Claude Code (CLI / IDE)

Project-scoped — create `.mcp.json` in the repo you work from:

```json
{
  "mcpServers": {
    "servicenowcase": {
      "command": "node",
      "args": ["D:/path/to/servicenowcase-mcp/dist/index.js"],
      "env": {
        "SNC_HOST": "pure.service-now.com",
        "SNC_BROWSER_URL": "http://127.0.0.1:9222"
      }
    }
  }
}
```

Or user-scoped (available in every project), from the CLI:

```bash
claude mcp add servicenowcase --scope user \
  --env SNC_HOST=pure.service-now.com \
  --env SNC_BROWSER_URL=http://127.0.0.1:9222 \
  -- node /abs/path/to/servicenowcase-mcp/dist/index.js
```

> **⚠️ Windows / PowerShell caveat.** Run that command from **Git Bash**, not PowerShell.
> PowerShell 5.1 swallows the `--` separator, so the command fails with:
>
> ```
> error: missing required argument 'commandOrUrl'
> ```
>
> The command itself is correct — only the shell is at fault. From PowerShell, use
> `add-json` instead (single-quoted JSON survives intact):
>
> ```powershell
> claude mcp add-json servicenowcase '{"command":"node","args":["D:/path/to/servicenowcase-mcp/dist/index.js"],"env":{"SNC_HOST":"pure.service-now.com","SNC_BROWSER_URL":"http://127.0.0.1:9222"}}' --scope user
> ```

**Restart Claude Code** — MCP servers do not hot-load; a server registered mid-session
will not appear until you restart. Then check with `/mcp` that `servicenowcase` is
connected and lists 10 tools. **After the restart, launch debug Chrome (step 2)** — see the
ordering warning there.

Verifying registration matters: `npm run smoke` and `npm run accept` drive the server
directly and **pass even when the server was never registered with Claude Code at all.**
Neither one proves your host can see it. `/mcp` showing 10 tools is the only proof.

#### 3b. Claude Desktop app

Claude Desktop has no CLI, so you edit its config file by hand.

**Step 1 — find the right config file.** On Windows there are two possible
locations and **picking the wrong one fails silently**: a config written to the
wrong path is simply never read, with no error anywhere. Which one applies depends
on how Claude Desktop was installed.

Check your install type first:

```powershell
Get-AppxPackage -Name *laude*        # prints a package => Microsoft Store / MSIX install
```

| Install type | Config file |
|---|---|
| **Microsoft Store / MSIX** (the `Get-AppxPackage` command prints something) | `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json` |
| **Normal installer** (nothing printed) | `%APPDATA%\Claude\claude_desktop_config.json` |
| **macOS** | `~/Library/Application Support/Claude/claude_desktop_config.json` |

A Store install **virtualizes** `%APPDATA%`, which is why the widely-documented
`%APPDATA%\Claude\` path is inert there. That path may even already contain a
config file — it still does nothing.

**Step 2 — merge, don't overwrite.** The file usually already holds your other
servers and preferences. Back it up first, and **quit Claude Desktop before
editing** — it rewrites this file while running, so an edit made with the app open
can be clobbered.

```powershell
$cfg = "$env:LOCALAPPDATA\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json"
Copy-Item $cfg "$cfg.bak"
```

Add this server inside the existing `mcpServers` object:

```json
{
  "mcpServers": {
    "servicenowcase": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\path\\to\\servicenowcase-mcp\\dist\\index.js"],
      "env": {
        "SNC_HOST": "pure.service-now.com",
        "SNC_BROWSER_URL": "http://127.0.0.1:9222"
      }
    }
  }
}
```

Use the **absolute path to `node.exe`**, not bare `node` — Desktop launches from
Explorer and may not inherit your `PATH`. On macOS use the output of `which node`.

**Step 3 — restart Claude Desktop, then verify from the logs.** Don't judge this
from the UI. The logs sit in a `logs\` folder next to the config file:

- `logs\mcp.log` — look for `servicenowcase` → **`Server started and connected
  successfully`**, followed by `initialize` and `tools/list`. That is the proof.
- `logs\mcp-server-servicenowcase.log` — this is Desktop's **INFO** log for the
  server (it starts with a `PATH` dump and mirrors protocol traffic), *not* an
  error-only log. Its size tells you nothing about health — read the contents.

If `mcp.log` has no `servicenowcase` entry at all, Desktop never read your config:
you almost certainly edited the wrong path — go back to step 1.

Then just ask Claude to open a case. If the debug Chrome isn't running it will
offer to start it (`sn_launch_browser`) and tell you to sign in.

#### 3c. Stop the permission prompts

By default Claude asks for confirmation before **every** tool call. A single QA
review makes dozens — open case, read case, open panel, read panel, open record,
search — so without this you spend the review clicking *Allow* instead of reading
the case. `.\scripts\install.ps1` does this for you; here it is by hand.

Add to `~/.claude/settings.json` (merge with what's already there):

```json
{
  "permissions": {
    "allow": [
      "mcp__servicenowcase__sn_status",
      "mcp__servicenowcase__sn_open_case",
      "mcp__servicenowcase__sn_read_case",
      "mcp__servicenowcase__sn_open_panel",
      "mcp__servicenowcase__sn_read_panel",
      "mcp__servicenowcase__sn_open_record",
      "mcp__servicenowcase__sn_search",
      "mcp__servicenowcase__sn_find_cases",
      "mcp__servicenowcase__sn_case_bundle"
    ]
  }
}
```

**`sn_launch_browser` is deliberately not on that list.** It is the only tool that
starts a process, and connecting is meant to stay an explicit decision — so it
keeps prompting. Everything allow-listed above only reads.

Note that `sn_search` and `sn_find_cases` are included even though they type into
the search box. That write is ephemeral and changes no record data, and the two
tools perform the same underlying action, so allow-listing one without the other
would be arbitrary.

**Claude Desktop has no permission-rules file.** There, click **"Always allow"**
the first time each tool is used.

### Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `SNC_HOST` | `pure.service-now.com` | The **only** host the server will read or navigate to |
| `SNC_BROWSER_URL` | `http://127.0.0.1:9222` | Where to find your debug Chrome |
| `SNC_BROWSER_WS` | *(empty)* | Explicit CDP WebSocket endpoint; overrides the URL |
| `SNC_CHROME_PATH` | *(auto-detected)* | Full path to `chrome.exe` / Chrome, if yours lives somewhere unusual |
| `SNC_CHROME_PROFILE` | `.chrome-debug-profile` | Where the dedicated debug profile lives |
| `SNC_TEST_CASES` | *(none)* | **Testing only.** Comma-separated case numbers for `npm run accept` |
| `SNC_TEST_SYS_ID` | *(none)* | **Testing only.** Record sys_id for `live-test.mjs freshopen` |

---

## Typical use

```
sn_case_bundle CS1234567   → everything about the case, one call

# or step by step:
sn_open_case CS1234567     → opens it
sn_read_case               → header + ~58 Details fields
sn_open_panel "Special Handling Notes List"
sn_read_panel              → the SHI notes, or "empty"
sn_find_cases <array name> → sibling cases on the same asset
```

---

## Updating

When this repo gets a new version (for example a new tool), each teammate runs:

```powershell
cd <your clone of servicenowcase-mcp>
git pull
.\scripts\install.ps1
```

Then **fully restart Claude** (Claude Code and Claude Desktop only load MCP servers
at startup). `install.ps1` rebuilds, re-runs the tool-surface gate and adds any new
read-only tool to the permission allow-list. Or just ask Claude: *"update the
ServiceNowCase MCP from its GitHub repo"*.

---

## Troubleshooting

**It sits on "installing", or never shows up in the connectors list.**
You are trying to install it as a *connector* or a *plugin*. It is neither — it is
a **local MCP server**, and a cloud-hosted connector could not reach your local
Chrome even if it did install. Delete whatever plugin/connector entry you added and
follow step 3 above.

**Claude Desktop shows no sign of the server.**
Check `logs\mcp.log` next to your config file. No `servicenowcase` line at all
means Desktop never read your config — on a Microsoft Store install the
`%APPDATA%\Claude\` path is inert; use the `%LOCALAPPDATA%\Packages\...` one. See
step 3b.

**Claude Code doesn't list the tools.**
MCP servers do not hot-load — restart Claude Code. `npm run smoke` passing proves
nothing about registration; only `/mcp` showing 10 tools does.

**"No case rows found" / empty search results.**
Check whether the output includes the hidden-tab warning. ServiceNow does not
render search results while its tab is hidden (minimised or fully covered by
another window). The server raises the tab and emulates focus to work around it;
if it still cannot, it says so explicitly rather than implying no cases exist.
An empty result carrying that warning means *unknown*, *not* "none". Restore the
Chrome window, or relaunch it with the occlusion flags above.

**`sn_read_case` returns 0 fields and 0 header fields.**
The workspace sometimes stops laying out record forms entirely — seen with
several case tabs open. The tool detects this and reports it. Close the case tabs
you don't need **in the browser**, or reload the workspace tab, then read again.
The tool deliberately will not do this for you (you may have an unsent draft).
Note: 3 open case tabs does not *always* break it; the count is a hint, not a
diagnosis.

**Reads suddenly return only a handful of fields.**
Suspect a leftover viewport override first — a stale Chrome device-metrics
override makes the Configurable Workspace collapse the whole Details form. Fix:

```bash
node scripts/clear-override.mjs    # force-clears and verifies
```

**"!! STALE READ ABORTED !!"**
Working as designed. The workspace keeps every previously opened case alive in
the DOM, so the tool cross-checks the form's own `Number` against the workspace
tab strip and refuses to report values when they disagree. Re-open the case you
want and read again.

**Fields listed under "Declared but NOT readable".**
Not empty — *unread*. ServiceNow never instantiated those controls in that
layout (commonly `comments`, `work_notes`, `close_notes`). Get work notes and
comments from the activity stream, and the short description from the record
title. Which fields land here varies between reads of the same case.

**A Special Handling note opens but its body is empty.**
Known limitation. The sub-record pane is transient, and an SHI note's rich-text
iframe occasionally isn't captured. The read says so explicitly — it reports the
body as **unread, never as empty** — and simply calling `sn_read_case` again has
always returned it. Sent-email bodies are not affected.

**"No pure.service-now.com tab found."**
The debug Chrome isn't running, isn't signed in, or is on a different port than
`SNC_BROWSER_URL`. Re-run the launch script.

**Small screens.** Below roughly 1360×660 the workspace collapses the Details
form. The tool enlarges the window when it can and warns when the screen won't
allow it.

---

## Build & test

```bash
npm run build            # tsc
npm run smoke            # surface gate: exactly 10 tools
npm run accept           # full gate: drives every tool over the real MCP protocol
node scripts/live-test.mjs read                  # read the open case
node scripts/live-test.mjs findcases "<query>"   # cross-case search
node scripts/live-test.mjs opencase CS1234567    # search + open
```

`npm run accept` is the exit gate: it drives all 10 tools against the cases you
give it and prints a PASS/WARN/FAIL checklist. **No real case numbers are
committed to this repo** — supply your own:

```bash
npm run accept -- CS1234567 CS7654321          # on the command line
SNC_TEST_CASES=CS1234567,CS7654321 npm run accept   # or by env var
echo '["CS1234567","CS7654321"]' > accept.cases.json  # or a local, gitignored file
```

Run with none of those and it tells you so and exits, rather than testing
nothing. Warnings are normal where a case
genuinely lacks a panel — those are facts about the case, not defects. Extend
`accept.mjs` rather than adding one-off probe scripts.

> **Both gates encode the tool count.** If you add or remove a tool, update
> `smoke-tools.mjs` *and* `accept.mjs` — otherwise the exit gate silently stops
> matching the real surface. (That happened once: `accept.mjs` sat at 7 for days
> after the 8th tool shipped.)

`npm run smoke` and `npm run accept` both drive the server directly, so they pass
even when it was never registered with your MCP host. Neither proves your host can
see it.

---

## Status

Complete and in use. The 9-tool surface is gated by `npm run smoke`; `npm run
accept` drives all of it over the real MCP protocol and passes.

Validated end-to-end against two known-good cases — including a full QA-form
fill from MCP data alone, which matched the human baselines exactly. Verified
running under **both Claude Code and the Claude Desktop app**. (The case numbers
themselves are customer identifiers and are kept out of this repo; see
`npm run accept` below for how to point it at your own.)

Known limitation: a Special Handling note body occasionally comes back empty. It
is always reported as *unread*, never as *empty*, and reading again has always
returned it.
