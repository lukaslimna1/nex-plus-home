# Diretrizes de Desenvolvimento e Guardrails no Windows â€” NEX+ Home

Este documento estabelece as regras operacionais, guardrails e procedimentos de seguranÃ§a para o ambiente de desenvolvimento local do **NEX+ Home** no Windows.

---

## 1. Por que `npm ci` nÃ£o deve rodar com `next dev` ativo

No Windows, mÃ³dulos nativos compilados (como `next-swc.win32-x64-msvc.node`) carregados ou mapeados em memÃ³ria pelo processo Node durante a execuÃ§Ã£o podem permanecer indisponÃ­veis para exclusÃ£o enquanto o processo os utiliza.

- O comando `npm ci` remove integralmente a pasta `node_modules` antes de reconstruÃ­-la a partir do `package-lock.json`.
- Se o servidor de desenvolvimento (`next dev` / `npm run dev`) estiver ativo e mantiver o binÃ¡rio carregado, a exclusÃ£o falharÃ¡ com o erro **`EPERM: operation not permitted (unlink)`**.
- **Regra**: Sempre encerre o servidor de desenvolvimento do NEX+ Home antes de executar `npm ci` ou reconstruÃ§Ãµes de dependÃªncias.

---

## 2. Como Executar o Script de Preflight

O script de preflight audita o ambiente local de forma **100% somente-leitura** (sem alterar arquivos, serviÃ§os ou processos):

```powershell
# ExecuÃ§Ã£o via npm script:
npm run preflight:windows

# ExecuÃ§Ã£o direta com guardrail para npm ci:
powershell.exe -NoLogo -NoProfile -File ./scripts/windows-preflight.ps1 -ForNpmCi
```

O modo `-ForNpmCi` retorna cÃ³digo de saÃ­da nÃ£o-zero (`exit 1`) caso detecte um servidor `next dev` associado ao repositÃ³rio NEX+ Home, bloqueando preventivamente operaÃ§Ãµes sujeitas a `EPERM`.

---

## 3. Regra de InteraÃ§Ã£o Humana (UAC e Segredos)

Processos iniciados pela automaÃ§Ã£o ou ferramentas em segundo plano da IDE nÃ£o sÃ£o considerados um canal confiÃ¡vel para UAC, GUI interativa ou entrada de segredos.

- **Regra Operacional**:
  - Toda operaÃ§Ã£o que exigir **UAC / ElevaÃ§Ã£o de Administrador** (como controle de serviÃ§os do Windows) ou **digitaÃ§Ã£o de senhas seguras** (como o superusuÃ¡rio `postgres` ou a role `nex_home_app`) deve ser entregue para execuÃ§Ã£o por Lucas em terminal/janela interativa visÃ­vel.
  - Senhas e credenciais nunca devem ser passadas via linha de comando, scripts gravados em disco ou reproduzidas em relatÃ³rios e logs.

---

## 4. InstÃ¢ncia Dedicada do PostgreSQL (Porta 5433)

- O **NEX+ Home** utiliza exclusivamente a instÃ¢ncia dedicada **PostgreSQL 18.6** no serviÃ§o `postgresql-x64-18`.
- **Porta**: `5433` (estritamente isolada em `127.0.0.1` e `::1` via `listen_addresses = 'localhost'`).
- **AutenticaÃ§Ã£o**: `scram-sha-256`.
- **Banco de Dados**: `nex_home` (Owner: `nex_home_app`, Locale: ICU `pt-BR`, Encoding: `UTF8`).

---

## 5. SeparaÃ§Ã£o do PostgreSQL do Odoo (Porta 5432)

- O serviÃ§o `PostgreSQL_For_Odoo` opera de forma independente na porta padrÃ£o `5432` em `C:\Program Files\Odoo 19.0.20260808\PostgreSQL\`.
- As instÃ¢ncias nÃ£o compartilham portas, dados, serviÃ§os ou configuraÃ§Ãµes.

---

## 6. SequÃªncia Segura para ReinÃ­cio do PostgreSQL

Caso seja necessÃ¡rio reiniciar o serviÃ§o `postgresql-x64-18`, execute a seguinte sequÃªncia manual em terminal visÃ­vel:

1. Abra um terminal PowerShell como **Administrador**.
2. Pare o serviÃ§o:
   ```powershell
   Stop-Service postgresql-x64-18
   ```
3. Aguarde e confirme que o status estÃ¡ como `Stopped`:
   ```powershell
   Get-Service postgresql-x64-18
   ```
4. Confirme que nenhum listener residual permanece ativo na porta `5433`:
   ```powershell
   Get-NetTCPConnection -LocalPort 5433 -State Listen -ErrorAction SilentlyContinue
   ```
5. Somente apÃ³s a confirmaÃ§Ã£o de que nenhum listener estÃ¡ em `Listen`, inicie o serviÃ§o novamente:
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

## 7. PreservaÃ§Ã£o das PolÃ­ticas de SeguranÃ§a do Windows

- O projeto **nÃ£o** altera, desativa ou recomenda desabilitar UAC, Windows Defender, SmartScreen, Windows Firewall ou polÃ­ticas de integridade do sistema operacional.
- O desenvolvimento do NEX+ Home adere rigorosamente aos padrÃµes de seguranÃ§a e governanÃ§a locais.

---

## 8. Isolamento de Rede do Servidor Next.js (Porta 3000)

- Os scripts `dev` e `start` do NEX+ Home sÃ£o deliberadamente configurados com `-H 127.0.0.1` no `package.json`.
- Isso garante que o servidor HTTP de desenvolvimento e execuÃ§Ã£o nunca escute em interfaces pÃºblicas (`0.0.0.0`), operando exclusivamente em loopback local (`127.0.0.1`).
