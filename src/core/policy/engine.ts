/**
 * NEX+ · Policy Engine · Egress, Zero-Cost & ACL Boundary
 * Motor Determinístico de Avaliação de Policy de L0 — Escopo 0.5 (Bloco 0.5C)
 *
 * Plano de Autoridade (L0).
 * Funções puras, avaliação determinística por eixos, ausência de efeitos colaterais ou seleção de rota.
 * Sem consulta a clock interno (evaluatedAt explícito) e com tratamento estrito de sensibilidade e termos com escopo.
 */

import type {
  RouteRevision,
  TermsResolutionResult,
  TermsResolutionContext,
} from '../capabilities/contracts';

import { resolveScopedTermsFacts } from '../capabilities/registry';

import type {
  PolicyRevision,
  SensitivityClass,
  EgressReasonCode,
  ZeroCostReasonCode,
  PolicyRuntimeRequirement,
  AxisDecision,
  PolicyDecision,
} from './contracts';

// ============================================================================
// 1. ÁLGEBRA PURA DE SENSIBILIDADE
// ============================================================================

/**
 * Mescla duas classes de sensibilidade de acordo com a invariante INV-16:
 * NORMAL + NORMAL = NORMAL
 * NORMAL + LOCAL_ONLY = LOCAL_ONLY
 * LOCAL_ONLY + NORMAL = LOCAL_ONLY
 * LOCAL_ONLY + LOCAL_ONLY = LOCAL_ONLY
 */
export function mergeSensitivity(s1: SensitivityClass, s2: SensitivityClass): SensitivityClass {
  if (s1 === 'LOCAL_ONLY' || s2 === 'LOCAL_ONLY') {
    return 'LOCAL_ONLY';
  }
  return 'NORMAL';
}

/**
 * Computa a sensibilidade efetiva considerando a presença de secret material (INV-08).
 * Secrets forçam estritamente LOCAL_ONLY sem constituir uma terceira classe.
 */
export function computeEffectiveSensitivity(
  baseSensitivity: SensitivityClass,
  containsSecretMaterial: boolean,
): SensitivityClass {
  if (containsSecretMaterial) {
    return 'LOCAL_ONLY';
  }
  return baseSensitivity;
}

// ============================================================================
// 2. AVALIAÇÃO DO EIXO DE EGRESS (Proteção de Fronteira & Provedores)
// ============================================================================

/**
 * Avalia o eixo de Egress para uma RouteRevision candidata sob a sensibilidade efetiva:
 * - Para NORMAL: egress operacional para serviços externos é permitido.
 * - Para LOCAL_ONLY: tráfego para IA externa ou serviços terceiros externos é expressamente negado.
 * Avalia conjuntamente crossesEgressBoundary, controlOwnership, externalServiceNature e networkTopologyScopes.
 */
export function evaluateEgressAxis(
  route: RouteRevision,
  effectiveSensitivity: SensitivityClass,
): AxisDecision<EgressReasonCode> {
  if (effectiveSensitivity === 'NORMAL') {
    if (!route.crossesEgressBoundary && route.externalServiceNature === 'none') {
      return {
        verdict: 'allow',
        reasonCode: 'EGRESS_NO_EXTERNAL_PROVIDER',
      };
    }
    return {
      verdict: 'allow',
      reasonCode: 'EGRESS_NORMAL_ALLOWED',
    };
  }

  // Sensibilidade LOCAL_ONLY:
  // 1. Bloqueio estrito de IA de terceiros
  if (route.externalServiceNature === 'ai_third_party') {
    return {
      verdict: 'deny',
      reasonCode: 'EGRESS_LOCAL_ONLY_EXTERNAL_PROVIDER',
    };
  }

  // 2. Bloqueio estrito de serviços externos não-IA de terceiros
  if (route.externalServiceNature === 'non_ai_third_party') {
    return {
      verdict: 'deny',
      reasonCode: 'EGRESS_LOCAL_ONLY_EXTERNAL_NON_AI',
    };
  }

  // 3. Bloqueio de caminhos com natureza mista ou desconhecida
  if (route.externalServiceNature === 'mixed_unknown') {
    return {
      verdict: 'deny',
      reasonCode: 'EGRESS_LOCAL_ONLY_UNKNOWN_EXTERNAL_PATH',
    };
  }

  // 4. Se cruza fronteira de egress sem ser operada exclusivamente pelo operador
  if (route.crossesEgressBoundary && route.controlOwnership !== 'operator_managed') {
    return {
      verdict: 'deny',
      reasonCode: 'EGRESS_LOCAL_ONLY_UNKNOWN_EXTERNAL_PATH',
    };
  }

  // 5. Rota sob controle do operador (loopback ou LAN local) sem serviços de terceiros
  if (route.controlOwnership === 'operator_managed' && route.externalServiceNature === 'none') {
    return {
      verdict: 'allow',
      reasonCode: 'EGRESS_NO_EXTERNAL_PROVIDER',
    };
  }

  // Fallback seguro fail-closed para qualquer outra combinação
  return {
    verdict: 'deny',
    reasonCode: 'EGRESS_LOCAL_ONLY_UNKNOWN_EXTERNAL_PATH',
  };
}

// ============================================================================
// 3. AVALIAÇÃO DO EIXO ZERO-COST (Garantia de Não-Cobrança Não Autorizada)
// ============================================================================

export interface ZeroCostEvaluationOutput {
  readonly decision: AxisDecision<ZeroCostReasonCode>;
  readonly runtimeRequirements: readonly PolicyRuntimeRequirement[];
}

/**
 * Avalia o eixo Zero-Cost para a Policy e os termos resolvidos no contexto:
 * - Utiliza resolveScopedTermsFacts() para filtrar exclusivamente fatos vigentes e aplicáveis ao contexto.
 * - Não existe silent paid fallback.
 * - Trial e promotional_credit não contam como gratuidade recorrente qualificada.
 * - Subscrições pagas não contam como gratuidade intrínseca.
 * - Ausência de cobrança externa comprovada (billingStatus known_none e 0 componentes aplicáveis) é suficiente.
 * - Incerteza / conflito de termos gera negação fail-closed.
 */
export function evaluateZeroCostAxis(
  policy: PolicyRevision,
  termsResult: TermsResolutionResult,
  context: TermsResolutionContext,
): ZeroCostEvaluationOutput {
  if (!policy.zeroCostRequired) {
    return {
      decision: {
        verdict: 'allow',
        reasonCode: 'ZERO_COST_NOT_REQUIRED',
      },
      runtimeRequirements: [],
    };
  }

  const scoped = resolveScopedTermsFacts(termsResult, context);

  // Avaliação de estados incompletos / de conflito fail-closed
  if (scoped.status === 'no_terms') {
    return {
      decision: { verdict: 'deny', reasonCode: 'ZERO_COST_NO_TERMS' },
      runtimeRequirements: [],
    };
  }

  if (scoped.status === 'no_applicable_terms') {
    return {
      decision: { verdict: 'deny', reasonCode: 'ZERO_COST_NO_APPLICABLE_TERMS' },
      runtimeRequirements: [],
    };
  }

  if (scoped.status === 'insufficient_context') {
    return {
      decision: { verdict: 'deny', reasonCode: 'ZERO_COST_CONTEXT_INSUFFICIENT' },
      runtimeRequirements: [],
    };
  }

  if (scoped.status === 'unresolved_conflict') {
    return {
      decision: { verdict: 'deny', reasonCode: 'ZERO_COST_TERMS_CONFLICT' },
      runtimeRequirements: [],
    };
  }

  // 1. Gratuidade integral recorrente aplicável
  const hasRecurringFullFree = scoped.applicableFreeEntitlements.some(
    (e) => e.type === 'recurring_full_free',
  );
  if (hasRecurringFullFree) {
    return {
      decision: {
        verdict: 'allow',
        reasonCode: 'ZERO_COST_RECURRING_FULL_FREE',
      },
      runtimeRequirements: [],
    };
  }

  // 2. Allowance gratuita recorrente aplicável (compatível em princípio com requisito para 0.5E)
  const hasRecurringAllowance = scoped.applicableFreeEntitlements.some(
    (e) => e.type === 'recurring_free_allowance',
  );
  if (hasRecurringAllowance) {
    return {
      decision: {
        verdict: 'allow',
        reasonCode: 'ZERO_COST_RECURRING_ALLOWANCE_PRINCIPLE',
      },
      runtimeRequirements: ['FREE_ALLOWANCE_AVAILABLE'],
    };
  }

  // 3. Benefícios não qualificadores isolados aplicáveis (promotional credit ou trial)
  const hasPromo = scoped.applicableFreeEntitlements.some(
    (e) => e.type === 'promotional_credit',
  );
  if (hasPromo) {
    return {
      decision: {
        verdict: 'deny',
        reasonCode: 'ZERO_COST_PROMOTIONAL_ONLY',
      },
      runtimeRequirements: [],
    };
  }

  const hasTrial = scoped.applicableFreeEntitlements.some(
    (e) => e.type === 'trial',
  );
  if (hasTrial) {
    return {
      decision: {
        verdict: 'deny',
        reasonCode: 'ZERO_COST_TRIAL_ONLY',
      },
      runtimeRequirements: [],
    };
  }

  // 4. Ausência de cobrança externa comprovada (billingStatus known_none, 0 componentes e sem benefícios temporários)
  // Nuance de L0: se billingStatus é known_none e não há cobranças aplicáveis, é Zero-Cost mesmo se freeEntitlementStatus for unknown
  if (scoped.billingStatus === 'known_none' && scoped.applicableBillingComponents.length === 0) {
    return {
      decision: {
        verdict: 'allow',
        reasonCode: 'ZERO_COST_NO_EXTERNAL_CHARGE',
      },
      runtimeRequirements: [],
    };
  }

  // 5. Billing status desconhecido
  if (scoped.billingStatus === 'unknown') {
    return {
      decision: {
        verdict: 'deny',
        reasonCode: 'ZERO_COST_TERMS_UNKNOWN',
      },
      runtimeRequirements: [],
    };
  }

  // 6. Se existe billing pago conhecido e freeEntitlementStatus for unknown
  if (scoped.freeEntitlementStatus === 'unknown') {
    return {
      decision: {
        verdict: 'deny',
        reasonCode: 'ZERO_COST_TERMS_UNKNOWN',
      },
      runtimeRequirements: [],
    };
  }

  // 7. Billing pago sem entitlement qualificador aplicável
  return {
    decision: {
      verdict: 'deny',
      reasonCode: 'ZERO_COST_PAID_ONLY',
    },
    runtimeRequirements: [],
  };
}

// ============================================================================
// 4. POLICY ENGINE EVALUATOR PRINCIPAL
// ============================================================================

export interface PolicyEvaluationParams {
  readonly policy: PolicyRevision;
  readonly route: RouteRevision;
  readonly termsResult: TermsResolutionResult;
  readonly context: TermsResolutionContext;
  readonly containsSecretMaterial: boolean;
  readonly evaluatedAt: string;
  readonly sensitivity?: SensitivityClass;
}

/**
 * Avalia deterministicamente se uma RouteRevision candidata satisfaz uma PolicyRevision:
 * - Exige inputs explícitos (evaluatedAt, containsSecretMaterial) sem consulta a clock interno.
 * - Computa sensibilidade efetiva.
 * - Avalia eixo de Egress.
 * - Avalia eixo de Zero-Cost consumindo a projeção de fatos resolvidos do contexto.
 * Retorna uma PolicyDecision imutável e factual com reason codes estáveis por eixo.
 */
export function evaluatePolicy(params: PolicyEvaluationParams): PolicyDecision {
  const {
    policy,
    route,
    termsResult,
    context,
    containsSecretMaterial,
    evaluatedAt,
    sensitivity = policy.defaultSensitivity,
  } = params;

  const effectiveSensitivity = computeEffectiveSensitivity(sensitivity, containsSecretMaterial);

  const egressAxis = evaluateEgressAxis(route, effectiveSensitivity);
  const zeroCostResult = evaluateZeroCostAxis(policy, termsResult, context);

  return {
    policyRevisionId: policy.policyRevisionId,
    routeRevisionId: route.routeRevisionId,
    effectiveSensitivity,
    containsSecretMaterial,
    egressAxis,
    zeroCostAxis: zeroCostResult.decision,
    requiredRuntimeRequirements: zeroCostResult.runtimeRequirements,
    evaluatedAt,
  };
}
