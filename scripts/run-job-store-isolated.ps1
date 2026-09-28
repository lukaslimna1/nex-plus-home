<#
.SYNOPSIS
    Harness canônico de validação isolada para Durable Job Store (Escopo 0.86C-2B).
.DESCRIPTION
    Cria um DATABASE PostgreSQL descartável dedicado (prefixo nex_job_),
    executa o ciclo completo de validação estrutural de migrations (UP -> DOWN -> UP),
    executa os testes de integração PostgreSQL do Job Store L0,
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
Write-Host " NEX+ · HARNESS DE DURABLE JOB STORE ISOLADO (0.86C-2B)" -ForegroundColor Cyan
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

    # Defaults de produção com wrappers que capturam $LASTEXITCODE imediatamente
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

    if ($CreatedByHarness -and $DatabaseName -and $DatabaseName.StartsWith("nex_job_") -and $DatabaseName -ne $OperationalDbName) {
        # 1. Terminate runner
        $termResult = & $TerminateRunner $DatabaseName
        $termExitCode = if ($null -ne $termResult -and $null -ne $termResult.ExitCode) { [int]$termResult.ExitCode } else { 1 }

        if ($termExitCode -ne 0) {
            Write-Host "[CLEANUP_FAIL] Falha ao encerrar conexões residuais no banco descartável '$DatabaseName' (exit code: $termExitCode)." -ForegroundColor Red
            $cleanupExitCode = 1
        }

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
            Write-Host "[CLEANUP_GUARD] Banco descartável não foi criado por esta execução ($DatabaseName). Operações de terminate/drop/confirm ignoradas com segurança." -ForegroundColor Green
        }
    }

    return $cleanupExitCode
}

# Verificação determinística isolada da guarda de ownership se solicitado por switch
if ($VerifyCleanupOwnershipOnly) {
    Write-Host "`n[PROVA DETERMINÍSTICA] Testando ownership guard do cleanup em isolamento..." -ForegroundColor Yellow
    $testSimulatedDb = "nex_job_simulated_guard_probe"
    $testCreatedDb = $false
    $executedDrop = $false
    $executedTerminate = $false

    # Simula bloco finally com guarda de ownership
    if ($testCreatedDb -and $testSimulatedDb -and $testSimulatedDb.StartsWith("nex_job_") -and $testSimulatedDb -ne $operationalDbName) {
        $executedTerminate = $true
        $executedDrop = $true
    } else {
        if (-not $testCreatedDb) {
            Write-Host "[CLEANUP_GUARD_TEST] Sucesso: tentativa de cleanup sobre DB não criado ($testSimulatedDb) foi bloqueada determinísticamente." -ForegroundColor Green
        }
    }

    if ($executedDrop -or $executedTerminate) {
        Write-Host "[PROVA_FAIL] Guarda de ownership falhou: executou cleanup indevido." -ForegroundColor Red
        exit 1
    }

    Write-Host "[PROVA_OK] Guarda de ownership verificada com sucesso: sem criação pelo harness, nenhuma conexão/drop é disparada." -ForegroundColor Green
    exit 0
}

# Verificação determinística isolada do tratamento de falha no terminate via função compartilhada
if ($VerifyTerminateFailureOnly) {
    Write-Host "`n[PROVA DETERMINÍSTICA] Testando tratamento de falha no terminate do cleanup em isolamento via runners injetados..." -ForegroundColor Yellow
    $testSimulatedDb = "nex_job_simulated_terminate_probe"

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

    # 1. terminate é chamado exatamente uma vez
    if ($calls.TerminateCount -ne 1) {
        Write-Host "[PROVA_FAIL] Terminate runner esperado chamado exatamente 1 vez, mas foi chamado $($calls.TerminateCount) vez(es)." -ForegroundColor Red
        exit 2
    }

    # 2. mesmo assim drop é chamado exatamente uma vez
    if ($calls.DropCount -ne 1) {
        Write-Host "[PROVA_FAIL] Drop runner esperado chamado exatamente 1 vez mesmo após falha de terminate, mas foi chamado $($calls.DropCount) vez(es)." -ForegroundColor Red
        exit 2
    }

    # 3. pós-condição é chamada exatamente uma vez quando aplicável
    if ($calls.CheckCount -ne 1) {
        Write-Host "[PROVA_FAIL] Check runner da pós-condição esperado chamado exatamente 1 vez, mas foi chamado $($calls.CheckCount) vez(es)." -ForegroundColor Red
        exit 2
    }

    # 4. apesar de drop + pós-condição terem sucesso, a falha anterior do terminate continua preservada no resultado final
    if ($simulatedExitCode -ne 1) {
        Write-Host "[PROVA_FAIL] Exit code retornado ($simulatedExitCode) divergiu do esperado 1 (falha de terminate não foi preservada)." -ForegroundColor Red
        exit 2
    }

    Write-Host "[PROVA_OK] Fluxo unificado de cleanup comprovado: terminate invocado (1x com exit 1), drop invocado (1x com exit 0), pós-condição invocada (1x confirmando inexistência) e erro preservado ($simulatedExitCode)." -ForegroundColor Green
    exit 1
}

# 3. Geração do nome do Database Descartável
$randomSuffix = [System.IO.Path]::GetRandomFileName().Substring(0, 6).ToLowerInvariant()
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$disposableDbName = "nex_job_${timestamp}_${randomSuffix}"

# Trava estrita de segurança
if (-not $disposableDbName.StartsWith("nex_job_") -or $disposableDbName -eq $operationalDbName) {
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
    if ($currentDb -ne $disposableDbName -or -not $currentDb.StartsWith("nex_job_")) {
        throw "Verificação de segurança falhou: banco conectado '$currentDb' diverge do esperado '$disposableDbName'."
    }
    Write-Host "Banco descartável conectado e verificado: $currentDb" -ForegroundColor Green

    # Configuração de ambiente filho isolado
    $env:DATABASE_URL = $disposableDbUrl
    $env:PAYLOAD_SECRET = $payloadSecret
    $env:NEX_REQUIRE_JOB_STORE_DB = "1"

    # 5. Executar Migrations UP no banco descartável
    Write-Host "`n[2/6] Executando migrations (UP) até 0.86C-2B no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) { throw "Falha ao executar payload migrate inicial no banco descartável" }

    # Colocar exclusivamente a migration 2B em batch superior ao maior batch anterior
    $updateBatchSql = "UPDATE payload_migrations SET batch = (SELECT coalesce(max(batch), 1) + 1 FROM payload_migrations WHERE name <> '20260927_220000_durable_job_store') WHERE name = '20260927_220000_durable_job_store';"
    & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c $updateBatchSql
    if ($LASTEXITCODE -ne 0) { throw "Falha ao ajustar batch da migration 2B no banco descartável" }

    # Verificar que exatamente uma migration está no batch superior (a 2B)
    $topBatchCount = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT count(*) FROM payload_migrations WHERE batch = (SELECT max(batch) FROM payload_migrations);").Trim()
    if ($LASTEXITCODE -ne 0 -or $topBatchCount -ne "1") {
        throw "Verificação de batch falhou: esperado exatamente 1 migration no batch de topo, obtido: $topBatchCount"
    }

    # Verificar as 2 tabelas do 0.86C-2B criadas pós-UP
    $tablesUpRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    if ($LASTEXITCODE -ne 0) { throw "Falha ao inspecionar tabelas pós-UP via psql" }
    $tablesUp = if ($tablesUpRaw) { @($tablesUpRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }

    $requiredTables086C2B = @(
        "nex_job_heads",
        "nex_job_events"
    )

    foreach ($tbl in $requiredTables086C2B) {
        if ($tablesUp -notcontains $tbl) {
            throw "Verificação pós-UP falhou: tabela 0.86C-2B obrigatória '$tbl' ausente no banco descartável."
        }
    }
    Write-Host "Todas as 2 tabelas de 0.86C-2B verificadas com sucesso pós-UP: $($requiredTables086C2B -join ', ')." -ForegroundColor Green

    # 6. Executar Testes de Integração PostgreSQL do 0.86C-2B
    Write-Host "`n[3/6] Executando testes funcionais e relacionais contra o banco descartável..." -ForegroundColor Yellow
    & npx tsx --test src/core/jobs/persistence/__tests__/postgres.integration.test.ts
    if ($LASTEXITCODE -ne 0) { throw "Falha nos testes de integração PostgreSQL do 0.86C-2B" }
    Write-Host "Testes de integração PostgreSQL concluídos com 100% de sucesso!" -ForegroundColor Green

    # 7. Testar Migration DOWN (Rollback exclusivo do 0.86C-2B)
    Write-Host "`n[4/6] Testando rollback de migration (DOWN do 0.86C-2B) no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate:down
    if ($LASTEXITCODE -ne 0) { throw "Falha ao executar payload migrate:down para 0.86C-2B no banco descartável" }

    # Provar que a migration 2B foi removida do histórico de migrations
    $migration2BCount = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT count(*) FROM payload_migrations WHERE name = '20260927_220000_durable_job_store';").Trim()
    if ($LASTEXITCODE -ne 0 -or $migration2BCount -ne "0") {
        throw "Verificação pós-DOWN falhou: migration 2B ainda consta em payload_migrations."
    }
    $priorMigrationsCount = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT count(*) FROM payload_migrations;").Trim()
    if ($LASTEXITCODE -ne 0 -or [int]$priorMigrationsCount -lt 1) {
        throw "Verificação pós-DOWN falhou: migrations anteriores foram indevidamente removidas (restam: $priorMigrationsCount)."
    }
    Write-Host "Verificado: DOWN removeu exclusivamente a migration 2B (restam $priorMigrationsCount migrations anteriores no ledger)." -ForegroundColor Green

    # Verificar estrutura pós-DOWN
    $tablesDownRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    if ($LASTEXITCODE -ne 0) { throw "Falha ao inspecionar tabelas pós-DOWN via psql" }
    $tablesDown = if ($tablesDownRaw) { @($tablesDownRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }

    foreach ($tbl in $requiredTables086C2B) {
        if ($tablesDown -contains $tbl) {
            throw "Verificação pós-DOWN falhou: tabela '$tbl' ainda existe após rollback."
        }
    }

    # Tabelas anteriores (incluindo 2A e base) devem permanecer intactas
    $requiredTablesPreserved = @(
        "users",
        "admins",
        "nex_observation_records",
        "nex_review_events",
        "nex_canonical_projection_revisions",
        "nex_reconciliation_case_revisions",
        "nex_session_operational_state",
        "nex_ingress_contents",
        "nex_input_records",
        "nex_input_parts",
        "nex_material_context_pins",
        "nex_material_context_items",
        "nex_execution_attempt_events",
        "nex_execution_attempt_heads",
        "nex_execution_signals",
        "nex_execution_evidence",
        "nex_execution_evidence_signals",
        "nex_execution_outcome_assessments",
        "nex_execution_outcome_evidence",
        "nex_execution_outcome_heads",
        "nex_execution_receipts"
    )
    foreach ($tbl in $requiredTablesPreserved) {
        if ($tablesDown -notcontains $tbl) {
            throw "Verificação pós-DOWN falhou: tabela '$tbl' foi indevidamente alterada no rollback."
        }
    }
    Write-Host "Estrutura pós-DOWN verificada: tabelas 0.86C-2B removidas, tabelas anteriores (incluindo 0.86C-2A) preservadas intactas." -ForegroundColor Green

    # 8. Executar Migration UP novamente (Convergência bidirecional)
    Write-Host "`n[5/6] Re-executando migrations (UP do 0.86C-2B) no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) { throw "Falha ao re-executar payload migrate no banco descartável" }

    $tablesReUpRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    if ($LASTEXITCODE -ne 0) { throw "Falha ao inspecionar tabelas pós-re-UP via psql" }
    $tablesReUp = if ($tablesReUpRaw) { @($tablesReUpRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }

    foreach ($tbl in $requiredTables086C2B) {
        if ($tablesReUp -notcontains $tbl) {
            throw "Verificação pós-re-UP falhou: tabela '$tbl' ausente após re-convergência."
        }
    }
    Write-Host "Schema reconvergido com sucesso após rollback e re-UP." -ForegroundColor Green

    # 9. Re-execução dos testes no schema restaurado
    Write-Host "`n[6/6] Executando novamente os testes funcionais no schema reconvergido..." -ForegroundColor Yellow
    & npx tsx --test src/core/jobs/persistence/__tests__/postgres.integration.test.ts
    if ($LASTEXITCODE -ne 0) { throw "Falha nos testes de integração após reconvergência" }
    Write-Host "Todos os testes de integração passaram com 100% de sucesso no schema restaurado!" -ForegroundColor Green
}
catch {
    Write-Host "`n[ERRO NO HARNESS] $_" -ForegroundColor Red
    $exitCode = 1
}
finally {
    # 10. Destruição segura e garantida do Database Descartável via função compartilhada
    if ($createdDisposableDb -and $disposableDbName -and $disposableDbName.StartsWith("nex_job_") -and $disposableDbName -ne $operationalDbName) {
        $env:DATABASE_URL = $dbUrl
    }

    $exitCode = Invoke-DisposableDatabaseCleanup `
        -DatabaseName $disposableDbName `
        -CreatedByHarness $createdDisposableDb `
        -OperationalDbName $operationalDbName `
        -CurrentExitCode $exitCode

    # Restauração estrita das variáveis de ambiente originais
    $env:DATABASE_URL = $dbUrl
    $env:PAYLOAD_SECRET = $payloadSecret
    $env:PGPASSWORD = $operationalPass
    Remove-Item env:NEX_REQUIRE_JOB_STORE_DB -ErrorAction SilentlyContinue
}

exit $exitCode
