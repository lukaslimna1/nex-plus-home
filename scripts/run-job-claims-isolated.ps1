<#
.SYNOPSIS
    Harness canônico de validação isolada para Canonical Job Claims (Escopo 0.86C-3B).
.DESCRIPTION
    Cria um DATABASE PostgreSQL descartável dedicado (prefixo nex_job_claims_),
    executa o ciclo completo de validação estrutural de migrations (UP -> DOWN -> UP),
    executa os testes de integração PostgreSQL do Job Claims Store (concorrência, fencing, renew, release),
    e destrói o banco descartável ao final sem afetar o banco de dados operacional.
#>

param ()

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

# 3. Geração do nome do Database Descartável
$randomSuffix = [System.IO.Path]::GetRandomFileName().Substring(0, 6).ToLowerInvariant()
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$disposableDbName = "nex_job_claims_${timestamp}_${randomSuffix}"

# Trava estrita de segurança
if (-not $disposableDbName.StartsWith("nex_job_claims_") -or $disposableDbName -eq $operationalDbName) {
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
    if ($currentDb -ne $disposableDbName -or -not $currentDb.StartsWith("nex_job_claims_")) {
        throw "Verificação de segurança falhou: banco conectado '$currentDb' diverge do esperado '$disposableDbName'."
    }
    Write-Host "Banco descartável conectado e verificado: $currentDb" -ForegroundColor Green

    # Configuração de ambiente filho isolado
    $env:DATABASE_URL = $disposableDbUrl
    $env:PAYLOAD_SECRET = $payloadSecret
    $env:NEX_REQUIRE_JOB_CLAIMS_DB = "1"

    # 5. Executar Migrations UP no banco descartável
    Write-Host "`n[2/6] Executando migrations (UP) até 0.86C-3B no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) { throw "Falha ao executar payload migrate inicial no banco descartável" }

    # Colocar exclusivamente a migration 3B em batch superior
    $updateBatchSql = "UPDATE payload_migrations SET batch = (SELECT coalesce(max(batch), 1) + 1 FROM payload_migrations WHERE name <> '20260928_230000_canonical_job_claims') WHERE name = '20260928_230000_canonical_job_claims';"
    & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c $updateBatchSql
    if ($LASTEXITCODE -ne 0) { throw "Falha ao ajustar batch da migration 3B no banco descartável" }

    # Verificar que a tabela nex_job_claims foi criada pós-UP
    $tablesUpRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    if ($LASTEXITCODE -ne 0) { throw "Falha ao inspecionar tabelas pós-UP via psql" }
    $tablesUp = if ($tablesUpRaw) { @($tablesUpRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }

    if ($tablesUp -notcontains "nex_job_claims") {
        throw "Verificação pós-UP falhou: tabela 'nex_job_claims' ausente no banco descartável."
    }
    Write-Host "Tabela 'nex_job_claims' verificada com sucesso pós-UP." -ForegroundColor Green

    # 6. Executar Testes de Integração PostgreSQL do 0.86C-3B
    Write-Host "`n[3/6] Executando testes funcionais e de concorrência atômica contra o banco descartável..." -ForegroundColor Yellow
    & npx tsx --test src/core/jobs/claims/__tests__/postgres-claims.integration.test.ts
    if ($LASTEXITCODE -ne 0) { throw "Falha nos testes de integração PostgreSQL do 0.86C-3B" }
    Write-Host "Testes de integração PostgreSQL concluídos com 100% de sucesso!" -ForegroundColor Green

    # 7. Testar Migration DOWN (Rollback exclusivo do 0.86C-3B)
    Write-Host "`n[4/6] Testando rollback de migration (DOWN do 0.86C-3B) no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate:down
    if ($LASTEXITCODE -ne 0) { throw "Falha ao executar payload migrate:down para 0.86C-3B no banco descartável" }

    # Provar que a migration 3B foi removida do histórico
    $migration3BCount = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT count(*) FROM payload_migrations WHERE name = '20260928_230000_canonical_job_claims';").Trim()
    if ($LASTEXITCODE -ne 0 -or $migration3BCount -ne "0") {
        throw "Verificação pós-DOWN falhou: migration 3B ainda consta em payload_migrations."
    }

    # Verificar estrutura pós-DOWN (tabela nex_job_claims não existe mais, mas nex_job_heads permanece)
    $tablesDownRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    if ($LASTEXITCODE -ne 0) { throw "Falha ao inspecionar tabelas pós-DOWN via psql" }
    $tablesDown = if ($tablesDownRaw) { @($tablesDownRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }

    if ($tablesDown -contains "nex_job_claims") {
        throw "Verificação pós-DOWN falhou: tabela 'nex_job_claims' ainda existe após DOWN."
    }
    if ($tablesDown -notcontains "nex_job_heads") {
        throw "Verificação pós-DOWN falhou: tabela 'nex_job_heads' foi indevidamente removida pelo DOWN de 3B."
    }
    Write-Host "Estrutura pós-DOWN verificada: nex_job_claims removida, tabelas anteriores intactas." -ForegroundColor Green

    # 8. Re-executar migrations (UP do 0.86C-3B) no banco descartável
    Write-Host "`n[5/6] Re-executando migrations (UP do 0.86C-3B) no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) { throw "Falha ao re-executar migrations UP" }
    Write-Host "Schema reconvergido com sucesso após rollback e re-UP." -ForegroundColor Green

    # 9. Executar novamente os testes funcionais no schema reconvergido
    Write-Host "`n[6/6] Executando novamente os testes funcionais no schema reconvergido..." -ForegroundColor Yellow
    & npx tsx --test src/core/jobs/claims/__tests__/postgres-claims.integration.test.ts
    if ($LASTEXITCODE -ne 0) { throw "Falha nos testes funcionais pós-reconvergência" }
    Write-Host "Todos os testes de integração passaram com 100% de sucesso no schema restaurado!" -ForegroundColor Green

} catch {
    Write-Host "`n[ERRO CRÍTICO NO HARNESS]: $_" -ForegroundColor Red
    $exitCode = 1
} finally {
    if ($createdDisposableDb -and $disposableDbName -and $disposableDbName.StartsWith("nex_job_claims_") -and $disposableDbName -ne $operationalDbName) {
        Write-Host "`n[CLEANUP] Encerrando conexões residuais e destruindo banco descartável..." -ForegroundColor Yellow

        $terminateConnectionsSql = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$disposableDbName' AND pid <> pg_backend_pid();"
        & psql -h $operationalHost -p $operationalPort -U $operationalUser -d postgres -c $terminateConnectionsSql 2>&1 | Out-Null

        & dropdb -h $operationalHost -p $operationalPort -U $operationalUser $disposableDbName 2>&1 | Out-Null

        $checkDbExistsSql = "SELECT count(*) FROM pg_database WHERE datname = '$disposableDbName';"
        $remainingCount = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d postgres -t -A -c $checkDbExistsSql).Trim()

        if ($remainingCount -eq "0") {
            Write-Host "[CLEANUP] Banco descartável '$disposableDbName' destruído e confirmado inexistente." -ForegroundColor Green
        } else {
            Write-Host "[CLEANUP_WARN] Não foi possível confirmar a exclusão do banco '$disposableDbName'." -ForegroundColor Red
            if ($exitCode -eq 0) { $exitCode = 1 }
        }
    }
}

exit $exitCode
