<#
.SYNOPSIS
    Harness canônico de validação isolada para Reconciliação Persistente, Precedente Contextual & Autoridade (Escopo 0.85D).
.DESCRIPTION
    Cria um DATABASE PostgreSQL descartável dedicado (prefixo nex_rec_),
    executa o ciclo completo de validação estrutural de migrations (UP -> DOWN -> UP),
    executa os testes de integração de reconciliação, gates de autoridade, e regressões 0.85B/0.85C,
    e destrói todos os recursos temporários ao final sem afetar o ambiente operacional.
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
Write-Host " NEX+ · HARNESS RECONCILIAÇÃO & AUTORIDADE (ESCOPO 0.85D)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Host: $operationalHost | Porta: $operationalPort | Banco Operacional: $operationalDbName (PROTEGIDO)"

# 3. Geração do nome do Database Descartável
$randomSuffix = [System.IO.Path]::GetRandomFileName().Substring(0, 6).ToLowerInvariant()
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$disposableDbName = "nex_rec_${timestamp}_${randomSuffix}"

# Trava estrita de segurança
if (-not $disposableDbName.StartsWith("nex_rec_") -or $disposableDbName -eq $operationalDbName) {
    Write-Host "[SECURITY_FAIL] Nome do banco descartável inválido: $disposableDbName" -ForegroundColor Red
    exit 1
}

$env:PGPASSWORD = $operationalPass
$escapedPass = [System.Uri]::EscapeDataString($operationalPass)
$disposableDbUrl = "postgresql://${operationalUser}:${escapedPass}@${operationalHost}:${operationalPort}/${disposableDbName}"

$exitCode = 0

try {
    # 4. Criação do Database Descartável
    Write-Host "`n[1/5] Criando banco de dados descartável: $disposableDbName..." -ForegroundColor Yellow
    & createdb -h $operationalHost -p $operationalPort -U $operationalUser $disposableDbName
    if ($LASTEXITCODE -ne 0) { throw "Falha ao criar banco de dados descartável: $disposableDbName" }

    $currentDb = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT current_database();").Trim()
    if ($currentDb -ne $disposableDbName -or -not $currentDb.StartsWith("nex_rec_")) {
        throw "Verificação de segurança falhou: banco conectado '$currentDb' diverge do esperado '$disposableDbName'."
    }
    Write-Host "Banco descartável conectado e verificado: $currentDb" -ForegroundColor Green

    # Configuração de ambiente filho isolado
    $env:DATABASE_URL = $disposableDbUrl
    $env:PAYLOAD_SECRET = $payloadSecret

    # 5. Executar Migrations UP no banco descartável
    Write-Host "`n[2/5] Executando migrations (UP) até 0.85D no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) { throw "Falha ao executar payload migrate inicial no banco descartável" }

    # Ajustar ledger de batches
    & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "UPDATE payload_migrations SET batch = 2 WHERE name = '20260820_030631_multiuser_auth';" | Out-Null
    & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "UPDATE payload_migrations SET batch = 3 WHERE name = '20260821_210000_observation_persistence';" | Out-Null
    & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "UPDATE payload_migrations SET batch = 4 WHERE name = '20260821_220000_evidence_artifact_store';" | Out-Null
    & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "UPDATE payload_migrations SET batch = 5 WHERE name = '20260821_230000_reconciliation_and_precedents';" | Out-Null

    # Verificar tabelas 0.85D criadas pós-UP
    $tablesUpRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    $tablesUp = if ($tablesUpRaw) { @($tablesUpRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }

    $requiredTables085D = @(
        "nex_reconciliation_case_revisions",
        "nex_reconciliation_case_heads",
        "nex_contextual_precedents"
    )

    foreach ($tbl in $requiredTables085D) {
        if ($tablesUp -notcontains $tbl) {
            throw "Verificação pós-UP falhou: tabela 0.85D obrigatória '$tbl' ausente no banco descartável."
        }
    }
    Write-Host "Todas as tabelas do 0.85D verificadas com sucesso pós-UP." -ForegroundColor Green

    # 6. Testar Migration DOWN (Rollback exclusivo do 0.85D)
    Write-Host "`n[3/5] Testando rollback de migration (DOWN do 0.85D) no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate:down
    if ($LASTEXITCODE -ne 0) { throw "Falha ao executar payload migrate:down para 0.85D no banco descartável" }

    # Verificar estrutura pós-DOWN
    $tablesDownRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    $tablesDown = if ($tablesDownRaw) { @($tablesDownRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }

    foreach ($tbl in $requiredTables085D) {
        if ($tablesDown -contains $tbl) {
            throw "Verificação pós-DOWN falhou: tabela '$tbl' ainda existe após rollback."
        }
    }

    # Tabelas do 0.85C e 0.85B devem permanecer intactas
    $requiredTablesPreserved = @(
        "nex_observation_records",
        "nex_review_events",
        "nex_canonical_projection_revisions",
        "nex_canonical_projection_heads",
        "nex_source_refs",
        "nex_evidence_artifacts",
        "nex_evidence_artifact_attempt_links"
    )
    foreach ($tbl in $requiredTablesPreserved) {
        if ($tablesDown -notcontains $tbl) {
            throw "Verificação pós-DOWN falhou: tabela '$tbl' foi indevidamente removida no rollback."
        }
    }
    Write-Host "Estrutura pós-DOWN verificada: tabelas 0.85D removidas, tabelas 0.85C/0.85B preservadas intactas." -ForegroundColor Green

    # 7. Executar Migration UP novamente (Convergência bidirecional)
    Write-Host "`n[4/5] Re-executando migrations (UP do 0.85D) no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) { throw "Falha ao re-executar payload migrate no banco descartável" }

    $tablesReUpRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    $tablesReUp = if ($tablesReUpRaw) { @($tablesReUpRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }

    foreach ($tbl in $requiredTables085D) {
        if ($tablesReUp -notcontains $tbl) {
            throw "Verificação pós-re-UP falhou: tabela 0.85D '$tbl' ausente após re-convergência."
        }
    }
    Write-Host "Schema reconvergido com sucesso após rollback e re-UP." -ForegroundColor Green

    # 8. Executar Todos os Testes Funcionais no Schema Reconvergido
    Write-Host "`n[5/5] Executando testes funcionais do 0.85D e regressão 0.85C/0.85B contra o schema reconvergido..." -ForegroundColor Yellow
    & npx tsx --test --test-concurrency=1 src/core/observations/reconciliation/__tests__/reconciliation.integration.test.ts src/core/observations/artifacts/__tests__/postgres.integration.test.ts src/core/observations/persistence/__tests__/postgres.integration.test.ts src/core/observations/reconciliation/__tests__/reconciliation.acceptance.integration.test.ts
    if ($LASTEXITCODE -ne 0) { throw "Falha nos testes de integração do 0.85D/0.85C/0.85B" }
    Write-Host "Todos os testes de integração e regressão passaram com 100% de sucesso!" -ForegroundColor Green

} catch {
    Write-Host "`n[ERRO NO HARNESS] $_" -ForegroundColor Red
    $exitCode = 1
} finally {
    # 9. Destruição segura e garantida do banco de dados descartável
    Write-Host "`nLimpeza: destruindo banco de dados descartável..." -ForegroundColor Yellow
    $env:DATABASE_URL = ""
    $env:PAYLOAD_SECRET = ""

    # Terminar conexões ativas no banco descartável se existirem
    try {
        & psql -h $operationalHost -p $operationalPort -U $operationalUser -d "postgres" -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$disposableDbName' AND pid <> pg_backend_pid();" | Out-Null
    } catch {}

    if ($disposableDbName.StartsWith("nex_rec_") -and $disposableDbName -ne $operationalDbName) {
        & dropdb -h $operationalHost -p $operationalPort -U $operationalUser $disposableDbName
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Banco descartável '$disposableDbName' removido com sucesso." -ForegroundColor Green
        } else {
            Write-Host "[WARN] Não foi possível remover o banco descartável: $disposableDbName" -ForegroundColor Yellow
        }
    }
}

exit $exitCode
