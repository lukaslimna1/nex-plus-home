# NEX+ · Autenticação Multiusuário da Aplicação
**Escopo 0.8A — Camada de Identidade Local, Sessão e Proteção Server-Side**

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

## 3. Fluxo de Autenticação e Sessão

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
  - Invalida a sessão atual e limpa os cookies de autenticação.
  - Redireciona o usuário para `/login`.

---

## 4. Proteção Server-Side da Home e Rotas

- **Rota Raiz (`/`)**: Redireciona via Server Component diretamente para `/home` (`redirect('/home')`), impedindo qualquer bypass de autenticação.
- **Rota Home (`/home`)**: Server Component que valida `getCurrentAppUser()`. Requisições sem sessão ativa válida de `users` são redirecionadas para `/login` antes de qualquer entrega de layout ou dados operacionais.
- **Rota Login (`/login`)**: Se o usuário já possuir sessão válida ativa, é redirecionado automaticamente para `/home`.

---

## 5. UI e Controles Indisponíveis

- **UserMiniCard**: Exibe o `displayName` real do usuário autenticado, com identificação neutra `"Usuário NEX+"` e avatar derivado deterministicamente de suas iniciais. Inclui menu de contexto para a ação de `"Sair"`.
- **Manter conectado**: Preservado visualmente, porém com atributo `disabled` e indicação acessível (`"Disponível em uma etapa futura."`).
- **Esqueci minha senha?**: Preservado visualmente, desabilitado com `aria-disabled="true"` e indicação acessível. Não há adapter de e-mail ou reset implementado nesta etapa.

---

## 6. Matriz de ACL e Próximos Passos

- A matriz fina de permissões societárias/funcionais permanece deliberadamente aberta.
- **Cloudflare Tunnel e Access**: Pertencem exclusivamente ao **Escopo 0.8B** (borda remota).
- **Local API Caveat**: A API Local do Payload (`payload.create`, `payload.find`) bypassa access control por padrão. Quando código futuro atuar em nome de usuários, deve-se passar explicitamente `overrideAccess: false` e `user`/`req`.
