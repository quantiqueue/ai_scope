# AI_SCOPE installer for Windows.
#
#   irm https://github.com/quantiqueue/ai_scope/releases/latest/download/install.ps1 | iex
#
# Installs to %LOCALAPPDATA%\ai-scope (no admin rights needed, nothing system-wide):
#   app\    the app (from the latest GitHub release)
#   node\   a private node.exe - only if this PC has no Node.js 18+
#   bin\    ai-scope.cmd, added to your user PATH
# plus a Start Menu shortcut "AI_SCOPE". Settings and history live in %USERPROFILE%\.ai_scope.
# Run the same line again to update. Uninstall: ai-scope --uninstall
#
# Options (set before running):
#   $env:AI_SCOPE_STARTUP = "1"        also start AI_SCOPE when you log in
#   $env:AI_SCOPE_NO_START = "1"       don't start it after installing
#   $env:AI_SCOPE_VERSION = "v1.2.0"   install a specific release instead of the latest
#   $env:AI_SCOPE_ZIP = "C:\path.zip"  install from a local zip (testing)
#   $env:AI_SCOPE_PRIVATE_NODE = "1"  always use a private Node.js, even if this PC has one

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads very slow in Windows PowerShell 5
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$Repo    = if ($env:AI_SCOPE_REPO) { $env:AI_SCOPE_REPO } else { 'quantiqueue/ai_scope' }
$Root    = Join-Path $env:LOCALAPPDATA 'ai-scope'
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
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('ai-scope-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$zip = Join-Path $tmp 'ai-scope.zip'
if ($env:AI_SCOPE_ZIP) {
  Copy-Item $env:AI_SCOPE_ZIP $zip
  Say "from $($env:AI_SCOPE_ZIP)"
} else {
  if ($env:AI_SCOPE_VERSION) { $url = "https://github.com/$Repo/releases/download/$($env:AI_SCOPE_VERSION)/ai-scope.zip" }
  else { $url = "https://github.com/$Repo/releases/latest/download/ai-scope.zip" }
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
Step 'Adding the ai-scope command'
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
$cmd = @"
@echo off
rem AI_SCOPE launcher (created by install.ps1). Run "ai-scope --help" for the options, "ai-scope --uninstall" to remove.
for %%I in ("%~dp0..") do set "AISCOPE_ROOT=%%~fI"
if /i "%~1"=="--uninstall" (copy /y "%AISCOPE_ROOT%\app\install\uninstall.ps1" "%TEMP%\ai-scope-uninstall.ps1" >nul & powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\ai-scope-uninstall.ps1" & exit /b)
title AI_SCOPE
set "AI_SCOPE_LAUNCHER=%~f0"
set "AISCOPE_NODE=%AISCOPE_ROOT%\node\node.exe"
if not exist "%AISCOPE_NODE%" (set "AISCOPE_NODE=node" & where node >nul 2>nul || (echo Node.js was not found. Run the AI_SCOPE installer again to get a private copy. & exit /b 1))
"%AISCOPE_NODE%" "%AISCOPE_ROOT%\app\bin\ai-scope.js" %*
"@
Set-Content -Path (Join-Path $BinDir 'ai-scope.cmd') -Value $cmd -Encoding ASCII

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
if (($userPath -split ';') -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $BinDir).TrimStart(';')), 'User')
  Say "Added $BinDir to your PATH (new terminals will see it)"
}
if (($env:Path -split ';') -notcontains $BinDir) { $env:Path = $env:Path + ';' + $BinDir }

# --- 4. Start Menu shortcut ---
Step 'Adding a Start Menu shortcut'
$lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'AI_SCOPE.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = Join-Path $BinDir 'ai-scope.cmd'
$s.Arguments = '--open'
$s.WorkingDirectory = $Root
$s.Description = 'AI_SCOPE - local AI monitor'
$s.WindowStyle = 7   # minimized console; close it to stop AI_SCOPE
$s.Save()
Say $lnk

# --- 5. optional: start at login ---
if ($env:AI_SCOPE_STARTUP -eq '1') {
  Step 'Starting AI_SCOPE when you log in'
  & (Join-Path $BinDir 'ai-scope.cmd') --install-startup | ForEach-Object { Say $_ }
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "AI_SCOPE $version is installed." -ForegroundColor Green
Say 'Start it from the Start Menu (AI_SCOPE), or run:  ai-scope --open'
Say 'Options:  ai-scope --help      Uninstall:  ai-scope --uninstall'
Write-Host ''

# --- 6. start it ---
if ($env:AI_SCOPE_NO_START -ne '1') {
  Start-Process -FilePath (Join-Path $BinDir 'ai-scope.cmd') -ArgumentList '--open' -WorkingDirectory $Root -WindowStyle Minimized
  Say 'AI_SCOPE is starting in a minimized window and will open http://localhost:9000'
  Write-Host ''
}
