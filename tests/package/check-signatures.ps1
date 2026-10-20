# Checks the Windows binaries in an unpacked release tarball: each needs a valid, timestamped Authenticode signature,
# and the modules the release signs need its publisher. Usage: check-signatures.ps1 -Package <dir> -Publisher <subject>
param([Parameter(Mandatory)][string]$Package, [Parameter(Mandatory)][string]$Publisher)
$ErrorActionPreference = 'Stop'
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
  Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1
if (-not $signtool) { throw 'signtool.exe was not found in the Windows SDK.' }
$required = @(& node "$PSScriptRoot\check-tarball.mjs" --windows-modules)
$root = (Resolve-Path $Package).Path.TrimEnd('\')
$problems = [System.Collections.Generic.List[string]]::new()
foreach ($rel in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $root $rel))) { $problems.Add("$rel is missing") }
}
$checked = 0
foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File) {
  $head = [byte[]]::new(2)
  $stream = [IO.File]::OpenRead($file.FullName)
  try { $read = $stream.Read($head, 0, 2) } finally { $stream.Dispose() }
  if ($read -ne 2 -or $head[0] -ne 0x4D -or $head[1] -ne 0x5A) { continue }
  $checked++
  $rel = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($signature.Status -ne 'Valid') { $problems.Add("$rel has no valid signature ($($signature.Status))"); continue }
  if (-not $signature.TimeStamperCertificate) { $problems.Add("$rel is signed without a timestamp") }
  $null = & $signtool.FullName verify /pa /tw /q $file.FullName
  if ($LASTEXITCODE -ne 0) { $problems.Add("$rel fails signtool verify /pa /tw (exit $LASTEXITCODE)") }
  if ($required -contains $rel -and $signature.SignerCertificate.Subject -ne $Publisher) {
    $problems.Add("$rel is signed by $($signature.SignerCertificate.Subject), not $Publisher")
  }
}
foreach ($problem in $problems) { Write-Output "not ok  $problem" }
if ($problems.Count -gt 0) { exit 1 }
Write-Output "ok  $checked Windows binaries signed and timestamped; the $($required.Count) release modules by $Publisher"
