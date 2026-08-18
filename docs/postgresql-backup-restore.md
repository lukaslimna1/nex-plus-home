# Runbook — Backup Lógico e Restore Drill do PostgreSQL 18

Este documento estabelece o procedimento operacional padrão para geração de backup lógico e teste de restauração isolada (*restore drill*) do banco de dados do **NEX+ Home**.

---

## 1. Objetivo

Garantir a recuperabilidade estrutural e de dados do banco de dados `nex_home` por meio de cópias lógicas consistentes, auditadas e testadas periodicamente, sem risco de indisponibilidade ou corrupção do ambiente de produção/desenvolvimento.

---

## 2. Escopo: Dump Lógico vs. PITR Futuro

- **Backup Lógico (`pg_dump` / `pg_restore`)**:
  - Exporta esquemas, definições DDL e dados das tabelas em formato de arquivo customizado (*PostgreSQL custom archive* `-Fc`).
  - Permite restauração seletiva, validação de integridade estrutural e portabilidade entre instâncias.
  - É a estratégia base adotada nesta fase de fundação.
- **Estratégia Futura (PITR - Point-In-Time Recovery)**:
  - Baseada no arquivamento contínuo de WAL (*Write-Ahead Logging*) e *base backups* físicos (`pg_basebackup`).
  - Será avaliada e implementada em escopo posterior de infraestrutura e alta disponibilidade.

---

## 3. Diretrizes de Segurança e Dados Sensíveis

> [!WARNING]
> Arquivos `.dump` contêm dados reais do banco de dados, incluindo hashes criptográficos, tokens e metadados de autenticação do Payload.

- **Nunca versionar backups no Git**: Arquivos de dump devem residir exclusivamente fora do repositório.
- **Localização Padrão de Armazenamento Local**:
  `G:\Nex+\Backups\NEX-Home\PostgreSQL\`
- **Zero Senhas em Scripts ou Linha de Comando**:
  - Nunca passe senhas via argumento `-W`, variáveis expostas ou strings inline.
  - A autenticação deve sempre utilizar o prompt interativo seguro do utilitário PostgreSQL.
- **Separação de Privilégios**:
  - `nex_home_app`: Role da aplicação (sem privilégios `CREATEDB` / `SUPERUSER`), utilizada para operações normais de backup e restore dentro do seu banco.
  - `postgres`: Superuser administrativo do cluster (porta 5433), utilizado exclusivamente para tarefas de DDL de cluster (`CREATE DATABASE` / `DROP DATABASE`).

---

## 4. Pré-requisitos e Ferramentas

Utilize exclusivamente os binários nativos do PostgreSQL 18.6 instalados no host:
- `pg_dump`: `C:\Program Files\PostgreSQL\18\bin\pg_dump.exe`
- `pg_restore`: `C:\Program Files\PostgreSQL\18\bin\pg_restore.exe`
- `psql`: `C:\Program Files\PostgreSQL\18\bin\psql.exe`

Parâmetros de conexão:
- **Host**: `127.0.0.1` (loopback estrito)
- **Porta**: `5433` (instância dedicada do NEX+ Home)
- **Database Origem**: `nex_home`

---

## 5. Procedimento de Backup Lógico

### 5.1. Geração do Dump

Gere o nome determinístico utilizando o padrão `nex_home_YYYYMMDD_HHMMSS_pg18.dump`:

```powershell
$ts = Get-Date -Format 'yyyyMMdd_HHmmss'
$dumpPath = "G:\Nex+\Backups\NEX-Home\PostgreSQL\nex_home_${ts}_pg18.dump"

& "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" -h 127.0.0.1 -p 5433 -U nex_home_app -d nex_home -Fc -f $dumpPath
```
*(Digite a senha da role `nex_home_app` no prompt interativo)*.

### 5.2. Validação do Arquivo e Integridade (SHA256)

Calcule e registre o hash SHA256 do arquivo gerado:

```powershell
Get-FileHash -Path $dumpPath -Algorithm SHA256
```

### 5.3. Inspeção da Tabela de Conteúdos (TOC)

Valide a estrutura interna do dump sem restaurá-lo:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" --list $dumpPath
```
*Verifique se todas as 8 tabelas principais (`admins`, `admins_sessions`, `payload_kv`, `payload_locked_documents`, `payload_locked_documents_rels`, `payload_migrations`, `payload_preferences`, `payload_preferences_rels`) estão presentes no TOC.*

---

## 6. Procedimento de Restore Drill (Banco Temporário)

> [!IMPORTANT]
> **Regra de Ouro**: NUNCA execute restore de teste por cima do banco de dados operacional `nex_home`. Utilize sempre um banco temporário isolado.

### 6.1. Criação do Banco Temporário pelo Superuser `postgres`

Conecte-se via `psql` como superuser:
```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h 127.0.0.1 -p 5433 -U postgres -d postgres
```

No prompt interativo do SQL:
```sql
CREATE DATABASE nex_home_restore_test WITH OWNER = nex_home_app TEMPLATE = template0 ENCODING = 'UTF8' LOCALE_PROVIDER = icu ICU_LOCALE = 'pt-BR';
\q
```

### 6.2. Execução do Restore no Banco Temporário

Execute o `pg_restore` autenticando-se como `nex_home_app`:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" -h 127.0.0.1 -p 5433 -U nex_home_app -d nex_home_restore_test --no-owner --no-privileges --single-transaction --exit-on-error $dumpPath
```
*(Digite a senha da role `nex_home_app` quando solicitado)*.

### 6.3. Validações Mínimas de Equivalência

Conecte-se ao banco restaurado e confirme:
1. **Contagem de Tabelas**: 8 tabelas públicas.
2. **Owners**: Todas as tabelas de propriedade de `nex_home_app`.
3. **Contagem de Registros**:
   - `SELECT count(*) FROM public.admins;` (deve equivaler à origem)
   - `SELECT count(*) FROM public.admins_sessions;`
   - `SELECT count(*) FROM public.payload_migrations;`
4. **Tipos de Coluna**: `admins.id` como `uuid`.
5. **Índices e Chaves Estrangeiras**: Integridade relacional preservada.

### 6.4. Limpeza: Destruição do Banco Temporário

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

## 7. Registro de Execuções e Auditoria

| Data (UTC-3) | Archive Gerado | SHA256 do Archive | Status do Drill | Executor |
|---|---|---|---|---|
| **17/08/2026** | `nex_home_20260817_230712_pg18.dump` | `DF3CDCA019E3BE42413CFE1CA242D3E1C84A628CCEC778285C3CB8A60FB00056` | **APROVADO** (Equivalência total 8/8 tabelas, 1 admin, 5 FKs, 30 índices) | Lucas Lima / Antigravity |
