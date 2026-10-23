# AI_SCOPE installer for Windows.
#
#   irm https://github.com/quantiqueue/ai_scope/releases/latest/download/install.ps1 | iex
#
# Installs to %LOCALAPPDATA%\ai_scope (no admin rights needed, nothing system-wide):
#   app\    the app (from the latest GitHub release)
#   node\   a private node.exe - only if this PC has no Node.js 18+
#   bin\    ai_scope.cmd (added to your user PATH) and ai_scope.vbs (starts it without a console window)
# plus a Start Menu shortcut "AI_SCOPE" (and, if you want, one on the desktop). The shortcuts run
# "ai_scope --app": AI_SCOPE starts in the background and opens in its own window. Settings and
# history live in %USERPROFILE%\.ai_scope.
# Run the same line again to update. Uninstall: ai_scope --uninstall
#
# Options (set before running):
#   $env:AI_SCOPE_STARTUP = "1"        also start AI_SCOPE when you log in
#   $env:AI_SCOPE_NO_START = "1"       don't start it after installing
#   $env:AI_SCOPE_DESKTOP = "1" / "0"  desktop shortcut yes / no, without asking
#   $env:AI_SCOPE_VERSION = "v1.2.0"   install a specific release instead of the latest
#   $env:AI_SCOPE_ZIP = "C:\path.zip"  install from a local zip (testing)
#   $env:AI_SCOPE_PRIVATE_NODE = "1"  always use a private Node.js, even if this PC has one

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads very slow in Windows PowerShell 5
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$Repo    = if ($env:AI_SCOPE_REPO) { $env:AI_SCOPE_REPO } else { 'quantiqueue/ai_scope' }
$Root    = Join-Path $env:LOCALAPPDATA 'ai_scope'
$AppDir  = Join-Path $Root 'app'
$NodeDir = Join-Path $Root 'node'
$BinDir  = Join-Path $Root 'bin'
$MinNode = 18

function Say($msg)  { Write-Host "  $msg" }
function Step($msg) { Write-Host "> $msg" -ForegroundColor Cyan }

Write-Host ''
Write-Host 'AI_SCOPE installer' -ForegroundColor Cyan
Write-Host ''

# --- stop a running AI_SCOPE from this install (files would be locked) ---
function Stop-AiScope {
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$AppDir*" }
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($procs) { Say 'Stopped the running AI_SCOPE.'; Start-Sleep -Milliseconds 800 }
  } catch {}
}

# --- 1. download the app ---
Step 'Downloading AI_SCOPE'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('ai_scope-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$zip = Join-Path $tmp 'ai_scope.zip'
if ($env:AI_SCOPE_ZIP) {
  Copy-Item $env:AI_SCOPE_ZIP $zip
  Say "from $($env:AI_SCOPE_ZIP)"
} else {
  if ($env:AI_SCOPE_VERSION) { $url = "https://github.com/$Repo/releases/download/$($env:AI_SCOPE_VERSION)/ai_scope.zip" }
  else { $url = "https://github.com/$Repo/releases/latest/download/ai_scope.zip" }
  Say $url
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
}

Stop-AiScope
New-Item -ItemType Directory -Path $Root -Force | Out-Null
if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $AppDir -Force
$version = (Get-Content (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json).version
Say "Installed version $version to $AppDir"

# --- 2. Node.js: use the PC's own if it's new enough, otherwise a private node.exe ---
Step 'Checking Node.js'
$nodeExe = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($env:AI_SCOPE_PRIVATE_NODE -eq '1') { $sys = $null; Say 'Using a private Node.js (AI_SCOPE_PRIVATE_NODE=1)' }
if ($sys) {
  try {
    $v = (& $sys.Source -v) -replace '^v', ''
    if ([int]($v.Split('.')[0]) -ge $MinNode) { $nodeExe = $sys.Source; Say "Using your Node.js $v ($($sys.Source))" }
    else { Say "Your Node.js $v is too old (needs $MinNode+), using a private copy instead" }
  } catch {}
}
$privNode = Join-Path $NodeDir 'node.exe'
if (-not $nodeExe) {
  if (Test-Path $privNode) {
    $nodeExe = $privNode
    Say "Using the private Node.js $((& $privNode -v)) in $NodeDir"
  } else {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $lts = $index | Where-Object { $_.lts -and ($_.files -contains ($arch + '-zip')) } | Select-Object -First 1
    if (-not $lts) { throw 'Could not find a Node.js LTS release for this PC.' }
    $nv = $lts.version
    Say "Downloading Node.js $nv ($arch, about 90 MB)"
    New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null
    $dl = Join-Path $tmp 'node.exe'
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$nv/$arch/node.exe" -OutFile $dl -UseBasicParsing
    # verify against the official checksums
    $sums = [string](Invoke-RestMethod -Uri "https://nodejs.org/dist/$nv/SHASUMS256.txt" -UseBasicParsing)
    $line = ($sums -split "`n") | Where-Object { $_ -match ("\s" + [regex]::Escape("$arch/node.exe") + "\s*$") } | Select-Object -First 1
    if (-not $line) { throw 'Could not find the Node.js checksum.' }
    $want = ($line.Trim() -split '\s+')[0].ToLower()
    $got = (Get-FileHash $dl -Algorithm SHA256).Hash.ToLower()
    if ($want -ne $got) { throw 'Node.js download failed the checksum check - please try again.' }
    Move-Item $dl $privNode -Force
    $nodeExe = $privNode
    Say "Saved to $NodeDir (only AI_SCOPE uses it)"
  }
}

# --- 3. launcher on the PATH ---
Step 'Adding the ai_scope command'
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
$cmd = @"
@echo off
rem AI_SCOPE launcher (created by install.ps1). Run "ai_scope --help" for the options, "ai_scope --uninstall" to remove.
for %%I in ("%~dp0..") do set "AISCOPE_ROOT=%%~fI"
if /i "%~1"=="--uninstall" (copy /y "%AISCOPE_ROOT%\app\install\uninstall.ps1" "%TEMP%\ai_scope-uninstall.ps1" >nul & powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\ai_scope-uninstall.ps1" & exit /b)
title AI_SCOPE
set "AI_SCOPE_LAUNCHER=%~f0"
set "AISCOPE_NODE=%AISCOPE_ROOT%\node\node.exe"
if not exist "%AISCOPE_NODE%" (set "AISCOPE_NODE=node" & where node >nul 2>nul || (echo Node.js was not found. Run the AI_SCOPE installer again to get a private copy. & exit /b 1))
"%AISCOPE_NODE%" "%AISCOPE_ROOT%\app\bin\ai_scope.js" %*
"@
Set-Content -Path (Join-Path $BinDir 'ai_scope.cmd') -Value $cmd -Encoding ASCII

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $BinDir).TrimStart(';')), 'User')
  Say "Added $BinDir to your PATH (new terminals will see it)"
}
if (($env:Path -split ';') -notcontains $BinDir) { $env:Path = $env:Path + ';' + $BinDir }

# --- 4. shortcuts: open AI_SCOPE in its own window (ai_scope --app), with no console window ---
# The shortcuts run wscript.exe with ai_scope.vbs, which starts "ai_scope.cmd --app" hidden.
$vbs = Join-Path $BinDir 'ai_scope.vbs'
$vbsText = @'
' AI_SCOPE app launcher (created by install.ps1): runs "ai_scope --app" without a console window.
' --app starts AI_SCOPE in the background if it isn't running, then opens it in its own window.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For Each a In WScript.Arguments
  args = args & " """ & a & """"
Next
CreateObject("WScript.Shell").Run """" & dir & "\ai_scope.cmd"" --app" & args, 0, False
'@
Set-Content -Path $vbs -Value $vbsText -Encoding ASCII

$ico = Join-Path $AppDir 'assets\ai_scope.ico'
$sh = New-Object -ComObject WScript.Shell
function New-AppShortcut($lnk) {
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $s.Arguments = '"' + $vbs + '"'
  $s.WorkingDirectory = $Root
  $s.Description = 'AI_SCOPE - local AI monitor'
  if (Test-Path $ico) { $s.IconLocation = $ico + ',0' }
  $s.Save()
  Say $lnk
}

Step 'Adding a Start Menu shortcut'
New-AppShortcut (Join-Path ([Environment]::GetFolderPath('Programs')) 'AI_SCOPE.lnk')

$desk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI_SCOPE.lnk'
$wantDesk = $env:AI_SCOPE_DESKTOP
if (-not $wantDesk) {
  if (Test-Path $desk) { $wantDesk = '1' }   # updating: keep (and refresh) the existing one
  else {
    $a = ''
    try { $a = Read-Host '  Create a desktop shortcut? [Y/n]' } catch {}
    $wantDesk = if ($a -match '^(n|no)$') { '0' } else { '1' }
  }
}
if ($wantDesk -eq '1') { Step 'Adding a desktop shortcut'; New-AppShortcut $desk }

# --- 5. optional: start at login ---
if ($env:AI_SCOPE_STARTUP -eq '1') {
  Step 'Starting AI_SCOPE when you log in'
  & (Join-Path $BinDir 'ai_scope.cmd') --install-startup | ForEach-Object { Say $_ }
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "AI_SCOPE $version is installed." -ForegroundColor Green
Say 'Start it from the Start Menu (AI_SCOPE) or the desktop shortcut - it opens in its own window.'
Say 'Closing the window keeps AI_SCOPE running in the background. Stop it with:  ai_scope --stop'
Say 'From a terminal:  ai_scope  (runs there, Ctrl+C to stop)   ai_scope --open  (in your browser)'
Say 'Options:  ai_scope --help      Uninstall:  ai_scope --uninstall'
Write-Host ''

# --- 6. start it ---
if ($env:AI_SCOPE_NO_START -ne '1') {
  Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $vbs + '"') -WorkingDirectory $Root
  Say 'AI_SCOPE is starting in the background and will open in its own window (http://localhost:9000)'
  Write-Host ''
}
