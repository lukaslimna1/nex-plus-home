# NEX+ · Route Eligibility, Selection & Escalation
**Escopo 0.5 (Bloco 0.5E) — Especificação Arquitetural e Matriz de Aceitação**

---

## 1. Fronteira e Responsabilidade (0.5D $\rightarrow$ 0.5E $\rightarrow$ 0.6)

O Bloco 0.5E é o **motor determinístico de autoridade e escalonamento de L0**:
- Orquestra os gates de Capability, Bindings, Route Lifecycle, Terms, Policy, Authorization Humana, Confirmação Humana e Runtime Facts;
- Emite avaliações imutáveis por rota (`RouteEvaluation`);
- Aplica seleção determinística estrita (seleção unívoca ou via `RouteSelectionPlan` explícito);
- Produz admissões formais para execução (`DispatchAdmission`) associadas a um `DecisionMaterialContextId` estrito;
- Gerencia escalonamentos humanos estruturados (`HumanEscalation`) e suspensões sem texto livre;
- Determina diretivas pós-tentativa (`assessContinuationAfterAttempt`) respeitando a proibição de retries cegos em mutações indeterminadas (INV-12).

> **Fronteira com o Bloco 0.6/0.7**: O 0.5E **NÃO** é o Resource Governor, não contém heurísticas de benchmark, não pontua latência/throughput dinâmico, não faz VRAM/CPU scheduling e não executa chamadas de rede/LLM. O 0.6 poderá futuramente fornecer `RouteSelectionPlan` determinísticos como input soberano para o 0.5E.

---

## 2. Pinos de Contexto Material (`DecisionMaterialContextId`)

Toda decisão de L0 opera sob um `DecisionMaterialContextId` representativo da revisão material exata do contexto (ator, operação, alvos, parâmetros materiais, sensibilidade de dados e revisões de regras).
- **Invalidação por Material Change**: Se o contexto mudar de $M_1$ para $M_2$, qualquer `AuthorizationDecision`, `ConfirmationDecision` ou `DispatchAdmission` emitida para $M_1$ torna-se imediatamente inválida.

---

## 3. Disposições de Decisão (Suspensões vs. Terminações)

| Tipo | Disposição | Descrição |
| :--- | :--- | :--- |
| **Sucesso** | `route_selected` | Exatamente uma rota elegível selecionada e admitida com todos os gates válidos. |
| **Suspensão** | `clarification_required` | Intenção ambígua com mutação potencial (INV-06) ou Capability não registrada. |
| **Suspensão** | `awaiting_human` | Confirmação/Autorização pendente, rota obsoleta (`deprecated`) ou múltiplas rotas elegíveis sem plano. |
| **Terminação** | `authorization_denied` | Autorização humana negada explicitamente (`denied`). |
| **Terminação** | `policy_denied` | Nenhuma rota satisfaz os eixos de Egress ou Zero-Cost da Policy. |
| **Terminação** | `no_eligible_route` | Nenhuma rota elegível após avaliação de todos os gates (ex: capacidade sem rotas, quota esgotada, rotas inativas). |
| **Terminação** | `cancelled` | Confirmação humana recusada (`declined`) ou cancelamento pré-dispatch. |

---

## 4. Matriz Compacta de Gates de Elegibilidade de Rota

Para que uma rota seja declarada `eligible`:
1. **Binding & Capability**:
   - Resolução de Capability Heads: Se houver exatamente 1 head, ele é selecionado. Se houver múltiplos heads sem `capabilityRevisionId` explícito, a decisão é suspensa sob `awaiting_human` (`MULTIPLE_CAPABILITY_REVISIONS`). É expressamente proibido selecionar por ordem de inserção (`heads[0]`).
   - Correlação Causal de Binding: O `BindingRevision` deve coincidir estritamente com `capability.capabilityRevisionId` e `route.routeRevisionId`.
   - Capability deve existir no Registry com status `active` (status `retired` $\rightarrow$ inelegível; `deprecated` $\rightarrow$ `awaiting_human` com escalonamento).
2. **Route Lifecycle**:
   - `active` $\rightarrow$ elegível.
   - `retired` $\rightarrow$ inelegível.
   - `deprecated` $\rightarrow$ não selecionável automaticamente (`awaiting_human`).
3. **Policy Engine (0.5C)**:
   - `egressAxis.verdict === 'allow'` (ex: `LOCAL_ONLY` bloqueia provedores externos de IA).
   - `zeroCostAxis.verdict === 'allow'` (quando `zeroCostRequired === true`, bloqueia cobranças pagas, trials e créditos promocionais isolados).
4. **Terms Resolution (0.5B)**:
   - Projeção de termos com escopo resolvido com sucesso (`status === 'resolved'`). Estados como `insufficient_context`, `no_applicable_terms` ou `unresolved_conflict` tornam a rota inelegível.
   - Correlação causal: Todas as `RouteTermsRevision` aplicáveis devem pertencer estritamente à mesma `route.routeRevisionId`.
5. **Runtime Facts**:
   - Correlação causal: `runtimeFacts.routeRevisionId` deve coincidir estritamente com `route.routeRevisionId`.
   - `availability === 'available'` (ou não `unavailable`).
   - `cooldown !== 'active'`.
   - `health !== 'unhealthy'` (`degraded` é permitido sem penalidade automática).
   - Fatos materiais devem ter `freshness === 'fresh'` (fatos `stale` ou `unknown` não satisfazem o gate).
   - Se a Policy exigir `FREE_ALLOWANCE_AVAILABLE`: `freeAllowanceAvailable === true` e `freshness === 'fresh'`. Quota esgotada (`false`) ou desconhecida $\rightarrow$ inelegível.

---

## 5. Seleção Determinística & `RouteSelectionPlan`

- **Proibição de Ordem Incidental**: É terminantemente proibido selecionar rota com base na ordem de inserção em Arrays ou Maps.
- **Caso 1 Rota Elegível**: Selecionada imediatamente.
- **Caso Múltiplas Rotas Elegíveis**:
  - Se houver `RouteSelectionPlan` válido: seleciona a primeira rota elegível listada na ordem de preferência do plano. Planos com IDs duplicados são rejeitados.
  - Se NÃO houver `RouteSelectionPlan`: a decisão é suspensa sob `awaiting_human` com `HumanEscalation` do tipo `multiple_eligible_routes`.

---

## 6. Admissão e Transição para Attempt (`DispatchAdmission`)

- Uma `DispatchAdmission` é gerada apenas quando a decisão atinge `route_selected`.
- Pinagem obrigatória de `authorizationId` e `confirmationId` se os gates correspondentes forem exigidos.
- O helper `buildAttemptCreatedEvent(admission, attemptId, createdAt)` cria o evento inicial de ciclo de vida do Bloco 0.5D validando que o contexto material atual coincide com a admissão.

---

## 7. Diretivas de Continuação Pós-Tentativa (`assessContinuationAfterAttempt`)

- **Validação Causal Estrita**: Valida que `assessment.attemptId === attempt.attemptId` e `attempt.decisionId === decisionId`.

| Desfecho do Attempt (0.5D) | Natureza da Operação | Diretiva de Continuação | Justificativa |
| :--- | :--- | :--- | :--- |
| `confirmed_mutation` | Mutativa | `stop` | Efeito fático comprovado com sucesso. |
| `confirmed_result` | Não-Mutativa | `stop` | Resultado verificado com sucesso. |
| `confirmed_no_mutation` | Mutativa / Não-Mutativa | `new_route_evaluation_required` | Falha sem efeito colateral. Nova rota exige reavaliação completa de gates. |
| `indeterminate` | **Mutativa** | **`human_escalation_required`** | **INV-12: Proibido retry automático ou avanço de rota em incerteza de mutação.** |
| `indeterminate` | Não-Mutativa | `new_route_evaluation_required` | Operação segura para nova tentativa sob novo ciclo de avaliação. |
