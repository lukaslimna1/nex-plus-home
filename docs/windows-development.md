# Diretrizes de Desenvolvimento e Guardrails no Windows — NEX+ Home

Este documento estabelece as regras operacionais, guardrails e procedimentos de segurança para o ambiente de desenvolvimento local do **NEX+ Home** no Windows.

---

## 1. Por que `npm ci` não deve rodar com `next dev` ativo

No Windows, o Next.js carrega módulos binários nativos compilados (como `next-swc.win32-x64-msvc.node`) diretamente na memória do processo Node. O subsistema de arquivos do Windows aplica travamento exclusivo (*file lock*) em qualquer binário `.node` em execução.

- O comando `npm ci` inicia removendo completamente a pasta `node_modules`.
- Se o servidor de desenvolvimento (`next dev` / `npm run dev`) estiver ativo, a exclusão falhará com erro **`EPERM: operation not permitted (unlink)`**.
- **Regra**: Sempre encerre o servidor de desenvolvimento antes de executar `npm ci` ou reconstruções de dependências.

---

## 2. Como Executar o Script de Preflight

O script de preflight audita o ambiente local de forma **100% somente-leitura** (sem alterar arquivos, serviços ou processos):

```powershell
# Execução via npm script:
npm run preflight:windows

# Execução direta com guardrail para npm ci:
powershell.exe -NoLogo -NoProfile -File ./scripts/windows-preflight.ps1 -ForNpmCi
```

O modo `-ForNpmCi` retorna código de saída não-zero caso detecte um servidor `next dev` associado ao repositório ou ativo na porta 3000, bloqueando preventivamente operações sujeitas a `EPERM`.

---

## 3. Regra de Interação Humana (UAC e Segredos)

Por mecanismos de segurança nativos do Windows (Isolamento de Sessão / Session Isolation):

- Processos executados em segundo plano por ferramentas automatizadas rodam sem anexação à área de trabalho interativa e não podem exibir diálogos de elevação (UAC) ou prompts interativos de senha.
- **Regra Operacional**:
  - Toda operação que exigir **UAC / Elevação de Administrador** (como reiniciar serviços do Windows) ou **digitação de senhas seguras** (como o superusuário `postgres`) deve ser executada diretamente por Lucas no terminal visível.
  - Senhas nunca devem ser passadas via linha de comando, scripts salvos ou impressas em relatórios e logs.

---

## 4. Instância Dedicada do PostgreSQL (Porta 5433)

- O **NEX+ Home** utiliza exclusivamente a instância dedicada **PostgreSQL 18.6** no serviço `postgresql-x64-18`.
- **Porta**: `5433` (estritamente isolada em `127.0.0.1` e `::1` via `listen_addresses = 'localhost'`).
- **Autenticação**: `scram-sha-256`.
- **Banco de Dados**: `nex_home` (Owner: `nex_home_app`, Locale: ICU `pt-BR`, Encoding: `UTF8`).

---

## 5. Separação do PostgreSQL do Odoo (Porta 5432)

- O serviço `PostgreSQL_For_Odoo` opera de forma independente na porta padrão `5432` em `C:\Program Files\Odoo 19.0.20260808\PostgreSQL\`.
- As instâncias não compartilham portas, dados, serviços ou configurações.

---

## 6. Sequência Segura para Reinício do PostgreSQL

Caso seja necessário reiniciar o serviço `postgresql-x64-18`:

1. Abra um terminal PowerShell elevado como **Administrador**.
2. Execute a parada ou reinício com aguardo explícito de liberação do socket:
   ```powershell
   Restart-Service postgresql-x64-18
   ```
3. Confirme que o serviço retornou ao estado `Running` e que os sockets em `127.0.0.1:5433` estão ativos via health check:
   ```powershell
   & "C:\Program Files\PostgreSQL\18\bin\pg_isready.exe" -h 127.0.0.1 -p 5433
   ```

---

## 7. Preservação das Políticas de Segurança do Windows

- O projeto **não** altera, desativa ou recomenda desabilitar UAC, Windows Defender, SmartScreen, Windows Firewall ou políticas de integridade do sistema operacional.
- O desenvolvimento do NEX+ Home adere rigorosamente aos padrões de segurança e governança locais.
