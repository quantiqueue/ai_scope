# AI_SCOPE proctop loop (AI_SCOPE-023): numbers for EVERY process, for the Processes scope's top-5 lenses.
# proctop.js runs it from a temp file (-File) after filling in __PARENT__ (Node's PID) and __EVERY__ (ms between samples).
# Every cycle prints:
#   P|pid|exe|cpuPercent|workingSet|path     one line per process (CPU % of the whole CPU, all cores); path (full exe path)
#                                            only the first time a process is seen, '' after that or when Windows won't tell
#                                            (refused: System32\<exe> if it exists, e.g. svchost.exe / dwm.exe)
#   I|path|base64png                         the exe's icon (32 px), once per exe path (after a block, 40 at a time)
#   G|pid|luid|dedicated|shared|util         one line per process and graphics card it uses (util = busiest engine type)
# then "---". One PDH query with wildcard counters over all processes (AI_SCOPE-023 probe on a test PC: ~1 s to set up,
# 2.5 s for the first collect - up to 6 s when the PC is busy - then 0.4 s per collect for ~340 processes). Don't use Get-Counter (8.7 s per read) or
# .NET PerformanceCounter (~25 s on first use) - see AI_SCOPE-037. Exe names come from a Toolhelp snapshot.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Globalization; using System.Runtime.InteropServices; using System.Text; using System.Text.RegularExpressions;
public static class AiScopeTop {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder name, ref uint size);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Entry { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref Entry e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref Entry e);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQuery(string src, IntPtr user, out IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounter(IntPtr q, string path, IntPtr user, out IntPtr c);
  [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArray(IntPtr c, uint fmt, ref uint size, out uint n, IntPtr buf);

  public static bool Alive(int pid) { IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return false;
    uint c; bool ok = GetExitCodeProcess(h, out c); CloseHandle(h); return ok && c == 259; }

  static IntPtr query = IntPtr.Zero;
  static IntPtr[] c = new IntPtr[5];   // dedicated, shared, engine util, cpu, working set
  public static bool Open() {
    if (PdhOpenQuery(null, IntPtr.Zero, out query) != 0) return false;
    string[] paths = { "\\GPU Process Memory(*)\\Dedicated Usage", "\\GPU Process Memory(*)\\Shared Usage", "\\GPU Engine(*)\\Utilization Percentage",
      "\\Process V2(*)\\% Processor Time", "\\Process V2(*)\\Working Set" };
    for (int i = 0; i < paths.Length; i++) if (PdhAddEnglishCounter(query, paths[i], IntPtr.Zero, out c[i]) != 0) c[i] = IntPtr.Zero;
    PdhCollectQueryData(query);
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
  static Dictionary<int, string> Names() {
    Dictionary<int, string> names = new Dictionary<int, string>();
    IntPtr s = CreateToolhelp32Snapshot(2, 0); if (s == IntPtr.Zero || s == new IntPtr(-1)) return names;
    Entry e = new Entry(); e.dwSize = (uint)Marshal.SizeOf(typeof(Entry));
    if (Process32FirstW(s, ref e)) { do { names[(int)e.th32ProcessID] = e.szExeFile; } while (Process32NextW(s, ref e)); }
    CloseHandle(s); return names;
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
  static readonly Regex ProcInst = new Regex("^(.*):(\\d+)$");
  static string F(double v) { return v.ToString("R", CultureInfo.InvariantCulture); }
  static void AddTo(Dictionary<string, double> d, string k, double v) { double o; d[k] = (d.TryGetValue(k, out o) ? o : 0) + v; }

  public static string Cycle() {
    if (query == IntPtr.Zero) return "";
    PdhCollectQueryData(query);
    Dictionary<int, string> names = Names();
    int cores = Math.Max(1, Environment.ProcessorCount);
    StringBuilder sb = new StringBuilder();
    // CPU + working set per process ("Process V2" instances are "<name>:<pid>", Windows 10 1709+)
    Dictionary<int, double> cpu = new Dictionary<int, double>(), ws = new Dictionary<int, double>();
    Dictionary<int, string> inst = new Dictionary<int, string>();
    foreach (KeyValuePair<string, double> kv in Read(c[3])) { Match m = ProcInst.Match(kv.Key); if (!m.Success) continue; int pid = int.Parse(m.Groups[2].Value); cpu[pid] = kv.Value / cores; inst[pid] = m.Groups[1].Value; }
    foreach (KeyValuePair<string, double> kv in Read(c[4])) { Match m = ProcInst.Match(kv.Key); if (!m.Success) continue; int pid = int.Parse(m.Groups[2].Value); ws[pid] = kv.Value; inst[pid] = m.Groups[1].Value; }
    foreach (KeyValuePair<int, string> kv in inst) {
      int pid = kv.Key; if (pid == 0 || kv.Value == "_Total" || kv.Value == "Idle") continue;
      string name; if (!names.TryGetValue(pid, out name) || string.IsNullOrEmpty(name)) name = kv.Value;
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
      sb.Append("P|" + pid + "|" + name.Replace("|", "/") + "|" + (hc ? F(Math.Max(0, cv)) : "") + "|" + (hw ? F(wv) : "") + "|" + path + "\n");
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
'@ -ReferencedAssemblies System.Drawing
if (-not [AiScopeTop]::Open()) { exit 1 }
$wait = 1000   # first numbers: CPU % and GPU % need two samples, 1 s apart is enough (then every __EVERY__ ms)
while ($true) {
  if (-not [AiScopeTop]::Alive(__PARENT__)) { exit }
  Start-Sleep -Milliseconds $wait; $wait = __EVERY__
  [Console]::Out.Write([AiScopeTop]::Cycle() + "---`n"); [Console]::Out.Flush()
  $icons = [AiScopeTop]::Icons(40); if ($icons) { [Console]::Out.Write($icons); [Console]::Out.Flush() }   # read with the next block
}
