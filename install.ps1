# Install the VibeX Host family (vibex-server, vibex-mcp, vibex-workflow-mcp
# and the web bundle) from a GitHub Release.
#
# The desktop app is not installed by this script; it ships as a Tauri
# installer with its own updater. Coding agents are not installed either —
# they live in your own environment (ADR-0060).
#
#   irm https://raw.githubusercontent.com/Xircth/VibeX/master/install.ps1 | iex
#
# Environment:
#   VIBEX_VERSION      Install this version instead of the latest release.
#   VIBEX_PLATFORM     Override platform detection (e.g. windows-x86_64).
#   VIBEX_GITHUB_REPO        Source repository. Default Xircth/VibeX.
#   VIBEX_HOST_FAMILY_BASE   Override the download origin (no trailing slash).
#   VIBEX_INSTALL_DIR        Where the `vibex.cmd` launcher goes. Default %LOCALAPPDATA%\VibeX\bin.
#   VIBEX_PRINT_PLAN         Print the resolved platform and URLs, then exit.

$ErrorActionPreference = "Stop"

$Repo = if ($env:VIBEX_GITHUB_REPO) { $env:VIBEX_GITHUB_REPO } else { "Xircth/VibeX" }
$CacheRoot = Join-Path $HOME ".vibex" "host-family"
$InstallDir = if ($env:VIBEX_INSTALL_DIR) { $env:VIBEX_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "VibeX" "bin" }
# Kept in step with npx-cli/bin/release-assets.js by scripts/release-assets.test.js.
$SupportedPlatforms = @(
    "linux-x86_64",
    "linux-aarch64",
    "darwin-aarch64",
    "windows-x86_64",
    "windows-aarch64"
)

function Fail([string]$Message) {
    Write-Error "error: $Message"
    exit 1
}

function Get-Platform {
    if ($env:VIBEX_PLATFORM) {
        return $env:VIBEX_PLATFORM
    }

    $os = if ($IsWindows -or $env:OS -eq "Windows_NT") {
        "windows"
    } elseif ($IsMacOS) {
        "darwin"
    } elseif ($IsLinux) {
        "linux"
    } else {
        Fail "unsupported operating system. Supported: $($SupportedPlatforms -join ', ')"
        return
    }

    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    $cpu = switch ($arch) {
        "X64" { "x86_64" }
        "Arm64" { "aarch64" }
        default {
            Fail "unsupported architecture: $arch. Supported: $($SupportedPlatforms -join ', ')"
            return
        }
    }

    return "$os-$cpu"
}

function Assert-SupportedPlatform([string]$Platform) {
    if ($SupportedPlatforms -notcontains $Platform) {
        Fail "unsupported platform: $Platform. Supported: $($SupportedPlatforms -join ', ')"
    }
}

function Get-LatestTag {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    if (-not $release.tag_name) {
        Fail "could not resolve the latest release of $Repo"
    }
    return $release.tag_name
}

function Get-FileSha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
}

# Both the archive digest and the per-file SHA256SUMS inside it are checked.
# There is deliberately no flag to skip either: a mismatch means the bytes are
# not the published release, and installing them anyway defers the problem to
# runtime.
function Assert-Digest([string]$Path, [string]$Expected) {
    $actual = Get-FileSha256 $Path
    if ($actual -ne $Expected.ToLowerInvariant()) {
        Fail "checksum mismatch for $(Split-Path $Path -Leaf): expected $Expected, got $actual"
    }
}

function Assert-Sha256Sums([string]$Root) {
    $sumsPath = Join-Path $Root "SHA256SUMS"
    if (-not (Test-Path $sumsPath)) {
        Fail "SHA256SUMS is missing under $Root"
    }

    $checked = 0
    foreach ($line in Get-Content $sumsPath) {
        if ($line -notmatch "^([a-fA-F0-9]{64})  (.+)$") {
            continue
        }
        $relative = $Matches[2] -replace "^\./", ""
        if ($relative -eq "SHA256SUMS") {
            continue
        }
        $file = Join-Path $Root ($relative -replace "/", [IO.Path]::DirectorySeparatorChar)
        if (-not (Test-Path $file)) {
            Fail "Host family file missing after extract: $relative"
        }
        Assert-Digest $file $Matches[1]
        $checked += 1
    }
    if ($checked -eq 0) {
        Fail "SHA256SUMS in the archive contained no checksums"
    }
}

function Write-Launcher([string]$FamilyRoot) {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $server = Join-Path $FamilyRoot "vibex-server.exe"
    if (-not (Test-Path $server)) {
        $server = Join-Path $FamilyRoot "vibex-server"
    }
    $cmd = Join-Path $InstallDir "vibex.cmd"
    Set-Content -Path $cmd -Encoding ascii -Value "@echo off`r`n`"$server`" %*"
    return $cmd
}

$platform = Get-Platform
Assert-SupportedPlatform $platform

if ($env:VIBEX_VERSION) {
    $tag = if ($env:VIBEX_VERSION.StartsWith("v")) { $env:VIBEX_VERSION } else { "v$($env:VIBEX_VERSION)" }
} else {
    $tag = Get-LatestTag
}
$version = $tag.TrimStart("v")
$archive = "VibeX-$version-$platform-server.tar.gz"
$baseUrl = if ($env:VIBEX_HOST_FAMILY_BASE) {
    $env:VIBEX_HOST_FAMILY_BASE.TrimEnd("/")
} else {
    "https://github.com/$Repo/releases/download/$tag"
}
$familyRoot = Join-Path $CacheRoot $tag $platform "family"

if ($env:VIBEX_PRINT_PLAN) {
    Write-Output "platform=$platform"
    Write-Output "tag=$tag"
    Write-Output "archive=$archive"
    Write-Output "archive_url=$baseUrl/$archive"
    Write-Output "checksum_url=$baseUrl/$archive.sha256"
    Write-Output "family_root=$familyRoot"
    exit 0
}

$temp = $null
try {
    if (Test-Path (Join-Path $familyRoot "SHA256SUMS")) {
        Write-Host "VibeX Host family $tag is already installed for $platform."
        Assert-Sha256Sums $familyRoot
    } else {
        $temp = Join-Path ([IO.Path]::GetTempPath()) ("vibex-install-" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $temp | Out-Null
        Write-Host "Downloading VibeX Host family $tag for $platform..."
        $archivePath = Join-Path $temp $archive
        $checksumPath = "$archivePath.sha256"
        Invoke-WebRequest -Uri "$baseUrl/$archive" -OutFile $archivePath
        Invoke-WebRequest -Uri "$baseUrl/$archive.sha256" -OutFile $checksumPath

        $expected = ((Get-Content $checksumPath -Raw) -split "\s+")[0]
        if (-not $expected) {
            Fail "the published checksum file for $archive was empty"
        }
        Assert-Digest $archivePath $expected

        $extract = Join-Path $temp "extract"
        New-Item -ItemType Directory -Path $extract | Out-Null
        tar -xzf $archivePath -C $extract
        $unpacked = Join-Path $extract $platform
        if (-not (Test-Path (Join-Path $unpacked "SHA256SUMS"))) {
            $unpacked = $extract
        }
        if (-not (Test-Path (Join-Path $unpacked "SHA256SUMS"))) {
            Fail "the archive did not contain SHA256SUMS"
        }
        Assert-Sha256Sums $unpacked

        if (Test-Path $familyRoot) {
            Remove-Item -Recurse -Force $familyRoot
        }
        New-Item -ItemType Directory -Force -Path (Split-Path $familyRoot) | Out-Null
        Move-Item $unpacked $familyRoot
    }

    $launcher = Write-Launcher $familyRoot
    Write-Host ""
    Write-Host "Installed VibeX Host family $tag to $familyRoot"
    Write-Host "Launcher: $launcher"

    $onPath = ($env:PATH -split ";" | ForEach-Object { $_.TrimEnd("\") }) -contains $InstallDir.TrimEnd("\")
    if ($onPath) {
        Write-Host ""
        Write-Host "Run ``vibex`` to start the server on http://127.0.0.1:17891"
    } else {
        Write-Host ""
        Write-Host "Add $InstallDir to your PATH, then run ``vibex``."
    }
} finally {
    if ($temp -and (Test-Path $temp)) {
        Remove-Item -Recurse -Force $temp
    }
}
