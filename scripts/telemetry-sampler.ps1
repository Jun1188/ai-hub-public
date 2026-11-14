param([int]$IntervalMs = 2000, [int]$ParentPid = 0)
# One long-lived, below-normal sampler instead of a PowerShell spawn per snapshot (measured ~0.5 s each).
# English PDH paths work on every UI language; process tree refreshes every 15 s.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch {}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

public static class HubTelemetry {
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhOpenQueryW(string src, IntPtr user, out IntPtr query);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhAddEnglishCounterW(IntPtr query, string path, IntPtr user, out IntPtr counter);
  [DllImport("pdh.dll")] static extern uint PdhCollectQueryData(IntPtr query);
  [DllImport("pdh.dll", CharSet = CharSet.Unicode)] static extern uint PdhGetFormattedCounterArrayW(IntPtr counter, uint format, ref uint size, ref uint count, IntPtr buffer);
  const uint MORE_DATA = 0x800007D2, FMT = 0x200 | 0x8000; // PDH_FMT_DOUBLE | PDH_FMT_NOCAP100
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);

  static IntPtr query;
  static readonly Dictionary<string, IntPtr> counters = new Dictionary<string, IntPtr>();
  static bool processV2;
  public static Dictionary<int, int> Parents = new Dictionary<int, int>();

  static bool Add(string key, string path) {
    IntPtr c;
    if (PdhAddEnglishCounterW(query, path, IntPtr.Zero, out c) != 0) return false;
    counters[key] = c; return true;
  }
  public static string Open() {
    if (PdhOpenQueryW(null, IntPtr.Zero, out query) != 0) return "pdh_open_failed";
    processV2 = Add("pcpu", @"\Process V2(*)\% Processor Time");
    string p = processV2 ? "Process V2" : "Process";
    if (!processV2) { Add("pcpu", @"\Process(*)\% Processor Time"); Add("pid", @"\Process(*)\ID Process"); }
    Add("pmem", @"\" + p + @"(*)\Working Set - Private");
    Add("pior", @"\" + p + @"(*)\IO Read Bytes/sec");
    Add("piow", @"\" + p + @"(*)\IO Write Bytes/sec");
    Add("geng", @"\GPU Engine(*)\Utilization Percentage");
    Add("gded", @"\GPU Process Memory(*)\Dedicated Usage");
    Add("gsh", @"\GPU Process Memory(*)\Shared Usage");
    Add("aded", @"\GPU Adapter Memory(*)\Dedicated Usage");
    Add("ash", @"\GPU Adapter Memory(*)\Shared Usage");
    // % Processor Time, not Utility: Utility is frequency-scaled (measured 10.4 vs 1.6 at idle on a Ryzen) and
    // would not add up with the per-process time-based values.
    Add("cpu", @"\Processor Information(_Total)\% Processor Time");
    Add("avail", @"\Memory\Available Bytes");
    Add("commit", @"\Memory\Committed Bytes");
    Add("limit", @"\Memory\Commit Limit");
    Add("pagein", @"\Memory\Pages Input/sec");
    Add("didle", @"\PhysicalDisk(*)\% Idle Time");
    Add("dr", @"\PhysicalDisk(*)\Disk Read Bytes/sec");
    Add("dw", @"\PhysicalDisk(*)\Disk Write Bytes/sec");
    Add("dlat", @"\PhysicalDisk(*)\Avg. Disk sec/Transfer");
    Add("dq", @"\PhysicalDisk(*)\Current Disk Queue Length");
    Add("nrx", @"\Network Interface(*)\Bytes Received/sec");
    Add("ntx", @"\Network Interface(*)\Bytes Sent/sec");
    PdhCollectQueryData(query);
    return "";
  }

  static Dictionary<string, double> Read(string key) {
    var result = new Dictionary<string, double>();
    IntPtr counter;
    if (!counters.TryGetValue(key, out counter)) return result;
    uint size = 0, count = 0;
    if (PdhGetFormattedCounterArrayW(counter, FMT, ref size, ref count, IntPtr.Zero) != MORE_DATA || size == 0) return result;
    IntPtr buffer = Marshal.AllocHGlobal((int)size);
    try {
      if (PdhGetFormattedCounterArrayW(counter, FMT, ref size, ref count, buffer) != 0) return result;
      int stride = IntPtr.Size + 16; // szName, CStatus (+pad), double
      for (int i = 0; i < count; i++) {
        IntPtr item = new IntPtr(buffer.ToInt64() + i * stride);
        string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(item));
        if (Marshal.ReadInt32(item, IntPtr.Size) != 0 || name == null) continue; // invalid instance (process exited)
        double value = BitConverter.Int64BitsToDouble(Marshal.ReadInt64(item, IntPtr.Size + 8));
        double prior; result[name] = result.TryGetValue(name, out prior) ? prior + value : value;
      }
    } finally { Marshal.FreeHGlobal(buffer); }
    return result;
  }
  static double One(string key) { foreach (var v in Read(key).Values) return v; return -1; }

  class Proc { public int Pid; public string Name; public double Cpu, Mem, IoR, IoW, Ded, Sh; public long Started; public double? Hf, HfIntervalMs; public uint? HardCount, HardBefore; public Dictionary<string, double> Eng = new Dictionary<string, double>(); }

  // Hard faults per process: PDH has only the system total (Pages Input/sec) and process IO counters miss paging reads of
  // memory-mapped files, so the reader ranking named the wrong process. SYSTEM_PROCESS_INFORMATION.HardFaultCount needs no admin.
  struct FaultCounter { public long Started; public uint Count; }
  static Dictionary<int, FaultCounter> hardPrev;
  static readonly System.Diagnostics.Stopwatch hardClock = System.Diagnostics.Stopwatch.StartNew();
  static double hardAt;
  // HardFaultCount is an internal field. Expand this list only after comparing native counters and process lifetimes on that host.
  static bool KnownFaultLayout(Version os, ushort processMachine, ushort nativeMachine, int pointerSize) {
    return os.Major == 10 && os.Minor == 0 && os.Build == 26300
      && processMachine == 0 && nativeMachine == 0x8664 && pointerSize == 8;
  }
  static bool DetectFaultLayout() {
    ushort processMachine, nativeMachine;
    try {
      return IsWow64Process2(new IntPtr(-1), out processMachine, out nativeMachine)
        && KnownFaultLayout(Environment.OSVersion.Version, processMachine, nativeMachine, IntPtr.Size);
    } catch (EntryPointNotFoundException) { return false; }
  }
  static readonly bool knownFaultLayout = DetectFaultLayout();
  static void ReadHardFaults(Dictionary<int, Proc> procs, long pdhAt) {
    if (!knownFaultLayout) return;
    var now = new Dictionary<int, FaultCounter>();
    var previous = hardPrev;
    hardPrev = null; // A failed or incomplete read breaks the baseline for the next interval.
    int len = 1 << 20, ret;
    const int pidOff = 80; // Native x64: ImageName and BasePriority precede UniqueProcessId.
    for (int attempt = 0; attempt < 4; attempt++) {
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        int st = NtQuerySystemInformation(5, buf, len, out ret);
        if (st == unchecked((int)0xC0000004)) { len = Math.Max(len * 2, ret + 65536); continue; } // STATUS_INFO_LENGTH_MISMATCH
        if (st != 0 || ret <= 0 || ret > len) return;
        for (long off = 0; ; ) {
          if (off + pidOff + IntPtr.Size > ret) return;
          IntPtr e = new IntPtr(buf.ToInt64() + off);
          int pid = (int)Marshal.ReadIntPtr(e, pidOff).ToInt64();
          long started = Marshal.ReadInt64(e, 32); // SYSTEM_PROCESS_INFORMATION.CreateTime (FILETIME).
          if (pid > 0 && started > 0 && started <= pdhAt)
            now[pid] = new FaultCounter { Started = started, Count = (uint)Marshal.ReadInt32(e, 16) };
          int next = Marshal.ReadInt32(e, 0);
          if (next == 0) break;
          if (next < pidOff + IntPtr.Size) return;
          off += next;
        }
        double sampledAt = hardClock.Elapsed.TotalSeconds;
        double dt = sampledAt - hardAt;
        foreach (var kv in now) {
          Proc proc; FaultCounter prior;
          if (!procs.TryGetValue(kv.Key, out proc)) continue;
          proc.Started = kv.Value.Started;
          proc.HardCount = kv.Value.Count;
          if (previous != null && dt > 0 && dt < 60 && previous.TryGetValue(kv.Key, out prior)
            && prior.Started == kv.Value.Started && prior.Count <= kv.Value.Count) {
            proc.Hf = (kv.Value.Count - prior.Count) / dt;
            proc.HardBefore = prior.Count;
            proc.HfIntervalMs = dt * 1000.0;
          }
        }
        hardPrev = now; hardAt = sampledAt;
        return;
      } finally { Marshal.FreeHGlobal(buf); }
    }
  }

  static int Field(string instance, string tag) {
    int i = instance.IndexOf(tag + "_", StringComparison.Ordinal); if (i < 0) return -1;
    int start = i + tag.Length + 1, end = instance.IndexOf('_', start); if (end < 0) end = instance.Length;
    int value; return int.TryParse(instance.Substring(start, end - start), out value) ? value : -1;
  }
  static string Luid(string instance) {
    int i = instance.IndexOf("luid_", StringComparison.Ordinal), j = instance.IndexOf("_phys", StringComparison.Ordinal);
    return i >= 0 && j > i ? instance.Substring(i + 5, j - i - 5) : "";
  }
  static string N(double v) { return double.IsNaN(v) || double.IsInfinity(v) ? "0" : Math.Round(v, 2).ToString(CultureInfo.InvariantCulture); }
  static string Q(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") { if (c == '"' || c == '\\') b.Append('\\').Append(c); else if (c < 32) b.Append(' '); else b.Append(c); }
    return b.Append('"').ToString();
  }

  public static string Sample(int cores) {
    long pdhAt = DateTime.UtcNow.ToFileTimeUtc(); // Exclude PID replacements born after this PDH observation.
    if (PdhCollectQueryData(query) != 0) return "{\"error\":\"pdh_collect_failed\"}";
    var procs = new Dictionary<int, Proc>();
    Func<int, string, Proc> get = (pid, name) => { Proc p; if (!procs.TryGetValue(pid, out p)) { p = new Proc { Pid = pid, Name = name }; procs[pid] = p; } else if (p.Name == null) p.Name = name; return p; };
    Dictionary<string, double> pids = processV2 ? null : Read("pid");
    Func<string, int> pidOf = inst => {
      if (processV2) { int c = inst.LastIndexOf(':'); int v; return c > 0 && int.TryParse(inst.Substring(c + 1), out v) ? v : -1; }
      double d; return pids.TryGetValue(inst, out d) ? (int)d : -1;
    };
    Func<string, string> nameOf = inst => { int c = processV2 ? inst.LastIndexOf(':') : inst.IndexOf('#'); return c > 0 ? inst.Substring(0, c) : inst; };
    foreach (var key in new[] { "pcpu", "pmem", "pior", "piow" })
      foreach (var kv in Read(key)) {
        int pid = pidOf(kv.Key); if (pid <= 0) continue;
        var p = get(pid, nameOf(kv.Key));
        if (key == "pcpu") p.Cpu = kv.Value / cores; else if (key == "pmem") p.Mem = kv.Value; else if (key == "pior") p.IoR = kv.Value; else p.IoW = kv.Value;
      }
    // Engine instances: pid_X_luid_A_B_phys_0_eng_N_engtype_T. Per process: busiest engine of each type (Task Manager's rule).
    var engineTotals = new Dictionary<string, double>();
    foreach (var kv in Read("geng")) {
      int pid = Field(kv.Key, "pid"); int t = kv.Key.IndexOf("engtype_", StringComparison.Ordinal);
      if (pid < 0 || t < 0) continue;
      string type = kv.Key.Substring(t + 8), luid = Luid(kv.Key), engine = luid + "|" + Field(kv.Key, "eng") + "|" + type;
      double sum; engineTotals[engine] = (engineTotals.TryGetValue(engine, out sum) ? sum : 0) + kv.Value;
      if (pid == 0 || kv.Value <= 0) continue;
      var p = get(pid, null); double prior;
      if (!p.Eng.TryGetValue(type, out prior) || kv.Value > prior) p.Eng[type] = kv.Value;
    }
    foreach (var kv in Read("gded")) { int pid = Field(kv.Key, "pid"); if (pid > 0) get(pid, null).Ded += kv.Value; }
    foreach (var kv in Read("gsh")) { int pid = Field(kv.Key, "pid"); if (pid > 0) get(pid, null).Sh += kv.Value; }
    ReadHardFaults(procs, pdhAt);

    var b = new StringBuilder();
    b.Append("{\"t\":").Append((long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds);
    b.Append(",\"cpu\":").Append(N(One("cpu")));
    b.Append(",\"mem\":{\"avail\":").Append(N(One("avail"))).Append(",\"commit\":").Append(N(One("commit")))
     .Append(",\"limit\":").Append(N(One("limit"))).Append(",\"pagesIn\":").Append(N(One("pagein"))).Append('}');
    b.Append(",\"disks\":[");
    var idle = Read("didle"); var dr = Read("dr"); var dw = Read("dw"); var lat = Read("dlat"); var dq = Read("dq"); bool first = true;
    foreach (var kv in idle) {
      if (kv.Key == "_Total") continue; double r, w, l, q; dr.TryGetValue(kv.Key, out r); dw.TryGetValue(kv.Key, out w); lat.TryGetValue(kv.Key, out l); dq.TryGetValue(kv.Key, out q);
      if (!first) b.Append(','); first = false;
      b.Append("{\"n\":").Append(Q(kv.Key)).Append(",\"busy\":").Append(N(Math.Max(0, 100 - kv.Value))).Append(",\"r\":").Append(N(r)).Append(",\"w\":").Append(N(w))
       .Append(",\"latMs\":").Append(N(l * 1000)).Append(",\"q\":").Append(N(q)).Append('}');
    }
    double rx = 0, tx = 0; foreach (var v in Read("nrx").Values) rx += v; foreach (var v in Read("ntx").Values) tx += v;
    b.Append("],\"net\":{\"rx\":").Append(N(rx)).Append(",\"tx\":").Append(N(tx)).Append('}');
    b.Append(",\"adapters\":[");
    var aded = Read("aded"); var ash = Read("ash"); first = true;
    foreach (var kv in aded) {
      string luid = Luid(kv.Key); double sh; ash.TryGetValue(kv.Key, out sh);
      var types = new Dictionary<string, double>();
      foreach (var e in engineTotals) { var parts = e.Key.Split('|'); if (parts[0] != luid) continue; double cur; if (!types.TryGetValue(parts[2], out cur) || e.Value > cur) types[parts[2]] = e.Value; }
      if (!first) b.Append(','); first = false;
      b.Append("{\"luid\":").Append(Q(luid)).Append(",\"ded\":").Append(N(kv.Value)).Append(",\"sh\":").Append(N(sh)).Append(",\"eng\":{");
      bool f2 = true; foreach (var t in types) { if (t.Value <= 0) continue; if (!f2) b.Append(','); f2 = false; b.Append(Q(t.Key)).Append(':').Append(N(Math.Min(100, t.Value))); }
      b.Append("}}");
    }
    b.Append("],\"procs\":[");
    first = true;
    foreach (var p in procs.Values) {
      double busiest = 0; foreach (var v in p.Eng.Values) busiest = Math.Max(busiest, v);
      bool keep = p.Cpu >= 0.5 || busiest >= 0.5 || p.Ded >= 32 * 1048576.0 || p.Sh >= 64 * 1048576.0 || p.IoR + p.IoW >= 262144 || p.Mem >= 300 * 1048576.0 || p.Hf >= 20;
      if (!keep) continue;
      int parent; Parents.TryGetValue(p.Pid, out parent);
      if (!first) b.Append(','); first = false;
      b.Append("{\"p\":").Append(p.Pid).Append(",\"pp\":").Append(parent).Append(",\"n\":").Append(Q(p.Name)).Append(",\"c\":").Append(N(p.Cpu))
       .Append(",\"m\":").Append(N(p.Mem)).Append(",\"r\":").Append(N(p.IoR)).Append(",\"w\":").Append(N(p.IoW)).Append(",\"hf\":").Append(p.Hf.HasValue ? N(p.Hf.Value) : "null")
       .Append(",\"started\":").Append(p.Started > 0 ? Q(p.Started.ToString(CultureInfo.InvariantCulture)) : "null")
       .Append(",\"hfCount\":").Append(p.HardCount.HasValue ? p.HardCount.Value.ToString(CultureInfo.InvariantCulture) : "null")
       .Append(",\"hfBefore\":").Append(p.HardBefore.HasValue ? p.HardBefore.Value.ToString(CultureInfo.InvariantCulture) : "null")
       .Append(",\"hfIntervalMs\":").Append(p.HfIntervalMs.HasValue ? N(p.HfIntervalMs.Value) : "null")
       .Append(",\"vd\":").Append(N(p.Ded)).Append(",\"vs\":").Append(N(p.Sh)).Append(",\"g\":{");
      bool f3 = true; foreach (var e in p.Eng) { if (e.Value < 0.1) continue; if (!f3) b.Append(','); f3 = false; b.Append(Q(e.Key)).Append(':').Append(N(e.Value)); }
      b.Append("}}");
    }
    return b.Append("]}").ToString();
  }
}
'@
$opened = [HubTelemetry]::Open()
if ($opened) { [Console]::Out.WriteLine('{"error":"' + $opened + '"}'); exit 2 }
$cores = [Environment]::ProcessorCount
$treeAt = [DateTime]::MinValue
while ($true) {
  # Sleep first: rate counters need a full interval since the previous collect.
  Start-Sleep -Milliseconds $IntervalMs
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
  if (([DateTime]::UtcNow - $treeAt).TotalSeconds -ge 15) {
    $map = New-Object 'System.Collections.Generic.Dictionary[int,int]'
    foreach ($row in (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction SilentlyContinue)) { $map[[int]$row.ProcessId] = [int]$row.ParentProcessId }
    [HubTelemetry]::Parents = $map
    $treeAt = [DateTime]::UtcNow
    # Editors only: devtools.js keeps the project/log path and worker name from these and drops the rest.
    $dev = @(Get-CimInstance Win32_Process -Filter "Name='Unity.exe' OR Name LIKE 'UnrealEditor%'" -Property ProcessId, Name, ExecutablePath, CommandLine -ErrorAction SilentlyContinue |
      ForEach-Object { @{ p = [int]$_.ProcessId; n = [string]$_.Name; exe = [string]$_.ExecutablePath; cmd = [string]$_.CommandLine } })
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ editors = $dev } -Compress -Depth 3))
  }
  [Console]::Out.WriteLine([HubTelemetry]::Sample($cores))
  [Console]::Out.Flush()
}
