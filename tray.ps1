# AI_SCOPE-111: the system tray icon. Windows only; started by tray.js and never meant to be run by hand.
#   powershell -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File tray.ps1 `
#            -Port 9000 -Version 0.5.4 -Icon C:\...\assets\ai_scope.ico -ParentPid 1234
# The icon answers one question - "is an AI_SCOPE running on this PC?" - so it lives and dies with that server
# process: when ParentPid is gone, the icon goes with it. The two menu items are loopback calls to that same
# server (Open App -> POST /api/tray/open, Quit AI_SCOPE -> POST /api/stop), so nothing here knows paths or
# command lines and there is nothing to quote.
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

function Ask-Scope([string]$apiPath, [string]$headerTag) {
  try {
    Invoke-WebRequest -Uri ('http://127.0.0.1:' + $Port + $apiPath) -Method Post -Headers @{ 'X-AI-Scope' = $headerTag } -ContentType 'application/json' -Body '' -UseBasicParsing -TimeoutSec 5 | Out-Null
    return $true
  } catch {
    Write-Output ('tray: ' + $apiPath + ' failed: ' + $_.Exception.Message)
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
$notify.Add_MouseClick({
  param($s, $e)
  if ($e.Button.ToString() -eq 'Left') {
    try { $menu.Show([System.Windows.Forms.Cursor]::Position) } catch { }
  }
})

$shuttingDown = $false
function Leave-Tray {
  $script:shuttingDown = $true
  try { $timer.Stop() } catch { }
  try { $notify.Visible = $false; $notify.Dispose() } catch { }
  [System.Windows.Forms.Application]::Exit()
}

$openItem.Add_Click({ [void](Ask-Scope '/api/tray/open' 'open') })
$quitItem.Add_Click({ if (Ask-Scope '/api/stop' 'stop') { Leave-Tray } })

# The icon belongs to the server that started it: when that process is gone, close the icon down.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { Leave-Tray }
})
$timer.Start()

Write-Output ('tray: AI_SCOPE ' + $Version + ' on port ' + $Port + ' (pid ' + $ParentPid + ')')
[System.Windows.Forms.Application]::Run()
