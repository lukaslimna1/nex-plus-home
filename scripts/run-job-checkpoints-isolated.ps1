<#
.SYNOPSIS
    Harness canônico de validação isolada para Continuation Checkpoint Contracts & Store (Escopo 0.86C-4A).
.DESCRIPTION
    Cria um DATABASE PostgreSQL descartável dedicado (prefixo nex_chk_),
    executa o ciclo completo de validação estrutural de migrations (UP -> DOWN -> UP),
    executa os testes de integração PostgreSQL do Continuation Checkpoint Store L0,
    e destrói o banco descartável ao final sem afetar o banco de dados operacional.
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
    Write-Host "[FAIL] Host operacional não é local: $operationalHost" -ForegroundColor Red
    exit 1
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " NEX+ · HARNESS DE CONTINUATION CHECKPOINT ISOLADO (0.86C-4A)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Host: $operationalHost | Porta: $operationalPort | Banco Operacional: $operationalDbName (PROTEGIDO)"

# ============================================================================
# FUNÇÃO COMPARTILHADA DE CLEANUP COM RUNNERS INJETÁVEIS
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
            $checkRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d postgres -t -A -c "SELECT count(*) FROM pg_database WHERE datname = '$targetDb';"
            $ec = $LASTEXITCODE
            $existsCount = if ($checkRaw) { $checkRaw.Trim() } else { "0" }
            return @{ ExitCode = $ec; ExistsCount = $existsCount }
        }
    }

    $cleanupExitCode = $CurrentExitCode

    if ($CreatedByHarness -and $DatabaseName -and $DatabaseName.StartsWith("nex_chk_") -and $DatabaseName -ne $OperationalDbName) {
        Write-Host "`n[CLEANUP] Encerrando conexões ativas no banco descartável $DatabaseName..." -ForegroundColor Yellow
        $termResult = & $TerminateRunner $DatabaseName
        if ($termResult.ExitCode -ne 0) {
            Write-Host "[WARN] Não foi possível encerrar conexões com pg_terminate_backend (ExitCode=$($termResult.ExitCode)). Continuando para drop..." -ForegroundColor Yellow
            if ($cleanupExitCode -eq 0) { $cleanupExitCode = $termResult.ExitCode }
        }

        Write-Host "[CLEANUP] Destruindo banco descartável $DatabaseName..." -ForegroundColor Yellow
        $dropResult = & $DropRunner $DatabaseName
        if ($dropResult.ExitCode -ne 0) {
            Write-Host "[CLEANUP_FAIL] Falha ao dropar banco descartável $DatabaseName (ExitCode=$($dropResult.ExitCode))." -ForegroundColor Red
            if ($cleanupExitCode -eq 0) { $cleanupExitCode = $dropResult.ExitCode }
        } else {
            $postCheck = & $CheckRunner $DatabaseName
            if ($postCheck.ExitCode -ne 0 -or $postCheck.ExistsCount -ne "0") {
                Write-Host "[CLEANUP_FAIL] Pós-condição falhou: banco descartável ainda consta no catálogo pg_database." -ForegroundColor Red
                if ($cleanupExitCode -eq 0) { $cleanupExitCode = 1 }
            } else {
                Write-Host "[CLEANUP] Banco descartável '$DatabaseName' destruído e confirmado inexistente." -ForegroundColor Green
            }
        }
    } else {
        if (-not $CreatedByHarness) {
            Write-Host "[CLEANUP_GUARD] Banco descartável não foi criado por esta execução ($DatabaseName). Operações de terminate/drop ignoradas." -ForegroundColor Green
        }
    }

    return $cleanupExitCode
}

# ============================================================================
# MODOS DE AUTOTESTE DO HARNESS (F-4A-HARNESS-MODES-01)
# ============================================================================

# 1. Verificação determinística isolada da guarda de ownership
if ($VerifyCleanupOwnershipOnly) {
    Write-Host "`n[PROVA DETERMINÍSTICA] Testando ownership guard do cleanup em isolamento..." -ForegroundColor Yellow
    $testSimulatedDb = "nex_chk_simulated_guard_probe"
    $executedDrop = $false
    $executedTerminate = $false

    $injectedTerminateRunner = {
        param($targetDb)
        $executedTerminate = $true
        return @{ ExitCode = 0 }
    }
    $injectedDropRunner = {
        param($targetDb)
        $executedDrop = $true
        return @{ ExitCode = 0 }
    }

    # Cenário A: Recurso não criado pelo harness ($CreatedByHarness = $false)
    $guardExitCodeA = Invoke-DisposableDatabaseCleanup `
        -DatabaseName $testSimulatedDb `
        -CreatedByHarness $false `
        -OperationalDbName $operationalDbName `
        -CurrentExitCode 0 `
        -TerminateRunner $injectedTerminateRunner `
        -DropRunner $injectedDropRunner

    if ($executedDrop -or $executedTerminate) {
        Write-Host "[PROVA_FAIL] Guarda de ownership falhou: executou terminate/drop indevido em DB sem ownership ($testSimulatedDb)." -ForegroundColor Red
        exit 1
    }

    # Cenário B: Tentativa com o nome do banco operacional mesmo com CreatedByHarness = $true
    $guardExitCodeB = Invoke-DisposableDatabaseCleanup `
        -DatabaseName $operationalDbName `
        -CreatedByHarness $true `
        -OperationalDbName $operationalDbName `
        -CurrentExitCode 0 `
        -TerminateRunner $injectedTerminateRunner `
        -DropRunner $injectedDropRunner

    if ($executedDrop -or $executedTerminate) {
        Write-Host "[PROVA_FAIL] Guarda de ownership falhou: executou terminate/drop indevido no banco operacional ($operationalDbName)." -ForegroundColor Red
        exit 1
    }

    # Cenário C: Tentativa com prefixo inválido
    $guardExitCodeC = Invoke-DisposableDatabaseCleanup `
        -DatabaseName "other_prefix_db" `
        -CreatedByHarness $true `
        -OperationalDbName $operationalDbName `
        -CurrentExitCode 0 `
        -TerminateRunner $injectedTerminateRunner `
        -DropRunner $injectedDropRunner

    if ($executedDrop -or $executedTerminate) {
        Write-Host "[PROVA_FAIL] Guarda de ownership falhou: executou terminate/drop indevido em DB com prefixo não-nex_chk_." -ForegroundColor Red
        exit 1
    }

    if ($guardExitCodeA -ne 0 -or $guardExitCodeB -ne 0 -or $guardExitCodeC -ne 0) {
        Write-Host "[PROVA_FAIL] Guarda de ownership falhou: exit code retornado divergiu de 0." -ForegroundColor Red
        exit 1
    }

    Write-Host "[PROVA_OK] Guarda de ownership verificada com sucesso: recurso sem ownership válido não dispara terminate nem drop e retorna exit code 0." -ForegroundColor Green
    exit 0
}

# 2. Verificação determinística isolada do caminho de falha no terminate
if ($VerifyTerminateFailureOnly) {
    Write-Host "`n[PROVA DETERMINÍSTICA] Testando tratamento de falha no terminate do cleanup em isolamento via runners injetados..." -ForegroundColor Yellow
    $testSimulatedDb = "nex_chk_simulated_terminate_probe"

    $calls = @{
        TerminateCount = 0
        DropCount = 0
        CheckCount = 0
    }

    $injectedTerminateRunner = {
        param($targetDb)
        $calls.TerminateCount++
        return @{ ExitCode = 1 }
    }

    $injectedDropRunner = {
        param($targetDb)
        $calls.DropCount++
        return @{ ExitCode = 0 }
    }

    $injectedCheckRunner = {
        param($targetDb)
        $calls.CheckCount++
        return @{ ExitCode = 0; ExistsCount = "0" }
    }

    $simulatedExitCode = Invoke-DisposableDatabaseCleanup `
        -DatabaseName $testSimulatedDb `
        -CreatedByHarness $true `
        -OperationalDbName $operationalDbName `
        -CurrentExitCode 0 `
        -TerminateRunner $injectedTerminateRunner `
        -DropRunner $injectedDropRunner `
        -CheckRunner $injectedCheckRunner

    # 1. Terminate runner chamado exatamente 1 vez
    if ($calls.TerminateCount -ne 1) {
        Write-Host "[PROVA_FAIL] Terminate runner esperado chamado exatamente 1 vez, mas foi chamado $($calls.TerminateCount) vez(es)." -ForegroundColor Red
        exit 2
    }

    # 2. Mesmo após falha de terminate, drop runner é chamado exatamente 1 vez
    if ($calls.DropCount -ne 1) {
        Write-Host "[PROVA_FAIL] Drop runner esperado chamado exatamente 1 vez mesmo após falha de terminate, mas foi chamado $($calls.DropCount) vez(es)." -ForegroundColor Red
        exit 2
    }

    # 3. Pós-condição check runner chamada exatamente 1 vez quando drop tem sucesso
    if ($calls.CheckCount -ne 1) {
        Write-Host "[PROVA_FAIL] Check runner da pós-condição esperado chamado exatamente 1 vez, mas foi chamado $($calls.CheckCount) vez(es)." -ForegroundColor Red
        exit 2
    }

    # 4. Falha do terminate continua preservada no resultado final (exit code não-zero = 1)
    if ($simulatedExitCode -ne 1) {
        Write-Host "[PROVA_FAIL] Exit code retornado ($simulatedExitCode) divergiu do esperado 1 (falha de terminate não foi preservada)." -ForegroundColor Red
        exit 2
    }

    Write-Host "[PROVA_OK] Fluxo unificado de cleanup comprovado: terminate invocado (1x com exit 1), drop invocado (1x com exit 0), pós-condição confirmada e erro preservado ($simulatedExitCode)." -ForegroundColor Green
    exit 1
}

# 3. Geração do nome do Database Descartável
$randomSuffix = [System.IO.Path]::GetRandomFileName().Substring(0, 6).ToLowerInvariant()
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$disposableDbName = "nex_chk_${timestamp}_${randomSuffix}"

if (-not $disposableDbName.StartsWith("nex_chk_") -or $disposableDbName -eq $operationalDbName) {
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
    Write-Host "`n[1/6] Criando banco de dados descartável: $disposableDbName..." -ForegroundColor Yellow
    & createdb -h $operationalHost -p $operationalPort -U $operationalUser $disposableDbName
    if ($LASTEXITCODE -ne 0) { throw "Falha ao criar banco de dados descartável: $disposableDbName" }
    $createdDisposableDb = $true

    # Verificação de segurança via query SQL direta
    $currentDb = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT current_database();").Trim()
    if ($currentDb -ne $disposableDbName -or -not $currentDb.StartsWith("nex_chk_")) {
        throw "Verificação de segurança falhou: banco conectado '$currentDb' diverge do esperado '$disposableDbName'."
    }
    Write-Host "Banco descartável conectado e verificado: $currentDb" -ForegroundColor Green

    # Configuração de ambiente filho isolado
    $env:DATABASE_URL = $disposableDbUrl
    $env:PAYLOAD_SECRET = $payloadSecret
    $env:NEX_REQUIRE_EXECUTION_LEDGER_DB = "1"

    # 5. Executar Migrations UP no banco descartável
    Write-Host "`n[2/6] Executando migrations (UP) até 0.86C-4A no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) { throw "Falha ao executar payload migrate inicial no banco descartável" }

    # Colocar exclusivamente a migration 4A em batch superior ao maior batch anterior
    $updateBatchSql = "UPDATE payload_migrations SET batch = (SELECT coalesce(max(batch), 1) + 1 FROM payload_migrations WHERE name <> '20260929_230000_canonical_job_checkpoints') WHERE name = '20260929_230000_canonical_job_checkpoints';"
    & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c $updateBatchSql
    if ($LASTEXITCODE -ne 0) { throw "Falha ao ajustar batch da migration 4A no banco descartável" }

    # Verificar que exatamente uma migration está no batch superior (a 4A)
    $topBatchCount = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT count(*) FROM payload_migrations WHERE batch = (SELECT max(batch) FROM payload_migrations);").Trim()
    if ($LASTEXITCODE -ne 0 -or $topBatchCount -ne "1") {
        throw "Verificação de batch falhou: esperado exatamente 1 migration no batch de topo, obtido: $topBatchCount"
    }

    # Verificar a tabela nex_job_checkpoints criada pós-UP
    $tableChkRaw = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'nex_job_checkpoints';").Trim()
    if ($tableChkRaw -ne "1") {
        throw "Verificação pós-UP falhou: tabela 'nex_job_checkpoints' ausente no banco descartável."
    }
    Write-Host "Tabela 'nex_job_checkpoints' verificada com sucesso pós-UP." -ForegroundColor Green

    # 6. Executar Testes de Integração PostgreSQL do 0.86C-4A
    Write-Host "`n[3/6] Executando testes funcionais e relacionais contra o banco descartável..." -ForegroundColor Yellow
    & npx tsx --test src/core/jobs/continuation/__tests__/job-checkpoints.integration.test.ts
    if ($LASTEXITCODE -ne 0) { throw "Falha nos testes de integração PostgreSQL do 0.86C-4A" }
    Write-Host "Testes de integração PostgreSQL concluídos com 100% de sucesso!" -ForegroundColor Green

    # 7. Testar Migration DOWN (Rollback exclusivo do 0.86C-4A)
    Write-Host "`n[4/6] Testando rollback de migration (DOWN do 0.86C-4A) no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate:down
    if ($LASTEXITCODE -ne 0) { throw "Falha ao executar payload migrate:down para 0.86C-4A no banco descartável" }

    # Provar que a migration 4A foi removida do histórico de migrations
    $migration4ACount = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT count(*) FROM payload_migrations WHERE name = '20260929_230000_canonical_job_checkpoints';").Trim()
    if ($LASTEXITCODE -ne 0 -or $migration4ACount -ne "0") {
        throw "Verificação pós-DOWN falhou: migration 4A ainda consta em payload_migrations."
    }

    # Verificar que nex_job_checkpoints foi removida pós-DOWN
    $tableChkDown = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'nex_job_checkpoints';").Trim()
    if ($tableChkDown -ne "0") {
        throw "Verificação pós-DOWN falhou: tabela 'nex_job_checkpoints' ainda existe após rollback."
    }

    # Tabelas anteriores devem permanecer intactas
    $requiredPriorTables = @("nex_job_heads", "nex_job_events", "nex_execution_attempt_heads", "nex_execution_outcome_assessments")
    foreach ($tbl in $requiredPriorTables) {
        $exists = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '$tbl';").Trim()
        if ($exists -ne "1") {
            throw "Verificação pós-DOWN falhou: tabela '$tbl' foi indevidamente removida."
        }
    }
    Write-Host "Estrutura pós-DOWN verificada: nex_job_checkpoints removida, tabelas anteriores preservadas intactas." -ForegroundColor Green

    # 8. Executar Migration UP novamente (Convergência bidirecional)
    Write-Host "`n[5/6] Re-executando migrations (UP do 0.86C-4A) no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) { throw "Falha ao re-executar payload migrate no banco descartável" }

    $tableChkReUp = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'nex_job_checkpoints';").Trim()
    if ($tableChkReUp -ne "1") {
        throw "Verificação pós-re-UP falhou: tabela 'nex_job_checkpoints' ausente após re-convergência."
    }
    Write-Host "Schema reconvergido com sucesso após rollback e re-UP." -ForegroundColor Green

    # 9. Re-execução dos testes no schema restaurado
    Write-Host "`n[6/6] Executando novamente os testes funcionais no schema reconvergido..." -ForegroundColor Yellow
    & npx tsx --test src/core/jobs/continuation/__tests__/job-checkpoints.integration.test.ts
    if ($LASTEXITCODE -ne 0) { throw "Falha nos testes de integração após reconvergência" }
    Write-Host "Todos os testes de integração passaram com 100% de sucesso no schema restaurado!" -ForegroundColor Green
}
catch {
    Write-Host "`n[ERRO NO HARNESS] $_" -ForegroundColor Red
    $exitCode = 1
}
finally {
    if ($createdDisposableDb -and $disposableDbName -and $disposableDbName.StartsWith("nex_chk_") -and $disposableDbName -ne $operationalDbName) {
        $env:DATABASE_URL = $dbUrl
    }

    $exitCode = Invoke-DisposableDatabaseCleanup `
        -DatabaseName $disposableDbName `
        -CreatedByHarness $createdDisposableDb `
        -OperationalDbName $operationalDbName `
        -CurrentExitCode $exitCode

    $env:DATABASE_URL = $dbUrl
    $env:PAYLOAD_SECRET = $payloadSecret
    $env:PGPASSWORD = $operationalPass
    Remove-Item env:NEX_REQUIRE_EXECUTION_LEDGER_DB -ErrorAction SilentlyContinue
}

exit $exitCode
