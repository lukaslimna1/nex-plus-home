# NEX+ · ExecutionEvidence & Attempt Ledger
**Escopo 0.5 (Bloco 0.5D / Hardening) — Especificação Arquitetural e Contratos Canônicos**

---

## 1. Fronteira e Posição Arquitetural (0.5C $\rightarrow$ 0.5D $\rightarrow$ 0.5E)

O Bloco 0.5C responde se uma rota satisfaz uma Policy.  
O Bloco 0.5D é a **camada de integridade factual e ledger append-only de execução**:
- Rastreia o ciclo de vida estrito de tentativas de execução (`Attempt`);
- Ingere sinais de execução (`ExecutionSignal`) através de projeção segura por allowlist (sem plaintext de segredos);
- Canonicaliza sinais em evidências fáticas auditáveis (`ExecutionEvidence`);
- Avalia o desfecho factual (`OutcomeAssessment`) sob a máxima: **Technical Success $\neq$ Factual Effect / Result**;
- Exige garantia estrutural explícita (`noSideEffectGuarantee: 'structural'`) para desfechos `confirmed_no_mutation` em falhas pré-dispatch;
- Materializa recibos históricos imutáveis discriminados por kind (`Receipt`);
- Mantém a linearidade unívoca de linhagem de `OutcomeAssessment` por `Attempt` no ledger append-only (`ExecutionLedgerStore`).

> **Fronteira com o Bloco 0.5E**: O 0.5D **NÃO** seleciona rotas, não faz retry, não faz fallback, não checa quotas ao vivo e não executa chamadas de rede. O escalonamento e coordenação de live dispatch pertencem ao 0.5E.

---

## 2. Invariante de Nascimento do Attempt (INV-09)

> **Regra Canônica**: Uma rota inelegível ou negada **NÃO cria Attempt**.  
Rejeições de Policy, negações de autorização humana, cancelamentos pré-dispatch e ausência de rota elegível geram `Receipt`, mas **zero `Attempt`**.

---

## 3. Ciclo de Vida do Attempt (Append-Only)

O `Attempt` não é um objeto mutável. O estado atual é derivado da sequência de eventos append-only:
1. `created` $\rightarrow$ Criado após seleção e autorização da rota para execução.
2. `running` $\rightarrow$ Dispatch iniciado pelo executor.
3. `terminal` $\rightarrow$ Conclusão técnica:
   - `succeeded`
   - `failed`
   - `timed_out`
   - `cancelled`
   - `unknown_completion`

### Transições Proibidas
- `created` $\rightarrow$ `succeeded` direto (sem passar por `running`) é estritamente proibido.
- `terminal` $\rightarrow$ qualquer outro estado é estritamente proibido.
- Nenhuma API `updateAttempt()` ou `deleteAttempt()` é exposta.

---

## 4. Projeção Segura e Proteção de Segredos (INV-08)

- **Default Seguro**: O payload bruto retornado por executores/provedores (`rawPayload`) **NÃO** entra no ledger por padrão.
- **Projeção por Allowlist**: Apenas campos explicitamente contidos na allowlist de metadados seguros são preservados em `ExecutionSignal.safeMetadata`.
- **Sem Plaintext de Segredos**: Tokens, chaves de API, senhas e cookies não permitidos na allowlist são descartados antes do registro no ledger.

---

## 5. Sinais, Evidências e Desfecho Factual

### A. `ExecutionSignal`
Originado do executor/driver. Pode ocorrer $0..N$ vezes para um Attempt, inclusive de forma tardia (*late signal*). Sinais tardios são aceitos pelo ledger, mas **não reabrem nem alteram o status técnico terminal do Attempt**.

### B. `ExecutionEvidence`
Fato canônico derivado por L0 a partir de sinais validados:
- `dispatch_confirmed`
- `pre_dispatch_failure` (com `noSideEffectGuarantee?: 'structural' | 'none'`)
- `effect_observed`
- `no_effect_verified`
- `result_verified`
- `technical_unproven`

### C. `OutcomeAssessment`
Registro imutável que avalia a mutação factual ou resultado:
- **Operação Mutativa**:
  - `confirmed_mutation`: Apenas quando há evidência factual (`effect_observed`).
  - `confirmed_no_mutation`: Apenas quando há prova de não-mutação (`no_effect_verified`) ou falha pré-dispatch com garantia estrutural (`noSideEffectGuarantee === 'structural'`).
  - `indeterminate`: Sucesso técnico isolado (HTTP 200 / exit 0 sem prova factual), falhas pós-dispatch, timeouts, falhas pré-dispatch sem garantia estrutural ou conflitos de sinais.
- **Operação Não-Mutativa**:
  - `confirmed_result`: Apenas com evidência factual (`result_verified`).
  - `indeterminate`: Sucesso técnico isolado sem `result_verified`.

> **Linhagem Estrita de Late Evidence**: A chegada de novas evidências gera um novo `OutcomeAssessment` que deve superseder estritamente o head atual da cadeia daquele Attempt (`supersedesAssessmentId === currentHeadId`). A criação de branches concorrentes ou supersession de nós antigos é proibida.

---

## 6. Materialização de Receipt

- **Discriminated Union**: `Receipt = ExecutionOutcomeReceipt | PolicyDenialReceipt | AuthorizationDenialReceipt | NoEligibleRouteReceipt | CancelledReceipt`.
- **Imutabilidade e Validação**: Recibos de execução exigem `attemptId`, `outcomeAssessmentId` e `routeEvaluationId` válidos do mesmo Attempt. Recibos de negação/cancelamento proíbem estritamente `attemptId` (INV-09).
- **Sem Falsas Declarações**: Se o `OutcomeAssessment` for `indeterminate`, o `Receipt` preserva a incerteza e proíbe declarações factuais de sucesso.

---

## 7. Imutabilidade Defensiva Profunda (Deep Defensive Copy & Freeze)

- **Ingestão e Leitura Seguras**: Tanto no momento da gravação (`append*`) quanto na leitura (`get*`, `list*`, `exportSnapshot`), o ledger aplica clonagem defensiva recursiva e congelamento estrito (`deepCloneAndFreeze`).
- **Isolamento Total de Referências**: Objetos e arrays aninhados (`safeMetadata`, `safeFacts`, `signalRefs`, `evidenceRefs`, `safeStructuredFacts`) não compartilham estado mutável com o chamador externo. Mutações posteriores nos objetos originais não afetam o ledger interno, e objetos lidos do ledger não podem ser mutados externamente.

