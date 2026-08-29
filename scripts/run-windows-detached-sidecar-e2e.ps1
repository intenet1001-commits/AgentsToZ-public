param(
  [string]$ApiBase = 'http://127.0.0.1:3001',
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("agentstoz-detached-sidecar-" + [guid]::NewGuid().ToString('N'))
$batchPath = Join-Path $tempRoot 'detach%prod% & sidecar.cmd'
$pidFile = Join-Path $tempRoot 'detached-child.pid'
$portId = 'windows-sidecar-detached-tree-' + [Guid]::NewGuid().ToString('N')
$ps1Path = Join-Path $tempRoot 'launch%prod% & sidecar.ps1'
$ps1PidFile = Join-Path $tempRoot 'ps1-child.pid'
$ps1PortId = 'windows-sidecar-powershell-' + [Guid]::NewGuid().ToString('N')
$originalPorts = $null
$combinedPorts = $null
$testPortsSaved = $false
$detachedPid = $null
$ps1Pid = $null

function Wait-Until {
  param([scriptblock]$Condition, [string]$Failure)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 100
  }
  throw $Failure
}

function Add-BaselinePortRows {
  param(
    [object]$Value,
    [System.Collections.Generic.List[object]]$Target,
    [System.Collections.Generic.HashSet[string]]$SeenIds
  )
  if ($null -eq $Value) { return }
  if ($Value -is [System.Array]) {
    foreach ($entry in $Value) { Add-BaselinePortRows -Value $entry -Target $Target -SeenIds $SeenIds }
    return
  }
  if ($null -eq $Value.PSObject.Properties['id']) { return }
  $id = [string]$Value.id
  if ($id -like 'windows-sidecar-detached-tree-*' -or $id -like 'windows-sidecar-powershell-*') { return }
  if ($SeenIds.Add($id)) { $Target.Add($Value) }
}

try {
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
  @"
@echo off
powershell.exe -NoLogo -NoProfile -NonInteractive -Command "`$p = Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 300' -PassThru; Set-Content -LiteralPath '%~dp0detached-child.pid' -Value `$p.Id"
"@ | Set-Content -Path $batchPath -Encoding ascii
  @"
Set-Content -LiteralPath (Join-Path `$PSScriptRoot 'ps1-child.pid') -Value `$PID
Start-Sleep -Seconds 300
"@ | Set-Content -Path $ps1Path -Encoding utf8

  $loadedPorts = Invoke-RestMethod -Uri "$ApiBase/api/ports" -Method Get
  $originalPorts = [System.Collections.Generic.List[object]]::new()
  $seenBaselinePortIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  Add-BaselinePortRows -Value $loadedPorts -Target $originalPorts -SeenIds $seenBaselinePortIds
  $testPort = [ordered]@{
    id = $portId
    name = 'Windows detached sidecar E2E'
    commandPath = $batchPath
    folderPath = $tempRoot
    isRunning = $false
  }
  $ps1TestPort = [ordered]@{
    id = $ps1PortId
    name = 'Windows PowerShell launcher E2E'
    commandPath = $ps1Path
    folderPath = $tempRoot
    isRunning = $false
  }
  $combinedPorts = [System.Collections.Generic.List[object]]::new()
  foreach ($portRow in $originalPorts) { $combinedPorts.Add($portRow) }
  $combinedPorts.Add([pscustomobject]$testPort)
  $combinedPorts.Add([pscustomobject]$ps1TestPort)
  $portsBody = ConvertTo-Json -InputObject ([ordered]@{
    basePorts = $loadedPorts
    ports = $combinedPorts.ToArray()
    source = 'windows-sidecar-e2e-setup'
  }) -Depth 100
  Invoke-RestMethod -Uri "$ApiBase/api/ports/merge" -Method Post -ContentType 'application/json' -Body $portsBody | Out-Null
  $testPortsSaved = $true

  $executeBody = @{ portId = $portId; commandPath = $batchPath; folderPath = $tempRoot; port = $null } | ConvertTo-Json
  Invoke-RestMethod -Uri "$ApiBase/api/execute-command" -Method Post -ContentType 'application/json' -Body $executeBody | Out-Null

  Wait-Until -Failure 'Detached sidecar child PID file was not created.' -Condition {
    Test-Path $pidFile -PathType Leaf
  }
  $detachedPid = [int](Get-Content $pidFile -Raw)
  if ($null -eq (Get-Process -Id $detachedPid -ErrorAction SilentlyContinue)) {
    throw "Detached sidecar child PID $detachedPid was not alive before Stop."
  }

  $stopBody = @{ portId = $portId; port = $null } | ConvertTo-Json
  Invoke-RestMethod -Uri "$ApiBase/api/stop-command" -Method Post -ContentType 'application/json' -Body $stopBody | Out-Null
  Wait-Until -Failure "Detached sidecar child PID $detachedPid survived Stop." -Condition {
    $null -eq (Get-Process -Id $detachedPid -ErrorAction SilentlyContinue)
  }
  Write-Host "Windows sidecar detached-tree E2E passed (PID $detachedPid terminated)."

  $ps1ExecuteBody = @{ portId = $ps1PortId; commandPath = $ps1Path; folderPath = $tempRoot; port = $null } | ConvertTo-Json
  Invoke-RestMethod -Uri "$ApiBase/api/execute-command" -Method Post -ContentType 'application/json' -Body $ps1ExecuteBody | Out-Null
  Wait-Until -Failure 'PowerShell launcher PID file was not created.' -Condition {
    Test-Path $ps1PidFile -PathType Leaf
  }
  $ps1Pid = [int](Get-Content $ps1PidFile -Raw)
  if ($null -eq (Get-Process -Id $ps1Pid -ErrorAction SilentlyContinue)) {
    throw "PowerShell launcher PID $ps1Pid was not alive before Stop."
  }
  $ps1StopBody = @{ portId = $ps1PortId; port = $null } | ConvertTo-Json
  Invoke-RestMethod -Uri "$ApiBase/api/stop-command" -Method Post -ContentType 'application/json' -Body $ps1StopBody | Out-Null
  Wait-Until -Failure "PowerShell launcher PID $ps1Pid survived Stop." -Condition {
    $null -eq (Get-Process -Id $ps1Pid -ErrorAction SilentlyContinue)
  }
  Write-Host "Windows sidecar PowerShell-launcher E2E passed (PID $ps1Pid terminated)."
} finally {
  $restoreFailure = $null
  if ($testPortsSaved -and $null -ne $originalPorts -and $null -ne $combinedPorts) {
    try {
      $restoreBody = ConvertTo-Json -InputObject ([ordered]@{
        basePorts = $combinedPorts.ToArray()
        ports = $originalPorts.ToArray()
        source = 'windows-sidecar-e2e-restore'
      }) -Depth 12
      Invoke-RestMethod -Uri "$ApiBase/api/ports/merge" -Method Post -ContentType 'application/json' -Body $restoreBody | Out-Null
    } catch {
      $restoreFailure = $_
    }
  }
  if ($detachedPid -and (Get-Process -Id $detachedPid -ErrorAction SilentlyContinue)) {
    taskkill.exe /PID $detachedPid /T /F | Out-Null
  }
  if ($ps1Pid -and (Get-Process -Id $ps1Pid -ErrorAction SilentlyContinue)) {
    taskkill.exe /PID $ps1Pid /T /F | Out-Null
  }
  Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
  if ($null -ne $restoreFailure) {
    throw "Windows sidecar E2E failed to restore the original ports: $($restoreFailure.Exception.Message)"
  }
}
