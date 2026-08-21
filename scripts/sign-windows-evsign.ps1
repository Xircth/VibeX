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

$cliPath = Join-Path $env:RUNNER_TEMP 'evsign-client.exe'
Invoke-WebRequest `
    -Uri 'https://mc.evsign.cn/evsign-client-cli-windows-latest' `
    -OutFile $cliPath `
    -UseBasicParsing
Unblock-File $cliPath

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
