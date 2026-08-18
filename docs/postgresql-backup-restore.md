# Runbook — Backup Lógico e Restore Drill do PostgreSQL 18

Este documento estabelece o procedimento operacional padrão para geração de backup lógico e teste de restauração isolada (*restore drill*) do banco de dados do **NEX+ Home**.

---

## 1. Objetivo

Garantir a recuperabilidade estrutural, de dados e de permissões do banco de dados `nex_home` por meio de cópias lógicas consistentes, auditadas e testadas periodicamente, sem restaurar sobre o banco operacional e com risco operacional minimizado.

---

## 2. Escopo: Dump Lógico vs. PITR Futuro

- **Backup Lógico (`pg_dump` / `pg_restore`)**:
  - Exporta esquemas, definições DDL, permissões e dados das tabelas de um database específico em formato de arquivo customizado (*PostgreSQL custom archive* `-Fc`).
  - Permite restauração seletiva, validação de integridade estrutural/ACLs e portabilidade entre instâncias.
  - É a estratégia base adotada nesta fase de fundação.
- **Estratégia Futura (PITR - Point-In-Time Recovery)**:
  - Baseada no arquivamento contínuo de WAL (*Write-Ahead Logging*) e *base backups* físicos (`pg_basebackup`).
  - Será avaliada e implementada em escopo posterior de infraestrutura e alta disponibilidade.

---

## 3. Limitações do `pg_dump` e Objetos Globais

- **Escopo do Database**: O utilitário `pg_dump` exporta exclusivamente os objetos pertencentes ao banco de dados especificado (`nex_home`).
- **Objetos Globais e Roles**: Roles de banco de dados (como `nex_home_app` e `postgres`), tablespaces e configurações globais do cluster não são salvos pelo `pg_dump`.
- **Pré-requisito para Restauração**: O procedimento de *restore drill* assume que a role `nex_home_app` já existe previamente no cluster com suas respectivas configurações de autenticação.
- **Recuperação Disaster Recovery do Zero**: A recomposição completa de um servidor ou cluster do zero exigirá um bootstrap prévio seguro das roles e configurações globais, cuja estratégia de automação, retenção, criptografia e armazenamento *offsite* será definida em escopo futuro.

---

## 4. Diretrizes de Segurança e Dados Sensíveis

> [!WARNING]
> Arquivos `.dump` contêm dados reais do banco de dados, incluindo hashes criptográficos, tokens e metadados de autenticação do Payload.

- **Nunca versionar backups no Git**: Arquivos de dump residem exclusivamente fora do repositório.
- **Localização Padrão de Armazenamento Local**:
  `G:\Nex+\Backups\NEX-Home\PostgreSQL\`
- **Gestão Segura de Autenticação**:
  - A opção `-W` / `--password` do PostgreSQL não aceita senhas como argumento; ela serve exclusivamente para forçar a solicitação interativa de senha no terminal.
  - Neste runbook, `-W` é opcional porque os utilitários já solicitam a senha interativamente quando a autenticação exige.
  - É expressamente proibido embutir senhas em connection strings na linha de comando, argumentos de execução, scripts, variáveis de ambiente expostas ou qualquer arquivo versionado.
- **Separação de Privilégios**:
  - `nex_home_app`: Role da aplicação (sem privilégios `CREATEDB` / `SUPERUSER`), utilizada para operações normais de backup e restore dentro do seu banco.
  - `postgres`: Superuser administrativo do cluster (porta 5433), utilizado exclusivamente para tarefas de DDL de cluster (`CREATE DATABASE` / `DROP DATABASE`).

---

## 5. Pré-requisitos e Ferramentas

Utilize exclusivamente os binários nativos do PostgreSQL 18.6 instalados no host:
- `pg_dump`: `C:\Program Files\PostgreSQL\18\bin\pg_dump.exe`
- `pg_restore`: `C:\Program Files\PostgreSQL\18\bin\pg_restore.exe`
- `psql`: `C:\Program Files\PostgreSQL\18\bin\psql.exe`

Parâmetros de conexão:
- **Host**: `127.0.0.1` (loopback estrito)
- **Porta**: `5433` (instância dedicada do NEX+ Home)
- **Database Origem**: `nex_home`

---

## 6. Procedimento de Backup Lógico

### 6.1. Geração do Dump

Gere o nome determinístico utilizando o padrão `nex_home_YYYYMMDD_HHMMSS_pg18.dump`:

```powershell
$ts = Get-Date -Format 'yyyyMMdd_HHmmss'
$dumpPath = "G:\Nex+\Backups\NEX-Home\PostgreSQL\nex_home_${ts}_pg18.dump"

& "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -h 127.0.0.1 -p 5433 -U nex_home_app -d nex_home -Fc -f $dumpPath
```
*(Digite a senha da role `nex_home_app` no prompt interativo)*.

### 6.2. Validação do Arquivo e Integridade (SHA256)

Calcule e registre o hash SHA256 do arquivo gerado:

```powershell
Get-FileHash -Path $dumpPath -Algorithm SHA256
```

### 6.3. Inspeção da Tabela de Conteúdos (TOC)

Valide a estrutura interna do dump sem restaurá-lo:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" --list $dumpPath
```
*Verifique se todas as 8 tabelas principais (`admins`, `admins_sessions`, `payload_kv`, `payload_locked_documents`, `payload_locked_documents_rels`, `payload_migrations`, `payload_preferences`, `payload_preferences_rels`) estão presentes no TOC.*

---

## 7. Procedimento de Restore Drill (Banco Temporário)

> [!IMPORTANT]
> **Regra de Isolamento**: NUNCA execute restore de teste por cima do banco de dados operacional `nex_home`. Utilize sempre um banco temporário isolado.

### 7.1. Criação do Banco Temporário e Aplicação do Baseline de ACL

Conecte-se via `psql` como superuser:
```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h 127.0.0.1 -p 5433 -U postgres -d postgres
```

No prompt interativo do SQL, crie o database e aplique imediatamente o baseline de privilégios revogando acesso do `PUBLIC`:
```sql
CREATE DATABASE nex_home_restore_test WITH OWNER = nex_home_app TEMPLATE = template0 ENCODING = 'UTF8' LOCALE_PROVIDER = icu ICU_LOCALE = 'pt-BR';

REVOKE CONNECT, TEMPORARY ON DATABASE nex_home_restore_test FROM PUBLIC;
\q
```

### 7.2. Execução do Restore no Banco Temporário

Execute o `pg_restore` autenticando-se como `nex_home_app` (reproduzindo privilégios de objetos do archive, sem o uso de `--no-privileges`):

```powershell
& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" -h 127.0.0.1 -p 5433 -U nex_home_app -d nex_home_restore_test --no-owner --single-transaction --exit-on-error $dumpPath
```
*(Digite a senha da role `nex_home_app` quando solicitado)*.

### 7.3. Validações Mínimas de Equivalência

Conecte-se ao banco restaurado e confirme:
1. **Contagem de Tabelas**: 8 tabelas públicas.
2. **Owners e Privilégios**: Todas as tabelas de propriedade de `nex_home_app`, com privilégios de schema/tabelas intactos.
3. **Database ACL**: `PUBLIC CONNECT` e `PUBLIC TEMPORARY` negados (`false`), `datacl` equivalente à origem.
4. **Contagem de Registros**:
   - `SELECT count(*) FROM public.admins;` (deve equivaler à origem)
   - `SELECT count(*) FROM public.admins_sessions;`
   - `SELECT count(*) FROM public.payload_migrations;`
5. **Tipos de Coluna**: `admins.id` como `uuid`.
6. **Índices e Chaves Estrangeiras**: Integridade relacional preservada.

### 7.4. Limpeza: Destruição do Banco Temporário

Após a auditoria, garanta que não há sessões abertas no banco de teste e remova-o como superuser:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h 127.0.0.1 -p 5433 -U postgres -d postgres
```

No prompt do SQL:
```sql
DROP DATABASE nex_home_restore_test;
\q
```

---

## 8. Registro de Execuções e Auditoria

| Data (UTC-3) | Archive Testado | SHA256 do Archive | Status do Drill | Observações |
|---|---|---|---|---|
| **17/08/2026** | `nex_home_20260817_230712_pg18.dump` | `DF3CDCA019E3BE42413CFE1CA242D3E1C84A628CCEC778285C3CB8A60FB00056` | **PARCIALMENTE VALIDADO** | Schema, dados, UUID, FKs e índices validados (8/8 tabelas, 1 admin). Privilégios do database não haviam sido explicitamente comparados. |
| **17/08/2026** | `nex_home_20260817_230712_pg18.dump` | `DF3CDCA019E3BE42413CFE1CA242D3E1C84A628CCEC778285C3CB8A60FB00056` | **APROVADO (EQUIVALÊNCIA TOTAL)** | Restore reexecutado sem `--no-privileges`. Baseline de database ACL validada (`PUBLIC CONNECT=false`, `PUBLIC TEMPORARY=false`), ACLs de objetos, schema, FKs e contagens 100% equivalentes à origem. |
