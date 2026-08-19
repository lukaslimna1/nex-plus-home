# NEX+ · Policy Engine · Egress, Zero-Cost & ACL Boundary
**Escopo 0.5 (Bloco 0.5C) — Especificação Arquitetural e Contratos Canônicos**

---

## 1. Fronteira Factual vs. Decisória (0.5B $\rightarrow$ 0.5C)

O Bloco 0.5B responde: *"O que existe no sistema e quais fatos conhecemos sobre rotas e termos?"*
O Bloco 0.5C responde: *"Diante destes fatos conhecidos, uma rota candidata satisfaz uma Policy imutável?"*

O Policy Engine de L0 é uma função determinística e pura que:
- **NÃO** seleciona rotas (`selectBestRoute`, `rankRoutes`, `chooseProvider`).
- **NÃO** executa chamadas, não cria tentativas (`Attempt`) e não gera evidências/recibos (`Receipt`).
- **NÃO** implementa cascatas de fallback pago silencioso (`silent paid fallback`).
- **NÃO** implementa retry automático nem bypass de invariantes (preservando INV-12 e INV-13).
- **NÃO** mescla ou confunde Authorization humana com decisão de egress (preservando INV-04, INV-05, INV-18).

---

## 2. Classes de Sensibilidade e Merge Puro

O NEX+ adota estritamente **duas classes canônicas de sensibilidade**:
1. `NORMAL`: Dados operacionais comuns do domínio sem restrição de fronteira física de terceiros.
2. `LOCAL_ONLY`: Dados restritos que não podem cruzar fronteiras para providers ou serviços de IA de terceiros.

> **Regra de Secrets (INV-08)**: Secrets e credenciais não constituem uma terceira classe. A presença de secret material (`containsSecretMaterial = true`) força deterministamente `effectiveSensitivity = LOCAL_ONLY`.

### Álgebra de Merge de Sensibilidade (INV-16)
$$\text{mergeSensitivity}(S_1, S_2) = \begin{cases} \text{LOCAL\_ONLY} & \text{se } S_1 = \text{LOCAL\_ONLY} \lor S_2 = \text{LOCAL\_ONLY} \\ \text{NORMAL} & \text{caso contrário} \end{cases}$$

A operação é comutativa, associativa e idempotente.

---

## 3. Eixo de Egress (Proteção de Fronteira e Providers)

O eixo de Egress avalia se a `RouteRevision` candidata viola a restrição de sensibilidade:

- **Para `NORMAL`**: Egress operacional para terceiros é permitido (`EGRESS_NORMAL_ALLOWED`), mantendo a segregação de autorização.
- **Para `LOCAL_ONLY`**:
  - `LOCAL_ONLY` **NÃO** exige `networkTopologyScopes = ['loopback']` obrigatório (ex: redes locais `lan` sob gestão de operador `operator_managed` sem serviços externos de terceiros são permitidas).
  - É expressamente proibido o envio de dados para serviços de IA de terceiros (`ai_third_party`), serviços externos não-IA (`non_ai_third_party`) ou rotas externas com natureza mista/desconhecida (`mixed_unknown`) quando `crossesEgressBoundary = true`.
  - A avaliação considera conjuntamente `crossesEgressBoundary`, `controlOwnership`, `externalServiceNature` e `networkTopologyScopes`. Um primeiro hop local não mascara egress para provedores externos.

---

## 4. Eixo Zero-Cost (Garantia de Não-Cobrança Não Autorizada)

Quando `zeroCostRequired = true`:
1. **Billing `known_none`**: Permitido (`ZERO_COST_NO_EXTERNAL_CHARGE`).
2. **`recurring_full_free`**: Permitido (`ZERO_COST_RECURRING_FULL_FREE`).
3. **`recurring_free_allowance`**: Permitido em princípio (`ZERO_COST_RECURRING_ALLOWANCE_PRINCIPLE`) comunicando o requisito de runtime `FREE_ALLOWANCE_AVAILABLE` para o Bloco 0.5E (que checará a quota live).
4. **`trial` ou `promotional_credit` isolados**: Negados deterministamente (`ZERO_COST_TRIAL_ONLY`, `ZERO_COST_PROMOTIONAL_ONLY`).
5. **Billing Pago / Subscrição Paga**: Negados (`ZERO_COST_PAID_ONLY`). Subscrição existente não é tratada como gratuidade intrínseca.
6. **Estados Incompletos / Conflitos (`no_terms`, `no_applicable_terms`, `insufficient_context`, `unresolved_conflict`, `unknown`)**: Negados com fail-closed estrito.

---

## 5. Authorization Boundary (Segregação de Responsabilidade)

- `HumanAuthorizationDecision` representa atestações de autorização humana com `actorRef`, `operation`, `resourceTarget`, `verdict` e `reasonCode`.
- `HumanAuthorizationDecision` e `PolicyDecision` são **totalmente ortogonais**:
  - Uma autorização humana aprovada (`authorized`) sobre dados `LOCAL_ONLY` **NÃO** autoriza envio para IA externa (Policy Egress = `deny`).
  - Uma autorização humana negada (`denied`) sobre dados `NORMAL` **NÃO** é sobreposta por Policy Egress `allow`.
- O helper final de orquestração `canExecute` pertence exclusivamente ao Bloco 0.5E.

---

## 6. PolicyRevision e PolicyDecision

- **`PolicyRevision`**: Identidade imutável (`PolicyKey`, `PolicyRevisionId`, `supersedesRevisionIds`, `defaultSensitivity`, `zeroCostRequired`, `allowedEgressTopologies`).
- **`PolicyDecision`**: Estrutura factual imutável gerada na avaliação contendo:
  - `policyRevisionId`, `routeRevisionId`;
  - `effectiveSensitivity`, `containsSecretMaterial`;
  - `egressAxis` (`verdict`, `reasonCode`);
  - `zeroCostAxis` (`verdict`, `reasonCode`);
  - `requiredRuntimeRequirements` (`['FREE_ALLOWANCE_AVAILABLE']`);
  - `evaluatedAt`.
