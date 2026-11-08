# AI_SCOPE commit loop (AI_SCOPE-118): committed bytes, the commit limit and the peak commit charge since the
# last boot, for the Hardware scope's RAM (Committed) tile and the app scopes' Mirror RAM (Committed) lens.
# ramcommitstats.js runs it from a temp file (-File) after filling in __PARENT__ (Node's PID) and __EVERY__
# (ms between samples). Every cycle prints one line:
#   M|CommitTotalBytes|CommitLimitBytes|CommitPeakBytes   (GetPerformanceInfo pages x PageSize)
# One GetPerformanceInfo call per sample, in a long-running PowerShell: the old per-60-s CIM route cost 9-11 s on
# Win32_OperatingSystem (snow, 2026-11-07) and timed out, which is why this exists.
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System; using System.Globalization; using System.Runtime.InteropServices;
public static class AiScopeCommit {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  // PERFORMANCE_INFORMATION: cb is a DWORD, the memory fields are SIZE_T (UIntPtr), the last three are DWORDs.
  // cb must be set to Marshal.SizeOf before the call.
  [StructLayout(LayoutKind.Sequential)]
  struct PerfInfo {
    public uint cb;
    public UIntPtr CommitTotal, CommitLimit, CommitPeak, PhysicalTotal, PhysicalAvailable, SystemCache,
                   KernelTotal, KernelPaged, KernelNonpaged, PageSize;
    public uint HandleCount, ProcessCount, ThreadCount;
  }
  [DllImport("kernel32.dll", EntryPoint = "K32GetPerformanceInfo")]
  static extern bool GetPerformanceInfo(ref PerfInfo info, uint size);

  public static bool Alive(int pid) { IntPtr h = OpenProcess(0x1000, false, pid); if (h == IntPtr.Zero) return false;
    uint c; bool ok = GetExitCodeProcess(h, out c); CloseHandle(h); return ok && c == 259; }

  public static string Collect() {
    PerfInfo p = new PerfInfo(); p.cb = (uint)Marshal.SizeOf(typeof(PerfInfo));
    if (!GetPerformanceInfo(ref p, p.cb)) return "";
    ulong page = (ulong)p.PageSize.ToUInt64();
    if (page == 0) return "";
    return "M|" + ((ulong)p.CommitTotal.ToUInt64() * page).ToString(CultureInfo.InvariantCulture) + "|" +
      ((ulong)p.CommitLimit.ToUInt64() * page).ToString(CultureInfo.InvariantCulture) + "|" +
      ((ulong)p.CommitPeak.ToUInt64() * page).ToString(CultureInfo.InvariantCulture) + "\n";
  }
}
'@
while ($true) {
  if (-not [AiScopeCommit]::Alive(__PARENT__)) { exit }
  $line = [AiScopeCommit]::Collect()
  if ($line) { [Console]::Out.Write($line); [Console]::Out.Flush() }
  Start-Sleep -Milliseconds __EVERY__
}
