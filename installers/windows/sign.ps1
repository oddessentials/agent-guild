# Signs Windows programs with Artifact Signing through SignTool and its dlib, Microsoft's documented
# integration, as the artifact-signing-action's module does for .exe and .dll files. Both tools come from
# NuGet packages pinned here by version and SHA-512; nothing else is installed. Signs in through the
# Azure CLI session that azure/login left, every other credential excluded.
#   ./installers/windows/sign.ps1 -Tools <empty dir> -Endpoint <url> -Account <name> -CertificateProfile <name> -Files <path>...
param([string]$Tools, [string]$Endpoint, [string]$Account, [string]$CertificateProfile, [string[]]$Files = @())
$ErrorActionPreference = 'Stop'

$Pins = @(
    @{ Id = 'microsoft.windows.sdk.buildtools'; Version = '10.0.26100.4188'; File = 'bin/10.0.26100.0/x64/signtool.exe'
       Sha512 = '3a489185d0ebd27803ebec26d04cddbb59a057c66e9275dd1f08f37875598d84978bd6c291892af4db3f5ff69bf41a076fe4eaff9fd19976dd356b42d2a1e2a5' },
    @{ Id = 'microsoft.artifactsigning.client'; Version = '1.0.128'; File = 'bin/x64/Azure.CodeSigning.Dlib.dll'
       Sha512 = '98f06a691f4fc2fa22f19dcf8556733e98607fbef91a312c453b9b0798cc9088dae0acb36e389b552a11b4d2320324785b8541c2b51091a724c05bc5df5cbf95' }
)

# A pinned package's file, from the package in $Dir (downloaded when it isn't there), used only if the
# package's SHA-512 is the pinned one.
function Get-PinnedFile([hashtable]$Pin, [string]$Dir) {
    $name = "$($Pin.Id).$($Pin.Version)"
    $package = Join-Path $Dir "$name.nupkg"
    if (-not (Test-Path $package)) {
        Invoke-WebRequest -UseBasicParsing -OutFile $package -Uri "https://api.nuget.org/v3-flatcontainer/$($Pin.Id)/$($Pin.Version)/$name.nupkg"
    }
    $hash = (Get-FileHash -Algorithm SHA512 -Path $package).Hash.ToLowerInvariant()
    if ($hash -ne $Pin.Sha512) {
        Remove-Item -Force $package
        throw "$name.nupkg's SHA-512 is $hash, not the pinned $($Pin.Sha512)."
    }
    $unpacked = Join-Path $Dir $name
    if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked }
    Expand-Archive -Path $package -DestinationPath $unpacked
    $file = Join-Path $unpacked $Pin.File
    if (-not (Test-Path $file)) { throw "$name.nupkg has no $($Pin.File)." }
    return $file
}

# The dlib's settings: the account and profile, and every credential but the Azure CLI's excluded.
function New-SigningMetadata([string]$Endpoint, [string]$Account, [string]$CertificateProfile) {
    [ordered]@{
        Endpoint = $Endpoint
        CodeSigningAccountName = $Account
        CertificateProfileName = $CertificateProfile
        ExcludeCredentials = @('EnvironmentCredential', 'WorkloadIdentityCredential', 'ManagedIdentityCredential',
            'SharedTokenCacheCredential', 'VisualStudioCredential', 'VisualStudioCodeCredential',
            'AzurePowerShellCredential', 'AzureDeveloperCliCredential', 'InteractiveBrowserCredential')
    } | ConvertTo-Json -Compress
}

if ($MyInvocation.InvocationName -eq '.') { return }

foreach ($name in 'Tools', 'Endpoint', 'Account', 'CertificateProfile', 'Files') {
    if (-not (Get-Variable -Name $name -ValueOnly)) { throw "sign-windows.ps1 needs -$name." }
}
if (-not ((dotnet --list-runtimes) -match '^Microsoft\.NETCore\.App ([89]|\d{2,})\.')) {
    throw 'The Artifact Signing dlib needs the .NET 8 runtime or newer, which this runner lacks.'
}
New-Item -ItemType Directory -Force -Path $Tools | Out-Null
$signtool = Get-PinnedFile $Pins[0] $Tools
$dlib = Get-PinnedFile $Pins[1] $Tools
$metadata = Join-Path $Tools 'metadata.json'
New-SigningMetadata $Endpoint $Account $CertificateProfile | Set-Content -Path $metadata -Encoding utf8
& $signtool sign /v /fd SHA256 /tr 'http://timestamp.acs.microsoft.com' /td SHA256 /dlib $dlib /dmdf $metadata @Files
# 0 is signed; 2 is signed with warnings, as the module takes it.
if ($LASTEXITCODE -notin 0, 2) { throw "signtool.exe failed with exit code $LASTEXITCODE." }
