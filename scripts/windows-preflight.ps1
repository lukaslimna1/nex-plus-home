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

# 1. Resolve Repository Root dynamically
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not (Test-Path (Join-Path $RepoRoot "package.json"))) {
    Write-Host "[FAIL] Unable to locate NEX+ Home repository root from $PSScriptRoot" -ForegroundColor Red
    exit 1
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " NEX+ Home - Windows Development Preflight & Guardrails" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Repository Root : $RepoRoot"

# 2. Git Status Check
Write-Host "`n--- [1/6] Git Repository ---" -ForegroundColor Yellow
$gitBranch = (& git -C $RepoRoot branch --show-current 2>$null)
$gitStatus = (& git -C $RepoRoot status --porcelain 2>$null)

if ($gitBranch) {
    Write-Host "Branch          : $gitBranch"
} else {
    Write-Host "[WARN] Git branch could not be determined." -ForegroundColor Yellow
}

if ($gitStatus -and $gitStatus.Trim().Length -gt 0) {
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
$normalizedRoot = $RepoRoot.Replace("\", "\\").ToLower()
$nodeProcesses = Get-CimInstance win32_process -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "^node" }

$nexDevRunning = $false
$nexDevPids = @()

foreach ($proc in $nodeProcesses) {
    $cmd = $proc.CommandLine
    if ($cmd -and ($cmd.ToLower().Contains($normalizedRoot) -or $cmd.ToLower().Contains("nex-home")) -and ($cmd -match "next(\s+dev|\.js\s+dev)" -or $cmd -match "npm(\s+run|\.js\s+run)\s+dev")) {
        $nexDevRunning = $true
        $nexDevPids += $proc.ProcessId
    }
}

# Also inspect port 3000 listeners
$port3000Listeners = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($port3000Listeners) {
    foreach ($listener in $port3000Listeners) {
        $ownerProc = Get-CimInstance win32_process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
        if ($ownerProc -and $ownerProc.Name -match "^node") {
            $nexDevRunning = $true
            if ($nexDevPids -notcontains $listener.OwningProcess) {
                $nexDevPids += $listener.OwningProcess
            }
        }
    }
}

if ($nexDevRunning) {
    Write-Host "NEX+ DEV SERVER : [RUNNING] Active PID(s): $($nexDevPids -join ', ')" -ForegroundColor Red
    Write-Host "Guardrail Alert : npm ci is NOT SAFE while this process is running (SWC binary lock)." -ForegroundColor Red
    if ($ForNpmCi) {
        Write-Host "`n[BLOCKED] Stop the NEX+ dev server before running npm ci." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "NEX+ DEV SERVER : [STOPPED] No active dev server detected." -ForegroundColor Green
    Write-Host "Guardrail Check : [PASS] Safe to perform dependency and build operations." -ForegroundColor Green
}

# 6. PostgreSQL 18 (NEX+ Home Dedicated Instance) Check
Write-Host "`n--- [5/6] PostgreSQL 18 (NEX+ Dedicated) ---" -ForegroundColor Yellow
$pgService = Get-Service -Name "postgresql-x64-18" -ErrorAction SilentlyContinue
if ($pgService) {
    $serviceColor = if ($pgService.Status -eq "Running") { [ConsoleColor]::Green } else { [ConsoleColor]::Red }
    Write-Host "Service Name    : $($pgService.Name) (Status: $($pgService.Status))" -ForegroundColor $serviceColor
} else {
    Write-Host "Service Name    : [WARN] postgresql-x64-18 service not found." -ForegroundColor Yellow
}

$pgListeners = Get-NetTCPConnection -LocalPort 5433 -State Listen -ErrorAction SilentlyContinue
$hasExternalBinding = $false
$hasLoopbackBinding = $false

if ($pgListeners) {
    foreach ($listener in $pgListeners) {
        $addr = $listener.LocalAddress
        Write-Host "Port 5433 Bind  : $($addr):$($listener.LocalPort) (PID: $($listener.OwningProcess))"
        if ($addr -eq "0.0.0.0" -or $addr -eq "::") {
            $hasExternalBinding = $true
        }
        if ($addr -eq "127.0.0.1" -or $addr -eq "::1") {
            $hasLoopbackBinding = $true
        }
    }

    if ($hasExternalBinding) {
        Write-Host "Network Isolation: [FAIL] Port 5433 bound to external interface ($($pgListeners.LocalAddress -join ', ')). Must be localhost only!" -ForegroundColor Red
    } elseif ($hasLoopbackBinding) {
        Write-Host "Network Isolation: [PASS] Strictly bound to loopback (127.0.0.1 / ::1)." -ForegroundColor Green
    }
} else {
    Write-Host "Port 5433 Bind  : [WARN] No active listener found on port 5433." -ForegroundColor Yellow
}

$pgIsReady = "C:\Program Files\PostgreSQL\18\bin\pg_isready.exe"
if (Test-Path $pgIsReady) {
    $readyOutput = (& $pgIsReady -h 127.0.0.1 -p 5433 2>&1)
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Health Check    : [PASS] pg_isready (127.0.0.1:5433 accepting connections)" -ForegroundColor Green
    } else {
        Write-Host "Health Check    : [WARN] pg_isready failed: $readyOutput" -ForegroundColor Yellow
    }
} else {
    Write-Host "Health Check    : [INFO] pg_isready not located at default path $pgIsReady" -ForegroundColor DarkGray
}

# 7. PostgreSQL 16 (Odoo Instance) Isolation Check
Write-Host "`n--- [6/6] PostgreSQL 16 (Odoo Instance) ---" -ForegroundColor Yellow
$odooService = Get-Service -Name "PostgreSQL_For_Odoo" -ErrorAction SilentlyContinue
if ($odooService) {
    Write-Host "Odoo Service    : $($odooService.Name) (Status: $($odooService.Status))" -ForegroundColor Cyan
} else {
    Write-Host "Odoo Service    : [INFO] PostgreSQL_For_Odoo not registered." -ForegroundColor DarkGray
}

$odooListeners = Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue
if ($odooListeners) {
    Write-Host "Port 5432 Bind  : Bound to PID $($odooListeners[0].OwningProcess) (Odoo cluster separate from NEX+)" -ForegroundColor DarkGray
} else {
    Write-Host "Port 5432 Bind  : [INFO] No listener on port 5432." -ForegroundColor DarkGray
}

Write-Host "`n============================================================" -ForegroundColor Cyan
Write-Host " Preflight check complete." -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
exit 0
