# AI_SCOPE disk loop (AI_SCOPE-030): read / write bytes per second and idle time per physical disk, for the Hardware
# scope's Disk tiles. diskstats.js runs it from a temp file (-File) after filling in __PARENT__ (Node's PID) and __EVERY__
# (ms between samples). Every cycle prints one line per physical disk, then "---":
#   D|instance|readBytesPerSec|writeBytesPerSec|idlePercent      instance = PhysicalDisk's name, e.g. "0 C: D:" (and "_Total")
# One PDH query with wildcard counters (never Get-Counter: seconds per read - AI_SCOPE-037).
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Globalization; using System.Runtime.InteropServices; using System.Text;
public static class AiScopeDisk {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQuery(string src, IntPtr user, out IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounter(IntPtr q, string path, IntPtr user, out IntPtr c);
  [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr q);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArray(IntPtr c, uint fmt, ref uint size, out uint n, IntPtr buf);

  public static bool Alive(int pid) { IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return false;
    uint c; bool ok = GetExitCodeProcess(h, out c); CloseHandle(h); return ok && c == 259; }

  static IntPtr query = IntPtr.Zero;
  static IntPtr[] c = new IntPtr[3];   // read B/s, write B/s, idle %
  public static bool Open() {
    if (PdhOpenQuery(null, IntPtr.Zero, out query) != 0) return false;
    string[] paths = { "\\PhysicalDisk(*)\\Disk Read Bytes/sec", "\\PhysicalDisk(*)\\Disk Write Bytes/sec", "\\PhysicalDisk(*)\\% Idle Time" };
    for (int i = 0; i < paths.Length; i++) if (PdhAddEnglishCounter(query, paths[i], IntPtr.Zero, out c[i]) != 0) c[i] = IntPtr.Zero;
    PdhCollectQueryData(query);
    return true;
  }
  static Dictionary<string, double> Read(IntPtr counter) {
    Dictionary<string, double> res = new Dictionary<string, double>();
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
        res[Marshal.PtrToStringUni(Marshal.ReadIntPtr(p)) ?? ""] = BitConverter.Int64BitsToDouble(Marshal.ReadInt64(p, vo));
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return res;
  }
  public static string Collect() {
    PdhCollectQueryData(query);
    Dictionary<string, double> r = Read(c[0]), w = Read(c[1]), idle = Read(c[2]);
    StringBuilder sb = new StringBuilder();
    foreach (string k in r.Keys) {
      double wv, iv;
      sb.Append("D|" + k.Replace("|", " ") + "|" + r[k].ToString("R", CultureInfo.InvariantCulture) + "|" +
        (w.TryGetValue(k, out wv) ? wv.ToString("R", CultureInfo.InvariantCulture) : "") + "|" +
        (idle.TryGetValue(k, out iv) ? iv.ToString("R", CultureInfo.InvariantCulture) : "") + "\n");
    }
    return sb.ToString();
  }
}
'@
if (-not [AiScopeDisk]::Open()) { exit 2 }
Start-Sleep -Milliseconds 1000
while ($true) {
  if (-not [AiScopeDisk]::Alive(__PARENT__)) { exit }
  [Console]::Out.Write([AiScopeDisk]::Collect() + "---`n"); [Console]::Out.Flush()
  Start-Sleep -Milliseconds __EVERY__
}
