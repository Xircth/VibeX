# Sample the VibeX process tree in Private Working Set.
# WorkingSetPrivate matches Task Manager's Memory column.
# Exit 0 when vibex.exe is running and the total is within -GateMB.
# Exit 1 when the total is over the gate. Exit 2 when vibex.exe is absent.
param(
  [int]$GateMB = 200
)

$ErrorActionPreference = 'Stop'

$procs = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match 'vibex|msedgewebview2|cua-driver|agy_acp' -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'vibex')
})
if (-not ($procs | Where-Object { $_.Name -eq 'vibex.exe' })) {
  Write-Error 'vibex.exe is not running. Start VibeX, idle 60 seconds, then sample again.'
  exit 2
}

$perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process
$rows = @($procs | ForEach-Object {
  $p = $_
  $pf = $perf | Where-Object { $_.IDProcess -eq $p.ProcessId } | Select-Object -First 1
  [PSCustomObject]@{
    PID          = $p.ProcessId
    PPID         = $p.ParentProcessId
    Name         = $p.Name
    PrivateWS_MB = if ($pf) { [math]::Round(($pf.WorkingSetPrivate / 1MB), 1) } else { $null }
    TotalWS_MB   = [math]::Round(($p.WorkingSetSize / 1MB), 1)
    Commit_MB    = [math]::Round(($p.PrivatePageCount / 1MB), 1)
  }
} | Sort-Object PrivateWS_MB -Descending)

$rows | Format-Table -AutoSize
$private = [math]::Round((($rows | Measure-Object -Property PrivateWS_MB -Sum).Sum), 1)
$working = [math]::Round((($rows | Measure-Object -Property TotalWS_MB -Sum).Sum), 1)
$commit = [math]::Round((($rows | Measure-Object -Property Commit_MB -Sum).Sum), 1)
"TOTAL PrivateWS (MB): $private"
"TOTAL WorkingSet (MB): $working"
"TOTAL Commit (MB): $commit"

if ($private -gt $GateMB) {
  Write-Error "Private WS $private MB exceeds the $GateMB MB gate."
  exit 1
}
exit 0
