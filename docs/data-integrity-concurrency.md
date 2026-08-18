# Contrato Técnico — Integridade de Dados, Concorrência e Escrita Multiwriter

Este documento estabelece as diretrizes normativas de arquitetura, concorrência, transações e integridade de dados para o **NEX+ Home**.

---

## 1. Topologia e Princípio Central de Escrita

O NEX+ Home adota uma arquitetura logicamente **multiwriter**, com ponto único de escrita centralizado na camada de aplicação:

```text
[ Usuários Humanos / MAX / Jobs em Background / Automações ]
                           ↓
               [ Backend NEX+ / Payload CMS ]
                           ↓
                   [ PostgreSQL 18 ]
```

- **Autoridade Canônica**: O PostgreSQL é o repositório de estado canônico e a autoridade final de integridade de dados do sistema.
- **Canal de Escrita Obrigatório de Produto**: Todos os writers normais de produto (usuários humanos, agentes de IA como o MAX, rotinas agendadas e integrações) devem submeter suas mutações exclusivamente através do backend/Payload.
- **Isolamento de Credenciais**: Frontend, MAX, jobs e automações de produto não recebem `DATABASE_URL` nem escrevem SQL diretamente.
- **Acesso Direto Excepcional e Auditado**: O acesso direto ao PostgreSQL é estritamente excepcional, reservado a operações administrativas, diagnóstico, manutenção, execução controlada de migrations ou procedimentos de backup/restore através de rotinas operacionais documentadas e auditadas.
- **Princípio do Menor Privilégio na Conexão**:
  - A role `nex_home_app` pode ser utilizada por ferramentas administrativas aprovadas quando necessário e seguro (ex.: utilitários `pg_dump` e `pg_restore` no banco da aplicação conforme o runbook oficial).
  - A role `postgres` permanece restrita a operações que exigem estritamente privilégios de administração do cluster ou superuser (`CREATE DATABASE`, `DROP DATABASE`, gerenciamento global).

---

## 2. Divisão de Responsabilidades: PostgreSQL vs. Payload

A integridade do sistema é estruturada sob o princípio de **defesa em profundidade**:

| Dimensão | Responsabilidade Principal | Papel do Payload (Aplicação) | Papel do PostgreSQL (Banco) |
|---|---|---|---|
| **Integridade Estrutural** | PostgreSQL | Validação prévia rápida e amigável para o cliente | Garantia final e mandatória (`NOT NULL`, tipos, `PK`, `UNIQUE`, `FK`, constraints) |
| **Autorização & ACL** | Payload | Execução de Access Control, verificação de identidade e escopo | Fiscalização estrutural via schemas/roles (e futuramente RLS) |
| **Regras de Negócio** | Payload | Orquestração de fluxos, transições de estado e *side-effects* | Imposição de invariantes invariáveis de domínio |
| **Concorrência & Transações**| Compartilhada | Propagação de contexto transacional e políticas de retry | Atomicidade, isolamento ACID e bloqueios de linha/tabela |

> [!IMPORTANT]
> **Regra de Ouro da Integridade**: Se a violação de uma regra puder corromper o estado do sistema independentemente de qual processo executou a escrita, a garantia definitiva **pertence obrigatoriamente ao PostgreSQL**.

---

## 3. Segurança da Local API do Payload

- **Comportamento Padrão de Bypass**: A Local API do Payload (`payload.create`, `payload.update`, etc.) opera por padrão com `overrideAccess: true`, ignorando as funções declaradas de Access Control.
- **Obrigatoriedade de Contexto em Operações Delegadas**: Quando uma chamada via Local API estiver atuando com as permissões de uma identidade sujeita a Access Control (usuários humanos, membros ou identidades restritas), ela deve obrigatoriamente fornecer:
  1. O objeto `user` correspondente à identidade; **E**
  2. `overrideAccess: false` de forma explícita.
  > [!WARNING]
  > Passar o parâmetro `user` de forma isolada **NÃO** ativa a verificação de permissões da Local API; a declaração de `overrideAccess: false` é indispensável.
- **Uso Legítimo do Bypass Privilegiado**: Chamadas deliberadamente privilegiadas podem utilizar o bypass padrão (`overrideAccess: true` ou ausência de flag) **apenas** quando:
  - O fluxo for estritamente interno e explicitamente privilegiado pelo design da aplicação;
  - Houver justificativa arquitetural documentada;
  - As verificações de autorização necessárias tiverem sido completamente validadas pelo próprio fluxo orquestrador;
  - A operação nunca for utilizada como atalho para contornar restrições aplicáveis a um usuário final.

---

## 4. Transações e Propagação de Contexto (`req`)

- **Atomicidade Multi-Operação**: Operações de negócio que envolvam múltiplas mutações e que devam suceder ou falhar em conjunto devem ser delimitadas por um bloco transacional explícito.
- **Propagação do Objeto `req`**: Para que operações aninhadas participem da mesma transação do Payload/Drizzle, o objeto `req` original da transação deve ser obrigatoriamente repassado para todas as chamadas subsequentes.
- **Rollback Comprovado**: Toda operação multi-escrita deve possuir testes que comprovem que falhas parciais realizam rollback integral no PostgreSQL sem deixar dados órfãos.

---

## 5. Nível de Isolamento do PostgreSQL

- **Padrão Adotado**: O cluster opera no nível padrão `READ COMMITTED`.
- **Elevação Restrita**: Não é permitida a elevação global para `REPEATABLE READ` ou `SERIALIZABLE`.
- **Critério para Elevações Pontuais**: Qualquer elevação de isolamento deverá ser restrita a uma transação/write path específico, acompanhada de justificativa técnica da anomalia a ser evitada (ex: *phantom reads*, *write skew*) e de uma política explícita de tratamento de erros de serialização (`40001` / retry).

---

## 6. Prevenção de Lost Update e Concorrência Otimista

- **Sem Mecanismos Genéricos Prematuros**: Não serão criadas colunas ou tabelas genéricas de concorrência enquanto não existirem collections de negócio ativas.
- **Política Explícita Obrigatória**: Ao introduzir a primeira entidade sujeita a edição simultânea por múltiplos escritores, a revisão técnica deverá definir formalmente uma das estratégias:
  1. *Last-Write-Wins* (deliberadamente aceito para o contexto);
  2. Concorrência Otimista (*Optimistic Concurrency Control* - OCC) com token/versão explícito;
  3. Bloqueio Pessimista (`SELECT ... FOR UPDATE`);
  4. Mutações Atômicas incrementais no SQL.
- **Advertência de Convenção**:
  - `updatedAt` **NÃO** é garantia confiável de concorrência otimista (suscetível a colisões e arredondamentos de timestamp).
  - O recurso *Payload Versions* **NÃO** substitui controle de concorrência transacional.

---

## 7. Idempotência e Retries

- **Gatilho de Idempotência**: Toda operação não-idempotente sujeita a reexecução (por timeouts de rede, reconexões, processamento de filas, webhooks, chamadas de IA ou cliques duplicados) deve possuir estratégia de idempotência comprovada antes de entrar em produção.
- **Chave de Idempotência**: Deve representar a **mesma intenção lógica** do cliente/escritor.
- **UUID vs. Idempotência**: O uso de `UUID` como chave primária garante identidade única e facilita o reuso da chave em retries, mas **UUID isolado não torna uma operação magicamente idempotente**.
- **Política de Retries**: É expressamente proibido o retry cego de operações de escrita sem semântica idempotente ou compensatória conhecida.

---

## 8. Chaves Estrangeiras e Unicidade no Banco

- **Foreign Keys**: Toda relação entre entidades de domínio que exija integridade referencial deve utilizar FK nativa no PostgreSQL sempre que tecnicamente suportado pela modelagem.
- **Política `ON DELETE` Consciente**: O uso de `CASCADE` não é padrão universal; deve ser deliberado por relação e adotado apenas quando o ciclo de vida do registro dependente for estritamente subordinado ao pai.
- **Unicidade de Negócio**: Invariantes de unicidade devem ser garantidos por restrições `UNIQUE` / índices únicos no PostgreSQL. Checagens em memória (*check-then-create*) sofrem de *race conditions* sob concorrência e não oferecem garantia real.
- **Enums e Constraints de Domínio**: Valores fechados e regras estruturais simples devem preferir representação nativa no PostgreSQL quando suportado pelas ferramentas de migração auditadas.

---

## 9. Agentes de IA (MAX), Jobs e Automações

- **Isonomia de Regras**: Processos internos de automação, rotinas assíncronas e o agente MAX não possuem privilégios arquiteturais excepcionais.
- **Submissão às Regras**: Suas mutações obedecem rigorosamente às mesmas camadas de validação, autorização aplicável, contratos transacionais e limites de concorrência que os usuários humanos.

---

## 10. Relação com Row Level Security (RLS)

> [!NOTE]
> Este contrato estabelece os princípios de integridade, transações e concorrência no nível da aplicação. Ele **não implementa nem substitui** o *PostgreSQL Row Level Security* (RLS), o qual será tratado em escopo próprio de governança de identidade multiusuário e runtime security.

---

## 11. Review Gates Obrigatórios

A revisão técnica de concorrência e integridade é **obrigatória** na ocorrência de qualquer um dos seguintes eventos pela primeira vez:

1. Criação da **primeira collection de negócio**;
2. Definição da **primeira restrição `UNIQUE` de domínio**;
3. Estabelecimento da **primeira relação com integridade referencial** entre collections de negócio;
4. Modelagem do **primeiro documento editável concorrentemente** por mais de um escritor;
5. Implementação da **primeira operação retryable / webhook / fila**;
6. Implementação do **primeiro job em background com escrita de estado**;
7. Implementação da **primeira rotina de escrita pelo MAX**;
8. Criação da **primeira operação atômica multi-documento**;
9. Implementação da **primeira chamada Local API atuando em nome de usuário**;
10. Introdução de **SQL customizado, triggers ou constraints (`CHECK`/`EXCLUDE`)** fora do padrão do Payload.
