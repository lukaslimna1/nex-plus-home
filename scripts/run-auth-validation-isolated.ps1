<#
.SYNOPSIS
    Harness canônico de validação isolada para autenticação multiusuário e testes E2E.
.DESCRIPTION
    Cria um DATABASE PostgreSQL descartável dedicado (prefixo nex_e2e_),
    executa o ciclo completo de validação estrutural de migrations (UP -> DOWN -> UP),
    compila a build atual de produção do Next.js e executa os testes E2E do Playwright
    em porta dedicada sem atingir o banco de dados operacional.
#>

$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$envFilePath = Join-Path $RepoRoot ".env"

if (-not (Test-Path $envFilePath)) {
    Write-Host "[FAIL] Arquivo .env não encontrado em $RepoRoot." -ForegroundColor Red
    exit 1
}

# 0. Preparação do Lock Exclusivo Atômico (a aquisição ocorre após o preflight)
$e2eLockFile = Join-Path $RepoRoot ".next-e2e-auth.lock"
$lockStream = $null
$lockOwnerToken = [guid]::NewGuid().ToString()
$lockAcquired = $false
$databaseCreated = $false

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
$hadOriginalEdgeUrl = [System.Environment]::GetEnvironmentVariables().ContainsKey("PAYLOAD_PUBLIC_SERVER_URL")
$originalEdgeUrl = $env:PAYLOAD_PUBLIC_SERVER_URL
$hadOriginalTrustedOrigins = [System.Environment]::GetEnvironmentVariables().ContainsKey("PAYLOAD_TRUSTED_ORIGINS")
$originalTrustedOrigins = $env:PAYLOAD_TRUSTED_ORIGINS
$hadOriginalEmailRelayUrl = [System.Environment]::GetEnvironmentVariables().ContainsKey("NEX_EMAIL_RELAY_URL")
$originalEmailRelayUrl = $env:NEX_EMAIL_RELAY_URL
$hadOriginalEmailRelaySecret = [System.Environment]::GetEnvironmentVariables().ContainsKey("NEX_EMAIL_RELAY_SECRET")
$originalEmailRelaySecret = $env:NEX_EMAIL_RELAY_SECRET

# Origem única e explícita do E2E isolado; não depende do .env real.
$e2eOrigin = "http://127.0.0.1:3108"
$env:PAYLOAD_PUBLIC_SERVER_URL = $e2eOrigin
$env:PAYLOAD_TRUSTED_ORIGINS = $e2eOrigin

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
Write-Host " NEX+ · HARNESS DE VALIDAÇÃO ISOLADO (ESCOPO 0.8A / 0.8B-L)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Modo: LOCAL AUTH VALIDATION MODE (origem isolada: $e2eOrigin)" -ForegroundColor Yellow
Write-Host "Host: $operationalHost | Porta: $operationalPort | Banco Operacional: $operationalDbName (PROTEGIDO)"

# 3. Geração do nome do Database Descartável
$randomSuffix = [System.IO.Path]::GetRandomFileName().Substring(0, 6).ToLowerInvariant()
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$disposableDbName = "nex_e2e_${timestamp}_${randomSuffix}"

# Trava estrita de segurança
if (-not $disposableDbName.StartsWith("nex_e2e_") -or $disposableDbName -eq $operationalDbName) {
    Write-Host "[SECURITY_FAIL] Nome do banco descartável inválido: $disposableDbName" -ForegroundColor Red
    exit 1
}

$env:PGPASSWORD = $operationalPass
$escapedPass = [System.Uri]::EscapeDataString($operationalPass)
$disposableDbUrl = "postgresql://${operationalUser}:${escapedPass}@${operationalHost}:${operationalPort}/${disposableDbName}"

$exitCode = 0

try {
    # O lock é adquirido somente depois dos preflights read-only e antes de qualquer ação no banco/build.
    # Não há remoção automática de lock existente: em caso ambíguo, falha fechada.
    try {
        $lockStream = [System.IO.File]::Open($e2eLockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $lockInfo = @{
            pid = $PID
            timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            type = "e2e:auth:isolated"
            token = $lockOwnerToken
        } | ConvertTo-Json
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($lockInfo)
        $lockStream.Write($bytes, 0, $bytes.Length)
        $lockStream.Flush()
        $lockAcquired = $true
    } catch [System.IO.IOException] {
        throw "[SECURITY_FAIL] ERRO DE CONCORRÊNCIA: outra instância de teste E2E isolado já está em execução (lock ativo em $e2eLockFile). Abortando."
    }

    # 4. Criação do Database Descartável
    Write-Host "`n[1/7] Criando banco de dados descartável: $disposableDbName..." -ForegroundColor Yellow
    & createdb -h $operationalHost -p $operationalPort -U $operationalUser $disposableDbName
    if ($LASTEXITCODE -ne 0) { throw "Falha ao criar banco de dados descartável: $disposableDbName" }
    $databaseCreated = $true

    # Verificação de segurança via query SQL direta
    $currentDb = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT current_database();").Trim()
    if ($currentDb -ne $disposableDbName -or -not $currentDb.StartsWith("nex_e2e_")) {
        throw "Verificação de segurança falhou: banco conectado '$currentDb' diverge do esperado '$disposableDbName'."
    }
    Write-Host "Banco descartável conectado e verificado: $currentDb" -ForegroundColor Green

    # 4. Configuração de ambiente isolado (sem mutar o arquivo .env de produção)
    $env:DATABASE_URL = $disposableDbUrl
    $env:PAYLOAD_SECRET = $payloadSecret
    $env:NODE_ENV = "production"
    $env:NEX_E2E_ISOLATED = "1"
    $env:PORT = "3108"
    $env:PAYLOAD_PUBLIC_SERVER_URL = $e2eOrigin
    $env:PAYLOAD_TRUSTED_ORIGINS = $e2eOrigin
    $env:NEX_BUILD_MODE = "e2e"
    $env:NEX_EMAIL_RELAY_URL = ""
    $env:NEX_EMAIL_RELAY_SECRET = ""
    Remove-Item env:NEXT_DIST_DIR -ErrorAction SilentlyContinue

    # 5. Executar Migrations UP no banco descartável
    Write-Host "`n[2/7] Executando migrations (UP) no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) { throw "Falha ao executar payload migrate inicial no banco descartável" }

    # Inspeção read-only do ledger real registrado pelo Payload (sem qualquer mutação)
    Write-Host "`n[LEDGER_PROSPECT] Consultando ledger real em payload_migrations..." -ForegroundColor Cyan
    $ledgerInitialRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "SELECT id, name, batch, created_at FROM payload_migrations ORDER BY id;"
    Write-Host $ledgerInitialRaw -ForegroundColor Cyan

    $maxBatchRaw = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT COALESCE(MAX(batch), 0) FROM payload_migrations;").Trim()
    $migrationsCountRaw = (& psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT COUNT(*) FROM payload_migrations;").Trim()
    Write-Host "Migrations aplicadas: $migrationsCountRaw | Batch(es) real(is) detectado(s): $maxBatchRaw | MAX(batch): $maxBatchRaw" -ForegroundColor Green

    # Verificar tabelas criadas pós-UP
    $tablesUpRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    $tablesUp = if ($tablesUpRaw) { @($tablesUpRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }
    if ($tablesUp -notcontains "users" -or $tablesUp -notcontains "users_sessions" -or $tablesUp -notcontains "admins") {
        throw "Verificação pós-UP falhou: tabelas esperadas ausentes no banco descartável."
    }
    Write-Host "Tabelas pós-UP verificadas: admins, users, users_sessions presentes." -ForegroundColor Green

    # 6. Testar Migration DOWN (Rollback real do último batch registrado pelo Payload)
    Write-Host "`n[3/7] Executando rollback do último batch real do Payload (migrate:down)..." -ForegroundColor Yellow
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

    # 7. Executar Migrations UP novamente (Convergência bidirecional real)
    Write-Host "`n[4/7] Re-executando migrations (UP) no banco descartável..." -ForegroundColor Yellow
    & npx payload migrate
    if ($LASTEXITCODE -ne 0) { throw "Falha ao re-executar payload migrate no banco descartável" }

    $ledgerReUp = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -c "SELECT id, name, batch FROM payload_migrations ORDER BY id;"
    Write-Host "Ledger pós-re-UP:`n$ledgerReUp" -ForegroundColor Cyan

    $tablesReUpRaw = & psql -h $operationalHost -p $operationalPort -U $operationalUser -d $disposableDbName -t -A -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
    $tablesReUp = if ($tablesReUpRaw) { @($tablesReUpRaw.Split("`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }
    if ($tablesReUp -notcontains "users" -or $tablesReUp -notcontains "users_sessions" -or $tablesReUp -notcontains "admins") {
        throw "Verificação pós-re-UP falhou: tabelas esperadas ausentes no banco descartável."
    }
    Write-Host "Schema reconvergido com sucesso após rollback e re-UP." -ForegroundColor Green

    # 8. Build da Aplicação Next.js com distDir isolado (.next-e2e-auth)
    Write-Host "`n[5/7] Executando build de produção Next.js isolado em .next-e2e-auth (NEX_BUILD_MODE=e2e)..." -ForegroundColor Yellow
    & npx next build
    if ($LASTEXITCODE -ne 0) { throw "Falha no build de produção isolado do Next.js" }

    # 9. Execução dos Testes E2E com Playwright
    Write-Host "`n[6/7] Executando testes E2E Playwright na porta dedicada $env:PORT com distDir isolado..." -ForegroundColor Yellow
    & npx playwright test
    if ($LASTEXITCODE -ne 0) { throw "Falha nos testes E2E do Playwright" }
    Write-Host "Todos os testes E2E passaram com 100% de sucesso!" -ForegroundColor Green
}
catch {
    Write-Host "`n[ERRO NO HARNESS] $_" -ForegroundColor Red
    $exitCode = 1
}
finally {
    # 10. Destruição segura e garantida do Database Descartável
    Write-Host "`n[7/7] Limpeza: destruindo banco de dados descartável e artefatos isolados..." -ForegroundColor Yellow
    if ($databaseCreated -and $disposableDbName -and $disposableDbName.StartsWith("nex_e2e_") -and $disposableDbName -ne $operationalDbName) {
        # Terminar conexões ativas no banco descartável antes de dropar
        & psql -h $operationalHost -p $operationalPort -U $operationalUser -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$disposableDbName' AND pid <> pg_backend_pid();" | Out-Null
        & dropdb -h $operationalHost -p $operationalPort -U $operationalUser $disposableDbName
        Write-Host "Banco descartável '$disposableDbName' removido com sucesso." -ForegroundColor Green
    } else {
        Write-Host "[SECURITY_WARN] Nome do banco não passou na validação de drop: $disposableDbName" -ForegroundColor Red
    }

    # Limpar diretório de build isolado do E2E
    $e2eDistPath = Join-Path $RepoRoot ".next-e2e-auth"
    if ($lockAcquired -and (Test-Path $e2eDistPath)) {
        Remove-Item -Path $e2eDistPath -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "Diretório de build isolado '$e2eDistPath' removido com sucesso." -ForegroundColor Green
    }

    # 11. Liberação do Lock Exclusivo
    if ($lockStream) {
        $lockStream.Close()
        $lockStream.Dispose()
        $lockStream = $null
    }
    if ($lockAcquired -and (Test-Path $e2eLockFile)) {
        for ($i = 0; $i -lt 10; $i++) {
            try {
                Remove-Item -Path $e2eLockFile -Force -ErrorAction Stop
                break
            } catch {
                Start-Sleep -Milliseconds 50
            }
        }
    }

    # Restauração das variáveis de ambiente de borda
    if ($hadOriginalEdgeUrl) {
        $env:PAYLOAD_PUBLIC_SERVER_URL = $originalEdgeUrl
    } else {
        Remove-Item env:\PAYLOAD_PUBLIC_SERVER_URL -ErrorAction SilentlyContinue
    }
    if ($hadOriginalTrustedOrigins) {
        $env:PAYLOAD_TRUSTED_ORIGINS = $originalTrustedOrigins
    } else {
        Remove-Item env:\PAYLOAD_TRUSTED_ORIGINS -ErrorAction SilentlyContinue
    }
    if ($hadOriginalEmailRelayUrl) {
        $env:NEX_EMAIL_RELAY_URL = $originalEmailRelayUrl
    } else {
        Remove-Item env:\NEX_EMAIL_RELAY_URL -ErrorAction SilentlyContinue
    }
    if ($hadOriginalEmailRelaySecret) {
        $env:NEX_EMAIL_RELAY_SECRET = $originalEmailRelaySecret
    } else {
        Remove-Item env:\NEX_EMAIL_RELAY_SECRET -ErrorAction SilentlyContinue
    }
    Remove-Item env:NEXT_DIST_DIR -ErrorAction SilentlyContinue
    Remove-Item env:NEX_BUILD_MODE -ErrorAction SilentlyContinue
}

exit $exitCode
