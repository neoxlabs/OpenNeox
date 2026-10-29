# Safe tests: dot-source library, use synthetic snapshots. Never kill live Neox.
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\build\windows-process-check.ps1" -Mode Library
$script:checks = 0
function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
    $script:checks++
}
function New-SnapshotProcess([int]$Id, [string]$Path, [int]$ParentId = 0) {
    [pscustomobject]@{ ProcessId = $Id; ExecutablePath = $Path; ParentProcessId = $ParentId; CreationDate = [datetime]'2026-01-01' }
}
$root = Get-NormalizedPath 'C:\Program Files\Neox\.'
Assert ($root -eq 'C:\Program Files\Neox') 'normalize trailing slash/dot'
Assert (Test-InstallPath 'c:\program files\NEOX\rg.exe' $root) 'case-insensitive child'
Assert (-not (Test-InstallPath 'C:\Program Files\Neox-other\Neox.exe' $root)) 'sibling prefix is not a child'
Assert (-not (Test-InstallPath 'C:\Program Files\Neox\..\Other\a.exe' $root)) 'normalize traversal'
Assert (-not (Test-InstallPath $null $root)) 'unknown path is not invented'
$special = Get-NormalizedPath "C:\Neox O'Brien & `$(); unicode 中文"
Assert (Test-InstallPath ($special + '\helpers\node.exe') $special) 'special characters stay path data'
Assert (Test-InstallPath '\\server\share\Neox\helper.exe' (Get-NormalizedPath '\\server\share\Neox')) 'UNC child'
$script:snapshot = @(
    (New-SnapshotProcess 100 'C:\Downloads\Neox Setup.exe' 200),
    (New-SnapshotProcess 101 'C:\Downloads\Neox Setup.exe'),
    (New-SnapshotProcess 200 "$root\Neox.exe"),
    (New-SnapshotProcess 201 "$root\rg.exe" 100),
    (New-SnapshotProcess 202 "$root\resources\os-bridge\neox-os-bridge.exe"),
    (New-SnapshotProcess 203 "$root\Uninstall Neox.exe"),
    (New-SnapshotProcess 204 "$root\helpers\Uninstall Neox.exe"),
    (New-SnapshotProcess 205 'C:\Program Files\Neox-other\rg.exe')
)
function Get-ProcessSnapshot { return $script:snapshot }
$blockers = @(Get-BlockingProcesses $root 100)
Assert (($blockers.ProcessId -join ',') -eq '200,201,202,204') 'only transaction image/exact uninstaller excluded; app ancestor and helpers remain'
$script:snapshot = @((New-SnapshotProcess 100 "$root\Setup.exe"), (New-SnapshotProcess 101 "$root\Setup.exe"), (New-SnapshotProcess 202 "$root\node.exe"))
$blockers = @(Get-BlockingProcesses $root 100)
Assert (($blockers.ProcessId -join ',') -eq '202') 'installer running inside install directory excluded'
$Mode = 'Inspect'; $InstallDirectory = $root; $InstallerProcessId = 100
Assert ((Invoke-ProcessCheck) -eq 10) 'Inspect reports blockers without closing'
$script:snapshot = @((New-SnapshotProcess 100 'C:\Downloads\Setup.exe'))
Assert ((Invoke-ProcessCheck) -eq 0) 'successful query with no blockers'
function Get-ProcessSnapshot { throw 'synthetic CIM denied' }
Assert ((Invoke-ProcessCheck) -eq 20) 'query failure cannot become success'
$InstallDirectory = 'C:\'
Assert ((Invoke-ProcessCheck) -eq 20) 'drive root refused'
$InstallDirectory = $root; $Mode = 'Close'; $GraceSeconds = 0; $ForceWaitSeconds = 0
$script:queries = 0; $script:closed = 0; $script:forced = 0
function Get-BlockingProcesses {
    $script:queries++
    if ($script:queries -le 2) { return @(New-SnapshotProcess 200 "$root\node.exe") }
    return @()
}
function Request-GracefulClose { $script:closed++ }
function Stop-VerifiedProcess { $script:forced++ }
Assert ((Invoke-ProcessCheck) -eq 0) 'bounded close path waits after force'
Assert ($script:closed -eq 1 -and $script:forced -eq 1 -and $script:queries -eq 3) 'graceful then force then verification'
function Get-BlockingProcesses { return @(New-SnapshotProcess 200 "$root\node.exe") }
Assert ((Invoke-ProcessCheck) -eq 10) 'persistent process fails closed'
# Test identity guard with a synthetic reused PID, no call to Get-Process/Kill.
. "$PSScriptRoot\..\build\windows-process-check.ps1" -Mode Library
function Get-CimInstance { return New-SnapshotProcess 200 'C:\Other\node.exe' }
Stop-VerifiedProcess (New-SnapshotProcess 200 "$root\node.exe") $root
$script:checks++
Write-Host "PASS: $script:checks safe installer-process checks"
