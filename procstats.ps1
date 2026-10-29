# AI_SCOPE procstats loop (AI_SCOPE-038). procstats.js runs it from a temp file (-File) after filling in
# __LUIDS__ (unused here, reserved), __FILE__ (watch file: one "key|port,port|name,name|tree" line per app; the names are
# optional - when given, only the app's processes with those exe names count, e.g. Bionic's llama-server.exe;
# tree=1 (AI_SCOPE-080) makes the names ANCHORS of the app's whole process tree instead) and __PARENT__ (Node's PID).
# Every 2 s prints, for each watched app:
#   P|key|pid|name|workingSet|private|cpu100ns       one line per process of the app
#   G|key|pid|luid|dedicated|shared|util              one line per process and graphics card it uses
#   I|key|pid|read|write                             IO Read / IO Write Bytes per second, per process (AI_SCOPE-076)
# then "---". An app's processes = the process listening on its port + all its child processes; with the watch
# file's tree flag (AI_SCOPE-080) the names ANCHOR the app's whole process tree (anchors + descendants + ancestry).
# GPU numbers: Windows GPU performance counters read through PDH. Since the 080 performance pass ONE query holds
# EIGHT shared wildcard counters (all processes) harvested once per cycle into pid-keyed tables - the earlier
# per-process wildcards cost ~350 ms each per cycle, which the larger tree families could not afford.
# Don't use .NET PerformanceCounter here: its first use took ~25 s on a test PC (AI_SCOPE-037/038).
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text; using System.Text.RegularExpressions;
public static class AiScopeProc {
  [StructLayout(LayoutKind.Sequential)] struct Mem { public uint cb, PageFaultCount; public UIntPtr PeakWorkingSetSize, WorkingSetSize,
    QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Entry { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
  [DllImport("psapi.dll")] static extern bool GetProcessMemoryInfo(IntPtr h, ref Mem m, uint cb);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref Entry e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref Entry e);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQuery(string src, IntPtr user, out IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounter(IntPtr q, string path, IntPtr user, out IntPtr c);
  [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr q);
  [DllImport("pdh.dll")] static extern uint PdhCloseQuery(IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArray(IntPtr c, uint fmt, ref uint size, out uint n, IntPtr buf);

  public static bool Alive(int pid) { IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return false;
    uint c; bool ok = GetExitCodeProcess(h, out c); CloseHandle(h); return ok && c == 259; }
  // "workingSet|private|cpu100ns", or null if the process is gone
  public static string Read(int pid) { IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return null;
    Mem m = new Mem(); m.cb = (uint)Marshal.SizeOf(typeof(Mem)); bool okm = GetProcessMemoryInfo(h, ref m, m.cb);
    long a, b, k, u; bool okt = GetProcessTimes(h, out a, out b, out k, out u); CloseHandle(h);
    return (okm ? m.WorkingSetSize.ToString() + "|" + m.PrivateUsage.ToString() : "|") + "|" + (okt ? (k + u).ToString() : ""); }
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

  // ---- PDH: AI_SCOPE-080 performance pass - ONE query with EIGHT shared wildcard counters (all processes),
  // fetched once per cycle into a pid-keyed harvest. The 072-077 design added 8 wildcard counters PER watched
  // pid; every fetch walks the counter's instance space, so a cycle cost roughly +350 ms per watched process
  // (measured on snow, 080 review: 1 pid ~700 ms, 5 pids ~1850 ms per cycle) - with tree watch mode Strata
  // alone watches ~5 processes, which stretched the 2 s loop to 4-6 s and tripped the mirror's > 6 s
  // line-break rule during normal operation. Shared wildcards keep the cycle flat however many apps and
  // processes are watched (the all-process proctop loop, AI_SCOPE-059, proved the same pattern at bigger scale).
  static IntPtr query = IntPtr.Zero;
  static IntPtr gd, gs, ge, pcpu, pws, ppb, pir, piw;
  static Dictionary<int, double[]> pv = new Dictionary<int, double[]>();   // pid -> {cpu%, ws, private, ioR, ioW}; NaN = no value
  static Dictionary<int, Dictionary<string, double[]>> gp = new Dictionary<int, Dictionary<string, double[]>>();  // pid -> luid -> {ded, shared, util, hasUtil}
  // "Process V2" instances are "name:pid" (Windows 10 1709+); GPU instances are
  // "pid_<hexpid>_luid_0x<h1>_0x<h2>_phys_N(_eng_N_engtype_<type>)"
  static readonly Regex PVi = new Regex("^(.+):(\\d+)$");
  static readonly Regex GPe = new Regex("^pid_([0-9a-fA-F]{1,16})_luid_0x([0-9a-fA-F]+)_0x([0-9a-fA-F]+)_phys_\\d+(?:_eng_\\d+_engtype_(.+))?$");
  static bool Open() {
    if (query != IntPtr.Zero) return true;
    if (PdhOpenQuery(null, IntPtr.Zero, out query) != 0) { query = IntPtr.Zero; return false; }
    PdhAddEnglishCounter(query, "\\GPU Process Memory(pid_*)\\Dedicated Usage", IntPtr.Zero, out gd);
    PdhAddEnglishCounter(query, "\\GPU Process Memory(pid_*)\\Shared Usage", IntPtr.Zero, out gs);
    PdhAddEnglishCounter(query, "\\GPU Engine(pid_*)\\Utilization Percentage", IntPtr.Zero, out ge);
    PdhAddEnglishCounter(query, "\\Process V2(*)\\% Processor Time", IntPtr.Zero, out pcpu);
    PdhAddEnglishCounter(query, "\\Process V2(*)\\Working Set", IntPtr.Zero, out pws);
    PdhAddEnglishCounter(query, "\\Process V2(*)\\Private Bytes", IntPtr.Zero, out ppb);
    PdhAddEnglishCounter(query, "\\Process V2(*)\\IO Read Bytes/sec", IntPtr.Zero, out pir);
    PdhAddEnglishCounter(query, "\\Process V2(*)\\IO Write Bytes/sec", IntPtr.Zero, out piw);
    PdhCollectQueryData(query);   // seed: rate counters need a second collect before they answer
    return true;
  }
  // Kept for the loop's membership-change bookkeeping; there is nothing per-pid to set up any more.
  public static void Watch(int[] pids) { Open(); }
  public static void Collect() { if (query != IntPtr.Zero) { PdhCollectQueryData(query); Harvest(); } }
  static void PutP(int pid, int slot, double v) {
    double[] a; if (!pv.TryGetValue(pid, out a)) { a = new double[] { double.NaN, double.NaN, double.NaN, double.NaN, double.NaN }; pv[pid] = a; }
    a[slot] = (a[slot] == a[slot] ? a[slot] : 0) + v;   // NaN-aware sum (a pid can have more than one instance)
  }
  static void PutG(int pid, string luid, int slot, double v) {
    Dictionary<string, double[]> m; if (!gp.TryGetValue(pid, out m)) { m = new Dictionary<string, double[]>(); gp[pid] = m; }
    double[] a; if (!m.TryGetValue(luid, out a)) { a = new double[] { 0, 0, 0, 0 }; m[luid] = a; }
    a[slot] += v;
  }
  static void Each(IntPtr c, System.Action<string, double> fn) {
    if (c == IntPtr.Zero) return;
    uint size = 0, n = 0;
    if (PdhGetFormattedCounterArray(c, 0x8200, ref size, out n, IntPtr.Zero) != 0x800007D2 || size == 0) return;
    IntPtr buf = Marshal.AllocHGlobal((int)size);
    try {
      if (PdhGetFormattedCounterArray(c, 0x8200, ref size, out n, buf) != 0) return;
      int item = IntPtr.Size == 8 ? 24 : 16, vo = IntPtr.Size == 8 ? 16 : 8;
      for (int i = 0; i < n; i++) {
        IntPtr p = new IntPtr(buf.ToInt64() + (long)i * item);
        int status = Marshal.ReadInt32(p, IntPtr.Size);
        if (status != 0 && status != 1) continue;
        string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p));
        if (name == null) continue;
        fn(name, BitConverter.Int64BitsToDouble(Marshal.ReadInt64(p, vo)));
      }
    } finally { Marshal.FreeHGlobal(buf); }
  }
  static int PvPid(string name) { Match m = PVi.Match(name ?? ""); return m.Success ? int.Parse(m.Groups[2].Value) : 0; }
  static void PutGpu(string nm, int slot, double v) {
    Match m = GPe.Match(nm); if (!m.Success) return;
    // the pid in GPU instance names is DECIMAL ("pid_640104_luid_...", verified on snow) - not hex like the
    // NVIDIA engine ids elsewhere; int.Parse in the invariant culture keeps it decimal.
    int pid; if (!int.TryParse(m.Groups[1].Value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out pid)) return;
    PutG(pid, (m.Groups[2].Value + "_" + m.Groups[3].Value).ToLowerInvariant(), slot, v);
  }
  static Dictionary<string, double> engTmp = new Dictionary<string, double>();
  static void Harvest() {
    pv.Clear(); gp.Clear(); engTmp.Clear();
    Each(pcpu, delegate(string nm, double v) { int p = PvPid(nm); if (p > 0) PutP(p, 0, v); });
    Each(pws, delegate(string nm, double v) { int p = PvPid(nm); if (p > 0) PutP(p, 1, v); });
    Each(ppb, delegate(string nm, double v) { int p = PvPid(nm); if (p > 0) PutP(p, 2, v); });
    Each(pir, delegate(string nm, double v) { int p = PvPid(nm); if (p > 0) PutP(p, 3, v); });
    Each(piw, delegate(string nm, double v) { int p = PvPid(nm); if (p > 0) PutP(p, 4, v); });
    Each(gd, delegate(string nm, double v) { PutGpu(nm, 0, v); });
    Each(gs, delegate(string nm, double v) { PutGpu(nm, 1, v); });
    Each(ge, delegate(string nm, double v) {
      Match m = GPe.Match(nm); if (!m.Success || !m.Groups[4].Success) return;
      string k = m.Groups[1].Value + "|" + (m.Groups[2].Value + "_" + m.Groups[3].Value).ToLowerInvariant() + "|" + m.Groups[4].Value.ToLowerInvariant();
      double o; engTmp[k] = (engTmp.TryGetValue(k, out o) ? o : 0) + v;
    });
    foreach (KeyValuePair<string, double> kv in engTmp) {   // busiest engine type per card, like before
      string[] parts = kv.Key.Split('|');
      int pid; if (!int.TryParse(parts[0], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out pid)) continue;
      Dictionary<string, double[]> m2; if (!gp.TryGetValue(pid, out m2)) { m2 = new Dictionary<string, double[]>(); gp[pid] = m2; }
      double[] a; if (!m2.TryGetValue(parts[1], out a)) { a = new double[] { 0, 0, 0, 0 }; m2[parts[1]] = a; }
      a[3] = 1;                        // an engine instance exists for this card - a 0 value is a REAL 0, not "no data"
      if (kv.Value > a[2]) a[2] = kv.Value;   // busiest engine type per card, like Task Manager
    }
  }
  // Whether the process appeared in this cycle's process counters (an alive check with no snapshot cost).
  public static bool Seen(int pid) { return pv.ContainsKey(pid); }
  // "workingSet|private||cpuPercent" from the process counters (cpu as a share of the whole CPU), or null
  public static string ProcCounters(int pid) {
    double[] a; if (!pv.TryGetValue(pid, out a)) return null;
    bool hasCpu = a[0] == a[0], hasWs = a[1] == a[1], hasPb = a[2] == a[2];   // NaN test: x != x
    if (!hasWs && !hasCpu) return null;
    System.Globalization.CultureInfo inv = System.Globalization.CultureInfo.InvariantCulture;
    return (hasWs ? ((long)a[1]).ToString() : "") + "|" + (hasPb ? ((long)a[2]).ToString() : "") + "||" +
      (hasCpu ? (a[0] / Environment.ProcessorCount).ToString("R", inv) : "");
  }
  // "G|key|pid|luid|dedicated|shared|util" lines for one process (cards it uses only)
  public static string Gpu(string key, int pid) {
    Dictionary<string, double[]> m; if (!gp.TryGetValue(pid, out m)) return "";
    StringBuilder sb = new StringBuilder();
    foreach (KeyValuePair<string, double[]> kv in m) {
      double[] a = kv.Value;
      if (a[0] <= 0 && a[1] <= 0 && a[2] <= 0) continue;
      sb.Append("G|" + key + "|" + pid + "|" + kv.Key + "|" + a[0].ToString("R", System.Globalization.CultureInfo.InvariantCulture) + "|" +
        a[1].ToString("R", System.Globalization.CultureInfo.InvariantCulture) + "|" + (a[3] > 0 ? a[2].ToString("R", System.Globalization.CultureInfo.InvariantCulture) : "") + "\n");
    }
    return sb.ToString();
  }
  // "I|key|pid|read|write" for one process (AI_SCOPE-076); "" when neither counter has a value yet
  public static string Io(string key, int pid) {
    double[] a; if (!pv.TryGetValue(pid, out a)) return "";
    bool hasR = a[3] == a[3], hasW = a[4] == a[4];
    if (!hasR && !hasW) return "";
    System.Globalization.CultureInfo inv = System.Globalization.CultureInfo.InvariantCulture;
    return "I|" + key + "|" + pid + "|" + (hasR ? a[3].ToString("R", inv) : "") + "|" + (hasW ? a[4].ToString("R", inv) : "") + "\n";
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
    if (-not [AiScopeProc]::Parents.ContainsKey($cur)) { break }
    $pp = [AiScopeProc]::Parents[$cur]
    if ($pp -le 4 -or -not [AiScopeProc]::Names.ContainsKey($pp)) { break }   # System / Idle / already exited
    if ($STOPPARENTS -contains [AiScopeProc]::Names[$pp]) { break }
    $chain += $pp; $cur = $pp
  }
  return $chain
}
$apps = @{}; $watched = ''; $stamp = $null; $last = 0; $missing = $false
function Resolve-Apps {
  $script:apps = @{}; $script:missing = $false
  $lines = @(); try { $lines = [IO.File]::ReadAllLines($file) } catch { }
  [AiScopeProc]::Snapshot()
  $listen = @{}   # port -> pid, from netstat (fast; Get-NetTCPConnection took 1.5 s)
  foreach ($l in (netstat.exe -ano)) { if ($l -match '^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)') { $listen[[int]$Matches[1]] = [int]$Matches[2] } }
  foreach ($line in $lines) {
    $parts = $line.Split('|'); if ($parts.Count -lt 2) { continue }
    $tree = ($parts.Count -ge 4 -and $parts[3] -eq '1')   # AI_SCOPE-080: names ANCHOR a process tree instead of filtering one
    $root = $null
    foreach ($p in $parts[1].Split(',')) { if ($p -and $listen.ContainsKey([int]$p)) { $root = $listen[[int]$p]; break } }
    $fam = @(); if ($root) { $fam = @([AiScopeProc]::Family($root)) }
    $want = @()
    if ($parts.Count -ge 3 -and $parts[2]) { $want = @($parts[2].Split(',') | Where-Object { $_ }) }
    if ($tree) {
      # 080 (Strata): family = port owner + descendants, the app-named anchors (strata.exe / strata-vision.exe)
      # + their descendants, and the ancestry chains of anchors and port owner - that captures the engine
      # manager / launcher workers doing the model-load I/O and CPU while the runner is still being built
      # (078's capture: the manager ran ~6 % CPU and read hundreds of MB ~80 s before strata.exe appeared),
      # while leaving a previous instance's leftover idle engine out (no named child, not the port owner).
      $spec = @($want | Where-Object { $GENERIC -notcontains $_ })
      $anchors = @((( [AiScopeProc]::Names).Keys | Where-Object { $spec -contains [AiScopeProc]::Names[$_] }) | Sort-Object)
      $allf = @($fam) + $anchors
      foreach ($a in $anchors) { $allf += @([AiScopeProc]::Family($a)); $allf += @(Get-Ancestry $a) }
      if ($root) { $allf += @(Get-Ancestry $root) }
      $claimed = @($script:apps.Values | ForEach-Object { $_ })
      $fam = @($allf | Sort-Object -Unique | Where-Object { $claimed -notcontains $_ })
    } else {
      if ($want.Count) { $fam = @($fam | Where-Object { $want -contains [AiScopeProc]::Names[$_] }) }
      # 077 batch 3: no listening port yet (a model LOAD/UNLOAD - the engine process runs before its port
      # exists) - find the app's processes by exe NAME, but only app-specific names: a shared runner like
      # llama-server.exe without its port would misattribute another app's process (Strata's strata.exe is
      # unique; the generic set is 052's). PIDs already claimed by another key are skipped.
      if (-not $root -and $want.Count) {
        $spec = @($want | Where-Object { $GENERIC -notcontains $_ })
        if ($spec.Count) {
          $claimed = @($script:apps.Values | ForEach-Object { $_ })
          $fam = @(([AiScopeProc]::Names).Keys | Where-Object { $spec -contains [AiScopeProc]::Names[$_] -and $claimed -notcontains $_ })
        }
      }
    }
    if ($fam.Count) { $script:apps[$parts[0]] = $fam } else { $script:missing = $true }
  }
  $all = @($script:apps.Values | ForEach-Object { $_ } | Sort-Object -Unique)
  $key = $all -join ','
  if ($key -ne $script:watched) { [AiScopeProc]::Watch([int[]]$all); $script:watched = $key }
}
while ($true) {
  if (-not [AiScopeProc]::Alive(__PARENT__)) { exit }
  $txt = $null; try { $txt = [IO.File]::ReadAllText($file) } catch { }
  $now = [Environment]::TickCount
  # look again every 10 s (PIDs change when an app restarts), every 4 s while a watched app has no processes yet
  if ($txt -ne $stamp -or [Math]::Abs($now - $last) -gt $(if ($missing) { 4000 } else { 10000 })) { Resolve-Apps; $stamp = $txt; $last = $now }
  [AiScopeProc]::Collect()
  $out = New-Object Text.StringBuilder
  foreach ($k in $apps.Keys) {
    foreach ($x in $apps[$k]) {
      # RAM / CPU via OpenProcess; some processes refuse it (Strata's strata.exe) - then from the process counters
      # (P line gets a 7th field, cpu %, instead of CPU time), else the GPU numbers only
      $r = [AiScopeProc]::Read($x)
      if ($null -eq $r) {
        if (-not [AiScopeProc]::Seen($x)) { $last = 0; continue }   # gone from this cycle's counters => gone
        $r = [AiScopeProc]::ProcCounters($x); if ($null -eq $r) { $r = '||' }
      }
      $null = $out.Append('P|' + $k + '|' + $x + '|' + [AiScopeProc]::Names[$x] + '|' + $r + "`n")
      $null = $out.Append([AiScopeProc]::Gpu($k, $x))
      $null = $out.Append([AiScopeProc]::Io($k, $x))
    }
  }
  [Console]::Out.Write($out.ToString() + "---`n"); [Console]::Out.Flush()
  Start-Sleep -Milliseconds 2000
}
