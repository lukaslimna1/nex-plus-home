# NEX+ · Autenticação Multiusuário da Aplicação
**Escopo 0.8A Hardening — Camada de Identidade Local, Sessão e Harness de Validação Isolado**

---

## 1. Separação de Identidades: Admins × Users

O NEX+ adota duas classes formais de identidade:

1. **`admins` (`src/collections/Admins.ts`)**:
   - Identidade administrativa técnica exclusiva para o **Payload Admin Panel** (`/admin`).
   - Mantida como `admin.user = Admins.slug` em `src/payload.config.ts`.
   - Gerencia a criação e manutenção dos usuários da aplicação.
   - **Não** é utilizada para operar a Home ou as rotas normais do NEX+.

2. **`users` (`src/collections/Users.ts`)**:
   - Identidade operacional dos usuários e sócios do NEX+.
   - Utilizada para autenticação no frontend (`/login`), acesso à `/home`, futuro assistente MAX e módulos operacionais.
   - **Não possui acesso ao Payload Admin Panel**.
   - Possui `displayName` (obrigatório), `email` e `password` nativos do auth Payload.

---

## 2. Proibição de Self-Registration

Não existe cadastro público de usuários. A criação, listagem, edição, deleção e desbloqueio de contas na collection `users` é restrita exclusivamente a identidades autenticadas como `admins`.
Usuários comuns da aplicação ou requisições anônimas recebem acesso negado (`false`) em todas as operações de mutação e consulta administrativa de usuários.

---

## 3. Workaround do Payload 3.88.0 & Fluxo de Sessão

- **Workaround de Autenticação na 3.88.0**:
  - Na versão `3.88.0` do Payload, a configuração `removeTokenFromResponses: true` remove o `result.token` do retorno de `payload.login()` antes que o helper `@payloadcms/next/auth login()` consiga ler o token para materializar o cookie `payload-token`.
  - O upstream do Payload corrigiu essa questão posteriormente no commit `b292343a89f812a0e03f2793708c6579935d161e`. Como o projeto não faz upgrade para canary nem patch em `node_modules`, o `removeTokenFromResponses` foi mantido desativado (comportamento padrão) na collection `Users`.
  - **Garantia de Não-Vazamento**: O token JWT gerado internamente pelo servidor é consumido exclusivamente pelo helper do Next.js para criação do cookie HTTP-only. A nossa Server Action (`src/auth/actions.ts`) **nunca** retorna o token, hashes, salts ou sessões para o Client Component. O retorno para a UI é estritamente `{ success: boolean, error?: string }`.

- **Login (`loginAction`)**:
  - Utiliza `login()` oficial de `@payloadcms/next/auth` em Server Action.
  - Normaliza o e-mail (`trim` e `lowercase`).
  - Cria sessão segura persistida na tabela `users_sessions` com cookie HTTP-only gerenciado pelo Payload.
  - Mensagens de erro para a interface são genéricas (`"E-mail ou senha inválidos."`), sem expor se o e-mail existe ou se a senha está incorreta.

- **Identidade Ativa (`getCurrentAppUser`)**:
  - Executada no servidor a partir dos `headers()` da requisição com `payload.auth({ headers })`.
  - Reconhece e projeta unicamente identidades da coleção `users`.
  - Retorna um DTO defensivo (`AppUserView`: `id`, `email`, `displayName`), sem expor hashes, salts, tokens de redefinição ou sessões.

- **Logout (`logoutAction`)**:
  - Utiliza `logout()` oficial de `@payloadcms/next/auth` em Server Action.
  - Respeita o resultado da operação (`handleLogoutResult`) e propaga eventuais falhas com mensagens genéricas seguras para a interface sem fabricar sucesso.
  - Invalida a sessão atual no banco de dados (`users_sessions`) e limpa os cookies de autenticação.
  - Redireciona o usuário para `/login`.

---

## 4. Proteção Server-Side da Home e Rotas

- **Rota Raiz (`/`)**: Redireciona via Server Component diretamente para `/home` (`redirect('/home')`), impedindo qualquer bypass de autenticação.
- **Rota Home (`/home`)**: Server Component que valida `getCurrentAppUser()`. Requisições sem sessão ativa válida de `users` são redirecionadas para `/login` antes de qualquer entrega de layout ou dados operacionais.
- **Rota Login (`/login`)**: Se o usuário já possuir sessão válida ativa, é redirecionado automaticamente para `/home`.

---

## 5. UI e Controles Indisponíveis

- **UserMiniCard**: Exibe o `displayName` real do usuário autenticado, com identificação neutra `"Usuário NEX+"` e avatar derivado deterministicamente de suas iniciais. Inclui dropdown acessível com o botão `"Sair"`. Em caso de falha no logout, o erro é exibido discretamente no menu sem desautenticar incorretamente a interface.
- **Manter conectado**: Preservado visualmente, porém com atributo `disabled` e indicação acessível (`aria-label="Manter conectado (Disponível em uma etapa futura)"`).
- **Esqueci minha senha?**: Preservado visualmente, desabilitado com `aria-disabled="true"` e indicação acessível. Não há adapter de e-mail ou reset implementado nesta etapa.

---

## 6. Harness de Validação Isolado (PostgreSQL DATABASE Real)

Para garantir que os testes de ponta a ponta e as validações estruturais de migração nunca atinjam o banco de dados operacional local, o projeto dispõe do harness canônico:

```powershell
npm run test:e2e:auth:isolated
```

### Arquitetura de Isolamento do Harness:
1. **Banco PostgreSQL Descartável Real (`DATABASE`, não schema)**:
   - Cria um banco dedicado com prefixo obrigatório `nex_e2e_<timestamp>_<random>` via `createdb`.
   - Trava fail-fast dupla: recusa terminantemente qualquer execução se a base não iniciar por `nex_e2e_` ou se for igual ao banco operacional.
2. **Reversibilidade de Migração Comprovada (`UP -> DOWN -> UP`)**:
   - `UP`: Aplica as migrations oficiais via Payload CLI e valida com `psql` a existência de `admins`, `admins_sessions`, `users` e `users_sessions`.
   - `DOWN`: Executa `payload migrate:down` e valida que `users` e `users_sessions` foram removidas, `admins` e `admins_sessions` permanecem intactas e a coluna `users_id` foi excluída das tabelas relacionais.
   - `UP`: Re-executa as migrations e valida a reconvergência total do schema.
3. **Build Obrigatória Imediatamente Antes do E2E**:
   - Compila `next build` garantindo que o servidor execute exatamente a versão atual do código.
4. **Playwright E2E Sem Reuso de Servidor**:
   - `playwright.config.ts` configurado com `reuseExistingServer: false` e porta dedicada (`3108`).
   - Bloqueio no `beforeAll` do Playwright: recusa tocar dados se `NEX_E2E_ISOLATED !== '1'` ou se o banco não iniciar por `nex_e2e_`.
   - Valida login anônimo, login real, emissão de cookie HTTP-only, permanência após reload, tentativa com senha inválida (sem cookie), logout com remoção de cookie e rejeição de requisição com cookie antigo (comprovando revogação da sessão no servidor).
5. **Limpeza Automática no `finally`**:
   - Encerra conexões ativas e remove o banco descartável via `dropdb`.
   - O banco de dados operacional **nunca** recebe comandos `migrate:down`, `migrate:reset` ou `dropdb`.
