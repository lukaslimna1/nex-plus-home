<#
.SYNOPSIS
    Harness canônico de validação isolada para Runtime Concurrency & Recovery Gate (Escopo 0.86C-3D).
.DESCRIPTION
    Cria um DATABASE PostgreSQL descartável dedicado (prefixo nex_job_recovery_),
    executa as migrations canônicas NEX, provisiona explicitamente o pg-boss schema 43,
    executa os testes de integração PostgreSQL do Runtime Concurrency & Recovery Gate (D1 a D13),
    e destrói o banco descartável ao final com cleanup robusto sem afetar o banco operacional.
#>

param (
    [switch]$VerifyCleanupOwnershipOnly,
    [switch]$VerifyTerminateFailureOnly
)

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envFilePath = Join-Path $RepoRoot ".env"

if (-not (Test-Path $envFilePath)) {
    Write-Host "[FAIL] Arquivo .env não encontrado em $RepoRoot." -ForegroundColor Red
    exit 1
}

# 1. Preflight PostgreSQL CLI Tools
$pgPaths = @("C:\Program Files\PostgreSQL\18\bin", "C:\Program Files\PostgreSQL\17\bin", "C:\Program Files\PostgreSQL\16\bin")
foreach ($p in $pgPaths) {
    if ((Test-Path $p) -and ($env:PATH -notlike "*$p*")) {
        $env:PATH = "$p;$env:PATH"
    }
}

if (-not (Get-Command psql -ErrorAction SilentlyContinue) -or -not (Get-Command createdb -ErrorAction SilentlyContinue) -or -not (Get-Command dropdb -ErrorAction SilentlyContinue)) {
    Write-Host "[FAIL] Ferramentas CLI do PostgreSQL (psql, createdb, dropdb) não encontradas no PATH." -ForegroundColor Red
    exit 1
}

# 2. Leitura segura de credenciais do .env (sem exibir segredos)
$envLines = Get-Content $envFilePath
$dbUrlLine = $envLines | Where-Object { $_ -match '^DATABASE_URL=' }
$payloadSecretLine = $envLines | Where-Object { $_ -match '^PAYLOAD_SECRET=' }

if (-not $dbUrlLine -or -not $payloadSecretLine) {
    Write-Host "[FAIL] DATABASE_URL ou PAYLOAD_SECRET ausentes no .env." -ForegroundColor Red
    exit 1
}

$dbUrl = $dbUrlLine.Substring('DATABASE_URL='.Length).Trim('"').Trim("'")
$payloadSecret = $payloadSecretLine.Substring('PAYLOAD_SECRET='.Length).Trim('"').Trim("'")

$uri = [System.Uri]$dbUrl
$userInfo = $uri.UserInfo.Split(':')
$operationalUser = $userInfo[0]
$operationalPass = [System.Uri]::UnescapeDataString($userInfo[1])
$operationalHost = $uri.Host
$operationalPort = $uri.Port
$operationalDbName = $uri.AbsolutePath.TrimStart('/')

if ($operationalHost -ne "127.0.0.1" -and $operationalHost -ne "localhost") {
    Write-Host "[SECURITY_FAIL] Host operacional deve ser localhost ou 127.0.0.1. Encontrado: $operationalHost" -ForegroundColor Red
    exit 1
}

# ============================================================================
# FUNÇÃO COMPARTILHADA DE CLEANUP COM RUNNERS INJETÁVEIS (PADRÃO ROBUSTO 0.86)
# ============================================================================
function Invoke-DisposableDatabaseCleanup {
    param (
        [Parameter(Mandatory = $true)]
        [string]$DatabaseName,

        [Parameter(Mandatory = $true)]
        [bool]$CreatedByHarness,

        [Parameter(Mandatory = $true)]
        [string]$OperationalDbName,

        [int]$CurrentExitCode = 0,

        [scriptblock]$TerminateRunner,
        [scriptblock]$DropRunner,
        [scriptblock]$CheckRunner
    )

    if ($null -eq $TerminateRunner) {
        $TerminateRunner = {
            param($targetDb)
            & psql -h $operationalHost -p $operationalPort -U $operationalUser -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$targetDb' AND pid <> pg_backend_pid();" | Out-Null
            $ec = $LASTEXITCODE
            return @{ ExitCode = $ec }
        }
    }

    if ($null -eq $DropRunner) {
        $DropRunner = {
            param($targetDb)
            & dropdb -h $operationalHost -p $operationalPort -U $operationalUser $targetDb
            $ec = $LASTEXITCODE
            return @{ ExitCode = $ec }
        }
    }

    if ($null -eq $CheckRunner) {
        $CheckRunner = {
            param($targetDb)
            $rawOutput = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d postgres -t -A -c "SELECT count(*) FROM pg_database WHERE datname = '$targetDb';"
            $ec = $LASTEXITCODE
            $trimmed = if ($null -ne $rawOutput) { ([string]$rawOutput).Trim() } else { "1" }
            return @{ ExitCode = $ec; ExistsCount = $trimmed }
        }
    }

    $cleanupExitCode = $CurrentExitCode

    Write-Host "`n[CLEANUP] Encerrando conexões residuais e destruindo banco descartável..." -ForegroundColor Yellow

    if ($CreatedByHarness -and $DatabaseName -and $DatabaseName.StartsWith("nex_job_recovery_") -and $DatabaseName -ne $OperationalDbName) {
        # 1. Terminate runner
        $termResult = & $TerminateRunner $DatabaseName
        $termExitCode = if ($null -ne $termResult -and $null -ne $termResult.ExitCode) { [int]$termResult.ExitCode } else { 1 }

        if ($termExitCode -ne 0) {
            Write-Host "[CLEANUP_WARN] pg_terminate_backend retornou código não-zero: $termExitCode" -ForegroundColor Yellow
        }

        Start-Sleep -Milliseconds 250

        # 2. Drop runner (executa mesmo se terminate falhou)
        $dropResult = & $DropRunner $DatabaseName
        $dropExitCode = if ($null -ne $dropResult -and $null -ne $dropResult.ExitCode) { [int]$dropResult.ExitCode } else { 1 }

        if ($dropExitCode -ne 0) {
            Write-Host "[CLEANUP_FAIL] Falha ao executar dropdb no banco descartável '$DatabaseName' (exit code: $dropExitCode)." -ForegroundColor Red
            $cleanupExitCode = 1
        } else {
            # 3. Post-condition check runner (somente se drop teve sucesso)
            $checkResult = & $CheckRunner $DatabaseName
            $checkExitCode = if ($null -ne $checkResult -and $null -ne $checkResult.ExitCode) { [int]$checkResult.ExitCode } else { 1 }
            $dbStillExists = if ($null -ne $checkResult -and $null -ne $checkResult.ExistsCount) { [string]$checkResult.ExistsCount } else { "1" }

            if ($checkExitCode -ne 0 -or $dbStillExists -ne "0") {
                Write-Host "[CLEANUP_FAIL] Banco descartável '$DatabaseName' ainda existe no catálogo de databases." -ForegroundColor Red
                $cleanupExitCode = 1
            } else {
                Write-Host "[CLEANUP] Banco descartável '$DatabaseName' destruído e confirmado inexistente." -ForegroundColor Green
            }
        }
    } else {
        if (-not $CreatedByHarness) {
            Write-Host "[CLEANUP_GUARD] Banco descartável não foi criado por esta execução ($DatabaseName). Operações de terminate/drop ignoradas com segurança." -ForegroundColor Green
        }
    }

    return $cleanupExitCode
}

# ============================================================================
# MODO DE AUTOTESTE DO HARNESS (TESTES DE ROBUSTEZ DO CLEANUP)
# ============================================================================
if ($VerifyCleanupOwnershipOnly) {
    Write-Host "[TEST_HARNESS] Validando regra de ownership guard do cleanup..." -ForegroundColor Cyan
    $res = Invoke-DisposableDatabaseCleanup -DatabaseName "nex_job_recovery_fake" -CreatedByHarness $false -OperationalDbName $operationalDbName -CurrentExitCode 0
    if ($res -ne 0) { throw "Ownership guard falhou" }
    Write-Host "[TEST_HARNESS] Ownership guard validado com sucesso!" -ForegroundColor Green
    exit 0
}

if ($VerifyTerminateFailureOnly) {
    Write-Host "[TEST_HARNESS] Validando comportamento sob falha de terminate backend..." -ForegroundColor Cyan
    $fakeTerm = { return @{ ExitCode = 1 } }
    $fakeDrop = { return @{ ExitCode = 0 } }
    $fakeCheck = { return @{ ExitCode = 0; ExistsCount = "0" } }
    $res = Invoke-DisposableDatabaseCleanup -DatabaseName "nex_job_recovery_fake_term" -CreatedByHarness $true -OperationalDbName $operationalDbName -CurrentExitCode 0 -TerminateRunner $fakeTerm -DropRunner $fakeDrop -CheckRunner $fakeCheck
    if ($res -ne 0) { throw "Cleanup falhou ao tratar aviso de terminate" }
    Write-Host "[TEST_HARNESS] Tratamento resiliente de terminate validado com sucesso!" -ForegroundColor Green
    exit 0
}

# ============================================================================
# EXECUÇÃO DO HARNESS ISOLADO
# ============================================================================
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$randomSuffix = -join ((97..122) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$disposableDbName = "nex_job_recovery_${timestamp}_${randomSuffix}"

$encodedPass = [System.Uri]::EscapeDataString($operationalPass)
$disposableDbUrl = "postgresql://${operationalUser}:${encodedPass}@${operationalHost}:${operationalPort}/${disposableDbName}"

$originalEnvDbUrl = $env:DATABASE_URL
$originalRequireDb = $env:NEX_REQUIRE_JOB_RUNTIME_RECOVERY_DB
$createdDisposableDb = $false
$exitCode = 0

$env:PGPASSWORD = $operationalPass

try {
    # 1. Criação do Banco Descartável
    Write-Host "`n[1/5] Criando banco de dados descartável: $disposableDbName..." -ForegroundColor Yellow
    & createdb -h $operationalHost -p $operationalPort -U $operationalUser $disposableDbName
    if ($LASTEXITCODE -ne 0) {
        throw "Falha ao criar o banco de dados descartável via createdb (exit code: $LASTEXITCODE)."
    }
    $createdDisposableDb = $true

    # 2. Verificação de Conectividade
    $checkSql = "SELECT current_database();"
    $currentDb = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c $checkSql).Trim()
    if ($currentDb -ne $disposableDbName) {
        throw "Conexão com o banco descartável falhou: esperado '$disposableDbName', obtido '$currentDb'."
    }
    Write-Host "Banco descartável conectado e verificado: $currentDb" -ForegroundColor Green

    $env:DATABASE_URL = $disposableDbUrl
    $env:PAYLOAD_SECRET = $payloadSecret

    # 3. Execução das Migrations Canônicas NEX
    Write-Host "`n[2/5] Executando migrations canônicas NEX no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) {
        throw "Falha ao executar payload migrate no banco descartável."
    }
    Write-Host "Migrations canônicas NEX aplicadas com sucesso." -ForegroundColor Green

    # 4. Provisionamento Explícito do pg-boss Schema 43
    Write-Host "`n[3/5] Provisionando schema pg-boss (versão 43) de forma explícita e controlada..." -ForegroundColor Yellow
    & npx tsx scripts/provision-pg-boss-schema.ts
    if ($LASTEXITCODE -ne 0) {
        throw "Falha ao executar provisionamento explícito do pg-boss no banco descartável."
    }

    # Confirmar versão no catálogo
    $versionCheckSql = "SELECT version FROM pgboss.version;"
    $pgBossVersion = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c $versionCheckSql).Trim()
    if ($pgBossVersion -ne "43") {
        throw "Verificação de schema pg-boss falhou: esperado versão '43', obtido: '$pgBossVersion'"
    }
    Write-Host "Schema pg-boss provisionado e verificado na versão 43." -ForegroundColor Green

    # 5. Execução dos Testes de Integração PostgreSQL do 0.86C-3D (D1 a D13)
    Write-Host "`n[4/5] Executando testes de integração PostgreSQL de Concorrência e Recuperação (0.86C-3D)..." -ForegroundColor Yellow
    $env:NEX_REQUIRE_JOB_RUNTIME_RECOVERY_DB = "1"
    & npx tsx --test src/core/jobs/runtime/__tests__/job-runtime-recovery.integration.test.ts
    $testExitCode = $LASTEXITCODE

    if ($testExitCode -ne 0) {
        Write-Host "`n[FAIL] Testes de integração PostgreSQL falharam com código: $testExitCode" -ForegroundColor Red
        $exitCode = $testExitCode
    } else {
        Write-Host "`n[PASS] Todos os testes de integração PostgreSQL (D1 a D13) passaram com 100% de sucesso!" -ForegroundColor Green
    }
} catch {
    Write-Host "`n[ERROR] Exceção durante o harness isolado: $_" -ForegroundColor Red
    $exitCode = 1
} finally {
    $exitCode = Invoke-DisposableDatabaseCleanup `
        -DatabaseName $disposableDbName `
        -CreatedByHarness $createdDisposableDb `
        -OperationalDbName $operationalDbName `
        -CurrentExitCode $exitCode

    $env:DATABASE_URL = $originalEnvDbUrl
    $env:NEX_REQUIRE_JOB_RUNTIME_RECOVERY_DB = $originalRequireDb
    Remove-Item env:PGPASSWORD -ErrorAction SilentlyContinue
}

exit $exitCode
