param([string]$Node, [string]$Cli, [string]$Scratch, [string]$Fixture)
$ErrorActionPreference = 'Stop'
$denied = Join-Path $Scratch 'ACL denied'
New-Item -ItemType Directory -Path $denied | Out-Null
$original = Get-Acl -LiteralPath $denied
$acl = Get-Acl -LiteralPath $denied
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Write', 'ContainerInherit,ObjectInherit', 'None', 'Deny')
$acl.AddAccessRule($rule)
try {
  Set-Acl -LiteralPath $denied -AclObject $acl
  & $Node $Cli ingest $Fixture --data-root $denied 2>$null | Out-Null
  if ($LASTEXITCODE -ne 1) { throw 'ACL write denial must fail with exit1' }
} finally { Set-Acl -LiteralPath $denied -AclObject $original }
# An actual loopback UNC source read, with a private temporary share and guaranteed removal.
$shareDir = Join-Path $Scratch 'UNC history 한글 공백'
New-Item -ItemType Directory -Path $shareDir | Out-Null
$history = Join-Path $shareDir 'history 한글.jsonl'
Copy-Item -LiteralPath $Fixture -Destination $history
$before = (Get-FileHash -LiteralPath $history -Algorithm SHA256).Hash
$share = 'ViewTraceRC_' + [Guid]::NewGuid().ToString('N')
$principal = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
try {
  New-SmbShare -Name $share -Path $shareDir -FullAccess $principal | Out-Null
  $unc = '\\localhost\' + $share + '\history 한글.jsonl'
  & $Node $Cli ingest $unc --data-root (Join-Path $Scratch 'UNC read local db') --json | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'actual UNC history ingest failed' }
  if ((Get-FileHash -LiteralPath $history -Algorithm SHA256).Hash -ne $before) { throw 'original UNC history changed' }
  $networkRoot = '\\localhost\' + $share + '\unsupported db'
  & $Node $Cli ingest $unc --data-root $networkRoot 2>$null | Out-Null
  if ($LASTEXITCODE -ne 1) { throw 'UNC SQLite data root must be refused honestly' }
} finally { Remove-SmbShare -Name $share -Force -ErrorAction SilentlyContinue }
Write-Output '{"windowsAclDenial":true,"actualUncHistoryRead":true,"uncDatabaseRefused":true,"historyUnchanged":true}'
