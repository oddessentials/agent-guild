# Waits for a process the install test started and returns its exit code, within a limit. Start-Process -Wait
# instead waits for the process and every descendant through a job object, with no limit, so one surviving grandchild
# holds the step until the job's timeout; the runner cannot always end it then, and the Setup log is lost with it.
# Past the limit this prints the live log and the processes still under the one waited for, stops them, and throws.
# Usage: wait-process.ps1 -Process <System.Diagnostics.Process> -Name <what it is> [-Seconds 180] [-Log <its log file>]
param(
  [Parameter(Mandatory)][System.Diagnostics.Process]$Process,
  [Parameter(Mandatory)][string]$Name,
  [int]$Seconds = 180,
  [string]$Log = ''
)
if ($Process.WaitForExit($Seconds * 1000)) {
  $Process.WaitForExit()
  return $Process.ExitCode
}
$stamp = (Get-Date).ToUniversalTime().ToString('HH:mm:ss.fff')
Write-Host "[$stamp] $Name (pid $($Process.Id)) did not exit within $Seconds s."
if ($Log -and (Test-Path -LiteralPath $Log)) {
  Write-Host "---- last lines of $Log"
  Get-Content -LiteralPath $Log -Tail 60 | ForEach-Object { Write-Host "  $_" }
}
$all = Get-CimInstance Win32_Process
$ids = @([uint32]$Process.Id)
do {
  $more = @($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId })
  if ($more) { $ids += $more.ProcessId }
} while ($more)
Write-Host "---- processes under $Name"
$all | Where-Object { $ids -contains $_.ProcessId } | Sort-Object CreationDate | ForEach-Object {
  $started = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('HH:mm:ss') } else { '?' }
  Write-Host ("  {0} {1}, parent {2}, started {3}: {4}" -f $_.Name, $_.ProcessId, $_.ParentProcessId, $started, ($_.CommandLine -replace '#token=\S+', '#token=...'))
}
foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
throw "$Name did not exit within $Seconds s."
