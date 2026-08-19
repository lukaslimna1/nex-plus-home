# NEX+ · Especificação Canônica de Contratos & Invariantes L0 / L1
**Documento Arquitetural — Escopo 0.5 (Bloco 0.5A · Rodada A4 — Correções Semânticas Finais)**  
**Status**: Congelamento Semântico para Checkpoint  
**Contexto**: Branch `feat/contracts-l0-l1-policy` | HEAD Base `843aed99b13f4eac134e19efca99e3389886ba8a`

---

## 1. Fundamentos & Separação de Autoridade (L0 × L1)

O sistema **NEX+** é arquitetado sob uma fronteira estrita e determinística entre o **Plano de Autoridade (L0)** e o **Plano de Experiência e Decisão (L1)**.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        L0 · NEX+ Authority Plane                       │
│  (Soberania: Policy, Capability Registry, Autorização, Evidence Ledger)│
└───────────────────────────────────▲────────────────────────────────────┘
                                    │ Contratos Canônicos & Disposições
                                    │ Evidence Validada & Outcome Assessment
┌───────────────────────────────────▼────────────────────────────────────┐
│                    L1 · MAX Experience & Decision                      │
│      (Cognição: Interpretação, Proposta de Rota, Síntese, Diálogo)     │
└───────────────────────────────────▲────────────────────────────────────┘
                                    │
                               User Input
```

### 1.1. L0 · NEX+ Authority Plane (A Autoridade Soberana)
É a autoridade determinística e transacional do sistema. L0 é soberano e exclusivo sobre:
- **Capability Registry**: o catálogo canônico e versionado de operações que o sistema é capaz de executar.
- **Policy Engine**: verificação estrita de conformidade de dados, egress e governança de custos (`Zero-Cost`).
- **Autorização Contextual**: decisão de L0 sobre se o ator tem direito de realizar determinada ação sobre determinado recurso/alvo no contexto atual (tendo a ACL humana como uma de suas fontes).
- **Confirmation Gate**: validação de consentimento humano explícito vinculado a uma operação concreta com parâmetros materiais fixados.
- **Deterministic Tools**: execução transacional local e comunicação soberana com o banco de dados (PostgreSQL).
- **Evidence Canonicalization**: recepção, validação, normalização e registro canônico de sinais de execução primários (`ExecutionSignal` 0..N $\rightarrow$ `ExecutionEvidence`).
- **Route Eligibility & Decision Ledger**: avaliação de rotas (`RouteEvaluation`), emissão do envelope auditável (`Decision`) e fixação de revisões (*Revision Pinning*).

### 1.2. L1 · MAX Decision & Experience Plane (A Experiência Cognitiva)
É o plano cognitivo de assistência, interpretação, orquestração e diálogo. MAX é responsável por:
- Receber o `InputRecord` e produzir uma `Interpretation` estruturada com provenance.
- Mapear a intenção (`Intent`) para uma `Capability` registrada em L0.
- Avaliar as rotas elegíveis aprovadas por L0 e formular uma proposta de decisão.
- Coordenar a experiência conversacional e sintetizar respostas a partir de dados e evidências validadas.
- Acionar o **Escalonamento Humano (`HumanEscalation`)** diante de ambiguidade, risco, bloqueio de rota ou necessidade de julgamento.

### 1.3. Limites Inegociáveis de Autoridade do MAX
MAX **NÃO** possui autoridade para:
1. Apresentar capabilities não registradas como operacionais ou tentar roteá-las.
2. Auto-autorizar qualquer ação ou contornar checagens de Policy ou Autorização.
3. Declarar sucesso factual de qualquer operação sem um `OutcomeAssessment` validado por L0.
4. Ignorar regras de *LOCAL-ONLY* ou *Zero-Cost*.
5. Modificar, flexibilizar ou reinterpretar políticas de governança e segurança.

---

## 2. Vocabulário Canônico

| Termo | Definição Canônica |
| :--- | :--- |
| **InputRecord** | Registro bruto, imutável e com dupla temporalidade (ocorrência vs observação) do evento ou mensagem originária do ator. |
| **SourceEventIdentity** | Identidade estável da ocorrência na fonte originária (ex: webhook ID, message ID), preservada separadamente do identificador interno. |
| **Interpretation** | Artefato cognitivo derivado e versionado, produzido por L1 a partir de um `InputRecord`, contendo a extração da intenção e parâmetros com rastreabilidade de proveniência. |
| **Intent** | Classificação semântica do objetivo contida dentro de uma `Interpretation`. |
| **Capability** | Descrição abstrata e declarativa de uma função do sistema (o *“o quê”*). Independe de rota ou provedor. |
| **Route** | Canal ou implementação concreta que executa uma Capability (o *“como”* e *“por onde”*). |
| **RouteEvaluation** | Avaliação contextual pré-execução realizada por L0 que atesta se uma Route é elegível para uma Decision específica naquele instante. |
| **Authorization** | Decisão contextual de L0 sobre se o ator possui permissão para executar a ação sobre o alvo naquele contexto (tendo ACL como uma das fontes). |
| **Confirmation** | Consentimento humano explícito emitido em runtime para uma operação concreta com parâmetros materiais fixados. |
| **PolicyDecision** | Veredito formal de L0 sobre conformidade de egress, classificação de dados e governança de custo com reason codes auditáveis. |
| **Decision** | Envelope auditável emitido por L0 para operações governadas que correlaciona todo o ciclo: input, interpretação, autorizações, confirmações, avaliações de rota, tentativas e disposição final. |
| **Attempt** | Unidade concreta e rastreável de disparo físico de uma Route elegível selecionada. |
| **ExecutionSignal** | Sinal primário bruto (0..N por Attempt) emitido pelo executor/driver/observação durante ou ao término de um Attempt. |
| **ExecutionEvidence** | Registro canônico validado, normalizado e gravado por L0 a partir de 1..N `ExecutionSignals` verificáveis. |
| **OutcomeAssessment** | Avaliação formal produzida por L0 a partir do technical outcome, evidências disponíveis e regras da rota, atestando o efeito fático e operacional do Attempt. |
| **Receipt** | Projeção imutável de auditoria gerada a partir dos registros canônicos de uma Decision governada resolvida. |
| **HumanEscalation** | Handoff estruturado de governança acionado diante de ambiguidade, risco, bloqueio de rota ou necessidade de julgamento humano. |

### 2.1. Distinções Semânticas Fundamentais
- **`InputRecord` $\rightarrow$ `Interpretation` $\rightarrow$ `Intent`**: O `InputRecord` é o fato original imutável; a `Interpretation` é a leitura de L1; a `Intent` é a classe semântica resultante.
- **`InputRecordId` $\neq$ `SourceEventIdentity`**: `InputRecordId` é o identificador interno único no NEX+; `SourceEventIdentity` é a identidade fornecida pela fonte originária externa.
- **`Authorization` $\neq$ `ACL Estática`**: A ACL é uma das fontes de entrada; a `Authorization` é a decisão contextual de L0 para o ator, ação, alvo e momento.
- **`Authorization` $\neq$ `Confirmation`**: Estar autorizado não dispensa o consentimento humano explícito (`Confirmation`) para ações de impacto material.
- **`Decision` $\neq$ `Authorization` $\neq$ `PolicyDecision`**: `Authorization` avalia o ator/alvo; `PolicyDecision` avalia dados/rotas/custos; `Decision` é o envelope integrador de L0.
- **`RouteEvaluation` $\neq$ `Attempt`**: A avaliação prévia atesta elegibilidade; o Attempt só existe quando uma rota elegível é concretamente disparada.
- **`ExecutionSignal` (0..N) $\neq$ `ExecutionEvidence` (1..N sinais)**: O sinal é a saída primária bruta do executor; a evidência é o registro consolidado e validado por L0.
- **`Technical Outcome` $\neq$ `OutcomeAssessment`**: O technical outcome descreve o transporte/protocolo técnico; o OutcomeAssessment atesta o efeito factual no domínio do negócio.
- **`Technical Failure` $\neq$ `Factual No-Mutation`**: A falha técnica de um disparo não garante automaticamente a ausência de mutação no sistema de destino.
- **`Human ACL` $\neq$ `AI Egress Policy`**: O direito de um ser humano acessar um dado não autoriza o envio desse dado para modelos de IA externos.

---

## 3. Identificadores Canônicos, Temporalidade & Duplicate Delivery

### 3.1. Identificadores Canônicos
Os identificadores do sistema são **opacos, únicos, estáveis, não reutilizados e estritamente correlacionáveis**, permitindo reconstrução causal completa de qualquer operação.

### 3.2. InputRecord: Origem, Temporalidade Dupla & Identidade de Fonte
O `InputRecord` é registrado na borda e preserva:
- **`InputRecordId`**: Identidade interna única gerada pelo NEX+.
- **`SourceEventIdentity`**: Identidade estável da ocorrência na fonte originária (quando fornecida pela origem).
- Origem / Source (usuário, webhook, trigger interno).
- **Timestamp de Ocorrência na Origem** (quando informado pela fonte).
- **Timestamp de Observação / Recebimento** (momento exato do registro em L0).
- Conteúdo bruto original ou referência canônica imutável.

### 3.3. Duplicate Delivery × Nova Ação Legítima
- **Reentrega Identificável (*Duplicate / Replay*)**: Quando uma mensagem ou webhook traz uma `SourceEventIdentity` já processada, essa reentrega **NÃO autoriza automaticamente um novo side effect mutativo** e deve ser submetida à política de deduplicação/idempotência.
- **Nova Ocorrência Legítima**: Mensagens com conteúdo idêntico, mas com identidades de origem distintas ou eventos comprovadamente novos, geram novos `InputRecords` legítimos.

### 3.4. Grafo Causal e de Correlação
Todo artefato operacional mantém vínculo causal explícito com seus antecedentes:

```
[Correlation Context]
  │
  ├── InputRecord (InputRecordId + SourceEventIdentity)
  │     └── Interpretation (com provenance e version pinning)
  │           └── Decision Envelope (L0) [Exigido em Operações Governadas]
  │                 ├── Target: Capability (Revision pinned)
  │                 ├── Authorization Contextual & Confirmation (Vinculada ao alvo/parâmetros)
  │                 ├── PolicyDecision (Reason codes por eixo)
  │                 ├── RouteEvaluations (Contextual pré-Attempt)
  │                 │
  │                 └── Attempt(s) (1..N tentativas para rotas elegíveis)
  │                       │
  │                       └── ExecutionSignal(s) (0..N sinais brutos por attempt)
  │                             │
  │                             └── ExecutionEvidence (Validada/Canonicalizada por L0)
  │                                   │
  │                                   └── OutcomeAssessment (Derivado de outcome + evidence + regras)
  │                                         │
  │                                         └── Receipt (Projeção Imutável para qualquer desfecho)
```

---

## 4. InputRecord, Interpretação & Ambiguidade Mutativa

### 4.1. Imutabilidade do InputRecord
- O `InputRecord` é registrado no momento exato de entrada e **nunca é modificado ou sobrescrito**.
- Qualquer reinterpretação ou esclarecimento produz uma **nova `Interpretation` versionada**, vinculada ao contexto por correlação, preservando o histórico integral.

### 4.2. Provenance da Interpretação Operacional
Toda `Interpretation` que sustentar uma decisão operacional deve registrar:
- Mecanismo ou interpretador utilizado (incluindo modelo/provedor e versão quando houver LLM).
- Timestamp da inferência.
- Referência direta ao `InputRecord` de origem.

### 4.3. Regra de Ambiguidade Potencialmente Mutativa (Fail-Closed & Preservação)
Se um input sugere uma ação de alteração de estado, mas apresenta ambiguidade de alvo, escopo ou parâmetros:
1. **É PROIBIDO reclassificar silenciosamente a solicitação como `suggestion` ou `conversation`** (o que destruiria a rastreabilidade da intenção mutativa).
2. O sistema preserva o `InputRecord` original.
3. O sistema registra a `Interpretation` com o marcador formal de ambiguidade.
4. O ciclo é imediatamente **suspenso em `clarification_required`**.
5. Após o esclarecimento do usuário, gera-se uma nova `Interpretation` correlacionada para prosseguir.

---

## 5. Taxonomia de Intent & Escopo de Operações Governadas

### 5.1. Taxonomia Canônica de Intent
Todo `InputRecord` processado recebe uma classificação de `Intent`:
1. **`conversation`**: Diálogo contextual, esclarecimento, saudações.
2. **`query`**: Consulta e leitura determinística de dados soberanos sem qualquer alteração de estado.
3. **`analysis`**: Comparação, síntese ou agregação cognitiva sobre dados já recuperados.
4. **`suggestion`**: Proposta formulada por L1 ao usuário. Não provoca mutação até comando explícito.
5. **`action`**: Operação formal de **mutação de estado** no ecossistema (criação, edição, exclusão, envio de mensagem, emissão de pedido).

### 5.2. Critério de Governança (Decision / Receipt em Conversas)
- Saudações e diálogos casuais puros **NÃO exigem a criação do envelope completo de `Decision` operacional nem `Receipt`**.
- A materialização do envelope governado (`Decision` e `Receipt`) é **obrigatória sempre que a interação entrar em um caminho operacional**, envolvendo:
  - Acionamento de uma `Capability` governada;
  - Seleção ou avaliação de uma `Route`;
  - Checagem formal de `Policy` (Egress / Custo);
  - Avaliação de `Authorization` ou `Confirmation`;
  - Invocação de tools ou consultas factuais dependentes de evidência;
  - Disparo de side effects.

---

## 6. Grafo de Dependências de Gates, Suspensões & Terminações

### 6.1. Dependência de Gates (Ordem Não Linear)
As checagens de Autorização, Confirmação, Policy (Egress/Custo) e RouteEvaluation não seguem uma ordem linear rígida universal, pois dependem das características específicas da rota e dos dados envolvidos.

> **Regra Obrigatória**: **Nenhum Attempt pode ser criado enquanto TODOS os gates aplicáveis à Route selecionada não estiverem satisfeitos e válidos no momento do dispatch.**

```
                                  [Decision Envelope (L0)]
                                             │
               ┌─────────────────────────────┼─────────────────────────────┐
               ▼                             ▼                             ▼
       [Authorization]                [Confirmation]               [PolicyDecision]
    (Ator/Alvo/Contexto)           (Consentimento do Ato)        (Egress/Custo/Zero-Cost)
               │                             │                             │
               └─────────────────────────────┼─────────────────────────────┘
                                             │
                                             ▼
                                     [RouteEvaluation]
                                 (Elegibilidade da Rota)
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
                 [SUSPENSÕES]                                [TERMINAÇÕES]
        - clarification_required                     - authorization_denied
        - awaiting_human (HumanEscalation)           - policy_denied
                                                     - no_eligible_route
                                                     - cancelled
```

### 6.2. Invalidação por Mudança Material (*Material Change*)
Se ocorrer alteração material em qualquer elemento que sustentou gates anteriores (ator, ação, alvo, parâmetros, classificação de dados, revisão de Capability/Route, quota de custo):
- **Os gates dependentes são imediatamente invalidados.**
- **É terminantemente proibido reutilizar silenciosamente uma `Confirmation` ou `RouteEvaluation` criada para um contexto materialmente divergente.**

### 6.3. Suspensões × Terminações da Decision
- **Suspensões (`clarification_required`, `awaiting_human`)**: Preservam o contexto e o grafo de correlação, aguardando intervenção para continuar.
- **Terminações (`authorization_denied`, `policy_denied`, `no_eligible_route`, `cancelled`)**: Encerram em definitivo a Decision atual. Qualquer nova tentativa exige uma nova Decision.
- **Retomada Segura (*Resume*)**: A retomada de uma suspensão **NUNCA reexecuta automaticamente Attempts mutativos anteriores**. Side effects já disparados não são repetidos sem uma nova decisão explícita válida.
- **Reason Codes**: Todo estado de negação ou suspensão deve registrar códigos de motivo estruturados detalhando qual gate barrou a operação e a justificativa técnica.

---

## 7. RouteEvaluation & Attempt Lifecycle

### 7.1. RouteEvaluation (Contextual e Temporal)
A `RouteEvaluation` não é uma autorização permanente. Ela reflete a elegibilidade no contexto e momento exatos da análise.
- Se quota, disponibilidade ou policy mudarem antes do disparo, a rota é reavaliada.
- **Rota inelegível NÃO cria Attempt.**

### 7.2. Attempt: Lifecycle × Technical Outcome
O `Attempt` representa exclusivamente o acionamento físico de uma rota elegível. A mutabilidade da operação é uma propriedade intrínseca derivada do contrato da Capability/Action, não um flag arbitrário duplicado no Attempt.

```
           Lifecycle:  [created] ──► [running] ──► [terminal]
                                                        │
                              ┌─────────────────────────┴─────────────────────────┐
                              ▼                         ▼                         ▼
Technical Outcome:       [succeeded]                 [failed]               [timed_out]
                                                   [cancelled]         [unknown_completion]
```

- **Lifecycle do Attempt**: `created` $\rightarrow$ `running` $\rightarrow$ `terminal`.
- **Technical Outcome ao Atingir Estado Terminal**:
  - **`succeeded`**: Conclusão técnica em total aderência ao contrato técnico da rota.
  - **`failed`**: Falha técnica confirmada na chamada/driver.
  - **`timed_out`**: Interrupção por estouro de tempo limite da chamada.
  - **`cancelled`**: Execução abortada antes da conclusão normal, fazendo o registro do Attempt atingir seu estado terminal.
  - **`unknown_completion`**: Perda de conectividade após envio do payload, sem confirmação técnica do driver.

---

## 8. Sinais de Execução, Evidência & Outcome Assessment

```
┌──────────────────┐    ExecutionSignals (0..N)   ┌──────────────────┐
│  Executor / Tool │ ───────────────────────────► │  L0 Authority    │
│  (Driver Físico) │   (Acks, Status, IDs, etc.)  │  (Validação)     │
└──────────────────┘                              └─────────┬────────┘
                                                            │ Canonicalização
                                                            ▼
                                                  ┌──────────────────┐
                                                  │ExecutionEvidence │
                                                  └─────────┬────────┘
                                                            │ Avaliação Factual
                                                            ▼
                                                  ┌──────────────────┐
                                                  │OutcomeAssessment │
                                                  │ - confirmed_mut. │
                                                  │ - confirmed_no_m.│
                                                  │ - indeterminate  │
                                                  └──────────────────┘
```

### 8.1. Produção de Sinais Primários (0..N Signals)
- Um Attempt pode produzir **zero, um ou múltiplos `ExecutionSignals`** (acknowledgments, IDs remotos, status intermediários, payload final, resultados de leitura observacional).
- L0 valida, normaliza, correlaciona e canonicaliza esses sinais em uma **`ExecutionEvidence`** soberana. L0 **não inventa** a prova primária.

### 8.2. Relação Estrutural: Technical Outcome $\rightarrow$ OutcomeAssessment
O `OutcomeAssessment` é a avaliação formal produzida por L0 sobre o efeito fático no domínio do negócio, calculada a partir do conjunto disponível de:
1. `Technical Outcome` do Attempt;
2. `ExecutionEvidence` válida e chancelada;
3. Regras determinísticas de evidência aplicáveis à Route.

> **Regra Fundamental**: **A existência de uma `ExecutionEvidence` suficiente NÃO é requisito para existir um `OutcomeAssessment`. Ela é requisito para qualquer `OutcomeAssessment` factual confirmado.** Na ausência de evidência suficiente ou diante de incerteza técnica, o `OutcomeAssessment` existe e assume o estado `indeterminate`.

### 8.3. Cenários de Zero Signals & Falhas Técnicas
- **Caso A (Attempt `succeeded` + Zero Signals / Evidência Insuficiente)**:
  - **NÃO autoriza confirmação de sucesso factual.**
  - `OutcomeAssessment` permanece `indeterminate`, salvo se a Route possuir regra determinística verificável que comprove o efeito por outro meio soberano.
- **Caso B (Attempt `failed` antes da possibilidade de side effect)**:
  - Pode produzir `confirmed_no_mutation` se e somente se a ausência de side effect for estruturalmente garantida (ex: falha de autenticação no driver antes do envio da requisição).
- **Caso C (Attempt `failed` após envio ou em ponto incerto)**:
  - **NÃO autoriza presumir `confirmed_no_mutation`.**
  - `OutcomeAssessment` permanece `indeterminate` até reconciliação ou evidência adicional.
  - **Invariante**: *Technical Failure $\neq$ Factual No-Mutation automaticamente.*

### 8.4. Sinais Conflitantes & Sinais Tardios
- **Sinais Conflitantes**: Quando sinais válidos relacionados ao mesmo Attempt discordarem e não houver regra determinística de precedência no contrato da Route, L0 **NÃO pode escolher arbitrariamente**. O resultado permanece `indeterminate`.
- **Sinais Tardios**: Sinais válidos recebidos após o Attempt atingir o estado terminal **NÃO apagam nem sobrescrevem silenciosamente** o histórico anterior; motivam uma nova avaliação/reconciliação preservando a rastreabilidade completa.

### 8.5. Declarações Factuais & Proibição de Retry Cego
- **Somente `confirmed_mutation` autoriza L1 a emitir declarações de sucesso mutativo** (*“criado”*, *“alterado”*, *“removido”*, *“enviado”*).
- O estado `indeterminate` **PROÍBE declaração de sucesso, PROÍBE declaração de falha factual e PROÍBE TERMINANTEMENTE retries cegos de mutação**, exigindo reconciliação ou `HumanEscalation`.

---

## 9. Receipt (Projeção Imutável de Auditoria)

- O `Receipt` é uma **projeção imutável de auditoria** gerada a partir dos registros canônicos de qualquer `Decision` governada resolvida (seja com sucesso, negação, cancelamento, `no_eligible_route` ou resolução humana).
- Consolida: `DecisionId`, referências de versão (*Revision Pinning*), `InputRecord` (`InputRecordId` + `SourceEventIdentity`), `Interpretation`, `Authorization`, `Confirmation` (se aplicável), `PolicyDecision`, `RouteEvaluations`, `Attempts`, `ExecutionEvidence` e `OutcomeAssessment`.
- O `Receipt` **NÃO é uma segunda fonte mutável de verdade**. Congelado no momento da emissão, reflete o veredito histórico exato daquela operação.

---

## 10. Políticas Soberanas de Egress, Secrets & Zero-Cost

### 10.1. Ortogonalidade entre ACL Humana e Egress de IA
A autorização humana e a política de saída para IAs externas são **eixos ortogonais e independentes**:
- A permissão humana de ler um dado não autoriza o tráfego desse dado para modelos de IA externos.
- A elegibilidade de uma rota de IA externa não supre a ausência de autorização de acesso humano.

### 10.2. Classificação de Dados: `NORMAL` × `LOCAL-ONLY`
- **`NORMAL`**: Dados operacionais gerais. Podem transitar por rotas externas compatíveis com a política de conformidade.
- **`LOCAL-ONLY` (rotulagem/alias: `LOCKED`)**: Dados que **jamais** podem sair do perímetro do host local/servidor soberano para modelos ou APIs externas.
  - *Comunicação local*: Processos locais e banco local (Postgres) não violam a política `LOCAL-ONLY`.
  - *Herança Restritiva*: A combinação de dados `NORMAL` com dados `LOCAL-ONLY` gera um contexto estritamente `LOCAL-ONLY`.

### 10.3. Tratamento Rigoroso de Secrets
- Chaves de API, senhas, tokens, cookies e credenciais são nativamente **`LOCAL-ONLY` por origem**.
- É terminantemente proibida a inclusão de segredos em texto claro em:
  - Prompts e embeddings externos;
  - Logs de conteúdo, traces, `ExecutionEvidence` ou `Receipt` (independentemente de serem públicos ou privados).

### 10.4. Invariantes Zero-Cost (Governança Financeira)
1. **Zero Fallback Pago Silencioso**: Falha ou indisponibilidade em rota gratuita proíbe escalonamento automático e silencioso para rotas com custo financeiro.
2. **Promotional/Trial $\neq$ Zero-Cost Recorrente**: Créditos temporários ou trials não constituem custo zero permanente.
3. **Esgotamento de Quota**: Quota esgotada torna a rota imediatamente inelegível.
4. **Isolamento de Rotas**: Falha de uma rota não autoriza migração automática para rota de política/custo divergente.

---

## 11. Ownership Matrix (Matriz Canônica de Responsabilidades)

| Ação / Decisão no Ciclo | NEX+ (L0) | MAX (L1) | Executor / Provider | Operador Humano |
| :--- | :---: | :---: | :---: | :---: |
| Registrar `InputRecord` imutável (origem/observação) | **Soberano** | | | |
| Preservar `SourceEventIdentity` e checar replay | **Soberano** | | | |
| Produzir `Interpretation` com provenance e Intent | | **Responsável** | | |
| Validar existência e versão da `Capability` | **Soberano** | | | |
| Emitir decisão contextual de `Authorization` | **Soberano** | | | |
| Validar e vincular `Confirmation` ao ato concreto | **Soberano** | | | **Interveniente** |
| Realizar `RouteEvaluation` e `PolicyDecision` | **Soberano** | | | |
| Formular proposta de `Decision` | | **Responsável** | | |
| Executar fisicamente o `Attempt` na Route | | | **Responsável** | |
| Emitir `ExecutionSignals` primários (0..N) | | | **Responsável** | |
| Validar e gravar `ExecutionEvidence` canônica | **Soberano** | | | |
| Determinar o `OutcomeAssessment` | **Soberano** | | | |
| Apresentar resultado e `Receipt` ao usuário | | **Responsável** | | |
| Arbitrar ambiguidade e `HumanEscalation` | | | | **Soberano** |

---

## 12. Invariantes Canônicas do Sistema (INV-01 a INV-24)

- **`INV-01`**: *Uma Capability não registrada no L0 pode ser discutida conversacionalmente como hipótese, mas é estritamente proibido representá-la como operacionalmente presente, selecioná-la ou roteá-la.*
- **`INV-02`**: *Route é estritamente um canal de execução e não possui autoridade para criar, estender ou modificar uma Capability.*
- **`INV-03`**: *A classificação `LOCAL-ONLY` bloqueia incondicionalmente o envio de dados para qualquer provedor ou IA externa.*
- **`INV-04`**: *Autorização humana válida não concede autorização automática para egress de dados a modelos de IA externos.*
- **`INV-05`**: *Permissão de egress em uma rota não supre a ausência de autorização humana contextual.*
- **`INV-06`**: *Ambiguidade em requisições potencialmente mutativas opera em modo fail-closed, preserva o InputRecord e a Interpretation com provenance, e suspende a execução em `clarification_required`.*
- **`INV-07`**: *Nenhum LLM ou provedor externo possui autoridade para formular, flexibilizar ou modificar políticas do sistema.*
- **`INV-08`**: *Secrets e credenciais nascem `LOCAL-ONLY` e jamais podem ser transmitidos a prompts externos ou gravados em texto claro em logs, traces, evidências ou receipts (públicos ou privados).*
- **`INV-09`**: *Route declarada inelegível em `RouteEvaluation` não pode ser instanciada e não cria `Attempt`.*
- **`INV-10`**: *Sucesso técnico de um Attempt (`technical success`) não implica automaticamente a ocorrência de efeito factual no domínio do negócio.*
- **`INV-11`**: *Sem `ExecutionEvidence` válida e `OutcomeAssessment` confirmado por L0, é terminantemente proibida a emissão de declarações factuais de mutação de estado.*
- **`INV-12`**: *Resultado de execução com `OutcomeAssessment` classificado como `indeterminate` proíbe terminantemente retry cego de mutação.*
- **`INV-13`**: *Falha de execução em uma Route não autoriza cascateamento automático para rotas com classificação de custo ou política divergente.*
- **`INV-14`**: *A política Zero-Cost proíbe qualquer fallback pago silencioso.*
- **`INV-15`**: *O escalonamento humano (`HumanEscalation`) é um handoff formal de governança, vedada a sua utilização como tratamento genérico de erro não tratado.*
- **`INV-16`**: *A herança de sensibilidade é sempre restritiva: a fusão de dados `NORMAL` e `LOCAL-ONLY` gera um contexto estritamente `LOCAL-ONLY`.*
- **`INV-17`**: *O `ExecutionSignal` primário nasce no executor/driver (0..N); L0 valida, normaliza e canonicaliza a `ExecutionEvidence` soberana.*
- **`INV-18`**: *`Decision`, `Authorization`, `Confirmation` e `PolicyDecision` são conceitos formalmente distintos e não podem ser mesclados ou substituídos entre si.*
- **`INV-19`**: *Confirmation é estritamente vinculada a uma operação concreta (ação, alvo e parâmetros materiais); qualquer mudança material invalida a confirmação anterior.*
- **`INV-20`**: *Mudança material em qualquer elemento que sustentou gates anteriores invalida imediatamente os gates dependentes.*
- **`INV-21`**: *A retomada de um fluxo suspenso (`Resume`) preserva o contexto e a correlação, mas NUNCA reexecuta automaticamente side effects mutativos já disparados.*
- **`INV-22`**: *Toda Decision operacional fixa as revisões históricas relevantes de Capability, Route, Policy e contratos aplicáveis (Revision Pinning).*
- **`INV-23`**: *Sinais ou evidências conflitantes ou insuficientes não podem produzir confirmação factual por inferência arbitrária; quando nenhuma regra determinística da Route resolver o conflito, o OutcomeAssessment permanece estritamente `indeterminate`.*
- **`INV-24`**: *Quando a origem fornecer identidade estável de ocorrência (`SourceEventIdentity`), ela deve ser preservada separadamente do `InputRecordId`; a reentrega identificável da mesma ocorrência não autoriza automaticamente novo side effect.*

---

## 13. Questões Abertas para Decisão Humana

As seguintes definições arquiteturais permanecem intencionalmente abertas para deliberação entre **Lucas + ChatGPT**:

1. **Estratégia de Persistência do `Receipt` (Bloco 0.5D)**: Tabela materializada no PostgreSQL vs view sintetizada em runtime correlacionando Decision, Attempts e Evidence.
2. **Formato Físico dos Identificadores**: Definição da representação de banco (UUIDv7 nativo do PostgreSQL 18 vs UUIDv4 vs prefixos em wrappers de aplicação na fronteira Payload).
3. **Mecanismo de Reconciliação para `indeterminate`**: Protocolo de polling, verificação idempotente ou conferência retroativa para chamadas que sofrerem timeout pós-envio.
4. **Catálogo Inicial de Capabilities & Confirmation Gates**: Definição de quais ações da Home exigirão consentimento humano prévio (`Confirmation Gate`) na v1.
5. **Mecanismo de Deduplicação e Idempotência (Bloco 0.5E)**: Protocolo de deduplicação física a partir de `SourceEventIdentity` e chaves de idempotência.
6. **Mecanismo de Revision Pinning**: Estratégia concreta de versionamento semântico (SemVer vs Content Hash) para fixação de revisões no `Decision Ledger`.
7. **Regras Determinísticas de Precedência de Evidência**: Contrato por Route para desempate de sinais múltiplos ou tardios.

---

## 14. Referências Externas de Desenho

As seguintes especificações e padrões da indústria informam os princípios de modelagem do NEX+, **sem constituir dependências rígidas de código**:

- **PostgreSQL 18 UUID**: Suporte nativo a identificadores ordenáveis temporalmente para alta performance em indexação de séries temporais e ledgers.
- **Model Context Protocol (MCP - 2026-07-28)**: Padrão de separação entre catálogo de ferramentas determinísticas, amostragem de modelos e transporte seguro de contexto.
- **OpenTelemetry Semantic Conventions**: Padrões de rastreabilidade distribuída, separação entre atributos de transporte técnico e semântica de domínio.
- **CloudEvents Specification**: Princípios de imutabilidade de eventos, dissociação temporal entre ocorrência na origem e observação no receptor.
- **LangGraph Durable Interrupt & Checkpointing**: Padrões de suspensão determinística para intervenção humana (*human-in-the-loop*) com garantia de não-reexecução de side effects.

---
*Fim da Especificação Canônica Endurecida (Rodada A4).*
