# NEX+ · ExecutionEvidence & Attempt Ledger
**Escopo 0.5 (Bloco 0.5D) — Especificação Arquitetural e Contratos Canônicos**

---

## 1. Fronteira e Posição Arquitetural (0.5C $\rightarrow$ 0.5D $\rightarrow$ 0.5E)

O Bloco 0.5C responde se uma rota satisfaz uma Policy.  
O Bloco 0.5D é a **camada de integridade factual e ledger append-only de execução**:
- Rastreia o ciclo de vida estrito de tentativas de execução (`Attempt`);
- Ingere sinais de execução (`ExecutionSignal`) através de projeção segura por allowlist (sem plaintext de segredos);
- Canonicaliza sinais em evidências fáticas auditáveis (`ExecutionEvidence`);
- Avalia o desfecho factual (`OutcomeAssessment`) sob a máxima: **Technical Success $\neq$ Factual Effect**;
- Materializa recibos históricos imutáveis (`Receipt`);
- Mantém o ledger append-only (`ExecutionLedgerStore`) com integridade causal estrita.

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
- `pre_dispatch_failure`
- `effect_observed`
- `no_effect_verified`
- `result_verified`
- `technical_unproven`

### C. `OutcomeAssessment`
Registro imutável que avalia a mutação factual:
- **Operação Mutativa**:
  - `confirmed_mutation`: Apenas quando há evidência factual (`effect_observed`).
  - `confirmed_no_mutation`: Apenas quando há prova de não-mutação (`no_effect_verified`) ou falha pré-dispatch comprovada sem side-effects.
  - `indeterminate`: Sucesso técnico isolado (HTTP 200 / exit 0 sem prova factual), falhas pós-dispatch, timeouts ou conflitos de sinais.
- **Operação Não-Mutativa**: `confirmed_result` ou `indeterminate`.

> **Late Evidence**: A chegada de novas evidências gera um **novo `OutcomeAssessment`** que supersede o anterior (`supersedesAssessmentId`), preservando o histórico integral de auditoria.

---

## 6. Materialização de Receipt

- **Imutabilidade Estrita**: O `Receipt` é **materializado no momento da decisão/conclusão**. Não é uma view recalculada dinamicamente, garantindo que alterações futuras de regras ou termos não modifiquem o histórico.
- **Sem Falsas Declarações**: Se o `OutcomeAssessment` for `indeterminate`, o `Receipt` preserva a incerteza e **proíbe declarações factuais de sucesso**.
- **Receipts sem Attempt**: Negações de Policy (`policy_denial`), negações de autorização (`authorization_denial`), cancelamentos pré-dispatch e falta de rota elegível (`no_eligible_route`) geram recibos materializados preservando INV-09.

---

## 7. Decisão de Persistência Física

A persistência do Bloco 0.5D é implementada em memória (`InMemoryExecutionLedgerStore`) para validação matemática de integridade causal.  
A interface `ExecutionLedgerStore` foi projetada para receber adaptadores PostgreSQL/Payload no Bloco 0.6+ sem alteração de contratos ou semântica de domínio.
