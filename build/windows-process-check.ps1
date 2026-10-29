# Windows PowerShell 5.1. Invoked with -File, never interpolated into PowerShell code.
[CmdletBinding()]
param(
    [ValidateSet('Close', 'Inspect', 'Library')][string]$Mode = 'Inspect',
    [string]$InstallDirectory,
    [int]$InstallerProcessId,
    [string]$UninstallerName = 'Uninstall Neox.exe',
    [string]$LogPath,
    [ValidateRange(0, 60)][int]$GraceSeconds = 10,
    [ValidateRange(0, 60)][int]$ForceWaitSeconds = 5
)
$ErrorActionPreference = 'Stop'

function Write-CheckLog([string]$Text) {
    $line = '{0:o} {1}' -f [DateTime]::Now, $Text
    Write-Host $line
    if ($LogPath) { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 }
}

function Get-NormalizedPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
        throw "Expected an absolute path: $Path"
    }
    return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Test-InstallPath([string]$Path, [string]$Root) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    $normalized = Get-NormalizedPath $Path
    return $normalized.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-ProcessSnapshot {
    # Query failures MUST NOT be treated as an empty result. No name-only fallback.
    return @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
}

function Get-ExcludedProcessIds($Snapshot, [int]$OwnerId) {
    $excluded = @{}
    $owner = $Snapshot | Where-Object { $_.ProcessId -eq $OwnerId } | Select-Object -First 1
    if (-not $owner -or -not $owner.ExecutablePath) {
        throw "Cannot establish installer identity for PID=$OwnerId"
    }
    # Never exclude ancestors/descendants wholesale: Neox may launch the installer.
    # NSIS elevation instances with the exact installer image are transaction peers.
    $ownerPath = Get-NormalizedPath $owner.ExecutablePath
    foreach ($process in $Snapshot) {
        if ($process.ExecutablePath -and (Get-NormalizedPath $process.ExecutablePath) -ieq $ownerPath) {
            $excluded[[int]$process.ProcessId] = $true
        }
    }
    $excluded[$PID] = $true
    return $excluded
}

function Get-BlockingProcesses([string]$Root, [int]$OwnerId) {
    $snapshot = @(Get-ProcessSnapshot)
    $excluded = Get-ExcludedProcessIds $snapshot $OwnerId
    $uninstallerPath = Join-Path $Root $UninstallerName
    $missingPaths = 0
    $blockers = @()
    foreach ($process in $snapshot) {
        if (-not $process.ExecutablePath) { $missingPaths++; continue }
        if ($excluded.ContainsKey([int]$process.ProcessId)) { continue }
        $path = Get-NormalizedPath $process.ExecutablePath
        # The exact generated uninstaller is part of the transaction, not a helper.
        # No wildcard/name-only exemptions (rg.exe/os-bridge/node are blockers).
        if ($path -ieq $uninstallerPath) { continue }
        if (Test-InstallPath $path $Root) { $blockers += $process }
    }
    if ($missingPaths) {
        Write-CheckLog "INFO: $missingPaths system/inaccessible processes have no executable path; no path inferred from names."
    }
    foreach ($process in $blockers) {
        Write-CheckLog "BLOCKER PID=$($process.ProcessId) PATH=$($process.ExecutablePath) CREATED=$($process.CreationDate)"
    }
    return $blockers
}

function Request-GracefulClose($Processes) {
    foreach ($process in $Processes) {
        try {
            $live = Get-Process -Id $process.ProcessId -ErrorAction Stop
            # CIM timestamps have microsecond precision; tolerate sub-millisecond truncation.
            if ([Math]::Abs(($live.StartTime.ToUniversalTime() - $process.CreationDate.ToUniversalTime()).TotalMilliseconds) -ge 1) { continue }
            $requested = $live.CloseMainWindow()
            Write-CheckLog "CLOSE PID=$($process.ProcessId) windowRequest=$requested"
        } catch {
            Write-CheckLog "CLOSE PID=$($process.ProcessId): $($_.Exception.Message)"
        }
    }
}

function Stop-VerifiedProcess($Process, [string]$Root) {
    # Revalidate PID + creation time + path just before acting (PID reuse).
    $current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $([int]$Process.ProcessId)" -ErrorAction Stop
    if (-not $current) { return }
    if ($current.CreationDate -ne $Process.CreationDate -or
        $current.ExecutablePath -ine $Process.ExecutablePath -or
        -not (Test-InstallPath $current.ExecutablePath $Root)) {
        Write-CheckLog "SKIP changed identity PID=$($Process.ProcessId)"
        return
    }
    $live = $null
    try {
        $live = Get-Process -Id $Process.ProcessId -ErrorAction Stop
        # Hold the process handle before checking StartTime and killing that object.
        $null = $live.Handle
        if ([Math]::Abs(($live.StartTime.ToUniversalTime() - $Process.CreationDate.ToUniversalTime()).TotalMilliseconds) -ge 1) { return }
        Write-CheckLog "FORCE PID=$($Process.ProcessId) PATH=$($Process.ExecutablePath)"
        $live.Kill()
    } catch {
        Write-CheckLog "FORCE FAILED PID=$($Process.ProcessId) PATH=$($Process.ExecutablePath): $($_.Exception.Message)"
    } finally {
        if ($live) { $live.Dispose() }
    }
}

function Invoke-ProcessCheck {
    try {
        $root = Get-NormalizedPath $InstallDirectory
        if ($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\', '/')) {
            throw 'Refusing to check an entire drive/share root.'
        }
        if ([IO.Path]::GetFileName($UninstallerName) -ne $UninstallerName) {
            throw 'UninstallerName must be a filename, not a path.'
        }
        Write-CheckLog "CHECK mode=$Mode directory=$root installerPID=$InstallerProcessId"
        $blockers = @(Get-BlockingProcesses $root $InstallerProcessId)
        if ($Mode -eq 'Inspect') {
            if ($blockers.Count) { return 10 }
            return 0
        }
        if (-not $blockers.Count) { return 0 }
        Request-GracefulClose $blockers
        $deadline = [DateTime]::UtcNow.AddSeconds($GraceSeconds)
        do {
            Start-Sleep -Milliseconds 250
            $blockers = @(Get-BlockingProcesses $root $InstallerProcessId)
            if (-not $blockers.Count) { return 0 }
        } while ([DateTime]::UtcNow -lt $deadline)
        foreach ($process in $blockers) { Stop-VerifiedProcess $process $root }
        $deadline = [DateTime]::UtcNow.AddSeconds($ForceWaitSeconds)
        do {
            Start-Sleep -Milliseconds 250
            $blockers = @(Get-BlockingProcesses $root $InstallerProcessId)
            if (-not $blockers.Count) { return 0 }
        } while ([DateTime]::UtcNow -lt $deadline)
        Write-CheckLog 'FAILED: install-directory processes remain. No files may be replaced.'
        return 10
    } catch {
        # Includes CIM errors, parameter errors and log failures; never fail open.
        Write-Host "QUERY/CHECK ERROR: $($_.Exception.Message)"
        if ($LogPath) {
            try { Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value "QUERY/CHECK ERROR: $($_.Exception.Message)" } catch { }
        }
        return 20
    }
}

if ($Mode -ne 'Library') { exit (Invoke-ProcessCheck) }
