<#
.SYNOPSIS
    Secure local .env generator for NEX+ Home development.
.DESCRIPTION
    Interactively requests the password for the nex_home_app database role,
    URI-escapes it in memory, generates a cryptographically secure PAYLOAD_SECRET,
    and writes the local .env file without displaying or storing credentials.
#>

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envFilePath = Join-Path $RepoRoot ".env"

if (Test-Path $envFilePath) {
    Write-Host "[BLOCKED] An existing .env file was found in $RepoRoot." -ForegroundColor Red
    Write-Host "This script refuses to overwrite an existing .env configuration." -ForegroundColor Red
    exit 1
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " NEX+ Home - Local Environment (.env) Setup" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Please enter the password for PostgreSQL role 'nex_home_app'."
Write-Host "The input will be hidden for security.`n"

$securePass = Read-Host -Prompt "Enter nex_home_app password" -AsSecureString

if ($null -eq $securePass -or $securePass.Length -eq 0) {
    Write-Host "[FAIL] Password cannot be empty." -ForegroundColor Red
    exit 1
}

$bstr = [System.IntPtr]::Zero
$plainPass = $null
$escapedPass = $null
$databaseUrl = $null
$payloadSecret = $null
$envContent = $null
$rng = $null
$bytes = $null

try {
    # 1. Convert SecureString to unmanaged BSTR in memory
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePass)
    $plainPass = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

    # 2. URI Escape the password
    $escapedPass = [System.Uri]::EscapeDataString($plainPass)

    # 3. Assemble DATABASE_URL
    $databaseUrl = "postgresql://nex_home_app:$escapedPass@127.0.0.1:5433/nex_home"

    # 4. Generate cryptographically strong PAYLOAD_SECRET (32 bytes / 256 bits entropy)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    $payloadSecret = [System.BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()

    # 5. Assemble and write .env content (UTF-8 without BOM)
    $envContent = "DATABASE_URL=$databaseUrl`nPAYLOAD_SECRET=$payloadSecret`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($envFilePath, $envContent, $utf8NoBom)

    Write-Host "`n.env created successfully." -ForegroundColor Green
    Write-Host "Secrets were not displayed." -ForegroundColor Green
}
finally {
    # 1. Zero and free unmanaged memory
    if ($bstr -ne [System.IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }

    # 2. Clear sensitive byte array if allocated
    if ($null -ne $bytes) {
        [System.Array]::Clear($bytes, 0, $bytes.Length)
        $bytes = $null
    }

    # 3. Dispose RandomNumberGenerator instance
    if ($null -ne $rng) {
        $rng.Dispose()
        $rng = $null
    }

    # 4. Release/null managed references (best effort; in .NET strings are immutable)
    $plainPass = $null
    $escapedPass = $null
    $databaseUrl = $null
    $payloadSecret = $null
    $envContent = $null
    $securePass = $null
    [System.GC]::Collect()
}
