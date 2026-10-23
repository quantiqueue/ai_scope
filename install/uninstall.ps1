# AI_SCOPE uninstaller for Windows (run with: ai_scope --uninstall).
# Stops AI_SCOPE (and its app window), then removes %LOCALAPPDATA%\ai_scope, the Start Menu and desktop
# shortcuts, the login item and the PATH entry.
# Asks before deleting your settings and history in %USERPROFILE%\.ai_scope.
$ErrorActionPreference = 'Continue'
$Root    = Join-Path $env:LOCALAPPDATA 'ai_scope'
$AppDir  = Join-Path $Root 'app'
$BinDir  = Join-Path $Root 'bin'
$Data    = if ($env:AI_SCOPE_DATA) { $env:AI_SCOPE_DATA } else { Join-Path $env:USERPROFILE '.ai_scope' }

Write-Host ''
Write-Host 'Uninstalling AI_SCOPE' -ForegroundColor Cyan

# stop it if it's running
try {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$AppDir*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # the app window (Edge/Chrome using AI_SCOPE's own profile in $Root\window*), so its files can be removed
  Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe' OR Name = 'chrome.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Root\window*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 800
} catch {}

$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'ai_scope.cmd'
if (Test-Path $startup) { Remove-Item $startup -Force; Write-Host '  Removed the login item' }
$lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'AI_SCOPE.lnk'
if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host '  Removed the Start Menu shortcut' }
$desk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI_SCOPE.lnk'
if (Test-Path $desk) { Remove-Item $desk -Force; Write-Host '  Removed the desktop shortcut' }

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -and (($userPath -split ';') -contains $BinDir)) {
  $new = (($userPath -split ';') | Where-Object { $_ -and $_ -ne $BinDir }) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $new, 'User')
  Write-Host '  Removed ai_scope from your PATH'
}

if (Test-Path $Root) {
  # Everything except bin\ now; bin\ai_scope.cmd is still running (it started this uninstaller), so bin\ is
  # removed at the very end by a hidden cmd, a moment after the launcher exits (deleting a running batch
  # file makes cmd print "The system cannot find the path specified").
  Get-ChildItem $Root -Force | Where-Object { $_.Name -ne 'bin' } | Remove-Item -Recurse -Force
  Write-Host "  Removed $Root"
}

if (Test-Path $Data) {
  $a = Read-Host "  Also delete your settings and history in $Data ? [y/N]"
  if ($a -match '^(y|yes)$') { Remove-Item $Data -Recurse -Force; Write-Host '  Deleted.' }
  else { Write-Host '  Kept (reinstalling picks them up again).' }
}
Write-Host ''
Write-Host 'AI_SCOPE has been uninstalled.' -ForegroundColor Green
Write-Host ''

# last step, after any questions: remove bin\ once the launcher has exited
if (Test-Path $Root) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c ping -n 3 127.0.0.1 >nul & rmdir /s /q "' + $Root + '"') -WindowStyle Hidden
}
