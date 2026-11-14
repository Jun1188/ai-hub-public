param([ValidateSet('threads', 'files')][string]$Mode = 'threads', [int]$TargetPid = 0, [int]$IntervalMs = 1000, [int]$Count = 10)
# On-demand probe of ONE process for the debugging tab (src/core/debugging/). Not part of the continuous sampler:
# per-thread and per-mapping reads cost too much to run for every process every 2 s. No admin needed for same-user processes.
#   threads: streams {t,pid,threads:[{id,n,c,main}]} every IntervalMs, Count times (c = % of one core).
#   files:   one {t,pid,files:[{path,image,mapped,resident}]} — memory-mapped files and how much of each is in RAM.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch {}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class HubProbe {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenThread(uint access, bool inherit, int tid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool GetThreadTimes(IntPtr h, out long create, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern int GetThreadDescription(IntPtr h, out IntPtr desc);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr addr, out MBI info, IntPtr len);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint QueryDosDeviceW(string drive, StringBuilder target, int size);
  [DllImport("psapi.dll", CharSet = CharSet.Unicode)] static extern uint GetMappedFileNameW(IntPtr h, IntPtr addr, StringBuilder name, uint size);
  [DllImport("psapi.dll", SetLastError = true)] static extern bool QueryWorkingSet(IntPtr h, IntPtr buf, int size);
  [StructLayout(LayoutKind.Sequential)] struct MBI { public IntPtr BaseAddress, AllocationBase; public uint AllocationProtect; public IntPtr RegionSize; public uint State, Protect, Type; }
  const uint THREAD_QUERY_INFORMATION = 0x40; // GetThreadDescription is denied with the LIMITED right (measured 0xD0000022)
  const uint MEM_IMAGE = 0x1000000, MEM_MAPPED = 0x40000, MEM_COMMIT = 0x1000;

  static string Q(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") { if (c == '"' || c == '\\') b.Append('\\').Append(c); else if (c < 32) b.Append(' '); else b.Append(c); }
    return b.Append('"').ToString();
  }
  static string N(double v) { return double.IsNaN(v) || double.IsInfinity(v) ? "0" : Math.Round(v, 2).ToString(CultureInfo.InvariantCulture); }
  static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }

  static Dictionary<int, long> cpuPrev = new Dictionary<int, long>();
  static DateTime cpuAt = DateTime.MinValue;
  static long priorProcessStart;
  public static string Threads(int pid) {
    var ids = new List<int>();
    long started = 0;
    try {
      using (var process = Process.GetProcessById(pid)) {
        try { started = process.StartTime.ToUniversalTime().ToFileTimeUtc(); } catch (System.ComponentModel.Win32Exception) {}
        foreach (ProcessThread t in process.Threads) ids.Add(t.Id);
      }
    } catch { return "{\"error\":\"process_gone\"}"; }
    if (started != priorProcessStart) { cpuPrev.Clear(); cpuAt = DateTime.MinValue; }
    priorProcessStart = started;
    var now = new Dictionary<int, long>(); var b = new StringBuilder(); long earliest = long.MaxValue; int mainId = 0;
    double dt = (DateTime.UtcNow - cpuAt).TotalMilliseconds * 10000; // 100-ns ticks
    var rows = new List<string>();
    foreach (int id in ids) {
      IntPtr h = OpenThread(THREAD_QUERY_INFORMATION, false, id); if (h == IntPtr.Zero) continue;
      try {
        long create, exit, kernel, user; if (!GetThreadTimes(h, out create, out exit, out kernel, out user)) continue;
        now[id] = kernel + user;
        if (create < earliest) { earliest = create; mainId = id; }
        long prev; double c = cpuPrev.TryGetValue(id, out prev) && dt > 0 ? Math.Min(100, (kernel + user - prev) * 100.0 / dt) : -1;
        IntPtr d; string name = "";
        if (GetThreadDescription(h, out d) >= 0) { name = Marshal.PtrToStringUni(d) ?? ""; LocalFree(d); }
        rows.Add(id + "\u0001" + name + "\u0001" + c.ToString(CultureInfo.InvariantCulture));
      } finally { CloseHandle(h); }
    }
    bool primed = cpuAt != DateTime.MinValue; cpuPrev = now; cpuAt = DateTime.UtcNow;
    b.Append("{\"t\":").Append(Now()).Append(",\"pid\":").Append(pid).Append(",\"started\":").Append(started > 0 ? Q(started.ToString(CultureInfo.InvariantCulture)) : "null")
     .Append(",\"total\":").Append(ids.Count).Append(",\"primed\":").Append(primed ? "true" : "false").Append(",\"threads\":[");
    bool first = true;
    foreach (var r in rows) {
      var f = r.Split('\u0001'); int id = int.Parse(f[0]); double c = double.Parse(f[2], CultureInfo.InvariantCulture);
      if (c < 0.2 && id != mainId && f[1].Length == 0) continue; // idle unnamed threads carry nothing
      if (!first) b.Append(','); first = false;
      b.Append("{\"id\":").Append(id).Append(",\"n\":").Append(Q(f[1])).Append(",\"c\":").Append(N(Math.Max(0, c)));
      if (id == mainId) b.Append(",\"main\":true");
      b.Append('}');
    }
    return b.Append("]}").ToString();
  }

  public static string Files(int pid, int top) {
    IntPtr h = OpenProcess(0x400 | 0x10, false, pid); // QUERY_INFORMATION | VM_READ
    if (h == IntPtr.Zero) return "{\"error\":\"open_failed\",\"code\":" + Marshal.GetLastWin32Error() + "}";
    try {
      // Resident pages: one QueryWorkingSet call, then a binary search per region instead of a page-by-page query.
      int ptr = IntPtr.Size, size = 64 * 1024; IntPtr buf = IntPtr.Zero; long count = 0; var pages = new List<long>();
      for (int attempt = 0; attempt < 6; attempt++) {
        buf = Marshal.AllocHGlobal(size);
        if (QueryWorkingSet(h, buf, size)) {
          count = ptr == 8 ? Marshal.ReadInt64(buf) : Marshal.ReadInt32(buf);
          for (long i = 0; i < count; i++) { long e = ptr == 8 ? Marshal.ReadInt64(buf, (int)((i + 1) * 8)) : (uint)Marshal.ReadInt32(buf, (int)((i + 1) * 4)); pages.Add(e & ~0xFFFL); }
          Marshal.FreeHGlobal(buf); buf = IntPtr.Zero; break;
        }
        long need = ptr == 8 ? Marshal.ReadInt64(buf) : Marshal.ReadInt32(buf);
        Marshal.FreeHGlobal(buf); buf = IntPtr.Zero;
        size = (int)Math.Min(int.MaxValue, (need + 4096) * ptr + ptr);
      }
      pages.Sort();
      var devices = new Dictionary<string, string>();
      foreach (var drive in Environment.GetLogicalDrives()) {
        var t = new StringBuilder(512); string letter = drive.TrimEnd('\\');
        if (QueryDosDeviceW(letter, t, 512) > 0) devices[t.ToString()] = letter;
      }
      var mapped = new Dictionary<string, long[]>(); var image = new HashSet<string>(); var names = new Dictionary<long, string>();
      long addr = 0; MBI m; var sb = new StringBuilder(1024);
      while (VirtualQueryEx(h, new IntPtr(addr), out m, new IntPtr(Marshal.SizeOf(typeof(MBI)))) != IntPtr.Zero) {
        long baseAddr = m.BaseAddress.ToInt64(), len = m.RegionSize.ToInt64();
        if (len <= 0) break;
        if (m.State == MEM_COMMIT && (m.Type == MEM_MAPPED || m.Type == MEM_IMAGE)) {
          long alloc = m.AllocationBase.ToInt64(); string name;
          if (!names.TryGetValue(alloc, out name)) {
            sb.Length = 0; name = GetMappedFileNameW(h, m.BaseAddress, sb, 1024) > 0 ? sb.ToString() : "";
            foreach (var d in devices) if (name.StartsWith(d.Key + "\\", StringComparison.OrdinalIgnoreCase)) { name = d.Value + name.Substring(d.Key.Length); break; }
            names[alloc] = name;
          }
          if (name.Length > 0) {
            long[] acc; if (!mapped.TryGetValue(name, out acc)) mapped[name] = acc = new long[2];
            acc[0] += len; acc[1] += Resident(pages, baseAddr, baseAddr + len) * 4096L;
            if (m.Type == MEM_IMAGE) image.Add(name);
          }
        }
        long next = baseAddr + len; if (next <= addr) break; addr = next;
      }
      var list = new List<KeyValuePair<string, long[]>>(mapped);
      list.Sort((a, c) => c.Value[1].CompareTo(a.Value[1]));
      var b = new StringBuilder();
      long started, exit, kernel, user;
      bool timed = GetProcessTimes(h, out started, out exit, out kernel, out user);
      b.Append("{\"t\":").Append(Now()).Append(",\"pid\":").Append(pid).Append(",\"started\":").Append(timed && started > 0 ? Q(started.ToString(CultureInfo.InvariantCulture)) : "null")
       .Append(",\"workingSetPages\":").Append(count).Append(",\"fileCount\":").Append(list.Count).Append(",\"files\":[");
      for (int i = 0; i < list.Count && i < top; i++) {
        if (i > 0) b.Append(',');
        b.Append("{\"path\":").Append(Q(list[i].Key)).Append(",\"image\":").Append(image.Contains(list[i].Key) ? "true" : "false")
         .Append(",\"mapped\":").Append(list[i].Value[0]).Append(",\"resident\":").Append(list[i].Value[1]).Append('}');
      }
      return b.Append("]}").ToString();
    } finally { CloseHandle(h); }
  }
  static long Resident(List<long> pages, long from, long to) {
    int lo = LowerBound(pages, from), hi = LowerBound(pages, to); return hi - lo;
  }
  static int LowerBound(List<long> v, long x) { int lo = 0, hi = v.Count; while (lo < hi) { int mid = (lo + hi) >> 1; if (v[mid] < x) lo = mid + 1; else hi = mid; } return lo; }
}
'@
if ($TargetPid -le 0) { [Console]::Out.WriteLine('{"error":"no_pid"}'); exit 2 }
if ($Mode -eq 'files') { [Console]::Out.WriteLine([HubProbe]::Files($TargetPid, 40)); exit 0 }
[void][HubProbe]::Threads($TargetPid) # prime: CPU rates need a previous reading
for ($i = 0; $i -lt $Count; $i++) {
  Start-Sleep -Milliseconds $IntervalMs
  $line = [HubProbe]::Threads($TargetPid)
  [Console]::Out.WriteLine($line); [Console]::Out.Flush()
  if ($line.StartsWith('{"error"')) { exit 0 }
}
