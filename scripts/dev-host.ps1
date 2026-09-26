# Boots an isolated development host for this plugin.
#
# A host booted with the default settings takes the primary host's port. On
# Windows a second bind of the same address can take the listener away from the
# running host, which kills it. This script therefore refuses the primary port,
# refuses a port that is already listening, refuses the primary DSH_HOME, and
# binds loopback only.

[CmdletBinding()]
param(
  # Dev instance port. The primary host owns its own port; pass a free one.
  [int]$Port = 3081,
  # Primary host port, always refused here.
  [int]$PrimaryPort = 3080,
  # Separate DSH_HOME: profiles, sessions, storages and credentials stay apart.
  [string]$DevHome = (Join-Path $HOME '.dsh-compaction-threshold-dev'),
  [string]$Profile = 'ct-dev',
  # Harness checkout. Give it to boot the host from source through tsx, which is
  # what a `link:`-ed plugin resolves against; omit it to use the installed `dsh`.
  [string]$Checkout
)

$ErrorActionPreference = 'Stop'

if ($Port -eq $PrimaryPort) { throw "port $PrimaryPort belongs to the primary host; pick another one (-Port 0 lets the OS choose)" }
if ($Port -lt 0 -or $Port -gt 65535) { throw "port $Port is out of range" }

$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
  $owners = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
  throw "port $Port is already in use (PID $owners); stop that process or pass -Port <free port>"
}

if (-not (Test-Path -LiteralPath $DevHome)) {
  throw "dev home $DevHome does not exist; create the profile first: dsh --profile $Profile --from-default-profile web --host 127.0.0.1 --port $Port --no-open"
}

$previousHome = $env:DSH_HOME
$env:DSH_HOME = (Resolve-Path -LiteralPath $DevHome).ProviderPath
if ($env:DSH_HOME -eq (Join-Path $HOME '.dsh')) {
  $env:DSH_HOME = $previousHome
  throw 'refusing to boot a dev host against the primary DSH_HOME'
}

Write-Host "dev host: profile=$Profile home=$env:DSH_HOME url=http://127.0.0.1:$Port"
Write-Host 'binding loopback only; the primary host keeps its port'
try {
  if ($Checkout) {
    Push-Location (Resolve-Path -LiteralPath $Checkout).ProviderPath
    try {
      node --import tsx/esm apps/cli/src/bin.ts --profile $Profile --host 127.0.0.1 --port $Port --no-open
    } finally {
      Pop-Location
    }
  } else {
    dsh --profile $Profile --host 127.0.0.1 --port $Port --no-open
  }
} finally {
  $env:DSH_HOME = $previousHome
}
