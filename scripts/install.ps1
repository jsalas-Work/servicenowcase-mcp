<#
.SYNOPSIS
  One-command setup for ServiceNowCase MCP on Windows.

.DESCRIPTION
  Builds the server, registers it with whichever Claude you have, and adds the
  permission allow-rules so the read-only tools stop asking for confirmation on
  every single call.

  That last part is the reason this script exists. Without it, every teammate
  gets a permission prompt for each case read, panel open and search - dozens per
  QA review - which destroys the continuity the tool is supposed to provide. It
  is not something each person should have to discover and hand-edit.

  WHAT IT WILL NOT DO:
    - It never overwrites a config file. Every edit is a MERGE, and a .bak copy
      is written first.
    - It does not allow-list sn_launch_browser. That is the only tool that starts
      a process, and connecting is meant to stay an explicit user decision, so it
      keeps prompting on purpose.
    - It cannot silence prompts in the Claude DESKTOP app - Desktop has no
      permission-rules file. There you click "Always allow" once per tool.

.PARAMETER SkipBuild
  Skip npm install / build / smoke (use when you have just built).

.EXAMPLE
  .\scripts\install.ps1
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $repo "dist\index.js"

function Say($msg)  { Write-Host $msg }
function Ok($msg)   { Write-Host "  [OK]   $msg" }
function Warn($msg) { Write-Host "  [WARN] $msg" }
function Info($msg) { Write-Host "  [ .. ] $msg" }

# The read-only surface. sn_launch_browser is deliberately ABSENT - see above.
$ALLOW_RULES = @(
  "mcp__servicenowcase__sn_status",
  "mcp__servicenowcase__sn_open_case",
  "mcp__servicenowcase__sn_read_case",
  "mcp__servicenowcase__sn_open_panel",
  "mcp__servicenowcase__sn_read_panel",
  "mcp__servicenowcase__sn_open_record",
  "mcp__servicenowcase__sn_search",
  "mcp__servicenowcase__sn_find_cases",
  "mcp__servicenowcase__sn_case_bundle"
)

# Read a JSON config, or an empty object if it does not exist yet. Fails loudly
# on malformed JSON rather than silently replacing someone's settings.
function Read-JsonConfig($path) {
  if (-not (Test-Path $path)) { return (New-Object PSObject) }
  $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  if (-not $raw.Trim()) { return (New-Object PSObject) }
  try { return $raw | ConvertFrom-Json }
  catch { throw "$path is not valid JSON. Fix or move it, then re-run. ($($_.Exception.Message))" }
}

# Always UTF-8 WITHOUT a BOM. Set-Content/Out-File in PowerShell 5.1 will happily
# write the wrong encoding and mangle every non-ASCII character in the file.
function Write-JsonConfig($path, $obj) {
  $dir = Split-Path -Parent $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  if (Test-Path $path) { Copy-Item $path "$path.bak" -Force }
  $json = $obj | ConvertTo-Json -Depth 32
  [System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Ensure-Property($obj, $name, $default) {
  if (-not $obj.PSObject.Properties[$name]) {
    $obj | Add-Member -NotePropertyName $name -NotePropertyValue $default
  }
  return $obj.$name
}

Say ""
Say "ServiceNowCase MCP - setup"
Say "=========================="
Say "Repo: $repo"
Say ""

# ---------------------------------------------------------------- 1. build ---
Say "1. Build"
if ($SkipBuild) {
  Info "skipped (-SkipBuild)"
} else {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm was not found. Install Node.js (https://nodejs.org) and re-run."
  }
  Push-Location $repo
  try {
    Info "npm install"
    npm install --silent
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    Info "npm run build"
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
    Info "npm run smoke (tool-surface gate)"
    npm run smoke
    if ($LASTEXITCODE -ne 0) { throw "the tool-surface gate FAILED - do not use this build" }
    Ok "built, and the tool surface matches"
  } finally { Pop-Location }
}
if (-not (Test-Path $dist)) { throw "$dist is missing - the build did not produce output." }
Say ""

# ------------------------------------------------- 2. register: Claude Code ---
Say "2. Register with Claude Code"
$haveClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
if (-not $haveClaude) {
  Warn "the 'claude' CLI was not found - skipping (fine if you only use the Desktop app)"
} else {
  $already = ""
  try { $already = (claude mcp list 2>&1 | Out-String) } catch { $already = "" }
  if ($already -match "servicenowcase") {
    Ok "already registered"
  } else {
    $nodePath = (Get-Command node).Source -replace "\\", "/"
    $distFwd  = $dist -replace "\\", "/"
    $payload  = '{"command":"' + $nodePath + '","args":["' + $distFwd + '"],' +
                '"env":{"SNC_HOST":"pure.service-now.com","SNC_BROWSER_URL":"http://127.0.0.1:9222"}}'

    # WHY THIS GOES THROUGH A SCRIPT FILE AND GIT BASH:
    #
    # PowerShell 5.1 mangles double quotes when passing arguments to a native
    # program, so the JSON never arrives intact and `claude` rejects it with
    # "Invalid configuration: : Invalid input". Verified failing four ways:
    # single-quoted, backslash-escaped, doubled-for-cmd, and inline via bash -lc.
    # (`claude mcp add ... -- node <path>` is no better - PowerShell swallows the
    # `--` separator.)
    #
    # Writing the command to a file and executing that file sidesteps the whole
    # argument layer: the JSON is read from disk, inside sh single quotes, and
    # never passes through PowerShell's native-argument handling. Git Bash is a
    # safe assumption here - you needed git to clone this repo.
    $bash = "C:\Program Files\Git\bin\bash.exe"
    if (-not (Test-Path $bash)) {
      $gitCmd = Get-Command git -ErrorAction SilentlyContinue
      if ($gitCmd) { $bash = Join-Path (Split-Path -Parent (Split-Path -Parent $gitCmd.Source)) "bin\bash.exe" }
    }

    if (-not (Test-Path $bash)) {
      Warn "Git Bash not found - could not register automatically."
      Say  "       Run this in Git Bash yourself:"
      Say  "         claude mcp add-json servicenowcase '$payload' --scope user"
    } else {
      $tmp = Join-Path $env:TEMP "snc-register.sh"
      $body = "#!/bin/sh`nclaude mcp add-json servicenowcase '$payload' --scope user`n"
      [System.IO.File]::WriteAllText($tmp, $body.Replace("`r`n", "`n"), (New-Object System.Text.ASCIIEncoding))
      & $bash ($tmp -replace "\\", "/")
      $rc = $LASTEXITCODE
      Remove-Item $tmp -ErrorAction SilentlyContinue
      if ($rc -ne 0) {
        Warn "registration failed (exit $rc) - register by hand, see the README"
      } else {
        Ok "registered (user scope)"
      }
    }
  }
}
Say ""

# ------------------------------------------------------- 3. THE PROMPT FIX ---
Say "3. Allow the read-only tools (stop the permission prompts)"
$settingsPath = Join-Path $env:USERPROFILE ".claude\settings.json"
$settings = Read-JsonConfig $settingsPath
$perms = Ensure-Property $settings "permissions" (New-Object PSObject)
Ensure-Property $perms "allow" @() | Out-Null

$existing = @($perms.allow)
$added = @()
foreach ($rule in $ALLOW_RULES) {
  if ($existing -notcontains $rule) { $existing += $rule; $added += $rule }
}

if ($added.Count -eq 0) {
  Ok "all $($ALLOW_RULES.Count) rules already present"
} else {
  $perms.allow = $existing
  Write-JsonConfig $settingsPath $settings
  Ok "added $($added.Count) rule(s) to $settingsPath"
  Info "backup: $settingsPath.bak"
}
Info "sn_launch_browser is NOT allow-listed on purpose - connecting stays your call"
Say ""

# ---------------------------------------------- 4. register: Claude Desktop ---
Say "4. Register with the Claude Desktop app"
# A Microsoft Store / MSIX install VIRTUALIZES %APPDATA%, so the widely
# documented path is silently inert there. Detect, do not assume.
$msixDir   = Join-Path $env:LOCALAPPDATA "Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude"
$normalDir = Join-Path $env:APPDATA "Claude"
$desktopDir = $null
if (Test-Path (Join-Path $msixDir "claude_desktop_config.json")) { $desktopDir = $msixDir }
elseif (Test-Path $msixDir) { $desktopDir = $msixDir }
elseif (Test-Path (Join-Path $normalDir "claude_desktop_config.json")) { $desktopDir = $normalDir }

if (-not $desktopDir) {
  Info "Claude Desktop not detected - skipping"
} else {
  $desktopCfgPath = Join-Path $desktopDir "claude_desktop_config.json"
  Info "config: $desktopCfgPath"
  # Desktop REWRITES this file while it runs. Editing it now is a coin flip:
  # either our change is lost when Desktop next saves, or we overwrite state
  # Desktop just wrote. Neither is acceptable, so refuse rather than gamble -
  # everything else above has already been applied and re-running is cheap.
  if (Get-Process -Name "Claude" -ErrorAction SilentlyContinue) {
    Warn "Claude Desktop is RUNNING - skipping this step so nothing gets clobbered."
    Warn "Quit Claude Desktop completely, then re-run:  .\scripts\install.ps1 -SkipBuild"
    Say ""
    Say "Everything else is done. Steps 1-3 above do not need repeating."
    return
  }
  $desktopCfg = Read-JsonConfig $desktopCfgPath
  $servers = Ensure-Property $desktopCfg "mcpServers" (New-Object PSObject)
  # Absolute node.exe: Desktop launches from Explorer and may not inherit PATH.
  $entry = [PSCustomObject]@{
    command = (Get-Command node).Source
    args    = @($dist)
    env     = [PSCustomObject]@{ SNC_HOST = "pure.service-now.com"; SNC_BROWSER_URL = "http://127.0.0.1:9222" }
  }
  if ($servers.PSObject.Properties["servicenowcase"]) { $servers.servicenowcase = $entry }
  else { $servers | Add-Member -NotePropertyName "servicenowcase" -NotePropertyValue $entry }
  Write-JsonConfig $desktopCfgPath $desktopCfg
  Ok "merged into the Desktop config (backup: $desktopCfgPath.bak)"
  Info "Desktop has no permission-rules file - click 'Always allow' once per tool there"
}
Say ""

Say "Done."
Say ""
Say "NEXT:"
Say "  1. Restart Claude Code (MCP servers do not hot-load), or restart Claude Desktop."
Say "  2. In Claude Code, run /mcp - it must show servicenowcase with 10 tools."
Say "     That is the ONLY proof it registered; npm run smoke passes either way."
Say "  3. Say 'connect to ServiceNow' and complete Okta/SSO in the Chrome window."
Say ""
