# Boots the isolated development host for this plugin.
#
# The primary host owns port 3080 on all interfaces. A second host that inherits
# the default port tries to bind the same address, which on Windows can take the
# listener away from the running host — that is exactly how a dev instance killed
# the primary one. This script makes the avoidance explicit and refuses to run
# while anything already listens on the target port.

[CmdletBinding()]
param(
  # Dev instance port. 3080 belongs to the primary host and is always refused.
  [int]$Port = 3081,
  # Separate DSH_HOME: profiles, sessions, storages and credentials stay apart.
  [string]$DevHome = 'C:\resource\dsh-compaction-threshold-dev-home',
  [string]$Profile = 'ct-dev',
  # Source tree of the harness that boots the host.
  [string]$Checkout = 'C:\resource\deepseek-harness'
)

$ErrorActionPreference = 'Stop'

if ($Port -eq 3080) { throw 'port 3080 belongs to the primary host; pick another one (or -Port 0)' }
if ($Port -lt 0 -or $Port -gt 65535) { throw "port $Port is out of range" }

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
  $owners = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
  throw "port $Port is already in use (PID $owners); stop that process or pass -Port <free port>"
}

$previousHome = $env:DSH_HOME
$env:DSH_HOME = (Resolve-Path -LiteralPath $DevHome).ProviderPath
if ($env:DSH_HOME -eq (Join-Path $env:USERPROFILE '.dsh')) {
  $env:DSH_HOME = $previousHome
  throw 'refusing to boot a dev host against the primary DSH_HOME'
}

Write-Host "dev host: profile=$Profile home=$env:DSH_HOME url=http://127.0.0.1:$Port"
Write-Host 'binding loopback only; the primary host keeps 3080'
Push-Location $Checkout
try {
  node --import tsx/esm apps/cli/src/bin.ts --profile $Profile --host 127.0.0.1 --port $Port --no-open
} finally {
  Pop-Location
  $env:DSH_HOME = $previousHome
}
