param(
  [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$devProcess = $null
$originalApiPort = $env:API_PORT
$originalUiPort = $env:PORT
$originalLocalUrl = $env:LOCAL_URL
$originalTarget = $env:TARGET

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

$apiPort = Get-FreeTcpPort
do { $uiPort = Get-FreeTcpPort } while ($uiPort -eq $apiPort)
$apiBase = "http://127.0.0.1:$apiPort"
$localUrl = "http://127.0.0.1:$uiPort"
$stdoutPath = Join-Path $tempRoot "agentstoz-windows-e2e-$apiPort.stdout.log"
$stderrPath = Join-Path $tempRoot "agentstoz-windows-e2e-$apiPort.stderr.log"
$env:API_PORT = $apiPort.ToString()
$env:PORT = $uiPort.ToString()

Set-Location $repoRoot

try {
  $devProcess = Start-Process `
    -FilePath 'bun' `
    -ArgumentList @('run', 'dev') `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $apiReady = $false
  $uiReady = $false

  while ((Get-Date) -lt $deadline) {
    if ($devProcess.HasExited) {
      throw "Development server exited before readiness (exit $($devProcess.ExitCode))."
    }

    try {
      $apiReady = (Invoke-WebRequest -UseBasicParsing -Uri "$apiBase/api/health" -TimeoutSec 3).StatusCode -eq 200
    } catch {
      $apiReady = $false
    }
    try {
      $uiReady = (Invoke-WebRequest -UseBasicParsing -Uri $localUrl -TimeoutSec 3).StatusCode -eq 200
    } catch {
      $uiReady = $false
    }

    if ($apiReady -and $uiReady) { break }
    Start-Sleep -Seconds 1
  }

  if (-not ($apiReady -and $uiReady)) {
    throw "Timed out waiting for both API $apiPort and UI $uiPort readiness."
  }

  & (Join-Path $PSScriptRoot 'run-windows-detached-sidecar-e2e.ps1') -ApiBase $apiBase

  $env:LOCAL_URL = $localUrl
  bun run test:windows:e2e
  if ($LASTEXITCODE -ne 0) {
    throw "Windows E2E exited with code $LASTEXITCODE."
  }

  $env:TARGET = $localUrl
  bun run test:smoke
  if ($LASTEXITCODE -ne 0) {
    throw "Windows smoke test exited with code $LASTEXITCODE."
  }
} catch {
  if (Test-Path $stdoutPath) { Get-Content $stdoutPath }
  if (Test-Path $stderrPath) { Get-Content $stderrPath }
  throw
} finally {
  if ($null -ne $devProcess -and -not $devProcess.HasExited) {
    taskkill.exe /PID $devProcess.Id /T /F | Out-Null
  }
  $env:API_PORT = $originalApiPort
  $env:PORT = $originalUiPort
  $env:LOCAL_URL = $originalLocalUrl
  $env:TARGET = $originalTarget
}
