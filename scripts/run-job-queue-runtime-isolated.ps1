<#
.SYNOPSIS
    Harness canônico de validação isolada para pg-boss Runtime Provider (Escopo 0.86C-3A).
.DESCRIPTION
    Cria um DATABASE PostgreSQL descartável dedicado (prefixo nex_job_queue_),
    executa as 6 provas técnicas obrigatórias:
      1. Caso A: migrate: false falha antes de provisionar, executa cleanup e não cria conexões residuais;
      2. Caso B: provisionamento explícito e controlado cria schema 43 sem drift;
      3. Caso C: runtime normal pós-provisionamento inicia com sucesso com migrate: false;
      4. Smoke Queue: envio, recuperação com retryCount e conclusão fenced de { jobId };
      5. Smoke Duplicidade: tolerância a múltiplos wake-ups para o mesmo jobId;
      6. Attempt Fence: prova de que settlement stale (affected=0, settled=false) não afeta nova tentativa ativa.
    Destrói o banco descartável ao final sem afetar o banco operacional.
#>

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

if (-not $dbUrlLine) {
    Write-Host "[FAIL] DATABASE_URL ausente no .env." -ForegroundColor Red
    exit 1
}

$dbUrl = $dbUrlLine.Substring('DATABASE_URL='.Length).Trim('"').Trim("'")
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

# Helper canônico unificado de cleanup
function Invoke-DisposableDatabaseCleanup {
    param (
        [Parameter(Mandatory = $true)]
        [string]$DatabaseName,

        [Parameter(Mandatory = $true)]
        [bool]$CreatedByHarness,

        [Parameter(Mandatory = $true)]
        [string]$OperationalDbName,

        [int]$CurrentExitCode = 0
    )

    $cleanupExitCode = $CurrentExitCode

    Write-Host "`n[CLEANUP] Encerrando conexões residuais e destruindo banco descartável..." -ForegroundColor Yellow

    if ($CreatedByHarness -and $DatabaseName -and $DatabaseName.StartsWith("nex_job_queue_") -and $DatabaseName -ne $OperationalDbName) {
        # 1. Terminate conexões
        & psql -h $operationalHost -p $operationalPort -U $operationalUser -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DatabaseName' AND pid <> pg_backend_pid();" | Out-Null
        $termExitCode = $LASTEXITCODE

        if ($termExitCode -ne 0) {
            Write-Host "[CLEANUP_FAIL] Falha ao encerrar conexões residuais no banco descartável '$DatabaseName' (exit code: $termExitCode)." -ForegroundColor Red
            $cleanupExitCode = 1
        }

        # 2. Dropdb
        & dropdb -h $operationalHost -p $operationalPort -U $operationalUser $DatabaseName
        $dropExitCode = $LASTEXITCODE

        if ($dropExitCode -ne 0) {
            Write-Host "[CLEANUP_FAIL] Falha ao executar dropdb no banco descartável '$DatabaseName' (exit code: $dropExitCode)." -ForegroundColor Red
            $cleanupExitCode = 1
        } else {
            # 3. Post-condition confirmation
            $rawOutput = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d postgres -t -A -c "SELECT count(*) FROM pg_database WHERE datname = '$DatabaseName';"
            $checkExitCode = $LASTEXITCODE
            $dbStillExists = if ($null -ne $rawOutput) { ([string]$rawOutput).Trim() } else { "1" }

            if ($checkExitCode -ne 0 -or $dbStillExists -ne "0") {
                Write-Host "[CLEANUP_FAIL] Banco descartável '$DatabaseName' ainda existe no catálogo de databases." -ForegroundColor Red
                $cleanupExitCode = 1
            } else {
                Write-Host "[CLEANUP] Banco descartável '$DatabaseName' destruído e confirmado inexistente." -ForegroundColor Green
            }
        }
    } else {
        if (-not $CreatedByHarness) {
            Write-Host "[CLEANUP_GUARD] Banco descartável não foi criado por esta execução ($DatabaseName). Operações de cleanup ignoradas com segurança." -ForegroundColor Green
        }
    }

    return $cleanupExitCode
}

# 3. Geração do nome do Database Descartável
$randomSuffix = [System.IO.Path]::GetRandomFileName().Substring(0, 6).ToLowerInvariant()
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$disposableDbName = "nex_job_queue_${timestamp}_${randomSuffix}"

# Trava estrita de segurança
if (-not $disposableDbName.StartsWith("nex_job_queue_") -or $disposableDbName -eq $operationalDbName) {
    Write-Host "[SECURITY_FAIL] Nome do banco descartável inválido: $disposableDbName" -ForegroundColor Red
    exit 1
}

$env:PGPASSWORD = $operationalPass
$escapedPass = [System.Uri]::EscapeDataString($operationalPass)
$disposableDbUrl = "postgresql://${operationalUser}:${escapedPass}@${operationalHost}:${operationalPort}/${disposableDbName}"

$exitCode = 0
$createdDisposableDb = $false

try {
    # 4. Criação do Database Descartável
    Write-Host "`n[1/4] Criando banco de dados descartável: $disposableDbName..." -ForegroundColor Yellow
    & createdb -h $operationalHost -p $operationalPort -U $operationalUser $disposableDbName
    if ($LASTEXITCODE -ne 0) { throw "Falha ao criar banco de dados descartável: $disposableDbName" }
    $createdDisposableDb = $true

    # Verificação de segurança via query SQL direta
    $currentDb = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT current_database();").Trim()
    if ($currentDb -ne $disposableDbName -or -not $currentDb.StartsWith("nex_job_queue_")) {
        throw "Verificação de segurança falhou: banco conectado '$currentDb' diverge do esperado '$disposableDbName'."
    }
    Write-Host "Banco descartável conectado e verificado: $currentDb" -ForegroundColor Green

    # Configuração de variáveis de ambiente para a suíte de integração
    $env:DATABASE_URL = $disposableDbUrl

    # 5. Execução do Runner de Integração
    Write-Host "`n[2/4] Executando suíte técnica de provas de runtime do pg-boss..." -ForegroundColor Yellow
    & npx tsx src/core/jobs/runtime/__tests__/job-queue-runtime.integration.ts
    $testExitCode = $LASTEXITCODE

    if ($testExitCode -ne 0) {
        Write-Host "`n[FAIL] Suíte de integração do runtime falhou com código: $testExitCode" -ForegroundColor Red
        $exitCode = $testExitCode
    } else {
        Write-Host "`n[PASS] Suíte de integração do runtime concluída com 100% de sucesso!" -ForegroundColor Green
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
}

exit $exitCode
