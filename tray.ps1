# AI_SCOPE-111: the system tray icon. Windows only; started by tray.js and never meant to be run by hand.
#   powershell -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File tray.ps1 `
#            -Port 9000 -Version 0.5.4 -Icon C:\...\assets\ai_scope.ico -ParentPid 1234
# The icon answers one question - "is an AI_SCOPE running on this PC?" - so it lives and dies with that server
# process: this helper holds a handle to it, checks it every 500 ms, and takes the icon down itself when that
# process exits. Nothing kills the helper on a stop: a killed PowerShell never reaches $notify.Dispose(), and
# Windows then leaves the dead icon in the tray until the mouse crosses it. The two menu items are loopback calls
# to that same server (Open App -> POST /api/tray/open, Quit AI_SCOPE -> POST /api/stop), so nothing here knows
# paths or command lines and there is nothing to quote.
# Needs ordinary (FullLanguage) PowerShell. On a machine where PowerShell is locked down by policy this script
# fails to load its types; tray.js logs one line and AI_SCOPE runs on exactly as it did before.
param(
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Icon,
  [Parameter(Mandatory = $true)][int]$ParentPid
)

$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  Write-Output 'tray: System.Windows.Forms / System.Drawing are not available (PowerShell may be restricted on this PC)'
  exit 2
}

# ASCII only in this text: Windows PowerShell 5 reads a file without a BOM in the system codepage, so a
# typographic separator would arrive as mojibake.
$label = 'AI_SCOPE ' + $Version + ' - port ' + $Port

$iconObj = $null
try { $iconObj = New-Object System.Drawing.Icon($Icon) } catch { }
if (-not $iconObj) { try { $iconObj = [System.Drawing.SystemIcons]::Application } catch { } }
if (-not $iconObj) { Write-Output 'tray: no icon could be loaded'; exit 2 }

function Write-TrayLog([string]$line) { try { [Console]::Out.WriteLine($line) } catch { } }

# Write-TrayLog, not Write-Output, inside this function: what a function puts on the pipeline is part of what it
# returns, so a failed request would come back as a two-item array - and `if (Ask-Scope ...)` reads an array as
# true, taking the icon down over an AI_SCOPE that is still running. The line is also lost on the pipeline: a
# WinForms event handler runs in its own pipeline and its output never reaches ai_scope.log, while stdout here is
# exactly what tray.js captures and logs.
function Ask-Scope([string]$apiPath, [string]$headerTag) {
  try {
    Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + $apiPath) -Method Post -Headers @{ 'X-AI-Scope' = $headerTag } -ContentType 'application/json' -Body '' -UseBasicParsing -TimeoutSec 5 | Out-Null
    return $true
  } catch {
    Write-TrayLog ('tray: ' + $apiPath + ' failed: ' + $_.Exception.Message)
    return $false
  }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$head = $menu.Items.Add($label)
$head.Enabled = $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$openItem = $menu.Items.Add('Open App')
$quitItem = $menu.Items.Add('Quit AI_SCOPE')

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $iconObj
$notify.Visible = $true
$notify.Text = $label
$notify.ContextMenuStrip = $menu

# Left click brings the menu up as well, so a plain click on the icon is enough (right click is the automatic one).
# Do not show the menu from here: a ContextMenuStrip shown by hand has no owner window, so it can stay up after the
# user clicks elsewhere and can come up behind the taskbar. NotifyIcon already owns its hidden window for the right
# click, and the private ShowContextMenu is the call that path makes - take it by reflection once, at startup, and
# call it for the left click too. Checked against the runtime that runs this file (Windows PowerShell 5.1,
# System.Windows.Forms 4.0.0.0): instance, non-public, no parameters, returns void. If some other PowerShell is ever
# missing that method, fall back to the old Show call rather than leave the left click dead.
$showContextMenu = $notify.GetType().GetMethod('ShowContextMenu', [System.Reflection.BindingFlags]'Instance,NonPublic')

$notify.Add_MouseClick({
  param($s, $e)
  if ($e.Button.ToString() -eq 'Left') {
    try {
      if ($showContextMenu) { [void]$showContextMenu.Invoke($notify, $null) }
      else { $menu.Show([System.Windows.Forms.Cursor]::Position) }
    } catch { }
  }
})

$shuttingDown = $false
function Leave-Tray {
  $script:shuttingDown = $true
  try { $timer.Stop() } catch { }
  # Dispose is the call that tells the shell to drop the icon. A helper killed outright never reaches it, and
  # Windows then leaves the dead icon on the taskbar until the mouse moves over it - so nothing kills this helper
  # on a stop: it closes itself down from the watch below.
  try { $notify.Visible = $false; $notify.Dispose() } catch { }
  Write-TrayLog 'tray: icon taken down'
  [System.Windows.Forms.Application]::Exit()
}

$openItem.Add_Click({ [void](Ask-Scope '/api/tray/open' 'open') })
$quitItem.Add_Click({ if (Ask-Scope '/api/stop' 'stop') { Leave-Tray } })

# The icon belongs to the server that started it, so the helper watches that process and closes itself down. The
# handle is taken ONCE: re-running Get-Process -Id on every tick would report "still running" if Windows later
# handed that number to an unrelated program, and a dead AI_SCOPE would keep its icon. 500 ms because the manual
# promises the icon goes away when that AI_SCOPE stops, and this watch - not a kill from the server - is what does
# it now for the Stop button, ai_scope --stop, Restart Now, the tray's own Quit, a Ctrl+C, a dev restart or a crash.
$parent = $null
try { $parent = [System.Diagnostics.Process]::GetProcessById($ParentPid) } catch { }

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
  try {
    if ($parent) { if ($parent.HasExited) { Leave-Tray } }
    elseif (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { Leave-Tray }
  } catch {
    Leave-Tray
  }
})
$timer.Start()

Write-Output ('tray: AI_SCOPE ' + $Version + ' on port ' + $Port + ' (pid ' + $ParentPid + ')')
[System.Windows.Forms.Application]::Run()
