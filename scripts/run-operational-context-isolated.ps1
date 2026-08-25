<#
.SYNOPSIS
    Harness canônico de validação isolada para persistência do Estado Operacional de Sessão (Escopo 0.86B-2).
.DESCRIPTION
    Cria um DATABASE PostgreSQL descartável dedicado (prefixo nex_ctx_),
    executa o ciclo completo de validação estrutural de migrations (UP -> DOWN -> UP),
    executa os testes de integração PostgreSQL de concorrência, isolamento multi-sessão e concorrência otimista,
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
Write-Host " NEX+ · HARNESS DE CONTEXTO OPERACIONAL ISOLADO (0.86B-2)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Host: $operationalHost | Porta: $operationalPort | Banco Operacional: $operationalDbName (PROTEGIDO)"

# 3. Geração do nome do Database Descartável
$randomSuffix = [System.IO.Path]::GetRandomFileName().Substring(0, 6).ToLowerInvariant()
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$disposableDbName = "nex_ctx_${timestamp}_${randomSuffix}"

# Trava estrita de segurança
if (-not $disposableDbName.StartsWith("nex_ctx_") -or $disposableDbName -eq $operationalDbName) {
    Write-Host "[SECURITY_FAIL] Nome do banco descartável inválido: $disposableDbName" -ForegroundColor Red
    exit 1
}

$env:PGPASSWORD = $operationalPass
$escapedPass = [System.Uri]::EscapeDataString($operationalPass)
$disposableDbUrl = "postgresql://${operationalUser}:${escapedPass}@${operationalHost}:${operationalPort}/${disposableDbName}"

$exitCode = 0

try {
    # 4. Criação do Database Descartável
    Write-Host "`n[1/6] Criando banco de dados descartável: $disposableDbName..." -ForegroundColor Yellow
    & createdb -h $operationalHost -p $operationalPort -U $operationalUser $disposableDbName
    if ($LASTEXITCODE -ne 0) { throw "Falha ao criar banco de dados descartável: $disposableDbName" }

    # Verificação de segurança via query SQL direta
    $currentDb = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT current_database();").Trim()
    if ($currentDb -ne $disposableDbName -or -not $currentDb.StartsWith("nex_ctx_")) {
        throw "Verificação de segurança falhou: banco conectado '$currentDb' diverge do esperado '$disposableDbName'."
    }
    Write-Host "Banco descartável conectado e verificado: $currentDb" -ForegroundColor Green

    # Configuração de ambiente filho isolado
    $env:DATABASE_URL = $disposableDbUrl
    $env:PAYLOAD_SECRET = $payloadSecret

    # 5. Executar Migrations UP no banco descartável
    Write-Host "`n[2/6] Executando migrations (UP) até 0.86B-2 no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) { throw "Falha ao executar payload migrate inicial no banco descartável" }

    # Ajustar ledger para manter batches ordenados 1..8
    & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "UPDATE payload_migrations SET batch = 2 WHERE name = '20260820_030631_multiuser_auth';" | Out-Null
    & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "UPDATE payload_migrations SET batch = 3 WHERE name = '20260821_210000_observation_persistence';" | Out-Null
    & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "UPDATE payload_migrations SET batch = 4 WHERE name = '20260821_220000_evidence_artifact_store';" | Out-Null
    & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "UPDATE payload_migrations SET batch = 5 WHERE name = '20260821_230000_reconciliation_and_precedents';" | Out-Null
    & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "UPDATE payload_migrations SET batch = 6 WHERE name = '20260824_190000_session_operational_state';" | Out-Null
    & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "UPDATE payload_migrations SET batch = 7 WHERE name = '20260824_210000_input_record_and_ingress';" | Out-Null
    & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "UPDATE payload_migrations SET batch = 8 WHERE name = '20260825_030000_material_context_pin';" | Out-Null

    # Verificar tabela nex_session_operational_state criada pós-UP
    $tablesUpRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    $tablesUp = if ($tablesUpRaw) { @($tablesUpRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }

    $requiredTable086B2 = "nex_session_operational_state"
    if ($tablesUp -notcontains $requiredTable086B2) {
        throw "Verificação pós-UP falhou: tabela 0.86B-2 obrigatória '$requiredTable086B2' ausente no banco descartável."
    }
    Write-Host "Tabela '$requiredTable086B2' verificada com sucesso pós-UP." -ForegroundColor Green

    # 6. Executar Testes de Integração PostgreSQL do 0.86B-2
    Write-Host "`n[3/6] Executando testes funcionais e de concorrência contra o banco descartável..." -ForegroundColor Yellow
    & npx tsx --test src/core/context/persistence/__tests__/postgres.integration.test.ts
    if ($LASTEXITCODE -ne 0) { throw "Falha nos testes de integração PostgreSQL do 0.86B-2" }
    Write-Host "Testes de integração PostgreSQL concluídos com 100% de sucesso!" -ForegroundColor Green

    # 7. Testar Migration DOWN (Rollback ordenado de 0.86B-4, 0.86B-3 e 0.86B-2)
    Write-Host "`n[4/6] Testando rollback de migration (DOWN ordenado de 0.86B-4, 0.86B-3 e 0.86B-2) no banco descartável..." -ForegroundColor Yellow
    Write-Host "Executando DOWN 1/3 (0.86B-4: material_context_pin)..."
    & npx payload migrate:down
    if ($LASTEXITCODE -ne 0) { throw "Falha no DOWN 1/3 (0.86B-4: material_context_pin) no banco descartável" }

    Write-Host "Executando DOWN 2/3 (0.86B-3: input_record_and_ingress)..."
    & npx payload migrate:down
    if ($LASTEXITCODE -ne 0) { throw "Falha no DOWN 2/3 (0.86B-3: input_record_and_ingress) no banco descartável" }

    Write-Host "Executando DOWN 3/3 (0.86B-2: session_operational_state)..."
    & npx payload migrate:down
    if ($LASTEXITCODE -ne 0) { throw "Falha no DOWN 3/3 (0.86B-2: session_operational_state) no banco descartável" }

    # Verificar estrutura pós-DOWN
    $tablesDownRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    $tablesDown = if ($tablesDownRaw) { @($tablesDownRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }

    if ($tablesDown -contains $requiredTable086B2) {
        throw "Verificação pós-DOWN falhou: tabela '$requiredTable086B2' ainda existe após rollback."
    }

    # Tabelas anteriores devem permanecer intactas
    $requiredTablesPreserved = @(
        "users",
        "admins",
        "nex_observation_records",
        "nex_review_events",
        "nex_canonical_projection_revisions",
        "nex_reconciliation_case_revisions"
    )
    foreach ($tbl in $requiredTablesPreserved) {
        if ($tablesDown -notcontains $tbl) {
            throw "Verificação pós-DOWN falhou: tabela '$tbl' foi indevidamente alterada no rollback."
        }
    }
    Write-Host "Estrutura pós-DOWN verificada: tabela '$requiredTable086B2' removida, tabelas anteriores preservadas intactas." -ForegroundColor Green

    # 8. Executar Migration UP novamente (Convergência bidirecional)
    Write-Host "`n[5/6] Re-executando migrations (UP do 0.86B-2) no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) { throw "Falha ao re-executar payload migrate no banco descartável" }

    $tablesReUpRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    $tablesReUp = if ($tablesReUpRaw) { @($tablesReUpRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }

    if ($tablesReUp -notcontains $requiredTable086B2) {
        throw "Verificação pós-re-UP falhou: tabela '$requiredTable086B2' ausente após re-convergência."
    }
    Write-Host "Schema reconvergido com sucesso após rollback e re-UP." -ForegroundColor Green

    # 9. Re-execução dos testes no schema restaurado
    Write-Host "`n[6/6] Executando novamente os testes funcionais no schema reconvergido..." -ForegroundColor Yellow
    & npx tsx --test src/core/context/persistence/__tests__/postgres.integration.test.ts
    if ($LASTEXITCODE -ne 0) { throw "Falha nos testes de integração após reconvergência" }
    Write-Host "Todos os testes de integração passaram com 100% de sucesso no schema restaurado!" -ForegroundColor Green
}
catch {
    Write-Host "`n[ERRO NO HARNESS] $_" -ForegroundColor Red
    $exitCode = 1
}
finally {
    # 10. Destruição segura e garantida do Database Descartável
    Write-Host "`nLimpeza: destruindo banco de dados descartável..." -ForegroundColor Yellow
    $env:DATABASE_URL = ""
    $env:PAYLOAD_SECRET = ""

    if ($disposableDbName -and $disposableDbName.StartsWith("nex_ctx_") -and $disposableDbName -ne $operationalDbName) {
        try {
            & psql -h $operationalHost -p $operationalPort -U $operationalUser -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$disposableDbName' AND pid <> pg_backend_pid();" | Out-Null
        } catch {}

        & dropdb -h $operationalHost -p $operationalPort -U $operationalUser $disposableDbName
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[FAIL] Falha ao destruir banco de dados descartável '$disposableDbName' (exit code: $LASTEXITCODE)." -ForegroundColor Red
            $exitCode = 1
        } else {
            Write-Host "Banco descartável '$disposableDbName' removido com sucesso." -ForegroundColor Green
        }
    } else {
        Write-Host "[SECURITY_WARN] Nome do banco não passou na validação de drop: $disposableDbName" -ForegroundColor Red
        $exitCode = 1
    }
}

exit $exitCode
