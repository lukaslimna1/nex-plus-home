# NEX+ · Autenticação Multiusuário da Aplicação
**Escopo 0.8A Hardening — Camada de Identidade Local, Sessão e Proteção Server-Side**

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
  - Invalida a sessão atual e limpa os cookies de autenticação.
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

## 6. Evidência E2E e Reversibilidade de Migração

- **Testes E2E com Playwright (`@playwright/test` 1.62.1)**:
  - O antigo script de smoke em Local API foi removido.
  - O fluxo completo de autenticação (anônimo, login real via interface, emissão de cookie HTTP-only, persistência após reload, login com credencial inválida e logout pelo UserMiniCard) é validado em navegador Chromium real em `tests/e2e/auth.spec.ts`.
- **Reversibilidade de Migration (DOWN)**:
  - A ordem de remoção no DOWN da migration `20260820_030631_multiuser_auth` espelha o UP em ordem estritamente reversa (remove constraints, remove índices, remove colunas relacionais e em seguida remove as tabelas `users_sessions` e `users`).
  - O ciclo completo de `UP -> DOWN -> UP` foi verificado com 100% de sucesso estrutural em schema descartável isolado sem tocar no banco de dados operacional.
- **Limitação de Cookie Multi-Auth do Payload**:
  - `admins` e `users` compartilham o prefixo padrão do cookie de autenticação do Payload. Caso um administrador e um usuário operem no mesmo navegador, o login mais recente sobrescreve a sessão ativa daquele navegador. Sessões simultâneas de papéis distintos requerem perfis ou janelas anônimas separadas.
