# AI_SCOPE procstats membership loop (AI_SCOPE-038; reshaped by AI_SCOPE-084 item 3, 2026-10-29).
# procstats.js runs it from a temp file (-File) after filling in __FILE__ (watch file: one
# "key|port,port|name,name|tree" line per app; the names are optional - when given, only the app's processes with
# those exe names count, e.g. Bionic's llama-server.exe; tree=1 (AI_SCOPE-080) makes the names ANCHORS of the app's
# whole process tree instead) and __PARENT__ (Node's PID).
#
# This script answers ONE question: WHICH processes belong to each watched app right now. It prints, whenever the
# watch file changed or its re-resolve clock fires:
#   F|key|pid|exeName        one line per process of the app's family
# then "---". An app's processes = the process listening on its port + all its child processes; with the watch
# file's tree flag (AI_SCOPE-080) the names ANCHOR the app's whole process tree (anchors + descendants + ancestry).
#
# It deliberately measures NOTHING: since 084 the numbers for every process (CPU %, working set, private bytes,
# I/O rates, VRAM / GPU % per card) come from proctop.ps1 / proctop.js - ONE all-process walk for the whole app
# (AI_SCOPE-059 proved that loop; the user's item 3 asked for exactly that shared sampler). procstats.js
# aggregates those rows over the families reported here, so the second PDH query, the second NtQuerySystemInformation
# walk and the per-cycle string building this script used to do are gone (measured on snow before the change:
# this child cost 8.0 % of one core while proctop cost 0.7 %).
# What stays here is the part only this script can do cheaply: the port -> pid table (netstat) and the parent / name
# table (CreateToolhelp32Snapshot) that the family and tree rules need.
# Don't use Get-Counter (8.7 s per read) or .NET PerformanceCounter (~25 s on first use) anywhere in AI_SCOPE
# (AI_SCOPE-037/038).
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class AiScopeFam {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Entry { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref Entry e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref Entry e);

  public static bool Alive(int pid) { IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return false;
    uint c; bool ok = GetExitCodeProcess(h, out c); CloseHandle(h); return ok && c == 259; }
  // All processes: pid -> parent pid, pid -> exe name
  public static Dictionary<int, int> Parents = new Dictionary<int, int>();
  public static Dictionary<int, string> Names = new Dictionary<int, string>();
  public static void Snapshot() {
    Parents.Clear(); Names.Clear();
    IntPtr s = CreateToolhelp32Snapshot(2, 0); if (s == IntPtr.Zero || s == new IntPtr(-1)) return;
    Entry e = new Entry(); e.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
    if (Process32FirstW(s, ref e)) { do { Parents[(int)e.th32ProcessID] = (int)e.th32ParentProcessID; Names[(int)e.th32ProcessID] = e.szExeFile; } while (Process32NextW(s, ref e)); }
    CloseHandle(s);
  }
  // root + all descendants (from the last Snapshot)
  public static List<int> Family(int root) {
    List<int> fam = new List<int>(); Queue<int> q = new Queue<int>(); q.Enqueue(root);
    while (q.Count > 0) { int x = q.Dequeue(); if (fam.Contains(x)) continue; fam.Add(x);
      foreach (KeyValuePair<int, int> kv in Parents) if (kv.Value == x && kv.Key != x) q.Enqueue(kv.Key); }
    return fam;
  }
}
'@
$file = '__FILE__'
# AI_SCOPE-077 review batch 3: runner names several apps share - without a listening port to attribute
# them to, they cannot be counted for any app (same GENERIC rule as the Linux / macOS path, 052).
$GENERIC = @('llama-server.exe', 'python.exe', 'python3.exe', 'node.exe')
# AI_SCOPE-080 tree mode: ancestry climbing stops here - these parents own arbitrary things, so an app-named
# child does not attribute them to the app (the chain is Windows' / the shell's, not the app's).
$STOPPARENTS = @('explorer.exe', 'services.exe', 'svchost.exe', 'wininit.exe', 'csrss.exe', 'conhost.exe', 'taskhostw.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'WmiPrvSE.exe', 'Memory Compression', 'System')
function Get-Ancestry([int]$px) {
  $chain = @(); $cur = $px
  for ($n = 0; $n -lt 10; $n++) {
    if (-not [AiScopeFam]::Parents.ContainsKey($cur)) { break }
    $pp = [AiScopeFam]::Parents[$cur]
    if ($pp -le 4 -or -not [AiScopeFam]::Names.ContainsKey($pp)) { break }   # System / Idle / already exited
    if ($STOPPARENTS -contains [AiScopeFam]::Names[$pp]) { break }
    $chain += $pp; $cur = $pp
  }
  return $chain
}
$apps = @{}; $stamp = $null; $last = 0; $missing = $false
function Resolve-Apps {
  $script:apps = @{}; $script:missing = $false
  $lines = @(); try { $lines = [IO.File]::ReadAllLines($file) } catch { }
  [AiScopeFam]::Snapshot()
  $listen = @{}   # port -> pid, from netstat (fast; Get-NetTCPConnection took 1.5 s)
  foreach ($l in (netstat.exe -ano)) { if ($l -match '^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)') { $listen[[int]$Matches[1]] = [int]$Matches[2] } }
  foreach ($line in $lines) {
    $parts = $line.Split('|'); if ($parts.Count -lt 2) { continue }
    $tree = ($parts.Count -ge 4 -and $parts[3] -eq '1')   # AI_SCOPE-080: names ANCHOR a process tree instead of filtering one
    $root = $null
    foreach ($p in $parts[1].Split(',')) { if ($p -and $listen.ContainsKey([int]$p)) { $root = $listen[[int]$p]; break } }
    $fam = @(); if ($root) { $fam = @([AiScopeFam]::Family($root)) }
    $want = @()
    if ($parts.Count -ge 3 -and $parts[2]) { $want = @($parts[2].Split(',') | Where-Object { $_ }) }
    if ($tree) {
      # 080 (Strata): family = port owner + descendants, the app-named anchors (strata.exe / strata-vision.exe)
      # + their descendants, and the ancestry chains of anchors and port owner - that captures the engine
      # manager / launcher workers doing the model-load I/O and CPU while the runner is still being built
      # (078's capture: the manager ran ~6 % CPU and read hundreds of MB ~80 s before strata.exe appeared),
      # while leaving a previous instance's leftover idle engine out (no named child, not the port owner).
      $spec = @($want | Where-Object { $GENERIC -notcontains $_ })
      $anchors = @((( [AiScopeFam]::Names).Keys | Where-Object { $spec -contains [AiScopeFam]::Names[$_] }) | Sort-Object)
      $allf = @($fam) + $anchors
      foreach ($a in $anchors) { $allf += @([AiScopeFam]::Family($a)); $allf += @(Get-Ancestry $a) }
      if ($root) { $allf += @(Get-Ancestry $root) }
      $claimed = @($script:apps.Values | ForEach-Object { $_ })
      $fam = @($allf | Sort-Object -Unique | Where-Object { $claimed -notcontains $_ })
    } else {
      if ($want.Count) { $fam = @($fam | Where-Object { $want -contains [AiScopeFam]::Names[$_] }) }
      # 077 batch 3: no listening port yet (a model LOAD/UNLOAD - the engine process runs before its port
      # exists) - find the app's processes by exe NAME, but only app-specific names: a shared runner like
      # llama-server.exe without its port would misattribute another app's process (Strata's strata.exe is
      # unique; the generic set is 052's). PIDs already claimed by another key are skipped.
      if (-not $root -and $want.Count) {
        $spec = @($want | Where-Object { $GENERIC -notcontains $_ })
        if ($spec.Count) {
          $claimed = @($script:apps.Values | ForEach-Object { $_ })
          $fam = @(([AiScopeFam]::Names).Keys | Where-Object { $spec -contains [AiScopeFam]::Names[$_] -and $claimed -notcontains $_ })
        }
      }
    }
    if ($fam.Count) { $script:apps[$parts[0]] = $fam } else { $script:missing = $true }
  }
}
while ($true) {
  if (-not [AiScopeFam]::Alive(__PARENT__)) { exit }
  $t0 = [Environment]::TickCount
  $txt = $null; try { $txt = [IO.File]::ReadAllText($file) } catch { }
  $now = [Environment]::TickCount
  # re-resolve when the watch file changed (an app module reports new ports every poll, so a model load's port
  # lands here at once) and otherwise every 10 s (PIDs change when an app restarts), every 4 s while a watched
  # app has no processes yet
  if ($txt -ne $stamp -or [Math]::Abs($now - $last) -gt $(if ($missing) { 4000 } else { 10000 })) {
    Resolve-Apps; $stamp = $txt; $last = $now
    $out = New-Object Text.StringBuilder
    foreach ($k in $apps.Keys) { foreach ($x in $apps[$k]) { $null = $out.Append('F|' + $k + '|' + $x + '|' + [AiScopeFam]::Names[$x] + "`n") } }
    # an empty block is a real answer too: nothing was found for any watched app (084: procstats.js then has no
    # family to aggregate, so the mirror tiles keep the attested wording instead of a stale tree)
    [Console]::Out.Write($out.ToString() + "---`n"); [Console]::Out.Flush()
  }
  # nothing else to do between re-resolves - the numbers come from proctop, not from here (AI_SCOPE-084 item 3)
  $el = [Environment]::TickCount - $t0
  if ($el -lt 0) { $el = 0 }
  if ($el -lt 2000) { Start-Sleep -Milliseconds (2000 - $el) }
}
