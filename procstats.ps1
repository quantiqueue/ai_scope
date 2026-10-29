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
# AI_SCOPE-084 (batch 1, 2026-10-29): the process numbers come from ONE NtQuerySystemInformation call per cycle
# (SystemProcessInformation - what Task Manager uses, no process handles), with CPU % and I/O rates obtained by
# diffing two cycles, exactly as AI_SCOPE-059 did for the Processes scope's proctop loop. That replaced the FIVE
# "\Process V2(*)" wildcard counters the 080 pass had left: they were nearly all of the cost (each ~1 s to add,
# ~1 s on the first collect, ~0.2 s per collect after - proctop.ps1's header; measured on snow with this file's own
# C# on 2026-10-29: 249-580 ms per collect+harvest cycle with NO process even watched, and 2037 ms to open the
# query), and the call also covers strata.exe, which refuses OpenProcess. GPU numbers stay on PDH - the query now
# holds only the THREE wildcards (GPU Process Memory x2, GPU Engine), ~1 ms per collect. The one-call walk: ~100 ms
# for 341 processes on snow, and that walk is what the ~100 ms cycle now consists of: the GPU harvest (batch 2,
# item 4) reads each instance's pid from its "pid_<n>_" prefix with a plain string scan and skips every instance
# this loop does not watch BEFORE running its regex and building its key (the engine counter answers with an
# instance per process x engine type x card - thousands on this PC, almost none of them ours).
# AI_SCOPE-084 also: the loop does nothing at all while the watch file has no apps (an app scope that attests
# 'idle' / 'off' / 'failed' is no longer watched - procstats.js answers those from its own 2 s zero heartbeat),
# a cycle whose collection FAILED emits no lines instead of dropping every process that refuses OpenProcess (which
# used to re-trigger the port/name lookup every loop), and the 2 s period is now measured rather than assumed
# (sleep 2000 - elapsed), so history points stay ~2 s apart instead of ~2.7 s.
# Don't use .NET PerformanceCounter here: its first use took ~25 s on a test PC (AI_SCOPE-037/038).
# Don't use Get-Counter either (8.7 s per read, AI_SCOPE-037).
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
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQuery(string src, IntPtr user, out IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounter(IntPtr q, string path, IntPtr user, out IntPtr c);
  [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr q);
  [DllImport("pdh.dll")] static extern uint PdhCloseQuery(IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArray(IntPtr c, uint fmt, ref uint size, out uint n, IntPtr buf);

  public static bool Alive(int pid) { IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return false;
    uint c; bool ok = GetExitCodeProcess(h, out c); CloseHandle(h); return ok && c == 259; }
  // The per-process fallback for machines where the one-call walk does not answer (see Walk): handles opened one
  // process at a time, which is what this loop did for every process before AI_SCOPE-084. "workingSet|private|
  // cpu100ns", or null if the process is gone or refuses OpenProcess (strata.exe, SYSTEM services).
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

  // ---- GPU numbers: PDH, THREE wildcard counters (AI_SCOPE-084 dropped the five "Process V2" ones) ----
  // One query, fetched once per cycle into a pid-keyed harvest (the 080 pass). The 072-077 design added wildcards
  // PER watched pid; every fetch walks the counter's instance space, so a cycle cost roughly +350 ms per watched
  // process (measured on snow, 080 review: 1 pid ~700 ms, 5 pids ~1850 ms per cycle).
  static IntPtr query = IntPtr.Zero;
  static IntPtr gd, gs, ge;
  static Dictionary<int, Dictionary<string, double[]>> gp = new Dictionary<int, Dictionary<string, double[]>>();  // pid -> luid -> {ded, shared, util, hasUtil}
  // GPU instance names are "pid_<hexpid>_luid_0x<h1>_0x<h2>_phys_N(_eng_N_engtype_<type>)"
  static readonly Regex GPe = new Regex("^pid_([0-9a-fA-F]{1,16})_luid_0x([0-9a-fA-F]+)_0x([0-9a-fA-F]+)_phys_\\d+(?:_eng_\\d+_engtype_(.+))?$");
  static bool Open() {
    if (query != IntPtr.Zero) return true;
    if (PdhOpenQuery(null, IntPtr.Zero, out query) != 0) { query = IntPtr.Zero; return false; }
    PdhAddEnglishCounter(query, "\\GPU Process Memory(pid_*)\\Dedicated Usage", IntPtr.Zero, out gd);
    PdhAddEnglishCounter(query, "\\GPU Process Memory(pid_*)\\Shared Usage", IntPtr.Zero, out gs);
    PdhAddEnglishCounter(query, "\\GPU Engine(pid_*)\\Utilization Percentage", IntPtr.Zero, out ge);
    PdhCollectQueryData(query);   // seed: rate counters need a second collect before they answer
    return true;
  }
  // AI_SCOPE-084 (item 4): the pids this cycle watches. GPU instance names carry their pid in a "pid_<digits>_"
  // prefix, so the harvest asks that cheap question FIRST and only runs its regex and allocates for processes we
  // actually watch - before, every GPU Engine instance on the machine (every process x every engine type x both
  // cards, often thousands) was matched and keyed. Resolve-Apps calls Watch() whenever the watched pid set changes.
  static HashSet<int> want = new HashSet<int>();
  // "pid_640104_luid_..." -> 640104, or 0 when the name is not a pid-prefixed instance. The pid there is DECIMAL
  // (verified on snow), not hex like the NVIDIA engine ids elsewhere.
  static int FastPid(string nm) {
    if (nm == null || nm.Length < 5 || nm[0] != 'p' || nm[1] != 'i' || nm[2] != 'd' || nm[3] != '_') return 0;
    int v = 0;
    for (int i = 4; i < nm.Length; i++) { char ch = nm[i]; if (ch < '0' || ch > '9') return ch == '_' ? v : 0; v = v * 10 + (ch - '0'); }
    return 0;
  }
  static bool Watched(string nm, out int pid) { pid = FastPid(nm); return pid > 0 && want.Contains(pid); }
  // Membership bookkeeping (the loop calls it when the watched pid set changes) and the harvest filter above.
  public static void Watch(int[] pids) {
    Open();
    want.Clear(); if (pids != null) foreach (int p in pids) if (p > 0) want.Add(p);
  }
  // Resume after an idle stretch (AI_SCOPE-084): forget the previous cycle so no rate is computed across the gap,
  // and seed the GPU rate counters again (their span would otherwise cover the whole idle period).
  public static void Reseed() {
    prev.Clear(); cur.Clear(); prevMs = 0; curMs = 0;
    if (query != IntPtr.Zero) PdhCollectQueryData(query);
  }
  // One cycle: the whole-process walk plus the GPU query. Returns false when the GPU query FAILED - the loop then
  // prints nothing for the cycle (a gap in the charts, which is honest) rather than reporting zeros, which for a
  // live family would be a false reading (AI_SCOPE-084 item 5; the old code ignored PdhCollectQueryData's return).
  // SnapOk says whether the walk answered: when it did not, the loop falls back to per-process handles.
  public static bool SnapOk { get { return snapOk; } }
  static bool snapOk = false;
  public static bool Collect() {
    snapOk = Walk();
    bool gpuOk = true;
    if (query != IntPtr.Zero && gd != IntPtr.Zero) gpuOk = PdhCollectQueryData(query) == 0;
    if (gpuOk) Harvest();
    return gpuOk;
  }
  // ---- every process in ONE call (AI_SCOPE-084, the pattern AI_SCOPE-059 proved for the Processes scope) ----
  class P { public long Ws, Priv, Cpu, Rd, Wr; }
  static Dictionary<int, P> cur = new Dictionary<int, P>(), prev = new Dictionary<int, P>();
  static long prevMs = 0, curMs = 0;
  static IntPtr spiBuf = IntPtr.Zero; static int spiLen = 0;
  static long NowMs() { return DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond; }
  // Offsets verified on snow 2026-10-29 against Get-Process: CreateTime 32, UserTime 40, KernelTime 48, ImageName
  // (UNICODE_STRING) 56 with its buffer pointer at 64, UniqueProcessId 80, WorkingSetSize 144, PagefileUsage 184,
  // PeakPagefileUsage 192, PrivateUsage 200, ReadTransferCount 232, WriteTransferCount 240 (x64). The x86 numbers
  // follow proctop.ps1's set from 059 and are just as unverified there - Walk's sanity check below is what keeps a
  // wrong offset from turning into wrong numbers. Names are NOT read here: the loop takes them from Snapshot().
  static bool Walk() {
    // rotate before the call: cur gets this cycle, prev keeps the cycle the rates are diffed against
    Dictionary<int, P> t = prev; prev = cur; cur = t;
    long at = NowMs();
    for (int tries = 0; tries < 6; tries++) {
      if (spiBuf == IntPtr.Zero) { spiLen = 1 << 20; spiBuf = Marshal.AllocHGlobal(spiLen); }
      int ret; int st = NtQuerySystemInformation(5, spiBuf, spiLen, out ret);   // 5 = SystemProcessInformation
      if (st == unchecked((int)0xC0000004)) {   // STATUS_INFO_LENGTH_MISMATCH: more processes than room
        Marshal.FreeHGlobal(spiBuf); spiLen = Math.Max(spiLen * 2, ret + 65536); spiBuf = Marshal.AllocHGlobal(spiLen); continue;
      }
      if (st != 0) return false;
      bool x64 = IntPtr.Size == 8;
      int oPid = x64 ? 80 : 68, oWs = x64 ? 144 : 104, oRd = x64 ? 232 : 160, oPriv = oRd - 32, oUser = 40, oKernel = 48;
      cur.Clear();
      long p = spiBuf.ToInt64();
      while (true) {
        IntPtr e = new IntPtr(p);
        int next = Marshal.ReadInt32(e, 0);
        int pid = (int)Marshal.ReadIntPtr(e, oPid).ToInt64();
        P s = new P();
        s.Ws = Marshal.ReadIntPtr(e, oWs).ToInt64();
        s.Cpu = Marshal.ReadInt64(e, oUser) + Marshal.ReadInt64(e, oKernel);
        s.Priv = Marshal.ReadInt64(e, oPriv); s.Rd = Marshal.ReadInt64(e, oRd); s.Wr = Marshal.ReadInt64(e, oRd + 8);
        cur[pid] = s;
        if (next <= 0) break;
        p += next;
      }
      // sanity: a real process list has the System process (pid 4) and dozens of entries; if the offsets ever stop
      // matching this struct, the walk reports failure and the loop uses the per-process fallback instead of garbage.
      if (cur.Count < 20 || !cur.ContainsKey(4)) return false;
      // only a COMPLETE walk moves the clock, and after a Reseed (curMs = 0) the first one sets both stamps the
      // same instant, so its rates come back empty rather than divided over the gap
      prevMs = curMs == 0 ? at : curMs; curMs = at;
      return true;
    }
    return false;
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
  static void PutGpu(string nm, int pid, int slot, double v) {
    Match m = GPe.Match(nm); if (!m.Success) return;   // pid already established by Watched() (084 item 4)
    PutG(pid, (m.Groups[2].Value + "_" + m.Groups[3].Value).ToLowerInvariant(), slot, v);
  }
  static Dictionary<string, double> engTmp = new Dictionary<string, double>();
  static void Harvest() {
    gp.Clear(); engTmp.Clear();
    Each(gd, delegate(string nm, double v) { int pid; if (!Watched(nm, out pid)) return; PutGpu(nm, pid, 0, v); });
    Each(gs, delegate(string nm, double v) { int pid; if (!Watched(nm, out pid)) return; PutGpu(nm, pid, 1, v); });
    Each(ge, delegate(string nm, double v) {
      // the same cheap filter first: on snow this counter answers with thousands of instances (every process x
      // every engine type x both cards), and this is the only one that needs a regex plus a string key per hit.
      int pid; if (!Watched(nm, out pid)) return;
      Match m = GPe.Match(nm); if (!m.Success || !m.Groups[4].Success) return;
      string k = pid + "|" + (m.Groups[2].Value + "_" + m.Groups[3].Value).ToLowerInvariant() + "|" + m.Groups[4].Value.ToLowerInvariant();
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
  // Whether the process is in this cycle's walk (an alive check with no snapshot cost). Only meaningful when
  // SnapOk: on a failed walk the loop must NOT conclude that every process it watches has exited (084 item 5 -
  // that is what used to re-run the port / name lookup every cycle, netstat included).
  public static bool Seen(int pid) { return snapOk && cur.ContainsKey(pid); }
  // "workingSet|private|cpu100ns" from the walk (CPU as cumulative 100 ns time - procstats.js turns it into a
  // percentage between cycles, exactly as it always did for the OpenProcess path), or null when the walk has no
  // entry for the pid.
  public static string Proc(int pid) {
    P s; if (!cur.TryGetValue(pid, out s)) return null;
    return s.Ws.ToString() + "|" + s.Priv.ToString() + "|" + s.Cpu.ToString();
  }
  // "I|key|pid|read|write" for one process (AI_SCOPE-076): bytes/sec from the I/O counters DIFFED against the
  // previous cycle (084), so a brand-new pid or the first cycle after a start / resume has no rate to report -
  // empty fields, which procstats.js reads as "no I/O number" rather than zero.
  public static string Io(string key, int pid) {
    if (!snapOk) return "";
    P a, b; if (!cur.TryGetValue(pid, out a) || !prev.TryGetValue(pid, out b)) return "";
    double dt = (curMs - prevMs) / 1000.0;
    if (dt <= 0.2) return "";
    System.Globalization.CultureInfo inv = System.Globalization.CultureInfo.InvariantCulture;
    long r = a.Rd >= b.Rd ? (long)((a.Rd - b.Rd) / dt) : 0L, w = a.Wr >= b.Wr ? (long)((a.Wr - b.Wr) / dt) : 0L;
    return "I|" + key + "|" + pid + "|" + r.ToString(inv) + "|" + w.ToString(inv) + "\n";
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
$apps = @{}; $watched = ''; $stamp = $null; $last = 0; $missing = $false; $idle = $true
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
  $t0 = [Environment]::TickCount
  $txt = $null; try { $txt = [IO.File]::ReadAllText($file) } catch { }
  $now = [Environment]::TickCount
  # look again every 10 s (PIDs change when an app restarts), every 4 s while a watched app has no processes yet
  if ($txt -ne $stamp -or [Math]::Abs($now - $last) -gt $(if ($missing) { 4000 } else { 10000 })) { Resolve-Apps; $stamp = $txt; $last = $now }
  if ($apps.Count -eq 0) {
    # AI_SCOPE-084 item 2: no app is being watched right now (their scopes attest 'idle' / 'off' / 'failed', and
    # procstats.js answers those with attested zeros). The loop sleeps instead of sampling - an app open with
    # nothing loaded costs this process nothing (before: ~0.7 s of work per ~2.7 s loop, all day).
    $idle = $true
  } else {
    if ($idle) {
      # coming back: drop the cycle we remember and seed the GPU rate counters, so no rate spans the idle gap
      # (a rate divided over a minutes-long gap would read as a dip). The short wait gives the counters a real
      # span before the first cycle that reports numbers.
      [AiScopeProc]::Reseed(); Start-Sleep -Milliseconds 400; $idle = $false
    }
    if ([AiScopeProc]::Collect()) {
      $out = New-Object Text.StringBuilder
      foreach ($k in $apps.Keys) {
        foreach ($x in $apps[$k]) {
          # RAM / CPU time for every process from the one-call walk (084) - no OpenProcess, so the processes that
          # refuse it (strata.exe) are covered too. If the walk did not answer, fall back to handles (Read) and
          # leave the ones that refuse it out WITHOUT re-running the lookup: a failed collection is not a signal
          # that every watched process exited (084 item 5).
          if ([AiScopeProc]::SnapOk) {
            if (-not [AiScopeProc]::Seen($x)) { $last = 0; continue }   # gone from this cycle's list => gone
            $r = [AiScopeProc]::Proc($x); if ($null -eq $r) { $r = '||' }
          } else {
            $r = [AiScopeProc]::Read($x); if ($null -eq $r) { continue }
          }
          $null = $out.Append('P|' + $k + '|' + $x + '|' + [AiScopeProc]::Names[$x] + '|' + $r + "`n")
          $null = $out.Append([AiScopeProc]::Gpu($k, $x))
          $null = $out.Append([AiScopeProc]::Io($k, $x))
        }
      }
      [Console]::Out.Write($out.ToString() + "---`n"); [Console]::Out.Flush()
    }
    # a failed GPU collection prints nothing for the cycle: the tiles keep their last honest reading and go stale
    # if it repeats, which is what the mirror's stale rule is for - and the watched set stays as it was.
  }
  # AI_SCOPE-084 item 6: the 2 s is the PERIOD, not the sleep - before, a cycle took work + 2 s (~2.7 s on snow),
  # which stretched the history spacing (and the 5-minute ring, HIST = 150) and made the chart's 6 s break rule
  # trigger on ordinary work. A cycle that overruns its budget just goes straight on to the next one.
  $el = [Environment]::TickCount - $t0
  if ($el -lt 0) { $el = 0 }
  if ($el -lt 2000) { Start-Sleep -Milliseconds (2000 - $el) }
}
