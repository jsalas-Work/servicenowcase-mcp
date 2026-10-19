<#
.SYNOPSIS
  Launch a debug-enabled Chrome for ServiceNowCase MCP to attach to.

.DESCRIPTION
  Starts Chrome with a remote-debugging port on a DEDICATED profile, so the MCP
  can borrow your logged-in ServiceNow session without ever handling credentials.

  This script only ever STARTS a browser. It does not close, kill or modify any
  Chrome you already have open, and it touches no ServiceNow data.

  You sign in to ServiceNow yourself, once per session, in the window it opens.

.PARAMETER Port
  Remote debugging port. Must match SNC_BROWSER_URL in your MCP config (9222).

.PARAMETER ProfileDir
  Dedicated Chrome profile directory. Keeping this separate from your everyday
  profile means the debug port never exposes your normal browsing session.

.EXAMPLE
  .\scripts\launch-debug-chrome.ps1
#>
param(
  [int]$Port = 9222,
  [string]$ProfileDir = (Join-Path (Split-Path $PSScriptRoot -Parent) ".chrome-debug-profile"),
  [string]$StartUrl = "https://pure.service-now.com/now/cwf/agent/home",
  # Opt-in: when a debug Chrome is already running but has NO ServiceNow tab,
  # open one in that EXISTING instance. Off by default so the script's default
  # behaviour stays "start a browser or report - never touch what's open".
  [switch]$OpenTab
)

$ErrorActionPreference = "Stop"
$SnHost = ([Uri]$StartUrl).Host

# Already listening? Don't start a second one. But DO work out whether it is
# actually usable: a Chrome whose window was closed often keeps running with no
# ServiceNow tab, and this script used to exit silently in exactly that state -
# the one where the user is most likely to run it. Reported 2026-07-30.
$inUse = $null
try {
  $inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
} catch { }
if ($inUse) {
  Write-Host "Port $Port is already listening - a debug Chrome is running." -ForegroundColor Green

  $targets = $null
  try {
    $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 10
  } catch {
    Write-Host ""
    Write-Host "WARNING: the port is open but it did not answer as Chrome." -ForegroundColor Yellow
    Write-Host "  Something else may be using port $Port. Check it, or fully quit Chrome"
    Write-Host "  and re-run this script."
    exit 0
  }

  $pages   = @($targets | Where-Object { $_.type -eq "page" })
  $snTabs  = @($pages | Where-Object { try { ([Uri]$_.url).Host -eq $SnHost } catch { $false } })
  $authTab = @($pages | Where-Object {
    $u = $_.url
    ($u -like "*okta.com*") -or ($u -like "*SAMLRequest=*") -or ($u -like "*login.microsoftonline.com*")
  })

  if ($snTabs.Count -gt 0) {
    Write-Host "ServiceNow tab found - you are ready to go." -ForegroundColor Green
    Write-Host ("  " + $snTabs[0].url)
    Write-Host "Nothing to do."
    exit 0
  }

  Write-Host ""
  if ($authTab.Count -gt 0) {
    Write-Host "ACTION NEEDED: signed out - the browser is on a sign-in page." -ForegroundColor Yellow
    Write-Host ("  " + $authTab[0].url)
    Write-Host "  Complete Okta/SSO sign-in in that window, then retry your command."
  } else {
    Write-Host "ACTION NEEDED: that Chrome has NO ServiceNow tab." -ForegroundColor Yellow
    Write-Host "  (Closing the window does not stop Chrome - the process keeps the port open,"
    Write-Host "   so this script will NOT start a second browser.)"
    $firstTab = ""
    if ($pages.Count -gt 0) { $firstTab = " -> " + $pages[0].url }
    Write-Host ("  Open tabs: " + $pages.Count + $firstTab)
    Write-Host ""
    Write-Host "  Fix it in any of these ways:"
    Write-Host "    1. In that Chrome window, open: $StartUrl"
    Write-Host "    2. Re-run with -OpenTab to open it for you:"
    Write-Host "         .\scripts\launch-debug-chrome.ps1 -OpenTab"
    Write-Host "    3. Or fully quit Chrome, then re-run this script."
  }

  if ($OpenTab) {
    $chromeForTab = @(
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
      "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $chromeForTab) {
      Write-Host "  Could not find chrome.exe to open the tab." -ForegroundColor Red
      exit 0
    }
    Write-Host ""
    Write-Host "Opening $StartUrl in the existing debug Chrome..." -ForegroundColor Cyan
    # Same --user-data-dir means Chrome hands the URL to the RUNNING instance as
    # a new tab instead of starting a second browser. Nothing is closed.
    Start-Process -FilePath $chromeForTab -ArgumentList @("--user-data-dir=`"$ProfileDir`"", $StartUrl)
    Write-Host "Complete Okta/SSO sign-in if prompted, then retry your command."
  }
  exit 0
}

$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) {
  Write-Error "chrome.exe not found. Checked:`n  $($candidates -join "`n  ")"
}

if (-not (Test-Path $ProfileDir)) {
  New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
  Write-Host "Created dedicated debug profile: $ProfileDir"
}

$chromeArgs = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$ProfileDir`"",
  # ServiceNow does not render its SEARCH RESULTS page while Chrome thinks the
  # tab is hidden, and Chrome calls a fully-covered window "hidden". The server
  # works around this per-operation, but these two flags remove the problem at
  # the source so searches behave identically whether or not the window is
  # buried behind your editor. Neither flag affects page content or security.
  "--disable-features=CalculateNativeWinOcclusion",
  "--disable-backgrounding-occluded-windows",
  # The workspace collapses the Details form in a small window (a 640x487
  # window left 13 fields unreadable). Open the window large enough for it.
  "--window-size=1400,900",
  "--no-first-run",
  "--no-default-browser-check",
  $StartUrl
)

Write-Host "Launching: $chrome" -ForegroundColor Cyan
Write-Host "  port    : $Port"
Write-Host "  profile : $ProfileDir"
Start-Process -FilePath $chrome -ArgumentList $chromeArgs

Write-Host ""
Write-Host "Next:" -ForegroundColor Yellow
Write-Host "  1. Complete SSO sign-in in the window that just opened (once per session)."
Write-Host "  2. Leave that ServiceNow tab open - the MCP attaches to it."
Write-Host "  3. Start Claude Code; the servicenowcase tools are ready."
