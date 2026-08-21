param(
    [Parameter(Mandatory = $true)]
    [string] $BundleRoot
)

$ErrorActionPreference = 'Stop'

if (-not $env:EVSIGN_LICENSE_KEY) {
    throw 'EVSIGN_LICENSE_KEY is required to Authenticode-sign Windows installers.'
}

if (-not (Test-Path $BundleRoot)) {
    throw "Windows bundle directory does not exist: $BundleRoot"
}

# GitHub-hosted runners get HTTP 444 from mc.evsign.cn. Use the official CLI
# mirrored as a repo release asset and verify the pin before signing.
$cliUrl = 'https://github.com/Xircth/VibeX/releases/download/evsign-cli-1.0.1/evsign-client-cli-win_v1.0.1.exe'
$cliSha256 = 'b1b2168a1d0ea757f26db18ac2e2b14e06fb74021f0d67add5e6be1a47dffd97'
$cliPath = Join-Path $env:RUNNER_TEMP 'evsign-client.exe'
Invoke-WebRequest `
    -Uri $cliUrl `
    -OutFile $cliPath `
    -UseBasicParsing
Unblock-File $cliPath

$actualSha256 = (Get-FileHash -Algorithm SHA256 -Path $cliPath).Hash.ToLowerInvariant()
if ($actualSha256 -ne $cliSha256) {
    throw "EVSign CLI checksum mismatch: expected $cliSha256, got $actualSha256"
}

$artifacts = Get-ChildItem $BundleRoot -Recurse -File |
    Where-Object { $_.Extension -in '.exe', '.msi' }
if ($artifacts.Count -eq 0) {
    throw "No Windows installers were produced under $BundleRoot"
}

foreach ($artifact in $artifacts) {
    $signArgs = @(
        $artifact.FullName,
        '-key', $env:EVSIGN_LICENSE_KEY,
        '-sha256',
        '-t', 'digicert',
        '-cdn'
    )
    if ($env:EVSIGN_SIGN_PASSWORD) {
        $signArgs += @('-pwd', $env:EVSIGN_SIGN_PASSWORD)
    }

    & $cliPath @signArgs
    if ($LASTEXITCODE -ne 0) {
        throw "EVSign failed for $($artifact.Name) with exit code $LASTEXITCODE"
    }

    if (Test-Path "$($artifact.FullName).sig") {
        if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
            throw 'TAURI_SIGNING_PRIVATE_KEY is required to refresh updater signatures after Authenticode signing.'
        }

        & pnpm exec tauri signer sign $artifact.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to refresh the updater signature for $($artifact.Name)"
        }
    }
}

Remove-Item $cliPath -Force -ErrorAction SilentlyContinue
