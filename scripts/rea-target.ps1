param([ValidateSet('list','process','file')][string]$Mode, [int]$TargetPid, [string]$LiteralFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($Mode -eq 'file') {
    $root = [IO.Path]::GetPathRoot($LiteralFile)
    if ($root -notmatch '^[a-zA-Z]:\\$' -or ([IO.DriveInfo]::new($root)).DriveType.ToString() -notin @('Fixed','Removable','Ram')) { throw 'local_drive_required' }
    $current = $root
    foreach ($part in $LiteralFile.Substring(3).Split('\')) {
        $current = [IO.Path]::Combine($current, $part)
        if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'use_local_file_outside_reparse_point' }
    }
    $version = if ([IO.Path]::GetExtension($current) -in @('.exe','.dll')) { [Diagnostics.FileVersionInfo]::GetVersionInfo($current).FileVersion }
    @{version=$version} | ConvertTo-Json -Compress
    exit
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class ReaWindow {
    public int Pid;
    public string Handle;
    public string Title;
    delegate bool Visitor(IntPtr h, IntPtr state);
    [DllImport("user32")] static extern bool EnumWindows(Visitor visitor, IntPtr state);
    [DllImport("user32")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int length);
    public static List<ReaWindow> List(int filter) {
        var result = new List<ReaWindow>();
        EnumWindows(delegate(IntPtr h, IntPtr s) {
            int pid;
            GetWindowThreadProcessId(h, out pid);
            if (!IsWindowVisible(h) || (filter != 0 && filter != pid)) return true;
            var text = new StringBuilder(256);
            if (GetWindowText(h, text, text.Capacity) > 0)
                result.Add(new ReaWindow { Pid=pid, Handle=h.ToInt64().ToString(), Title=text.ToString() });
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@
$windows = [ReaWindow]::List($TargetPid)
$processes = if ($Mode -eq 'process') { Get-Process -Id $TargetPid } else { Get-Process }
$rows = foreach ($proc in $processes) {
    try {
        $start = $proc.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
        $file = $proc.Path
        if (!$file) { continue }
        $owned = @($windows | Where-Object Pid -eq $proc.Id | Select-Object Handle,Title)
        [pscustomobject]@{ pid=$proc.Id; started=$start; name=$proc.ProcessName; path=$file; windows=$owned }
    } catch { continue }
}
ConvertTo-Json -Compress -Depth 4 -InputObject @($rows)
