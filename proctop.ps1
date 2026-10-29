# AI_SCOPE proctop loop (AI_SCOPE-023): numbers for EVERY process, for the Processes scope's top-5 lenses.
# proctop.js runs it from a temp file (-File) after filling in __PARENT__ (Node's PID) and __EVERY__ (ms between samples).
# Every cycle prints:
#   P|pid|exe|cpuPercent|workingSet|path|ioRead|ioWrite|privateBytes|parentPid   one line per process (CPU % of the whole CPU, all cores); path (full exe path)
#                                            only the first time a process is seen, '' after that or when Windows won't tell
#                                            (refused: System32\<exe> if it exists, e.g. svchost.exe / dwm.exe); ioRead / ioWrite =
#                                            bytes/s of ALL the process's I/O (disk, network, devices - AI_SCOPE-030)
#   I|path|base64png                         the exe's icon (32 px), once per exe path (after a block, 40 at a time)
#   G|pid|luid|dedicated|shared|util         one line per process and graphics card it uses (util = busiest engine type)
#   T|phase|ms[|how]                         start-up timings, once per start (AI_SCOPE-059): begin (Unix ms when the script
#                                            began), types (load / compile the C#, how = cache|compiled|memory), counters (open the
#                                            query + add the counters), collect1 (first collect), cycle1 (building the first block)
#   W|partial                                first block only (AI_SCOPE-059): printed right after the first collect, so only the
#                                            plain values (working set, GPU memory) are in; CPU %, GPU % and I/O need a second sample
# then "---". Per process name, CPU time, working set and I/O bytes come from ONE NtQuerySystemInformation call per cycle
# (SystemProcessInformation, what Task Manager uses; no process handles needed), rates by diffing two cycles. AI_SCOPE-059:
# this replaced four "Process V2" PDH wildcard counters, which were nearly all of the cost (each ~1 s to add, ~1 s on the
# first collect, ~0.2 s per collect after that). The GPU numbers stay on one PDH query with wildcard counters (GPU Process
# Memory, GPU Engine: ~1 ms per collect). Don't use Get-Counter (8.7 s per read) or .NET PerformanceCounter (~25 s on
# first use) - see AI_SCOPE-037.
# The C# below is compiled once per version into __DLL__ (AI_SCOPE-059; proctop.js names it after a hash of this file)
# and later starts only load that DLL, instead of Add-Type compiling it on every start.
$ErrorActionPreference = 'SilentlyContinue'
$sw = [Diagnostics.Stopwatch]::StartNew()
[Console]::Out.Write('T|begin|' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + "`n"); [Console]::Out.Flush()
$src = @'
using System; using System.Collections.Generic; using System.Globalization; using System.Runtime.InteropServices; using System.Text; using System.Text.RegularExpressions;
public static class AiScopeTop {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQuery(string src, IntPtr user, out IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounter(IntPtr q, string path, IntPtr user, out IntPtr c);
  [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArray(IntPtr c, uint fmt, ref uint size, out uint n, IntPtr buf);

  public static bool Alive(int pid) { IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return false;
    uint c; bool ok = GetExitCodeProcess(h, out c); CloseHandle(h); return ok && c == 259; }

  static IntPtr query = IntPtr.Zero;
  static IntPtr[] c = new IntPtr[3];   // dedicated, shared, engine util (per process and card)
  public static long AddMs, CollectMs;   // start-up timings (AI_SCOPE-059)
  public static bool Open() {
    System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
    if (PdhOpenQuery(null, IntPtr.Zero, out query) != 0) return false;
    string[] paths = { "\\GPU Process Memory(*)\\Dedicated Usage", "\\GPU Process Memory(*)\\Shared Usage", "\\GPU Engine(*)\\Utilization Percentage" };
    for (int i = 0; i < paths.Length; i++) if (PdhAddEnglishCounter(query, paths[i], IntPtr.Zero, out c[i]) != 0) c[i] = IntPtr.Zero;
    AddMs = sw.ElapsedMilliseconds; sw.Reset(); sw.Start();
    PdhCollectQueryData(query);
    CollectMs = sw.ElapsedMilliseconds;
    return true;
  }
  // instance name -> value (valid values only)
  static List<KeyValuePair<string, double>> Read(IntPtr counter) {
    List<KeyValuePair<string, double>> res = new List<KeyValuePair<string, double>>();
    if (counter == IntPtr.Zero) return res;
    uint size = 0, n = 0;
    if (PdhGetFormattedCounterArray(counter, 0x8200, ref size, out n, IntPtr.Zero) != 0x800007D2 || size == 0) return res;
    IntPtr buf = Marshal.AllocHGlobal((int)size);
    try {
      if (PdhGetFormattedCounterArray(counter, 0x8200, ref size, out n, buf) != 0) return res;
      int item = IntPtr.Size == 8 ? 24 : 16, vo = IntPtr.Size == 8 ? 16 : 8;
      for (int i = 0; i < n; i++) {
        IntPtr p = new IntPtr(buf.ToInt64() + (long)i * item);
        int status = Marshal.ReadInt32(p, IntPtr.Size); if (status != 0 && status != 1) continue;
        res.Add(new KeyValuePair<string, double>(Marshal.PtrToStringUni(Marshal.ReadIntPtr(p)) ?? "", BitConverter.Int64BitsToDouble(Marshal.ReadInt64(p, vo))));
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return res;
  }
  // ---- Every process in one call (AI_SCOPE-059): SYSTEM_PROCESS_INFORMATION entries, read by offset ----
  class Snap { public long Cpu, Create, Rd, Wr, Priv, Ppid; }   // CPU time (user + kernel, 100 ns), creation time (tells a reused PID apart), I/O bytes, private bytes and parent pid (AI_SCOPE-084: the mirror's RAM (Committed) lens needs the first, procstats.js resolves each app's process family from the second - the rules the old procstats.ps1 ran, now on this table)
  static Dictionary<int, Snap> prevSnap = null; static long prevTicks = 0;
  static IntPtr spiBuf = IntPtr.Zero; static int spiLen = 0;
  // pid -> name, pid -> working set, pid -> counters. false if Windows refused (then the cycle has no per-process numbers).
  static bool Snapshot(Dictionary<int, string> inst, Dictionary<int, double> ws, Dictionary<int, Snap> now) {
    for (int tries = 0; tries < 6; tries++) {
      if (spiBuf == IntPtr.Zero) { spiLen = 1 << 20; spiBuf = Marshal.AllocHGlobal(spiLen); }
      int ret; int st = NtQuerySystemInformation(5, spiBuf, spiLen, out ret);   // 5 = SystemProcessInformation
      if (st == unchecked((int)0xC0000004)) {   // STATUS_INFO_LENGTH_MISMATCH: more processes than room
        Marshal.FreeHGlobal(spiBuf); spiLen = Math.Max(spiLen * 2, ret + 65536); spiBuf = Marshal.AllocHGlobal(spiLen); continue;
      }
      if (st != 0) return false;
      bool x64 = IntPtr.Size == 8;
      // offsets: 32 CreateTime, 40 UserTime, 48 KernelTime, 56 ImageName (UNICODE_STRING); then by pointer size:
      // oRd: ReadTransferCount, + 8 = WriteTransferCount.
      // oPriv (AI_SCOPE-084) = PrivateUsage, 32 bytes before ReadTransferCount; verified on snow 2026-10-29 against
      // Get-Process PrivateMemorySize64 (and it equals PagefileUsage there, as psapi's PROCESS_MEMORY_COUNTERS reports).
      // oPpid (AI_SCOPE-084) = InheritedFromUniqueProcessId, the ULONG_PTR right after UniqueProcessId - verified the
      // same day against Get-CimInstance Win32_Process.ParentProcessId for 8 processes, all matching.
      int oNameBuf = x64 ? 64 : 60, oPid = x64 ? 80 : 68, oPpid = oPid + 8, oWs = x64 ? 144 : 104, oRd = x64 ? 232 : 160, oPriv = oRd - 32;
      long p = spiBuf.ToInt64();
      while (true) {
        IntPtr e = new IntPtr(p);
        int next = Marshal.ReadInt32(e, 0);
        int pid = (int)Marshal.ReadIntPtr(e, oPid).ToInt64();
        int nlen = Marshal.ReadInt16(e, 56) & 0xFFFF; IntPtr nbuf = Marshal.ReadIntPtr(e, oNameBuf);
        string name = pid == 0 ? "Idle" : nbuf != IntPtr.Zero && nlen > 0 ? Marshal.PtrToStringUni(nbuf, nlen / 2) : pid == 4 ? "System" : "";
        Snap s = new Snap(); s.Create = Marshal.ReadInt64(e, 32); s.Cpu = Marshal.ReadInt64(e, 40) + Marshal.ReadInt64(e, 48);
        s.Rd = Marshal.ReadInt64(e, oRd); s.Wr = Marshal.ReadInt64(e, oRd + 8); s.Priv = Marshal.ReadInt64(e, oPriv);
        s.Ppid = (long)Marshal.ReadIntPtr(e, oPpid).ToInt64();
        inst[pid] = name; ws[pid] = (double)Marshal.ReadIntPtr(e, oWs).ToInt64(); now[pid] = s;
        if (next <= 0) break;
        p += next;
      }
      return true;
    }
    return false;
  }
  // pid -> exe name it had when its path was looked up (a reused PID gets looked up again); exe paths whose icon was sent
  static Dictionary<int, string> seen = new Dictionary<int, string>();
  static HashSet<string> iconSent = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  static Queue<string> iconQueue = new Queue<string>();
  // "I|path|png" lines for up to max exes still waiting for their icon. Printed after a block, so icons never delay
  // the numbers (the first block has ~70 new exes; loading System.Drawing and reading them all took ~15 s on the test PC).
  public static string Icons(int max) {
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < max && iconQueue.Count > 0; i++) { string p = iconQueue.Dequeue(); string png = IconOf(p); if (png != null) sb.Append("I|" + p + "|" + png + "\n"); }
    return sb.ToString();
  }
  static string PathOf(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return "";
    try { StringBuilder sb = new StringBuilder(1024); uint n = 1024; return QueryFullProcessImageNameW(h, 0, sb, ref n) ? sb.ToString(0, (int)n) : ""; }
    finally { CloseHandle(h); }
  }
  static string IconOf(string path) {
    try {
      using (System.Drawing.Icon ic = System.Drawing.Icon.ExtractAssociatedIcon(path)) {
        if (ic == null) return null;
        using (System.Drawing.Bitmap bmp = ic.ToBitmap()) using (System.IO.MemoryStream ms = new System.IO.MemoryStream()) {
          bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png); return Convert.ToBase64String(ms.ToArray());
        }
      }
    } catch { return null; }
  }
  static readonly Regex GpuInst = new Regex("^pid_(\\d+)_luid_0x([0-9a-fA-F]+)_0x([0-9a-fA-F]+)_phys_\\d+(?:_eng_\\d+_engtype_(.*))?$");
  static string F(double v) { return v.ToString("R", CultureInfo.InvariantCulture); }
  static void AddTo(Dictionary<string, double> d, string k, double v) { double o; d[k] = (d.TryGetValue(k, out o) ? o : 0) + v; }

  // first: the block right after Open()'s collect (no new collect; rates - CPU %, I/O, GPU engine % - need a second cycle)
  public static string Cycle(bool first) {
    if (query == IntPtr.Zero) return "";
    if (!first) PdhCollectQueryData(query);
    int cores = Math.Max(1, Environment.ProcessorCount);
    StringBuilder sb = new StringBuilder();
    if (first) sb.Append("W|partial\n");
    // Name, working set, CPU % (of the whole CPU, all cores) and I/O bytes/s per process, from one snapshot + the previous one
    Dictionary<int, double> cpu = new Dictionary<int, double>(), ws = new Dictionary<int, double>(), ior = new Dictionary<int, double>(), iow = new Dictionary<int, double>();
    Dictionary<int, string> inst = new Dictionary<int, string>();
    Dictionary<int, Snap> now = new Dictionary<int, Snap>();
    long ticks = System.Diagnostics.Stopwatch.GetTimestamp();
    if (Snapshot(inst, ws, now)) {
      double dt = prevSnap == null ? 0 : (ticks - prevTicks) / (double)System.Diagnostics.Stopwatch.Frequency;
      if (!first && dt > 0.2) foreach (KeyValuePair<int, Snap> kv in now) {
        Snap o; if (!prevSnap.TryGetValue(kv.Key, out o) || o.Create != kv.Value.Create) continue;   // new process (or a reused PID): no rate yet
        cpu[kv.Key] = (kv.Value.Cpu - o.Cpu) / (dt * 1e7 * cores) * 100;
        ior[kv.Key] = (kv.Value.Rd - o.Rd) / dt; iow[kv.Key] = (kv.Value.Wr - o.Wr) / dt;
      }
      prevSnap = now; prevTicks = ticks;
    }
    foreach (KeyValuePair<int, string> kv in inst) {
      int pid = kv.Key; if (pid == 0 || kv.Value == "Idle") continue;
      string name = kv.Value; if (string.IsNullOrEmpty(name)) continue;
      double cv, wv; bool hc = cpu.TryGetValue(pid, out cv), hw = ws.TryGetValue(pid, out wv);
      string path = "", was;
      if (!seen.TryGetValue(pid, out was) || was != name) {
        seen[pid] = name; path = PathOf(pid);
        // Services running as SYSTEM (svchost, dwm, lsass, ...) don't give their path to a non-admin app: most live in System32
        if (path == "" && name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) {
          string sys = System.IO.Path.Combine(Environment.SystemDirectory, name);
          if (System.IO.File.Exists(sys)) path = sys;
          else { sys = System.IO.Path.Combine(Environment.SystemDirectory, "wbem\\" + name); if (System.IO.File.Exists(sys)) path = sys; }   // WmiPrvSE.exe
        }
        if (path != "" && !iconSent.Contains(path)) { iconSent.Add(path); iconQueue.Enqueue(path); }
      }
      double rv, xv; bool hr = ior.TryGetValue(pid, out rv), hx = iow.TryGetValue(pid, out xv);
      // AI_SCOPE-084: private bytes (the mirror's RAM (Committed) lens) and the parent pid (procstats.js resolves
      // each app's process family from the sample's own table - the 077 generic-runner and 080 tree rules used to
      // run here, next to a second CreateToolhelp32Snapshot that cost 125-240 ms every re-resolve).
      Snap snp = null; now.TryGetValue(pid, out snp);
      sb.Append("P|" + pid + "|" + name.Replace("|", "/") + "|" + (hc ? F(Math.Max(0, cv)) : "") + "|" + (hw ? F(wv) : "") + "|" + path + "|" +
        (hr ? F(Math.Max(0, rv)) : "") + "|" + (hx ? F(Math.Max(0, xv)) : "") + "|" + (snp != null ? F(snp.Priv) : "") + "|" +
        (snp != null ? snp.Ppid.ToString() : "0") + "\n");
    }
    // forget processes that are gone
    List<int> gone = new List<int>(); foreach (int k in seen.Keys) if (!inst.ContainsKey(k)) gone.Add(k); foreach (int k in gone) seen.Remove(k);
    // GPU per process and card: memory summed, utilization = busiest engine type (each type summed over its engines), like Task Manager
    Dictionary<string, double> ded = new Dictionary<string, double>(), sh = new Dictionary<string, double>(), eng = new Dictionary<string, double>();
    foreach (KeyValuePair<string, double> kv in Read(c[0])) { Match m = GpuInst.Match(kv.Key); if (m.Success) AddTo(ded, m.Groups[1].Value + "|" + (m.Groups[2].Value + "_" + m.Groups[3].Value).ToLowerInvariant(), kv.Value); }
    foreach (KeyValuePair<string, double> kv in Read(c[1])) { Match m = GpuInst.Match(kv.Key); if (m.Success) AddTo(sh, m.Groups[1].Value + "|" + (m.Groups[2].Value + "_" + m.Groups[3].Value).ToLowerInvariant(), kv.Value); }
    foreach (KeyValuePair<string, double> kv in Read(c[2])) { Match m = GpuInst.Match(kv.Key); if (m.Success) AddTo(eng, m.Groups[1].Value + "|" + (m.Groups[2].Value + "_" + m.Groups[3].Value).ToLowerInvariant() + "|" + m.Groups[4].Value.ToLowerInvariant(), kv.Value); }
    Dictionary<string, double> util = new Dictionary<string, double>();
    foreach (KeyValuePair<string, double> kv in eng) { int i = kv.Key.LastIndexOf('|'); string k = kv.Key.Substring(0, i); double o; util[k] = Math.Max(util.TryGetValue(k, out o) ? o : 0, kv.Value); }
    HashSet<string> keys = new HashSet<string>(ded.Keys); keys.UnionWith(sh.Keys); keys.UnionWith(util.Keys);
    foreach (string k in keys) {
      double d, s, u; ded.TryGetValue(k, out d); sh.TryGetValue(k, out s); bool hu = util.TryGetValue(k, out u);
      if (d <= 0 && s <= 0 && u <= 0) continue;
      sb.Append("G|" + k + "|" + F(d) + "|" + F(s) + "|" + (hu ? F(Math.Min(100, u)) : "") + "\n");
    }
    return sb.ToString();
  }
}
'@
function Ready { return [bool]('AiScopeTop' -as [type]) }
$dll = '__DLL__'
$tTypes = $sw.ElapsedMilliseconds; $how = 'cache'
if ($dll -and (Test-Path -LiteralPath $dll)) { try { Add-Type -Path $dll -ErrorAction Stop } catch {} }
if (-not (Ready) -and $dll) {
  $how = 'compiled'
  # First start of this version: compile into the cache. To a name of our own first, then rename - another AI_SCOPE
  # may be compiling the same file right now.
  $tmp = $dll -replace '\.dll$', ('-' + $PID + '.dll')
  try {
    Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing -OutputAssembly $tmp -OutputType Library -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $dll)) { Move-Item -LiteralPath $tmp -Destination $dll -ErrorAction Stop }
  } catch {}
  if (-not (Ready)) { foreach ($f in @($dll, $tmp)) { if (-not (Ready) -and (Test-Path -LiteralPath $f)) { try { Add-Type -Path $f -ErrorAction Stop } catch {} } } }
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }   # fails while loaded; proctop.js tidies up later
}
if (-not (Ready)) { $how = 'memory'; Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing }   # no cache: compile in memory, as before
$tTypes = $sw.ElapsedMilliseconds - $tTypes
if (-not [AiScopeTop]::Open()) { exit 1 }
# First block straight away (AI_SCOPE-059): memory values are valid after one collect, so Top RAM / VRAM / shared don't wait
# for the second sample. No icons after it, so the full block isn't held up by them.
$t = $sw.ElapsedMilliseconds; $first = [AiScopeTop]::Cycle($true); $t = $sw.ElapsedMilliseconds - $t
[Console]::Out.Write('T|types|' + $tTypes + '|' + $how + "`nT|counters|" + [AiScopeTop]::AddMs + "`nT|collect1|" + [AiScopeTop]::CollectMs +
  "`nT|cycle1|" + $t + "`n" + $first + "---`n"); [Console]::Out.Flush()
# Pace (AI_SCOPE-059): ms between samples, from the control file proctop.js writes (fast while a Processes lens is looked
# at, slow otherwise). Read every 250 ms while waiting; a faster pace than the current wait takes a sample at once.
$ctl = '__CTL__'; $every = __EVERY__
function Pace { try { $v = [int]([IO.File]::ReadAllText($ctl).Trim()); if ($v -ge 1000) { return $v } } catch {}; return $every }
$wait = 1000   # first numbers: CPU % and GPU % need two samples, 1 s apart is enough (then every $every ms)
while ($true) {
  if (-not [AiScopeTop]::Alive(__PARENT__)) { exit }
  $slept = 0
  while ($slept -lt $wait) {
    Start-Sleep -Milliseconds 250; $slept += 250
    $e = Pace
    if ($e -ne $every) { $faster = $e -lt $every; $every = $e; if ($faster) { $wait = [Math]::Min($wait, [Math]::Max(1000, $slept)) } }   # rates need >= 1 s
  }
  $wait = $every
  [Console]::Out.Write([AiScopeTop]::Cycle($false) + "---`n"); [Console]::Out.Flush()
  $icons = [AiScopeTop]::Icons(40); if ($icons) { [Console]::Out.Write($icons); [Console]::Out.Flush() }   # read with the next block
}
