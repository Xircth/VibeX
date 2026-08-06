param(
  [Parameter(Mandatory = $true)]
  [string]$Executable
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
  throw "Desktop executable is missing: $Executable"
}

function Get-PeSubsystem([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
    throw "Not a valid PE executable: $Path"
  }
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
  $signature = [Text.Encoding]::ASCII.GetString($bytes, $peOffset, 4)
  if ($signature -ne "PE`0`0") {
    throw "Invalid PE signature: $Path"
  }
  return [BitConverter]::ToUInt16($bytes, $peOffset + 24 + 68)
}

if ((Get-PeSubsystem $Executable) -ne 2) {
  throw 'VibeX must use IMAGE_SUBSYSTEM_WINDOWS_GUI and must not allocate a console.'
}

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class VibeXWindowInspector {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int maxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    public static uint[] ConsoleWindowOwners() {
        var owners = new List<uint>();
        EnumWindows((window, _) => {
            var name = new StringBuilder(256);
            GetClassName(window, name, name.Capacity);
            if (name.ToString() == "ConsoleWindowClass") {
                GetWindowThreadProcessId(window, out var processId);
                owners.Add(processId);
            }
            return true;
        }, IntPtr.Zero);
        return owners.ToArray();
    }
}
'@

function Test-DescendsFrom([uint32]$ProcessId, [uint32]$AncestorId) {
  $visited = @{}
  $current = $ProcessId
  while ($current -ne 0 -and -not $visited.ContainsKey($current)) {
    if ($current -eq $AncestorId) {
      return $true
    }
    $visited[$current] = $true
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
      return $false
    }
    $current = [uint32]$process.ParentProcessId
  }
  return $false
}

$process = Start-Process -FilePath $Executable -PassThru
try {
  Start-Sleep -Seconds 8
  if ($process.HasExited) {
    throw "VibeX exited during the Windows startup smoke test with code $($process.ExitCode)."
  }

  $consoleOwners = [VibeXWindowInspector]::ConsoleWindowOwners()
  foreach ($owner in $consoleOwners) {
    if (Test-DescendsFrom $owner ([uint32]$process.Id)) {
      throw "VibeX spawned a visible console window owned by process $owner."
    }
  }
}
finally {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
    $process.WaitForExit()
  }
}
