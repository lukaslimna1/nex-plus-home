<#
.SYNOPSIS
    Windows Development Preflight & Guardrail Script for NEX+ Home.
.DESCRIPTION
    Audits the local development environment in a strict read-only manner.
    Detects running Next.js dev servers, node/npm versions, PostgreSQL services,
    port bindings, and administrative privileges before destructive or build tasks.
.PARAMETER ForNpmCi
    If specified, exits with code 1 if a running NEX+ dev server is detected,
    preventing file-locking EPERM errors during npm ci.
#>
param(
    [switch]$ForNpmCi
)

$ErrorActionPreference = "Continue"
$hasCriticalError = $false

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " NEX+ Home - Windows Development Preflight & Guardrails" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# 1. Resolve and Validate Repository Root via Git
$ScriptRootResolved = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$gitTopLevelRaw = (& git -C $ScriptRootResolved rev-parse --show-toplevel 2>&1)

if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($gitTopLevelRaw)) {
    Write-Host "[FAIL] Git rev-parse failed or git not available: $gitTopLevelRaw" -ForegroundColor Red
    $hasCriticalError = $true
    $RepoRoot = $ScriptRootResolved
} else {
    $RepoRoot = (Resolve-Path $gitTopLevelRaw.Trim()).Path
    if ($RepoRoot.ToLowerInvariant() -ne $ScriptRootResolved.ToLowerInvariant()) {
        Write-Host "[FAIL] Derived repository root ($ScriptRootResolved) does not match Git toplevel ($RepoRoot)" -ForegroundColor Red
        $hasCriticalError = $true
    }
}

Write-Host "Repository Root : $RepoRoot"

# 2. Git Status Check
Write-Host "`n--- [1/6] Git Repository ---" -ForegroundColor Yellow
$gitBranch = (& git -C $RepoRoot branch --show-current 2>&1)
if ($LASTEXITCODE -ne 0) {
    Write-Host "Branch          : [FAIL] Unable to determine Git branch ($gitBranch)" -ForegroundColor Red
    $hasCriticalError = $true
} else {
    Write-Host "Branch          : $gitBranch"
}

$gitStatus = (& git -C $RepoRoot status --porcelain 2>&1)
if ($LASTEXITCODE -ne 0) {
    Write-Host "Working Tree    : [FAIL] git status command failed ($gitStatus)" -ForegroundColor Red
    $hasCriticalError = $true
} elseif ($null -ne $gitStatus -and $gitStatus.Trim().Length -gt 0) {
    Write-Host "Working Tree    : [WARN] Dirty (uncommitted changes present)" -ForegroundColor Yellow
} else {
    Write-Host "Working Tree    : [PASS] Clean" -ForegroundColor Green
}

# 3. Node.js and npm Runtime Check
Write-Host "`n--- [2/6] Runtime Environment ---" -ForegroundColor Yellow
$nodeVersion = (& node -v 2>$null)
$npmVersion = (& npm -v 2>$null)

$expectedNode = "v24.19.0"
$expectedNpm = "12.0.2"

if ($nodeVersion -eq $expectedNode) {
    Write-Host "Node.js Version : [PASS] $nodeVersion" -ForegroundColor Green
} else {
    Write-Host "Node.js Version : [WARN] $nodeVersion (Expected: $expectedNode)" -ForegroundColor Yellow
}

if ($npmVersion -eq $expectedNpm) {
    Write-Host "npm Version     : [PASS] $npmVersion" -ForegroundColor Green
} else {
    Write-Host "npm Version     : [WARN] $npmVersion (Expected: $expectedNpm)" -ForegroundColor Yellow
}

# 4. Elevation Check
Write-Host "`n--- [3/6] Session Elevation ---" -ForegroundColor Yellow
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    Write-Host "ADMIN SESSION   : YES (Elevated Administrator)" -ForegroundColor Cyan
} else {
    Write-Host "ADMIN SESSION   : NO (Standard User - UAC/Service management requires elevated prompt)" -ForegroundColor DarkGray
}

# 5. Next.js Dev Server Detection (SWC File Lock Guardrail)
Write-Host "`n--- [4/6] Next.js Dev Server Guardrail ---" -ForegroundColor Yellow

function Normalize-PathStr($p) {
    if (-not $p) { return "" }
    return $p.Replace("/", "\").TrimEnd("\").ToLowerInvariant()
}

function Test-IsNexHomeDevProcess($proc, $rootPath, $allNodeProcs) {
    if (-not $proc) { return $false }
    $cmd = $proc.CommandLine
    if (-not $cmd) { return $false }

    $cmdNorm = $cmd.Replace("/", "\").ToLowerInvariant()
    $rootNorm = Normalize-PathStr $rootPath

    # 1. Direct path inclusion + Next.js / npm dev markers
    if ($cmdNorm.Contains($rootNorm)) {
        if ($cmdNorm.Contains("\node_modules\next\") -or $cmdNorm.Contains("start-server.js") -or $cmdNorm -match "next(\.js|\.cmd|\.ps1)?\s+dev" -or $cmdNorm -match "npm(\.js|\.cmd|\.ps1)?\s+(run\s+)?dev") {
            return $true
        }
    }

    # 2. Process Tree Parent Check (child of next dev launcher)
    if ($proc.ParentProcessId) {
        $parent = $allNodeProcs | Where-Object { $_.ProcessId -eq $proc.ParentProcessId } | Select-Object -First 1
        if ($parent -and $parent.CommandLine) {
            $parentCmdNorm = $parent.CommandLine.Replace("/", "\").ToLowerInvariant()
            if ($parentCmdNorm.Contains($rootNorm) -and ($parentCmdNorm.Contains("\node_modules\next\") -or $parentCmdNorm -match "next|npm")) {
                return $true
            }
        }
    }

    return $false
}

$nodeProcesses = Get-CimInstance win32_process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "^node" }
$nexDevRunning = $false
$nexDevPids = @()

foreach ($proc in $nodeProcesses) {
    if (Test-IsNexHomeDevProcess $proc $RepoRoot $nodeProcesses) {
        $nexDevRunning = $true
        if ($nexDevPids -notcontains $proc.ProcessId) {
            $nexDevPids += $proc.ProcessId
        }
    }
}

# Inspect port 3000 listeners
$port3000Listeners = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($port3000Listeners) {
    foreach ($listener in $port3000Listeners) {
        $ownerProc = Get-CimInstance win32_process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
        $execPath = if ($ownerProc -and $ownerProc.ExecutablePath) { $ownerProc.ExecutablePath } else { if ($ownerProc) { $ownerProc.Name } else { "Unknown" } }
        Write-Host "Port 3000 Bind  : $($listener.LocalAddress):3000 (PID: $($listener.OwningProcess), Process: $execPath)"

        if ($ownerProc -and (Test-IsNexHomeDevProcess $ownerProc $RepoRoot $nodeProcesses)) {
            $nexDevRunning = $true
            if ($nexDevPids -notcontains $listener.OwningProcess) {
                $nexDevPids += $listener.OwningProcess
            }
        } else {
            Write-Host "Port 3000 Note  : [INFO] Port 3000 occupied by unrelated process (PID: $($listener.OwningProcess))." -ForegroundColor DarkGray
        }
    }
}

if ($nexDevRunning) {
    Write-Host "NEX+ DEV SERVER : [RUNNING] Active PID(s): $($nexDevPids -join ', ')" -ForegroundColor Red
    Write-Host "Guardrail Alert : npm ci is NOT SAFE while this process is running (SWC binary lock)." -ForegroundColor Red
} else {
    Write-Host "NEX+ DEV SERVER : [STOPPED] No active dev server for this project detected." -ForegroundColor Green
    Write-Host "Guardrail Check : [PASS] Safe to perform dependency and build operations." -ForegroundColor Green
}

# 6. PostgreSQL 18 (NEX+ Dedicated Instance) Check
Write-Host "`n--- [5/6] PostgreSQL 18 (NEX+ Dedicated) ---" -ForegroundColor Yellow
$expectedPg18Bin = "C:\Program Files\PostgreSQL\18\bin\postgres.exe"
$expectedPg18Data = "C:\Program Files\PostgreSQL\18\data"
$expectedPg18Ctl = "C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe"

# 6.1 Check Service Configuration & State
$pgService = Get-CimInstance win32_service -Filter "Name = 'postgresql-x64-18'" -ErrorAction SilentlyContinue
if ($pgService) {
    $serviceRunning = ($pgService.State -eq "Running")
    $serviceAuto = ($pgService.StartMode -eq "Auto")
    $pathMatch = ($pgService.PathName -and $pgService.PathName.ToLowerInvariant().Contains($expectedPg18Ctl.ToLowerInvariant()) -and $pgService.PathName.ToLowerInvariant().Contains($expectedPg18Data.ToLowerInvariant()))

    if ($serviceRunning -and $serviceAuto -and $pathMatch) {
        Write-Host "Service Status  : [PASS] $($pgService.Name) (State: $($pgService.State), StartMode: $($pgService.StartMode))" -ForegroundColor Green
    } else {
        Write-Host "Service Status  : [FAIL] $($pgService.Name) (State: $($pgService.State), StartMode: $($pgService.StartMode), PathName: $($pgService.PathName))" -ForegroundColor Red
        $hasCriticalError = $true
    }
} else {
    Write-Host "Service Status  : [FAIL] postgresql-x64-18 service not found!" -ForegroundColor Red
    $hasCriticalError = $true
}

# 6.2 Check Binary Version
if (Test-Path $expectedPg18Bin) {
    $pgVerOutput = (& $expectedPg18Bin --version 2>&1)
    if ($pgVerOutput -match "18\.6") {
        Write-Host "Binary Version  : [PASS] $pgVerOutput" -ForegroundColor Green
    } else {
        Write-Host "Binary Version  : [WARN] $pgVerOutput (Expected: PostgreSQL 18.6)" -ForegroundColor Yellow
    }
} else {
    Write-Host "Binary Version  : [FAIL] $expectedPg18Bin not found!" -ForegroundColor Red
    $hasCriticalError = $true
}

# 6.3 Check Port 5433 Listeners and Process Ownership
$pgListeners = Get-NetTCPConnection -LocalPort 5433 -State Listen -ErrorAction SilentlyContinue
if ($pgListeners) {
    $allLoopback = $true
    $allPg18Owner = $true
    $pgServicePid = if ($pgService) { $pgService.ProcessId } else { 0 }

    foreach ($listener in $pgListeners) {
        $addr = $listener.LocalAddress
        $ownerPid = $listener.OwningProcess
        $ownerProc = Get-CimInstance win32_process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
        $ownerName = if ($ownerProc) { $ownerProc.Name } else { "Unknown" }
        $ownerPath = if ($ownerProc -and $ownerProc.ExecutablePath) { $ownerProc.ExecutablePath } else { "" }
        $parentPid = if ($ownerProc) { $ownerProc.ParentProcessId } else { 0 }

        $displayPath = if ($ownerPath) { $ownerPath } else { "$ownerName (Parent PID: $parentPid -> Service PID: $pgServicePid)" }
        Write-Host "Port 5433 Bind  : $($addr):$($listener.LocalPort) (PID: $ownerPid, Process: $displayPath)"

        if ($addr -ne "127.0.0.1" -and $addr -ne "::1") {
            $allLoopback = $false
        }

        $isVerifiedPg18 = $false
        if ($ownerPath -and $ownerPath.ToLowerInvariant() -eq $expectedPg18Bin.ToLowerInvariant()) {
            $isVerifiedPg18 = $true
        } elseif ($ownerName -eq "postgres.exe" -and ($ownerPid -eq $pgServicePid -or $parentPid -eq $pgServicePid)) {
            $isVerifiedPg18 = $true
        }

        if (-not $isVerifiedPg18) {
            $allPg18Owner = $false
        }
    }

    if (-not $allLoopback) {
        Write-Host "Network Isolation: [FAIL] Port 5433 bound to non-loopback address!" -ForegroundColor Red
        $hasCriticalError = $true
    } elseif (-not $allPg18Owner) {
        Write-Host "Process Ownership: [FAIL] Port 5433 owned by executable other than PostgreSQL 18 ($expectedPg18Bin)!" -ForegroundColor Red
        $hasCriticalError = $true
    } else {
        Write-Host "Port 5433 Checks: [PASS] Strictly loopback and owned by PostgreSQL 18." -ForegroundColor Green
    }
} else {
    Write-Host "Port 5433 Bind  : [FAIL] No active listener found on port 5433!" -ForegroundColor Red
    $hasCriticalError = $true
}

# 6.4 Health Check via pg_isready
$pgIsReady = "C:\Program Files\PostgreSQL\18\bin\pg_isready.exe"
if (Test-Path $pgIsReady) {
    $readyOutput = (& $pgIsReady -h 127.0.0.1 -p 5433 2>&1)
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Health Check    : [PASS] pg_isready (127.0.0.1:5433 accepting connections)" -ForegroundColor Green
    } else {
        Write-Host "Health Check    : [FAIL] pg_isready failed: $readyOutput" -ForegroundColor Red
        $hasCriticalError = $true
    }
} else {
    Write-Host "Health Check    : [FAIL] pg_isready binary not found at $pgIsReady" -ForegroundColor Red
    $hasCriticalError = $true
}

# 7. PostgreSQL 16 (Odoo Instance) Isolation Check
Write-Host "`n--- [6/6] PostgreSQL 16 (Odoo Instance) ---" -ForegroundColor Yellow
$odooService = Get-CimInstance win32_service -Filter "Name = 'PostgreSQL_For_Odoo'" -ErrorAction SilentlyContinue
$odooServicePid = if ($odooService) { $odooService.ProcessId } else { 0 }

if ($odooService) {
    Write-Host "Odoo Service    : $($odooService.Name) (State: $($odooService.State), Service PID: $odooServicePid)" -ForegroundColor Cyan
} else {
    Write-Host "Odoo Service    : [INFO] PostgreSQL_For_Odoo not registered." -ForegroundColor DarkGray
}

$odooListeners = Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue
if ($odooListeners) {
    foreach ($listener in $odooListeners) {
        $ownerPid = $listener.OwningProcess
        $ownerProc = Get-CimInstance win32_process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
        $ownerName = if ($ownerProc) { $ownerProc.Name } else { "Unknown" }
        $ownerPath = if ($ownerProc -and $ownerProc.ExecutablePath) { $ownerProc.ExecutablePath } else { "" }
        $parentPid = if ($ownerProc) { $ownerProc.ParentProcessId } else { 0 }

        $isOdooVerified = $false
        if ($ownerPath -and $ownerPath.ToLowerInvariant().Contains("c:\program files\odoo")) {
            $isOdooVerified = $true
        } elseif ($ownerName -eq "postgres.exe" -and ($ownerPid -eq $odooServicePid -or $parentPid -eq $odooServicePid)) {
            $isOdooVerified = $true
        }

        $displayPath = if ($ownerPath) { $ownerPath } else { "$ownerName (Parent PID: $parentPid -> Odoo Service PID: $odooServicePid)" }

        if ($isOdooVerified) {
            Write-Host "Port 5432 Bind  : $($listener.LocalAddress):5432 (PID: $ownerPid, Odoo PostgreSQL verified: $displayPath)" -ForegroundColor DarkGray
        } else {
            Write-Host "Port 5432 Bind  : [WARN] $($listener.LocalAddress):5432 occupied by non-Odoo process ($displayPath)" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "Port 5432 Bind  : [INFO] No listener on port 5432." -ForegroundColor DarkGray
}

Write-Host "`n============================================================" -ForegroundColor Cyan

# Determine Final Exit Code
if ($ForNpmCi -and $nexDevRunning) {
    Write-Host "[BLOCKED] Cannot run npm ci while NEX+ dev server is active (PID: $($nexDevPids -join ', '))." -ForegroundColor Red
    Write-Host "Please stop the NEX+ dev server before running npm ci." -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Cyan
    exit 1
}

if ($hasCriticalError) {
    Write-Host "Preflight check finished with CRITICAL ERROR(S). Status: FAIL" -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Cyan
    exit 1
}

Write-Host "Preflight check complete. Status: PASS" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
exit 0
