# NEX+ · Capability Registry & Route/Terms Ledger
**Especificação Factual Canônica — Escopo 0.5 (Bloco 0.5B · Rodada B1.3 — Microcorreção Semântica Pré-Checkpoint)**  
**Status**: Especificação Factual Aprovada para Checkpoint  
**Contexto**: Branch `feat/contracts-l0-l1-policy` | HEAD Base `f9fc3f5807d85d1dd823f454e2b1fb195beda76b`  
**Referência Canônica**: [`docs/contracts-l0-l1.md`](file:///g:/Nex+/NEX-Home/docs/contracts-l0-l1.md) (Bloco 0.5A)

---

## 1. Fundamentos & Princípio de Soberania do Domínio

O Bloco 0.5B estabelece como o **Plano de Autoridade (L0)** modela, armazena e versiona factual e deterministicamente:
1. **O que o NEX+ sabe fazer** (*Capability Registry*);
2. **Quais rotas técnicas existem** (*Route Ledger*);
3. **Quais vínculos de compatibilidade foram chancelados por L0** (*Capability-Route Binding Ledger*);
4. **Quais termos comerciais e de privacidade estão vigentes** (*Terms Ledger*);
5. **Qual conjunto exato desses fatos sustentou uma decisão operacional** (*Revision Pinning*).

```
┌────────────────────────────────────────────────────────────────────────┐
│                        L0 · DOMAIN AUTHORITY                           │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                 Capability Registry (O "Quê")                  │   │
│   │   - CapabilityKey: suppliers.catalog.query                     │   │
│   │   - CapabilityRevision: rev_cap_sup_v1 (Snapshot Imutável)     │   │
│   │   - Semantic Contract: Input/Output JSON Schema 2020-12        │   │
│   │   - DomainEffect: none (read_only)                             │   │
│   └───────────────────────────────▲────────────────────────────────┘   │
│                                   │                                    │
│             ┌─────────────────────┴──────────────────────┐             │
│             │ CapabilityRouteBindingRevision (Atestação) │             │
│             │  - BindingRevisionId: rev_bind_pg_sup_v1   │             │
│             │  - AdapterRef: adapter_pg_sql_v1           │             │
│             │  - NativeContractRef: native_pg_schema_v1  │             │
│             └─────────────────────┬──────────────────────┘             │
│                                   │                                    │
│   ┌───────────────────────────────▼────────────────────────────────┐   │
│   │                    Route Ledger (O "Como")                     │   │
│   │   - RouteKey: postgres.suppliers_table_read                   │   │
│   │   - RouteRevision: rev_route_pg_v1 (Snapshot Imutável)         │   │
│   │   - RouteTermsRevision: rev_terms_pg_local_v1                  │   │
│   │   - RouteObservation (Live): telemetria efêmera de runtime     │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.1. Princípio Fundamental de Separação
- **Capability é propriedade soberana do domínio NEX+**: Provedores, modelos de IA, servidores MCP, APIs ou executores **NÃO possuem a Capability**. Eles são implementações técnicas representadas em `RouteRevisions`.
- **Validade do Estado Sem Rotas**: Uma `Capability` existente e `active` no domínio com **zero rotas elegíveis** no momento é um **estado operacional perfeitamente válido**. A ausência temporária de rotas não torna a funcionalidade inexistente.

---

## 2. Imutabilidade, Linhagem & Determinação de Vigência (Heads)

### 2.1. Imutabilidade Absoluta de Revisões
`CapabilityRevision`, `RouteRevision`, `CapabilityRouteBindingRevision` e `RouteTermsRevision` são **snapshots estritamente imutáveis**.
- Nenhuma revisão existente pode sofrer alteração retrospectiva de campos ou estado.
- Qualquer evolução, ajuste de contrato, mudança de termos ou transição de lifecycle gera compulsoriamente uma **nova Revision**.

### 2.2. Linhagem & Supersession Explícita (`SupersedesRevisionIds`)
> **Regra Anti-Heurística**: É expressamente proibido determinar a revisão vigente por `created_at` mais recente, maior número sequencial, ordem de inserção física ou maior SemVer.

- A vigência é determinada deterministicamente através de **relações explícitas de substituição (`SupersedesRevisionIds`)**.
- Uma revisão deixa de ser um **HEAD vigente** no instante em que outra revisão válida a supersede explicitamente em sua linhagem.
- A revisão antiga permanece imutável, intacta e eternamente acessível para auditoria.

### 2.3. Invariantes Formais de Supersession
Para preservar a integridade matemática do grafo de linhagem, as relações declaradas em `SupersedesRevisionIds` obedecem obrigatoriamente às seguintes invariantes:
1. **Anti-Self-Supersession**: Uma Revision **não pode** apontar para o seu próprio identificador (`C1 → C1` é estritamente rejeitado).
2. **Anti-Ciclo (Grafo Acíclico Dirigido)**: Relações de supersession **não podem** formar ciclos diretos ou indiretos (`C1 → C2 → C1` é estritamente rejeitado).
3. **Isolamento de Identidade Lógica (Anti-Cross-Identity)**: Uma Revision **não pode** superseder uma revisão pertencente a outra entidade lógica incompatível (ex: uma revisão de `Capability A` jamais pode superseder uma revisão de `Capability B`). Toda relação de substituição permanece estritamente confinada à mesma linhagem canônica da entidade.
4. **Exclusividade Relacional**: Timestamps, datas (`created_at`), UUIDs, SemVer ou ordenação física de inserção **não constituem** e **não substituem** a relação explícita de supersession.

*Estas invariantes aplicam-se uniformemente a `CapabilityRevision`, `RouteRevision`, `CapabilityRouteBindingRevision` e `RouteTermsRevision`.*

### 2.4. Múltiplos Heads Vigentes Paralelos
O sistema suporta formalmente que uma `CapabilityKey` ou `RouteKey` possua **múltiplos HEADS vigentes em paralelo** (ex: `rev_cap_v1: active` e `rev_cap_v2: active` coexistindo simultaneamente para dar suporte a clientes com versões de contrato distintas, sem que v2 superseda v1). O conjunto factual vigente é o conjunto de heads não supersedidos de suas linhagens.

### 2.5. Lifecycle $\neq$ Head
- **LifecycleState** (`active`, `deprecated`, `retired`): Representa o estado de governança semântica daquela revisão específica.
- **Head**: Responde se aquela revisão foi ou não formalmente substituída por outra revisão na árvore de linhagem.
- *Exemplo*: Se `C1 (active)` for supersedida por `C2 (deprecated)`, C1 permanece congelada no passado com seu texto histórico `active`, mas **não é mais um Head**. O Head atual é C2. Novas Decisions só podem selecionar Heads vigentes.
- *Candidatura*: Revisões com estado `retired` não são candidatas para novas operações; revisões `active` e `deprecated` podem existir como Heads operacionais (com a governança de uso de `deprecated` sendo delegada ao Policy Engine no Bloco 0.5C).

---

## 3. Contratos Canônicos (Capability) $\times$ Contratos Nativos (Route)

### 3.1. JSON Schema 2020-12 & Limite Estrutural
- Os contratos canônicos de entrada e saída da `CapabilityRevision` são definidos formalmente no dialeto **JSON Schema Draft 2020-12** (declarando `$schema: "https://json-schema.org/draft/2020-12/schema"`).
- **Estrutura $\neq$ Semântica**: A compatibilidade puramente estrutural em JSON Schema não prova equivalência semântica (ex: `amount: number` em BRL vs `amount: number` em centavos). JSON Schema sozinho **nunca autoriza a criação automática de um Binding**. A equivalência exige validação semântica formal em L0.

### 3.2. Contrato Nativo da Rota (`NativeContractRevisionRef`)
- A `RouteRevision` documenta seu contrato externo original através de um **`NativeContractRevisionRef`**.
- **Exigência de Reprodutibilidade Histórica**: O `NativeContractRevisionRef` identifica a **revisão exata e imutável** do contrato externo que foi avaliada (via snapshot, digest, versionamento de pacote ou especificação congelada). Uma URL mutável isolada não é suficiente.
- O contrato nativo serve de especificação técnica para o adapter e não concorre com o contrato canônico do domínio.

### 3.3. Versão do Adapter (`AdapterRevisionRef`)
- O `AdapterRevisionRef` identifica a revisão exata do código/transformador de software utilizado para atestar a compatibilidade entre a rota e a capability. Mudanças no código do adapter exigem nova `AdapterRevisionRef` e novo Binding.

---

## 4. Capability-Route Binding Ledger (`CapabilityRouteBindingRevision`)

O Binding é a entidade canônica imutável que registra a afirmação de compatibilidade chancelada por L0.

```
┌────────────────────────────────────────────────────────────────────────┐
│                  CapabilityRouteBindingRevision                        │
│                                                                        │
│  - BindingRevisionId: rev_bind_01j9...                                 │
│  - CapabilityRevisionId: rev_cap_suppliers_v2                          │
│  - RouteRevisionId: rev_route_postgres_v1                              │
│  - AdapterRevisionRef: adapter_pg_sql_transformer_v2                   │
│  - NativeContractRevisionRef: native_pg_table_schema_v2                │
│  - SupportedExecutionModes: [atomic_batch, non_streaming]              │
│  - DomainEffectAtested: none (compatível com read_only)                │
│  - Provenance: l0_certification_suite_2026_08                          │
│  - SupersedesRevisionIds: [rev_bind_pg_sup_v1]                         │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.1. Semântica do Binding Canônico
- **Existência Apenas Pós-Validação**: Não existe Binding canônico no estado `unverified` ou `candidate`. Dados em descoberta pertencem à fase pré-canônica. Um `CapabilityRouteBindingRevision` só é gerado após L0 verificar e aceitar formalmente a afirmação de compatibilidade.
- **Mapeamento N:M Desacoplado**: Uma mesma `RouteRevision` física (ex: `R1`) pode possuir bindings independentes com `C1` e `C2`, eliminando a criação de revisões falsas da rota.
- **Cobertura Operacional Completa**: A atestação do Binding cobre input, output, unidades semânticas, mapeamento de erros, suporte a streaming/async e compatibilidade com o `DomainEffect`.
- *Exemplo de Modo*: Se a Route suporta streaming, mas a Capability exige resultado final atômico, o Binding atesta formalmente o uso da rota em modo não-streaming ou através de adapter que consolida a resposta.

---

## 5. Route Identity & Representação Ortogonal de Execução

### 5.1. Identidade: `RouteKey` $\times$ `RouteRevisionId`
- **`RouteKey`**: Identificador estável da alternativa técnica de execução (ex: `postgres.suppliers_direct`, `google.gemini_2_5_flash_rest`).
- **`RouteRevisionId`**: Snapshot imutável da definição técnica, localidade e comportamento da rota.

### 5.2. Desacoplamento Ortogonal de Localidade, Controle e Egress
Elimina-se o uso de rótulos ambíguos (como "Híbrido"), decompondo a execução em quatro dimensões factuais independentes:

1. **`NetworkTopologyScopes`** (Zero ou mais):
   - `loopback`: Tráfego estritamente no host local (ex: socket Unix, 127.0.0.1).
   - `lan`: Tráfego restrito à rede local / intranet corporativa privada.
   - `wan`: Tráfego através da internet pública ou redes externas.
   *(Rotas compostas podem registrar legitimamente `[loopback, wan]`)*.
2. **`ControlOwnership`**: `operator_managed`, `third_party`, `mixed`, `unknown`.
3. **`ExternalServiceNature`**: `ai_third_party`, `non_ai_third_party`, `none`, `mixed_unknown`.
4. **`CrossesEgressBoundary`** (`boolean`): Fato objetivo se os dados cruzam o perímetro de soberania local em direção a serviços externos.

> **Invariante do Gateway Local**: Uma rota que se conecta a um gateway/proxy local em `loopback`, mas cujo gateway repassa conteúdo para um provedor externo na `wan`, registra compulsoriamente `NetworkTopologyScopes = [loopback, wan]` e `CrossesEgressBoundary = true`. O primeiro hop local não mascara o egress externo.

---

## 6. DomainEffect $\times$ Efeitos de Infraestrutura

Para evitar contradições em flags técnicas, a mutabilidade é separada entre efeitos no domínio de negócio e efeitos auxiliares de infraestrutura:

### 6.1. `DomainEffect`
Responde se a execução da rota tem potencial para alterar o recurso ou estado do domínio que a Capability observa ou opera:
- **`none`**: Ausência total de mutação no estado de negócio do recurso (compatível com Capabilities `read_only`).
- **`may_mutate_domain`**: A execução altera ou pode alterar dados, entidades ou estados observáveis de negócio.

### 6.2. Distinção de Efeitos de Infraestrutura
- Efeitos auxiliares normais de infraestrutura (realização de `HTTP GET`, geração de logs de acesso, consumo de quotas, aquecimento de cache, telemetria) registram **`DomainEffect = none`**.
- Se uma rota de leitura executar ações que alterem o estado de negócio observável (ex: marcar mensagem como lida, incrementar contador comercial, alterar status de transação), ela registra **`DomainEffect = may_mutate_domain`** e é **rejeitada** para bindings com Capabilities `read_only`.

---

## 7. IdempotencyProfile (Fato Contratual $\neq$ Autorização de Retry)

A idempotência é documentada como um perfil técnico com escopo, não como um booleano simplista.

### 7.1. Estrutura do `IdempotencyProfile`
- **`support_type`**: `none`, `natural`, `keyed`, `unknown`.
- **`ScopeAndConditions`** (quando `keyed` ou `natural` sob restrições):
  - `operation_scope`: Endpoints, métodos ou versões de API em que a garantia é válida.
  - `account_scope`: Escopo da chave (por conta, por tenant, global).
  - `key_placement`: Cabeçalho/campo esperado (ex: `Idempotency-Key`).
  - `retention_window`: Janela de validade da chave (ex: 24 horas).
  - `payload_restrictions`: Regras para payloads idênticos vs divergentes com a mesma chave.
  - `provenance`: Origem da especificação contratual e grau de verificação.

### 7.2. Invariante Soberana de Retry
> **O `IdempotencyProfile` é um fato técnico e NUNCA concede permissão automática de retry.**  
> Diante de `OutcomeAssessment = indeterminate`, a invariante **`INV-12`** é absoluta: é terminantemente proibido o retry cego de mutação, independentemente de a rota possuir suporte a idempotência.

---

## 8. Terms Ledger: `RouteTermsRevision`, Custos Decompostos, Entitlements & Conflitos

### 8.1. Decomposição do Modelo de Custos e Entitlements
O modelo factual separa estritamente a obrigação de cobrança (*Billing*) dos benefícios e gratuidades (*FreeEntitlements*):

#### A) Eixo de Cobrança (Billing)
1. **`BillingStatus`**: `known_none`, `known_components`, `unknown`.
2. **`BillingComponents`** (Lista de 0..N componentes factuais quando `known_components`):
   - `fixed_subscription`: Valor fixo periódico.
   - `flat_contractual`: Valor fechado sob contrato.
   - `metered_usage`: Cobrança por token, requisição ou tempo.
   - `metered_overage`: Cobrança por volume excedente ao plano base.
   - `one_time`: Tarifa única por disparo.
   - `unknown`: Componente de custo não especificado.

#### B) Eixo de Benefícios e Gratuidades (FreeEntitlements Composáveis)
1. **`FreeEntitlementStatus`**:
   - **`known_none`**: Foi formalmente determinado que não há benefícios/gratuidades conhecidos aplicáveis naquele escopo.
   - **`known_entitlements`**: Existe pelo menos um benefício/entitlement factual conhecido e registrado.
   - **`unknown`**: Informação de gratuidade insuficiente ou não auditada (*nunca inferir `known_none` pela simples ausência de elementos na lista*).
2. **`FreeEntitlements`** (Lista de 0..N benefícios independentes quando `known_entitlements`):
   - `recurring_free_allowance`: Cota periódica contratual gratuita (ex: 1000 chamadas/mês grátis).
   - `recurring_full_free`: Serviço integralmente gratuito de forma permanente no escopo.
   - `promotional_credit`: Crédito financeiro/promocional de teste (**NÃO constitui gratuidade recorrente**).
   - `trial`: Período/plano de testes temporário (**NÃO constitui gratuidade recorrente**).
   - `custom_allowance`: Benefício pontual ou de classe específica.

### 8.2. Escopo e Condições Independentes por Entitlement
Cada benefício na lista `FreeEntitlements` pode possuir ou referenciar dimensões factuais próprias:
- `applicability_scope`: Condições em que o benefício é aplicável (ex: por conta, por região).
- `quota_amount` e `unit`: Quantidade e unidade da cota (ex: 1000 requisições, US$ 50).
- `renewal_period`: Período de reinício da franquia (ex: mensal, diário, pontual).
- `validity_window`: Janela temporal de vigência/expiração.
- `provenance` & `verification_status`: Rastreabilidade de quem atestou o benefício.

> **Princípio de Não-Fusão**: Uma rota que oferece simultaneamente uma franquia recorrente de 1000 chamadas/mês (`recurring_free_allowance`) e um crédito promocional de R$ 50 (`promotional_credit`) preserva **ambos os fatos em paralelo**, com seus respectivos prazos e regras de renovação independentes.

### 8.3. TermsApplicability & Resolução Factual de Conflitos
- **`TermsApplicability`**: Descreve de forma declarativa onde/quando os termos se aplicam (`account_tier`, `region`, `request_mode = "zdr"`, `credential_profile`, `endpoint_class`).
- **Termos Componíveis $\neq$ Conflito**: Termos e entitlements que coexistem e se complementam (ex: subscription fixa + overage metered, ou allowance + crédito promocional) compõem legitimamente o retrato factual aplicável.
- **Tratamento de Conflitos Factualmente Não Resolvidos**:
  - Se dois `RouteTermsRevision` heads vigentes aplicam-se ao mesmo contexto/operação, possuem escopos sobrepostos e fornecem fatos materiais incompatíveis, sem que um superseda o outro e sem regra factual explícita de composição:
  - **É terminantemente proibido escolher um vencedor por heurística** (`created_at`, timestamp, maior UUID, SemVer ou ordem de inserção).
  - O Bloco 0.5B registra deterministicamente um **CONFLITO FACTUAL NÃO RESOLVIDO**.
  - A consequência de governança e autorização pertence exclusivamente ao Policy Engine (0.5C), que rejeitará a rota ou suspenderá a decisão por ausência de certeza factual.
- **Sem Precedência Implícita por "Mais Específico"**: Políticas gerais de provedor (*provider-wide*) não são herdadas tacitamente por endpoints específicos, e regras específicas não sobrescrevem genericamente dados conflitantes sem prova factual explícita de sobreposição. Na ausência de prova, preserva-se `UNKNOWN` ou `CONFLITO`.

---

## 9. FactProvenance, Freshness & o Estado `UNKNOWN`

### 9.1. Eixos do `FactProvenance`
Todo fato registrado em L0 decompõe sua rastreabilidade em três dimensões:
1. **`Source`** (Quem afirmou): `provider_published_terms`, `official_docs`, `aggregator_feed`, `operator_assertion`, `runtime_observation`, `internal_derivation`.
2. **`AcquisitionBasis`** (Como foi obtido): `declared`, `observed`, `derived`, `measured`, `imported`.
3. **`VerificationStatus`**: `unverified`, `corroborated`, `empirically_verified`, `unknown`.

### 9.2. Fato Canônico em L0
Um fato é canônico porque L0 aceitou seu registro no ledger com proveniência explícita. Isso não significa que L0 ateste onisciência empírica no mundo físico. O Policy Engine (0.5C) avaliará se o grau de verificação atende à política da Decision.

### 9.3. `UNKNOWN` $\times$ `STALE`
- **`UNKNOWN`**: Ausência de dados confiáveis conhecidos.
- **`STALE`**: Dado previamente conhecido cuja idade temporal (`observed_at`) exige reavaliação de frescor pelo Policy Engine.

---

## 10. Tripla Separação: Static $\times$ Temporal $\times$ Live

```
┌────────────────────────────────────────────────────────────────────────┐
│ A) STATIC DEFINITION (Imutável / Heads por Linhagem)                   │
│    CapabilityRevision · RouteRevision · CapabilityRouteBindingRevision │
├────────────────────────────────────────────────────────────────────────┤
│ B) TEMPORAL TERMS (Versionada / Vigência e Supersession)               │
│    RouteTermsRevision (BillingComponents, Entitlements, Privacy, Scopes)│
├────────────────────────────────────────────────────────────────────────┤
│ C) LIVE OBSERVATION (Volátil / Efêmera de Runtime)                     │
│    RouteObservation (Health imediato, cooldown, quota residual)        │
└────────────────────────────────────────────────────────────────────────┘
```

### 10.1. RouteObservation (Efêmera) $\times$ RouteEvaluation (Snapshot Material)
- A **`RouteObservation`** armazena telemetria transitória em tempo real e pode ser descartada da memória sem violar a rastreabilidade.
- Quando um fato de runtime influencia materialmente a elegibilidade de uma rota, a **`RouteEvaluation`** (entidade canônica de L0 congelada no Bloco 0.5A) grava um **snapshot imutável dos fatos materiais utilizados** (ex: `quota_remaining_observed`, `health_status`, `resolved_terms_applicability`).
- **Invariante de Segurança (`INV-08`)**: Se a aplicabilidade depender de credenciais, o snapshot na `RouteEvaluation` registra apenas identificadores não-secretos, escopos ou profiles, sendo estritamente proibida a persistência de chaves ou senhas em texto claro.

---

## 11. Revision Pinning no Decision Ledger

Toda `Decision` operacional registra e fixa a cadeia completa de identidades imutáveis:

```
Decision Snapshot (L0 Ledger)
  ├── DecisionId: dec_01j9...
  ├── PinnedCapability: CapabilityRevisionId
  ├── PinnedBinding: CapabilityRouteBindingRevisionId
  │     ├── (Resolve AdapterRevisionRef)
  │     └── (Resolve NativeContractRevisionRef)
  ├── PinnedRoute: RouteRevisionId
  ├── PinnedTerms: RouteTermsRevisionId
  └── AssociatedRouteEvaluation: RouteEvaluationId
        └── (Snapshot dos fatos materiais live e de applicability resolvidos)
```

Essa cadeia garante que uma Decision possa ser historicamente auditada e reproduzida mesmo após anos de alterações no catálogo, mudanças de contratos externos e reajustes comerciais.

---

## 12. Validação Semântica contra os 18 Testes Obrigatórios (Rodada B1.3)

Todos os cenários são classificados deterministicamente pelo modelo factual de 0.5B:

1. **Route possui somente recurring free allowance**:  
   *Classificação*: `DETERMINÍSTICO`.  
   *Fato*: `FreeEntitlementStatus: known_entitlements`, lista `FreeEntitlements` contendo 1 elemento do tipo `recurring_free_allowance`.

2. **Route possui somente promotional credit**:  
   *Classificação*: `DETERMINÍSTICO`.  
   *Fato*: `FreeEntitlementStatus: known_entitlements`, lista `FreeEntitlements` contendo 1 elemento do tipo `promotional_credit` com data limite associada.

3. **Route possui recurring free allowance + promotional credit simultaneamente**:  
   *Classificação*: `DETERMINÍSTICO`.  
   *Fato*: `FreeEntitlementStatus: known_entitlements`, lista `FreeEntitlements` preserva ambos os objetos em paralelo sem perda de dados.

4. **Route não possui entitlement e isso foi confirmado**:  
   *Classificação*: `DETERMINÍSTICO`.  
   *Fato*: `FreeEntitlementStatus: known_none`, lista vazia preservada com status formal explícito.

5. **Informação sobre entitlement nunca foi auditada**:  
   *Classificação*: `DETERMINÍSTICO` (preserva estado `UNKNOWN`).  
   *Fato*: `FreeEntitlementStatus: unknown`.

6. **Allowance expira/esgota, promotional credit permanece**:  
   *Classificação*: `DETERMINÍSTICO`.  
   *Fato*: Avaliação temporal independente; a expiração da cota recorrente não invalida o saldo do crédito promocional.

7. **Promotional credit expira, allowance recorrente permanece**:  
   *Classificação*: `DETERMINÍSTICO`.  
   *Fato*: A expiração da janela do crédito pontual mantém a cota recorrente renovável intacta.

8. **Dois entitlements possuem applicability diferente**:  
   *Classificação*: `DETERMINÍSTICO`.  
   *Fato*: Cada entitlement carrega seu próprio `applicability_scope` (ex: allowance para região BR, crédito para tier Enterprise).

9. **Billing metered + allowance + promotional credit coexistem**:  
   *Classificação*: `DETERMINÍSTICO`.  
   *Fato*: Eixos ortogonais preservados: `BillingStatus: known_components` (`metered_usage`) + `FreeEntitlementStatus: known_entitlements` (`recurring_free_allowance`, `promotional_credit`).

10. **Trial existe, mas não existe benefício recorrente**:  
    *Classificação*: `DETERMINÍSTICO`.  
    *Fato*: Tipado explicitamente como `trial`; não é promovido a `recurring_full_free`.

11. **Supersession C1 → C2 válida na mesma linhagem**:  
    *Classificação*: `DETERMINÍSTICO`.  
    *Fato*: `C2.SupersedesRevisionIds = [C1]`. C1 deixa de ser Head, C2 assume como Head vigente.

12. **Supersession C1 → C1 (self-supersession)**:  
    *Classificação*: `DETERMINÍSTICO` (rejeitado por invariante anti-self-supersession).

13. **Supersession C1 → C2 → C1 (ciclo)**:  
    *Classificação*: `DETERMINÍSTICO` (rejeitado por invariante de grafo acíclico).

14. **Revision de Capability A tenta superseder Capability B**:  
    *Classificação*: `DETERMINÍSTICO` (rejeitado por invariante de isolamento de identidade canônica).

15. **Dois RouteTerms heads aplicáveis possuem fatos compatíveis e componíveis**:  
    *Classificação*: `DETERMINÍSTICO`.  
    *Fato*: Composição aditiva preservada (ex: assinatura base T1 + overage T2).

16. **Dois RouteTerms heads aplicáveis possuem fatos incompatíveis sem supersession**:  
    *Classificação*: `UNKNOWN/CONFLICT preservado deterministicamente`.  
    *Fato*: L0 registra conflito semântico explícito; nenhum vencedor é escolhido por heurística.

17. **Cenário 16 avaliado sob ordenação temporal**:  
    *Classificação*: `DETERMINÍSTICO`.  
    *Fato*: A regra anti-heurística proíbe terminantemente a escolha por `created_at` ou timestamp.

18. **Decision antiga auditada após supersession futura**:  
    *Classificação*: `DETERMINÍSTICO`.  
    *Fato*: Grafo imutável de IDs pinados reconstrói o estado exato da época sem interferência da nova revisão.

---

## 13. Exemplos Conceituais Demonstrativos

### Exemplo A: Capability Active com Rota Externa sob Billing Metered e Múltiplos Entitlements
- **Capability**: `suppliers.catalog.query` @ `rev_cap_sup_v1` (`DomainEffect = none`).
- **Route**: `gemini.semantic_search` @ `rev_route_gemini_v1` (`CrossesEgressBoundary: true`).
- **Terms**: `rev_terms_gemini_v1`:
  - `BillingStatus`: `known_components` (`metered_usage`).
  - `FreeEntitlementStatus`: `known_entitlements`.
  - `FreeEntitlements`:
    1. `recurring_free_allowance` (1.500 requests/mês na região BR).
    2. `promotional_credit` (US$ 100 com validade até 2026-12-31).
  - `TermsApplicability`: `training_opt_out_guaranteed = true` sob `request_mode = "zdr"`.

### Exemplo B: Capability Active com Zero Rotas Elegíveis
- **Capability**: `shipping.carrier_rate.calculate` @ `rev_cap_ship_v1` (`DomainEffect = none`).
- **Route**: `carrier.fedex_rest` @ `rev_route_fedex_v1`.
- **Fato Live**: `RouteObservation` reporta `health = unreachable`.
- *Resultado*: A Capability permanece `active`. A `RouteEvaluation` grava o snapshot da falha de conectividade e reporta `no_eligible_route`, suspendendo em `HumanEscalation` sem alterar o catálogo de domínio.

### Exemplo C: Route sem Entitlement Confirmada vs Rota Não Auditada
- **Route A**: `market.scraping_api` com `FreeEntitlementStatus: known_none` (comprovadamente paga em todas as chamadas).
- **Route B**: `legacy.partner_api` com `FreeEntitlementStatus: unknown` (não auditada; não assume gratuidade).

---

## 14. Fronteira Arquitetural: Bloco 0.5B $\times$ Bloco 0.5C

```
┌────────────────────────────────────────────────────────────────────────┐
│                        0.5B: LEDGER DE FATOS                           │
│  "Quais são os fatos objetivos, técnicos e contratuais vigentes?"      │
│  - Schemas, localidade, egress, idempotência, billing, entitlements.   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Fatos Fidedignos com Provenance
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       0.5C: POLICY ENGINE & GATES                      │
│  "Dados estes fatos, esta rota é elegível para esta Decision?"         │
│  - Autorização de Egress para LOCAL-ONLY, conformidade Zero-Cost,      │
│    exigência de Confirmation Gates, seleção de rota e fallback.        │
└────────────────────────────────────────────────────────────────────────┘
```

- **O Bloco 0.5B NÃO decide**: Zero-Cost, elegibilidade de egress para `LOCAL-ONLY`, autorização de ACL, exigência de confirmação humana ou retry.
- **O Bloco 0.5B DEVE fornecer**: Todos os fatos, tipagens, proveniências e termos condicionais necessários para que o Bloco 0.5C execute sua governança matemática e determinística.

---

## 15. Referências Externas de Desenho

As seguintes especificações informam as diretrizes deste documento, **sem constituir dependências de software do NEX+**:
- **Model Context Protocol (MCP - Revisão Publicada 2026-07-28)**: Padrão de descoberta de ferramentas (`tools/list`), JSON Schema 2020-12 completo para ferramentas, Tasks como extensão e desacoplamento de transporte.
- **A2A Agent Card / Skills Specification**: Modelagem de cartões de capacidades e contratos semânticos de agentes.
- **OpenAPI 3.2 Specification**: Padrões de interfaces desacopladas e metadados de transporte.
- **JSON Schema Draft 2020-12**: Padrão canônico de validação de schemas de entrada e saída.
- **Stripe API Idempotency Specification (v1 / v2)**: Padrões de escopo, janelas de retenção e restrições de payload em operações com chave de idempotência.
- **Padrões de Roteamento LiteLLM / OpenRouter**: Princípios de normalização de provedores e rastreamento de quotas.

---
*Fim da Especificação Canônica do Bloco 0.5B (Rodada B1.3 — Microcorreção Semântica Pré-Checkpoint).*
