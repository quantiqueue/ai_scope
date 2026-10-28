# AI_SCOPE procstats loop (AI_SCOPE-038). procstats.js runs it from a temp file (-File) after filling in
# __LUIDS__ (unused here, reserved), __FILE__ (watch file: one "key|port,port|name,name" line per app; the names are
# optional - when given, only the app's processes with those exe names count, e.g. Bionic's llama-server.exe) and __PARENT__ (Node's PID).
# Every 2 s prints, for each watched app:
#   P|key|pid|name|workingSet|private|cpu100ns       one line per process of the app
#   G|key|pid|luid|dedicated|shared|util              one line per process and graphics card it uses
#   I|key|pid|read|write                             IO Read / IO Write Bytes per second, per process (AI_SCOPE-076)
# then "---". An app's processes = the process listening on its port + all its child processes.
# GPU numbers: Windows GPU performance counters read through PDH (one query, wildcard per process, collected every
# cycle). Don't use .NET PerformanceCounter here: its first use took ~25 s on a test PC (AI_SCOPE-037/038).
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
  // Whether a process still exists (a fresh snapshot; works even when OpenProcess is refused, e.g. Strata's strata.exe)
  public static bool Exists(int pid) {
    IntPtr s = CreateToolhelp32Snapshot(2, 0); if (s == IntPtr.Zero || s == new IntPtr(-1)) return true;
    Entry e = new Entry(); e.dwSize = (uint)Marshal.SizeOf(typeof(Entry)); bool found = false;
    if (Process32FirstW(s, ref e)) { do { if ((int)e.th32ProcessID == pid) { found = true; break; } } while (Process32NextW(s, ref e)); }
    CloseHandle(s); return found;
  }
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

  // ---- PDH: one query, three wildcard counters per process ----
  static IntPtr query = IntPtr.Zero;
  static Dictionary<int, IntPtr[]> counters = new Dictionary<int, IntPtr[]>();
  public static void Watch(int[] pids) {
    if (query != IntPtr.Zero) { PdhCloseQuery(query); query = IntPtr.Zero; }
    counters.Clear();
    if (PdhOpenQuery(null, IntPtr.Zero, out query) != 0) { query = IntPtr.Zero; return; }
    foreach (int p in pids) {
      IntPtr d, s, e;
      string inst = "pid_" + p + "_*";
      if (PdhAddEnglishCounter(query, "\\GPU Process Memory(" + inst + ")\\Dedicated Usage", IntPtr.Zero, out d) != 0) d = IntPtr.Zero;
      if (PdhAddEnglishCounter(query, "\\GPU Process Memory(" + inst + ")\\Shared Usage", IntPtr.Zero, out s) != 0) s = IntPtr.Zero;
      if (PdhAddEnglishCounter(query, "\\GPU Engine(" + inst + ")\\Utilization Percentage", IntPtr.Zero, out e) != 0) e = IntPtr.Zero;
      // CPU / RAM from the process counters too, for processes that refuse OpenProcess (Strata's strata.exe):
      // "Process V2" instances are named "<name>:<pid>" (Windows 10 1709+), so a "*:<pid>" wildcard finds the process by PID.
      IntPtr pc, ws, pb, ir, iw;
      if (PdhAddEnglishCounter(query, "\\Process V2(*:" + p + ")\\% Processor Time", IntPtr.Zero, out pc) != 0) pc = IntPtr.Zero;
      if (PdhAddEnglishCounter(query, "\\Process V2(*:" + p + ")\\Working Set", IntPtr.Zero, out ws) != 0) ws = IntPtr.Zero;
      if (PdhAddEnglishCounter(query, "\\Process V2(*:" + p + ")\\Private Bytes", IntPtr.Zero, out pb) != 0) pb = IntPtr.Zero;
      // AI_SCOPE-076: file I/O rates for the Strata I/O lens. Also PDH (not GetProcessIoCounters): strata.exe refuses
      // OpenProcess, so there is no handle to ask. Measured on snow: IO Read / IO Write Bytes/sec resolve VALID for
      // strata.exe; Page Writes/sec does not exist per process, so pagefile traffic is out of reach here (it is
      // charged to System). Sockets are not counted either - a download that is written to disk shows as a write only.
      if (PdhAddEnglishCounter(query, "\\Process V2(*:" + p + ")\\IO Read Bytes/sec", IntPtr.Zero, out ir) != 0) ir = IntPtr.Zero;
      if (PdhAddEnglishCounter(query, "\\Process V2(*:" + p + ")\\IO Write Bytes/sec", IntPtr.Zero, out iw) != 0) iw = IntPtr.Zero;
      counters[p] = new IntPtr[] { d, s, e, pc, ws, pb, ir, iw };
    }
    PdhCollectQueryData(query);
  }
  public static void Collect() { if (query != IntPtr.Zero) PdhCollectQueryData(query); }
  static readonly Regex Inst = new Regex("luid_0x([0-9a-fA-F]+)_0x([0-9a-fA-F]+)_phys_\\d+(?:_eng_\\d+_engtype_(.*))?$");
  // luid -> value: memory summed per card; engines: busiest engine type per card (like Task Manager)
  static Dictionary<string, double> ByLuid(IntPtr c, bool engines) {
    Dictionary<string, double> res = new Dictionary<string, double>();
    if (c == IntPtr.Zero) return res;
    uint size = 0, n = 0;
    if (PdhGetFormattedCounterArray(c, 0x8200, ref size, out n, IntPtr.Zero) != 0x800007D2 || size == 0) return res;
    IntPtr buf = Marshal.AllocHGlobal((int)size);
    try {
      if (PdhGetFormattedCounterArray(c, 0x8200, ref size, out n, buf) != 0) return res;
      int item = IntPtr.Size == 8 ? 24 : 16, vo = IntPtr.Size == 8 ? 16 : 8;
      Dictionary<string, double> per = new Dictionary<string, double>();
      for (int i = 0; i < n; i++) {
        IntPtr p = new IntPtr(buf.ToInt64() + (long)i * item);
        int status = Marshal.ReadInt32(p, IntPtr.Size);
        if (status != 0 && status != 1) continue;
        string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p));
        Match m = Inst.Match(name ?? ""); if (!m.Success) continue;
        string luid = (m.Groups[1].Value + "_" + m.Groups[2].Value).ToLowerInvariant();
        string key = engines ? luid + "|" + m.Groups[3].Value.ToLowerInvariant() : luid;
        double v = BitConverter.Int64BitsToDouble(Marshal.ReadInt64(p, vo)), o;
        per[key] = (per.TryGetValue(key, out o) ? o : 0) + v;
      }
      foreach (KeyValuePair<string, double> kv in per) {
        string luid = engines ? kv.Key.Split('|')[0] : kv.Key; double o;
        res[luid] = engines ? Math.Max(res.TryGetValue(luid, out o) ? o : 0, kv.Value) : kv.Value;
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return res;
  }
  // Sum of all instances of a counter (null when it has no valid value yet)
  static double? Sum(IntPtr c) {
    if (c == IntPtr.Zero) return null;
    uint size = 0, n = 0;
    if (PdhGetFormattedCounterArray(c, 0x8200, ref size, out n, IntPtr.Zero) != 0x800007D2 || size == 0) return null;
    IntPtr buf = Marshal.AllocHGlobal((int)size);
    try {
      if (PdhGetFormattedCounterArray(c, 0x8200, ref size, out n, buf) != 0) return null;
      int item = IntPtr.Size == 8 ? 24 : 16, vo = IntPtr.Size == 8 ? 16 : 8; double t = 0; bool any = false;
      for (int i = 0; i < n; i++) {
        IntPtr q = new IntPtr(buf.ToInt64() + (long)i * item);
        int status = Marshal.ReadInt32(q, IntPtr.Size); if (status != 0 && status != 1) continue;
        t += BitConverter.Int64BitsToDouble(Marshal.ReadInt64(q, vo)); any = true;
      }
      return any ? (double?)t : null;
    } finally { Marshal.FreeHGlobal(buf); }
  }
  // "workingSet|private||cpuPercent" from the process counters (cpu as a share of the whole CPU), or null
  public static string ProcCounters(int pid) {
    IntPtr[] c; if (!counters.TryGetValue(pid, out c)) return null;
    double? cpu = Sum(c[3]), ws = Sum(c[4]), pb = Sum(c[5]);
    if (ws == null && cpu == null) return null;
    System.Globalization.CultureInfo inv = System.Globalization.CultureInfo.InvariantCulture;
    return (ws == null ? "" : ((long)ws.Value).ToString()) + "|" + (pb == null ? "" : ((long)pb.Value).ToString()) + "||" +
      (cpu == null ? "" : (cpu.Value / Environment.ProcessorCount).ToString("R", inv));
  }
  // "G|key|pid|luid|dedicated|shared|util" lines for one process (cards it uses only)
  public static string Gpu(string key, int pid) {
    IntPtr[] c; if (!counters.TryGetValue(pid, out c)) return "";
    Dictionary<string, double> d = ByLuid(c[0], false), s = ByLuid(c[1], false), e = ByLuid(c[2], true);
    StringBuilder sb = new StringBuilder();
    HashSet<string> luids = new HashSet<string>(d.Keys); luids.UnionWith(s.Keys); luids.UnionWith(e.Keys);
    foreach (string l in luids) {
      double dv, sv, ev; d.TryGetValue(l, out dv); s.TryGetValue(l, out sv); bool he = e.TryGetValue(l, out ev);
      if (dv <= 0 && sv <= 0 && ev <= 0) continue;
      sb.Append("G|" + key + "|" + pid + "|" + l + "|" + dv.ToString("R", System.Globalization.CultureInfo.InvariantCulture) + "|" +
        sv.ToString("R", System.Globalization.CultureInfo.InvariantCulture) + "|" + (he ? ev.ToString("R", System.Globalization.CultureInfo.InvariantCulture) : "") + "\n");
    }
    return sb.ToString();
  }
  // "I|key|pid|read|write" for one process (AI_SCOPE-076); "" when neither counter has a value yet
  public static string Io(string key, int pid) {
    IntPtr[] c; if (!counters.TryGetValue(pid, out c) || c.Length < 8) return "";
    double? r = Sum(c[6]), w = Sum(c[7]);
    if (r == null && w == null) return "";
    System.Globalization.CultureInfo inv = System.Globalization.CultureInfo.InvariantCulture;
    return "I|" + key + "|" + pid + "|" + (r == null ? "" : r.Value.ToString("R", inv)) + "|" + (w == null ? "" : w.Value.ToString("R", inv)) + "\n";
  }
}
'@
$file = '__FILE__'
$apps = @{}; $watched = ''; $stamp = $null; $last = 0; $missing = $false
function Resolve-Apps {
  $script:apps = @{}; $script:missing = $false
  $lines = @(); try { $lines = [IO.File]::ReadAllLines($file) } catch { }
  [AiScopeProc]::Snapshot()
  $listen = @{}   # port -> pid, from netstat (fast; Get-NetTCPConnection took 1.5 s)
  foreach ($l in (netstat.exe -ano)) { if ($l -match '^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)') { $listen[[int]$Matches[1]] = [int]$Matches[2] } }
  foreach ($line in $lines) {
    $parts = $line.Split('|'); if ($parts.Count -lt 2) { continue }
    $root = $null
    foreach ($p in $parts[1].Split(',')) { if ($p -and $listen.ContainsKey([int]$p)) { $root = $listen[[int]$p]; break } }
    $fam = @(); if ($root) { $fam = @([AiScopeProc]::Family($root)) }
    if ($parts.Count -ge 3 -and $parts[2]) {
      $want = @($parts[2].Split(',') | Where-Object { $_ })
      $fam = @($fam | Where-Object { $want -contains [AiScopeProc]::Names[$_] })
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
        if (-not [AiScopeProc]::Exists($x)) { $last = 0; continue }
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
