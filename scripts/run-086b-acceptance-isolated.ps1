<#
.SYNOPSIS
    Harness canônico de validação isolada para Acceptance Transversal 0.86B-5.
.DESCRIPTION
    Cria um DATABASE PostgreSQL descartável dedicado (prefixo nex_086b_acc_),
    executa o ciclo completo de validação estrutural de migrations (UP -> DOWN -> UP),
    executa os testes de integração PostgreSQL transversais (0.86B-5 Acceptance Gate),
    e destrói o banco descartável ao final sem afetar o banco de dados operacional.
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
Write-Host " NEX+ · HARNESS DE ACCEPTANCE TRANSVERSAL 0.86B-5 (ISOLADO)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Host: $operationalHost | Porta: $operationalPort | Banco Operacional: $operationalDbName (PROTEGIDO)"

# 3. Geração do nome do Database Descartável
$randomSuffix = [System.IO.Path]::GetRandomFileName().Substring(0, 6).ToLowerInvariant()
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$disposableDbName = "nex_086b_acc_${timestamp}_${randomSuffix}"

# Trava estrita de segurança
if (-not $disposableDbName.StartsWith("nex_086b_acc_") -or $disposableDbName -eq $operationalDbName) {
    Write-Host "[SECURITY_FAIL] Nome do banco descartável inválido: $disposableDbName" -ForegroundColor Red
    exit 1
}

$env:PGPASSWORD = $operationalPass
$escapedPass = [System.Uri]::EscapeDataString($operationalPass)
$disposableDbUrl = "postgresql://${operationalUser}:${escapedPass}@${operationalHost}:${operationalPort}/${disposableDbName}"

$exitCode = 0
$databaseCreated = $false

try {
    # 4. Criação do Database Descartável
    Write-Host "`n[1/6] Criando banco de dados descartável: $disposableDbName..." -ForegroundColor Yellow
    & createdb -h $operationalHost -p $operationalPort -U $operationalUser $disposableDbName
    if ($LASTEXITCODE -ne 0) { throw "Falha ao criar banco de dados descartável: $disposableDbName" }
    $databaseCreated = $true

    # Verificação de segurança via query SQL direta
    $currentDb = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT current_database();").Trim()
    if ($currentDb -ne $disposableDbName -or -not $currentDb.StartsWith("nex_086b_acc_")) {
        throw "Verificação de segurança falhou: banco conectado '$currentDb' diverge do esperado '$disposableDbName'."
    }
    Write-Host "Banco descartável conectado e verificado: $currentDb" -ForegroundColor Green

    # Configuração de ambiente filho isolado
    $env:DATABASE_URL = $disposableDbUrl
    $env:PAYLOAD_SECRET = $payloadSecret

    # 5. Executar Migrations UP no banco descartável
    Write-Host "`n[2/6] Executando migrations (UP 1..8) no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) { throw "Falha ao executar payload migrate inicial no banco descartável" }

    # Inspeção read-only do ledger real registrado pelo Payload (sem qualquer mutação)
    Write-Host "`n[LEDGER_PROSPECT] Consultando ledger real em payload_migrations..." -ForegroundColor Cyan
    $ledgerInitialRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "SELECT id, name, batch, created_at FROM payload_migrations ORDER BY id;"
    Write-Host $ledgerInitialRaw -ForegroundColor Cyan

    $maxBatchRaw = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT COALESCE(MAX(batch), 0) FROM payload_migrations;").Trim()
    $migrationsCountRaw = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT COUNT(*) FROM payload_migrations;").Trim()
    Write-Host "Migrations aplicadas: $migrationsCountRaw | Batch(es) real(is) detectado(s): $maxBatchRaw | MAX(batch): $maxBatchRaw" -ForegroundColor Green

    # Verificar tabelas pós-UP
    $tablesUpRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    $tablesUp = if ($tablesUpRaw) { @($tablesUpRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }

    $requiredTables = @(
        "users",
        "admins",
        "nex_session_operational_state",
        "nex_ingress_contents",
        "nex_input_records",
        "nex_input_parts",
        "nex_material_context_pins",
        "nex_material_context_items"
    )
    foreach ($tbl in $requiredTables) {
        if ($tablesUp -notcontains $tbl) {
            throw "Verificação pós-UP falhou: tabela obrigatória '$tbl' ausente no banco descartável."
        }
    }
    Write-Host "Tabelas verificadas com sucesso pós-UP: $($requiredTables -join ', ')." -ForegroundColor Green

    # 6. Executar Testes de Integração PostgreSQL do 0.86B-5
    Write-Host "`n[3/6] Executando testes transversais de integração PostgreSQL (0.86B-5)..." -ForegroundColor Yellow
    & npx tsx --test src/core/__tests__/086b-postgres.acceptance.test.ts
    if ($LASTEXITCODE -ne 0) { throw "Falha nos testes de integração PostgreSQL do 0.86B-5" }
    Write-Host "Testes de integração PostgreSQL concluídos com 100% de sucesso!" -ForegroundColor Green

    # 7. Testar Migration DOWN (Rollback real do último batch registrado pelo Payload)
    Write-Host "`n[4/6] Executando rollback do último batch real do Payload (migrate:down)..." -ForegroundColor Yellow
    & npx payload migrate:down
    if ($LASTEXITCODE -ne 0) { throw "Falha ao executar payload migrate:down no banco descartável" }

    # Inspeção pós-DOWN (read-only)
    $ledgerTableExists = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'payload_migrations');").Trim()
    if ($ledgerTableExists -eq "t") {
        $ledgerPostDown = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "SELECT id, name, batch FROM payload_migrations ORDER BY id;"
        Write-Host "Ledger pós-DOWN:`n$ledgerPostDown" -ForegroundColor Cyan
    } else {
        Write-Host "Ledger pós-DOWN: tabela payload_migrations revertida pelo rollback do batch inicial." -ForegroundColor Cyan
    }
    Write-Host "Rollback do último batch real concluído com sucesso." -ForegroundColor Green

    # 8. Executar Migration UP novamente (Convergência bidirecional real)
    Write-Host "`n[5/6] Re-executando migrations (UP) no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) { throw "Falha ao re-executar payload migrate no banco descartável" }

    $ledgerReUp = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "SELECT id, name, batch FROM payload_migrations ORDER BY id;"
    Write-Host "Ledger pós-re-UP:`n$ledgerReUp" -ForegroundColor Cyan

    $tablesReUpRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    $tablesReUp = if ($tablesReUpRaw) { @($tablesReUpRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }

    foreach ($tbl in $requiredTables) {
        if ($tablesReUp -notcontains $tbl) {
            throw "Verificação pós-re-UP falhou: tabela '$tbl' ausente após re-convergência."
        }
    }
    Write-Host "Schema reconvergido com sucesso após rollback e re-UP." -ForegroundColor Green

    # 9. Re-execução dos testes no schema restaurado
    Write-Host "`n[6/6] Executando novamente os testes funcionais no schema reconvergido..." -ForegroundColor Yellow
    & npx tsx --test src/core/__tests__/086b-postgres.acceptance.test.ts
    if ($LASTEXITCODE -ne 0) { throw "Falha nos testes de integração após reconvergência" }
    Write-Host "Todos os testes de integração passaram com 100% de sucesso no schema restaurado!" -ForegroundColor Green
}
catch {
    Write-Host "`n[ERRO NO HARNESS] $_" -ForegroundColor Red
    $exitCode = 1
}
finally {
    # 10. Destruição segura e garantida do Database Descartável
    Write-Host "`n[CLEANUP] Encerrando conexões residuais e destruindo banco descartável..." -ForegroundColor Yellow
    $cleanupFailed = $false

    if ($databaseCreated -and $disposableDbName -and $disposableDbName.StartsWith("nex_086b_acc_") -and $disposableDbName -ne $operationalDbName -and ($disposableDbName -match '^[a-zA-Z0-9_]+$')) {
        $env:DATABASE_URL = $dbUrl
        & psql -h $operationalHost -p $operationalPort -U $operationalUser -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$disposableDbName' AND pid <> pg_backend_pid();" | Out-Null
        & dropdb -h $operationalHost -p $operationalPort -U $operationalUser $disposableDbName
        $dropExitCode = $LASTEXITCODE

        if ($dropExitCode -ne 0) {
            Write-Host "[CLEANUP_FAIL] dropdb retornou exit code $dropExitCode ao tentar destruir '$disposableDbName'." -ForegroundColor Red
            $cleanupFailed = $true
        }

        # Pós-condição: confirmar ausência do banco via query direta em pg_database
        $dbExistsRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d postgres -t -A -c "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$disposableDbName');"
        $psqlCheckExitCode = $LASTEXITCODE

        if ($psqlCheckExitCode -ne 0) {
            Write-Host "[CLEANUP_FAIL] Falha ao verificar pós-condição do banco no PostgreSQL (psql exit code $psqlCheckExitCode)." -ForegroundColor Red
            $cleanupFailed = $true
        } else {
            $dbExists = if ($dbExistsRaw) { $dbExistsRaw.Trim() } else { "" }
            if ($dbExists -eq "f" -or $dbExists -eq "false") {
                if ($dropExitCode -eq 0) {
                    Write-Host "[CLEANUP] Banco descartável '$disposableDbName' destruído com sucesso." -ForegroundColor Green
                }
            } else {
                Write-Host "[CLEANUP_FAIL] Pós-condição falhou: banco descartável '$disposableDbName' ainda existe no PostgreSQL." -ForegroundColor Red
                $cleanupFailed = $true
            }
        }
    } elseif ($databaseCreated) {
        Write-Host "[SECURITY_FAIL] Nome do banco não passou na validação de drop: $disposableDbName" -ForegroundColor Red
        $cleanupFailed = $true
    }

    # Restauração estrita das variáveis de ambiente originais
    $env:DATABASE_URL = $dbUrl
    $env:PAYLOAD_SECRET = $payloadSecret
    $env:PGPASSWORD = $operationalPass

    if ($cleanupFailed) {
        $exitCode = 1
    }
}

exit $exitCode
