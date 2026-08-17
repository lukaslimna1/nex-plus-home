# Diretrizes de Desenvolvimento e Guardrails no Windows — NEX+ Home

Este documento estabelece as regras operacionais, guardrails e procedimentos de segurança para o ambiente de desenvolvimento local do **NEX+ Home** no Windows.

---

## 1. Por que `npm ci` não deve rodar com `next dev` ativo

No Windows, módulos nativos compilados (como `next-swc.win32-x64-msvc.node`) carregados ou mapeados em memória pelo processo Node durante a execução podem permanecer indisponíveis para exclusão enquanto o processo os utiliza.

- O comando `npm ci` remove integralmente a pasta `node_modules` antes de reconstruí-la a partir do `package-lock.json`.
- Se o servidor de desenvolvimento (`next dev` / `npm run dev`) estiver ativo e mantiver o binário carregado, a exclusão falhará com o erro **`EPERM: operation not permitted (unlink)`**.
- **Regra**: Sempre encerre o servidor de desenvolvimento do NEX+ Home antes de executar `npm ci` ou reconstruções de dependências.

---

## 2. Como Executar o Script de Preflight

O script de preflight audita o ambiente local de forma **100% somente-leitura** (sem alterar arquivos, serviços ou processos):

```powershell
# Execução via npm script:
npm run preflight:windows

# Execução direta com guardrail para npm ci:
powershell.exe -NoLogo -NoProfile -File ./scripts/windows-preflight.ps1 -ForNpmCi
```

O modo `-ForNpmCi` retorna código de saída não-zero (`exit 1`) caso detecte um servidor `next dev` associado ao repositório NEX+ Home, bloqueando preventivamente operações sujeitas a `EPERM`.

---

## 3. Regra de Interação Humana (UAC e Segredos)

Processos iniciados pela automação ou ferramentas em segundo plano da IDE não são considerados um canal confiável para UAC, GUI interativa ou entrada de segredos.

- **Regra Operacional**:
  - Toda operação que exigir **UAC / Elevação de Administrador** (como controle de serviços do Windows) ou **digitação de senhas seguras** (como o superusuário `postgres` ou a role `nex_home_app`) deve ser entregue para execução por Lucas em terminal/janela interativa visível.
  - Senhas e credenciais nunca devem ser passadas via linha de comando, scripts gravados em disco ou reproduzidas em relatórios e logs.

---

## 4. Instância Dedicada do PostgreSQL (Porta 5433)

- O **NEX+ Home** utiliza exclusivamente a instância dedicada **PostgreSQL 18.6** no serviço `postgresql-x64-18`.
- **Porta**: `5433` (estritamente isolada em `127.0.0.1` e `::1` via `listen_addresses = 'localhost'`).
- **Autenticação**: `scram-sha-256`.
- **Banco de Dados**: `nex_home` (Owner: `nex_home_app`, Locale: ICU `pt-BR`, Encoding: `UTF8`).
- **Configuração**: configuração isolada e dedicada ao ecossistema da aplicação.

---

## 5. Separação do PostgreSQL do Odoo (Porta 5432)

- O serviço `PostgreSQL_For_Odoo` opera de forma independente na porta padrão `5432` em `C:\Program Files\Odoo 19.0.20260808\PostgreSQL\`.
- As instâncias não compartilham portas, dados, serviços ou configurações.

---

## 6. Sequência Segura para Reinício do PostgreSQL

Caso seja necessário realizar o reinício do serviço `postgresql-x64-18`, execute a seguinte sequência manual em terminal visível:

1. Abra um terminal PowerShell como **Administrador**.
2. Pare o serviço:
   ```powershell
   Stop-Service postgresql-x64-18
   ```
3. Aguarde e confirme que o status está como `Stopped`:
   ```powershell
   Get-Service postgresql-x64-18
   ```
4. Confirme que nenhum listener residual permanece ativo na porta `5433`:
   ```powershell
   Get-NetTCPConnection -LocalPort 5433 -State Listen -ErrorAction SilentlyContinue
   ```
5. Somente após a confirmação de que nenhum listener está em `Listen`, inicie o serviço novamente:
   ```powershell
   Start-Service postgresql-x64-18
   ```
6. Confirme que o status retornou para `Running`:
   ```powershell
   Get-Service postgresql-x64-18
   ```
7. Valide os listeners loopback (devem ser estritamente `127.0.0.1` e `::1` em estado `Listen`):
   ```powershell
   Get-NetTCPConnection -LocalPort 5433 -State Listen | Select-Object LocalAddress, LocalPort, State
   ```
8. Execute o health check:
   ```powershell
   & "C:\Program Files\PostgreSQL\18\bin\pg_isready.exe" -h 127.0.0.1 -p 5433
   ```

---

## 7. Preservação das Políticas de Segurança do Windows

- O projeto **não** altera, desativa ou recomenda desabilitar UAC, Windows Defender, SmartScreen, Windows Firewall ou políticas de integridade do sistema operacional.
- O desenvolvimento do NEX+ Home adere rigorosamente aos padrões de segurança e governança locais.

---

## 8. Isolamento de Rede do Servidor Next.js (Porta 3000)

- Os scripts oficiais do projeto `dev` e `start` são configurados para bind explícito em `127.0.0.1` no `package.json`.
- Qualquer execução alternativa deve ser auditada pelo preflight para assegurar que não haja exposição indevida em interfaces não intencionais.

---

## 9. Nota Operacional sobre Codificação de Arquivos

- Automação executada em Windows PowerShell 5.1 não deve regravar arquivos UTF-8 versionados usando encoding implícito.
