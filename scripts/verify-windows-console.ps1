param([string]$Node, [string]$Cli, [string]$DataRoot, [string]$Producer, [string]$Ready)
$ErrorActionPreference = 'Stop'
# Allocate an isolated real console. Never broadcast Ctrl+C into the Actions host console.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ViewTraceConsole {
  public delegate bool Handler(uint signal);
  public static Handler KeepAlive = signal => true;
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AllocConsole();
  [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
  [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint signal, uint group);
}
'@
[ViewTraceConsole]::FreeConsole() | Out-Null
if (-not [ViewTraceConsole]::AllocConsole()) { throw 'AllocConsole failed' }
[ViewTraceConsole]::SetConsoleCtrlHandler([ViewTraceConsole]::KeepAlive, $true) | Out-Null
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $Node
$info.Arguments = '"' + $Cli + '" run --data-root "' + $DataRoot + '" --json -- "' + $Node + '" "' + $Producer + '" --hold'
$info.UseShellExecute = $false
$info.CreateNoWindow = $false
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$child = New-Object System.Diagnostics.Process
$child.StartInfo = $info
try {
  if (-not $child.Start()) { throw 'wrapper start failed' }
  $stdout = $child.StandardOutput.ReadToEndAsync()
  $stderr = $child.StandardError.ReadToEndAsync()
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (-not (Test-Path -LiteralPath $Ready)) {
    if ($child.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'producer never became ready' }
    Start-Sleep -Milliseconds 100
  }
  if (-not [ViewTraceConsole]::GenerateConsoleCtrlEvent(0, 0)) { throw 'GenerateConsoleCtrlEvent CTRL_C_EVENT failed' }
  if (-not $child.WaitForExit(40000)) { throw 'console cancellation timeout' }
  Write-Output $stdout.Result
  if ($child.ExitCode -ne 130) { throw ('real Ctrl+C exit must be130, got ' + $child.ExitCode + ' ' + $stderr.Result) }
  Write-Output '{"consoleCtrlC":true,"exitCode":130}'
} finally {
  if (-not $child.HasExited) { $child.Kill() }
  $child.Dispose()
  [ViewTraceConsole]::FreeConsole() | Out-Null
}
