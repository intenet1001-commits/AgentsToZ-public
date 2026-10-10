param(
  [int]$TimeoutSeconds = 120,
  [switch]$HostedRunnerSmoke
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$targetRoot = if ($env:CARGO_TARGET_DIR) {
  $env:CARGO_TARGET_DIR
} else {
  Join-Path $repoRoot 'cargo-targets\portmanager'
}
$installerRoot = Join-Path $targetRoot 'release\bundle\nsis'
$installer = Get-ChildItem -Path $installerRoot -Filter '*.exe' -File |
  Sort-Object LastWriteTimeUtc -Descending |
  Select-Object -First 1
if ($null -eq $installer) {
  throw "NSIS installer was not found under $installerRoot."
}

$installRoot = Join-Path $tempRoot 'agentstoz-packaged-install'
$workspace = Join-Path $tempRoot 'AgentsToZ Packaged & Lifecycle'
$isolatedAppData = Join-Path $tempRoot 'agentstoz-packaged-appdata'
$originalAppData = $env:APPDATA
$originalPackagedExe = $env:AGENTSTOZ_PACKAGED_EXE
$originalPackagedWorkspace = $env:AGENTSTOZ_PACKAGED_WORKSPACE
$originalPackagedCommand = $env:AGENTSTOZ_PACKAGED_COMMAND
$originalPackagedListener = $env:AGENTSTOZ_PACKAGED_LISTENER
$originalPackagedPort = $env:AGENTSTOZ_PACKAGED_PORT
$originalPackagedTimeout = $env:AGENTSTOZ_PACKAGED_TIMEOUT_MS
$originalDetachedCommand = $env:AGENTSTOZ_PACKAGED_DETACHED_COMMAND
$originalDetachedPidFile = $env:AGENTSTOZ_DETACHED_PID_FILE
$originalApiPort = $env:API_PORT
$originalAppDataDir = $env:APP_DATA_DIR
$originalParentPid = $env:PORTMGR_PARENT_PID
$appExe = $null
$uninstaller = $null
$listenerScript = $null
$detachedPidFile = $null
$packagedSidecar = $null

function Test-TcpListener {
  param([Parameter(Mandatory = $true)][int]$Port)
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync('127.0.0.1', $Port)
    if (-not $task.Wait(1000)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-Until {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Condition,
    [Parameter(Mandatory = $true)][string]$Failure,
    [int]$Seconds = 30
  )
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 250
  }
  throw $Failure
}

try {
  Remove-Item -Recurse -Force $installRoot, $workspace, $isolatedAppData -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $installRoot, $workspace, $isolatedAppData | Out-Null

  $install = Start-Process `
    -FilePath $installer.FullName `
    -ArgumentList @('/S', "/D=$installRoot") `
    -Wait `
    -PassThru
  if ($install.ExitCode -ne 0) {
    throw "NSIS silent install failed with exit code $($install.ExitCode)."
  }

  $appExe = Join-Path $installRoot 'app.exe'
  if (-not (Test-Path $appExe -PathType Leaf)) {
    $appExe = (Get-ChildItem -Path $installRoot -Filter '*.exe' -File -Recurse |
      Where-Object { $_.Name -ne 'uninstall.exe' } |
      Select-Object -First 1).FullName
  }
  if (-not $appExe -or -not (Test-Path $appExe -PathType Leaf)) {
    throw "Installed AgentsToZ_byCS application executable was not found under $installRoot."
  }
  $uninstaller = Join-Path $installRoot 'uninstall.exe'

  $tauriConfig = Get-Content (Join-Path $repoRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
  $installedVersion = (Get-Item $appExe).VersionInfo.ProductVersion
  if ($installedVersion -ne $tauriConfig.version) {
    throw "Installed app version $installedVersion does not match committed version $($tauriConfig.version)."
  }

  if ($HostedRunnerSmoke) {
    $packagedSidecar = Get-ChildItem -Path $installRoot -Filter 'agentstoz-api-sidecar.exe' -File -Recurse |
      Select-Object -First 1
    if ($null -eq $packagedSidecar) {
      throw "Installed API sidecar was not found under $installRoot."
    }
    $packagedSupervisor = Get-ChildItem -Path $installRoot -Filter 'windows-process-supervisor.ps1' -File -Recurse |
      Select-Object -First 1
    if ($null -eq $packagedSupervisor) {
      throw "Installed Windows process supervisor was not found under $installRoot."
    }

    $sidecarPort = 0
    $sidecarReservation = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
      $sidecarReservation.Start()
      $sidecarPort = ([System.Net.IPEndPoint]$sidecarReservation.LocalEndpoint).Port
    } finally {
      $sidecarReservation.Stop()
    }

    $env:API_PORT = $sidecarPort.ToString()
    $env:APP_DATA_DIR = $isolatedAppData
    $env:PORTMGR_PARENT_PID = $PID.ToString()
    Start-Process -FilePath $packagedSidecar.FullName -WindowStyle Hidden | Out-Null

    $health = $null
    Wait-Until -Seconds 30 -Failure "Installed API sidecar did not become ready on $sidecarPort." -Condition {
      try {
        $script:health = Invoke-RestMethod -Uri "http://127.0.0.1:$sidecarPort/api/health" -TimeoutSec 2
        return $true
      } catch {
        return $false
      }
    }
    $contract = Get-Content (Join-Path $repoRoot 'context-api-contract.json') -Raw | ConvertFrom-Json
    if ($health.service -ne 'agentstoz-api' -or [int]$health.schemaVersion -ne [int]$contract.schemaVersion) {
      throw "Installed API sidecar health contract did not match the repository contract."
    }
    foreach ($capability in $contract.requiredCapabilities) {
      if ($health.capabilities -notcontains $capability) {
        throw "Installed API sidecar is missing required capability: $capability"
      }
    }

    Write-Host "Hosted Windows package smoke passed: silent install, v$installedVersion, bundled sidecar health, supervisor, uninstall."
    return
  }

  $listenerPort = 0
  $reservation = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $reservation.Start()
    $listenerPort = ([System.Net.IPEndPoint]$reservation.LocalEndpoint).Port
  } finally {
    $reservation.Stop()
  }

  $listenerScript = Join-Path $workspace 'packaged-listener.ts'
  $batchPath = Join-Path $workspace 'run%prod% & packaged.ps1'
  $detachedBatchPath = Join-Path $workspace 'detach%prod% & packaged.cmd'
  $detachedPidFile = Join-Path $workspace 'detached-child.pid'
  @"
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1) throw new Error('PORT is required');
Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: () => new Response('packaged-e2e'),
});
setInterval(() => {}, 60_000);
"@ | Set-Content -Path $listenerScript -Encoding utf8
  @"
& bun (Join-Path `$PSScriptRoot 'packaged-listener.ts')
exit `$LASTEXITCODE
"@ | Set-Content -Path $batchPath -Encoding utf8
  @"
@echo off
powershell.exe -NoLogo -NoProfile -NonInteractive -Command "`$p = Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 300' -PassThru; Set-Content -LiteralPath `$env:AGENTSTOZ_DETACHED_PID_FILE -Value `$p.Id"
"@ | Set-Content -Path $detachedBatchPath -Encoding ascii

  $env:APPDATA = $isolatedAppData
  $env:AGENTSTOZ_PACKAGED_EXE = $appExe
  $env:AGENTSTOZ_PACKAGED_WORKSPACE = $workspace
  $env:AGENTSTOZ_PACKAGED_COMMAND = $batchPath
  $env:AGENTSTOZ_PACKAGED_LISTENER = $listenerScript
  $env:AGENTSTOZ_PACKAGED_PORT = $listenerPort.ToString()
  $env:AGENTSTOZ_PACKAGED_TIMEOUT_MS = ($TimeoutSeconds * 1000).ToString()
  $env:AGENTSTOZ_PACKAGED_DETACHED_COMMAND = $detachedBatchPath
  $env:AGENTSTOZ_DETACHED_PID_FILE = $detachedPidFile

  Push-Location $repoRoot
  try {
    bunx wdio run wdio.windows-packaged.conf.mjs
    if ($LASTEXITCODE -ne 0) {
      throw "Installed Tauri native WebDriver E2E failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }

  Wait-Until -Seconds 30 -Failure "Native stop_command left a listener on $listenerPort." -Condition {
    -not (Test-TcpListener -Port $listenerPort)
  }
  $remaining = @(Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($listenerScript)
  })
  if ($remaining.Count -ne 0) {
    throw "Listener descendants remained after native Tauri stop: $($remaining.ProcessId -join ', ')"
  }

  Write-Host "Installed Windows native E2E passed: installer, Tauri IPC, sidecar health, execute, restart, stop."
} catch {
  throw
} finally {
  $cleanupProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.CommandLine -and $listenerScript -and $_.CommandLine.Contains($listenerScript)) -or
    ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase))
  })
  foreach ($process in $cleanupProcesses) {
    taskkill.exe /PID $process.ProcessId /T /F | Out-Null
  }
  $env:APPDATA = $originalAppData
  $env:AGENTSTOZ_PACKAGED_EXE = $originalPackagedExe
  $env:AGENTSTOZ_PACKAGED_WORKSPACE = $originalPackagedWorkspace
  $env:AGENTSTOZ_PACKAGED_COMMAND = $originalPackagedCommand
  $env:AGENTSTOZ_PACKAGED_LISTENER = $originalPackagedListener
  $env:AGENTSTOZ_PACKAGED_PORT = $originalPackagedPort
  $env:AGENTSTOZ_PACKAGED_TIMEOUT_MS = $originalPackagedTimeout
  $env:AGENTSTOZ_PACKAGED_DETACHED_COMMAND = $originalDetachedCommand
  $env:AGENTSTOZ_DETACHED_PID_FILE = $originalDetachedPidFile
  $env:API_PORT = $originalApiPort
  $env:APP_DATA_DIR = $originalAppDataDir
  $env:PORTMGR_PARENT_PID = $originalParentPid
  if ($uninstaller -and (Test-Path $uninstaller -PathType Leaf)) {
    Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$installRoot") -Wait | Out-Null
  }
  Remove-Item -Recurse -Force $installRoot, $workspace, $isolatedAppData -ErrorAction SilentlyContinue
}
