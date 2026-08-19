/**
 * NEX+ · Policy Engine · Egress, Zero-Cost & ACL Boundary
 * Motor Determinístico de Avaliação de Policy de L0 — Escopo 0.5 (Bloco 0.5C)
 *
 * Plano de Autoridade (L0).
 * Funções puras, avaliação determinística por eixos, ausência de efeitos colaterais ou seleção de rota.
 */

import type { RouteRevision, TermsResolutionResult } from '../capabilities/contracts';

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
 * Avalia o eixo Zero-Cost para a Policy e os termos resolvidos da rota:
 * - Não existe silent paid fallback.
 * - Trial e promotional_credit não contam como gratuidade recorrente qualificada.
 * - Subscrições pagas não contam como gratuidade intrínseca.
 * - Incerteza / conflito de termos gera negação fail-closed.
 */
export function evaluateZeroCostAxis(
  policy: PolicyRevision,
  termsResult: TermsResolutionResult,
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

  // Avaliação de estados incompletos / de conflito fail-closed
  if (termsResult.status === 'no_terms') {
    return {
      decision: { verdict: 'deny', reasonCode: 'ZERO_COST_NO_TERMS' },
      runtimeRequirements: [],
    };
  }

  if (termsResult.status === 'no_applicable_terms') {
    return {
      decision: { verdict: 'deny', reasonCode: 'ZERO_COST_NO_APPLICABLE_TERMS' },
      runtimeRequirements: [],
    };
  }

  if (termsResult.status === 'insufficient_context') {
    return {
      decision: { verdict: 'deny', reasonCode: 'ZERO_COST_CONTEXT_INSUFFICIENT' },
      runtimeRequirements: [],
    };
  }

  if (termsResult.status === 'unresolved_conflict') {
    return {
      decision: { verdict: 'deny', reasonCode: 'ZERO_COST_TERMS_CONFLICT' },
      runtimeRequirements: [],
    };
  }

  // Termos aplicáveis (single_applicable ou composable_terms)
  const termsList =
    termsResult.status === 'single_applicable' ? [termsResult.terms] : termsResult.terms;

  // Se algum termo possuir status de faturamento ou de benefício desconhecido
  const hasUnknownState = termsList.some(
    (t) => t.billingStatus === 'unknown' || t.freeEntitlementStatus === 'unknown',
  );
  if (hasUnknownState) {
    return {
      decision: { verdict: 'deny', reasonCode: 'ZERO_COST_TERMS_UNKNOWN' },
      runtimeRequirements: [],
    };
  }

  // 1. Gratuidade integral recorrente
  const hasRecurringFullFree = termsList.some((t) =>
    t.freeEntitlements.some((e) => e.type === 'recurring_full_free'),
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

  // 2. Allowance gratuita recorrente (compatível em princípio com requisito para 0.5E)
  const hasRecurringAllowance = termsList.some((t) =>
    t.freeEntitlements.some((e) => e.type === 'recurring_free_allowance'),
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

  // 3. Benefícios não qualificadores isolados (promotional credit ou trial)
  const hasPromo = termsList.some((t) =>
    t.freeEntitlements.some((e) => e.type === 'promotional_credit'),
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

  const hasTrial = termsList.some((t) =>
    t.freeEntitlements.some((e) => e.type === 'trial'),
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
  const allKnownNone = termsList.every(
    (t) => t.billingStatus === 'known_none' && t.billingComponents.length === 0,
  );
  if (allKnownNone) {
    return {
      decision: {
        verdict: 'allow',
        reasonCode: 'ZERO_COST_NO_EXTERNAL_CHARGE',
      },
      runtimeRequirements: [],
    };
  }

  // 5. Billing pago (metered, subscription, flat, etc.)
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
  readonly sensitivity?: SensitivityClass;
  readonly containsSecretMaterial?: boolean;
  readonly evaluatedAt?: string;
}

/**
 * Avalia deterministicamente se uma RouteRevision candidata satisfaz uma PolicyRevision:
 * - Computa sensibilidade efetiva.
 * - Avalia eixo de Egress.
 * - Avalia eixo de Zero-Cost.
 * Retorna uma PolicyDecision imutável e factual com reason codes estáveis por eixo.
 */
export function evaluatePolicy(params: {
  readonly policy: PolicyRevision;
  readonly route: RouteRevision;
  readonly termsResult: TermsResolutionResult;
  readonly sensitivity?: SensitivityClass;
  readonly containsSecretMaterial?: boolean;
  readonly evaluatedAt?: string;
}): PolicyDecision {
  const {
    policy,
    route,
    termsResult,
    sensitivity = policy.defaultSensitivity,
    containsSecretMaterial = false,
    evaluatedAt = new Date().toISOString(),
  } = params;

  const effectiveSensitivity = computeEffectiveSensitivity(sensitivity, containsSecretMaterial);

  const egressAxis = evaluateEgressAxis(route, effectiveSensitivity);
  const zeroCostResult = evaluateZeroCostAxis(policy, termsResult);

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
