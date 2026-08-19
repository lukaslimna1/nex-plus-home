/**
 * NEX+ · Route Eligibility, Selection & Escalation
 * Avaliador Determinístico de RouteEvaluation — Escopo 0.5 (Bloco 0.5E)
 *
 * Plano de Autoridade (L0).
 * Avaliação de gates: Capability Lifecycle, Route Lifecycle, Terms, Policy e Runtime Facts.
 */

import type {
  CapabilityRevision,
  CapabilityRouteBindingRevision,
  RouteRevision,
  RouteTermsRevisionId,
  TermsResolutionContext,
  TermsResolutionResult,
} from '../capabilities/contracts';

import type { PolicyRevision } from '../policy/contracts';
import { evaluatePolicy } from '../policy/engine';
import type { DecisionId, RouteEvaluationId } from '../execution/contracts';

import type {
  DecisionMaterialContextId,
  RouteEvaluation,
  RouteEvaluationStatus,
  RouteRuntimeFacts,
} from './contracts';

export interface EvaluateCandidateRouteParams {
  readonly decisionId: DecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly routeEvaluationId: RouteEvaluationId;
  readonly capability: CapabilityRevision;
  readonly binding: CapabilityRouteBindingRevision;
  readonly route: RouteRevision;
  readonly termsResult: TermsResolutionResult;
  readonly termsContext: TermsResolutionContext;
  readonly policy: PolicyRevision;
  readonly containsSecretMaterial: boolean;
  readonly runtimeFacts?: RouteRuntimeFacts;
  readonly evaluatedAt: string;
}

/**
 * Avalia deterministicamente se uma RouteRevision candidata vinculada a uma CapabilityRevision
 * é elegível, inelegível ou requer intervenção humana sob os gates de L0.
 */
export function evaluateCandidateRoute(params: EvaluateCandidateRouteParams): RouteEvaluation {
  const {
    decisionId,
    materialContextId,
    routeEvaluationId,
    capability,
    binding,
    route,
    termsResult,
    termsContext,
    policy,
    containsSecretMaterial,
    runtimeFacts,
    evaluatedAt,
  } = params;

  // 0. Correlação Causal e Estrutural Obrigatória
  if (binding.capabilityRevisionId !== capability.capabilityRevisionId) {
    throw new Error(
      `[L0 RouteEvaluation] Binding '${binding.bindingRevisionId}' capabilityRevisionId '${binding.capabilityRevisionId}' does not match capability '${capability.capabilityRevisionId}'.`,
    );
  }
  if (binding.routeRevisionId !== route.routeRevisionId) {
    throw new Error(
      `[L0 RouteEvaluation] Binding '${binding.bindingRevisionId}' routeRevisionId '${binding.routeRevisionId}' does not match route '${route.routeRevisionId}'.`,
    );
  }
  if (runtimeFacts && runtimeFacts.routeRevisionId !== route.routeRevisionId) {
    throw new Error(
      `[L0 RouteEvaluation] RuntimeFacts routeRevisionId '${runtimeFacts.routeRevisionId}' does not match candidate route '${route.routeRevisionId}'.`,
    );
  }
  if (termsResult.status === 'single_applicable' && termsResult.terms.routeRevisionId !== route.routeRevisionId) {
    throw new Error(
      `[L0 RouteEvaluation] TermsRevision '${termsResult.terms.termsRevisionId}' routeRevisionId '${termsResult.terms.routeRevisionId}' does not match candidate route '${route.routeRevisionId}'.`,
    );
  }
  if (termsResult.status === 'composable_terms') {
    for (const t of termsResult.terms) {
      if (t.routeRevisionId !== route.routeRevisionId) {
        throw new Error(
          `[L0 RouteEvaluation] Composable TermsRevision '${t.termsRevisionId}' routeRevisionId '${t.routeRevisionId}' does not match candidate route '${route.routeRevisionId}'.`,
        );
      }
    }
  }

  const reasonCodes: string[] = [];
  let isAwaitingHuman = false;
  let isDenied = false;

  // 1. Gate de Lifecycle da Capability
  if (capability.lifecycle === 'retired') {
    isDenied = true;
    reasonCodes.push('CAPABILITY_RETIRED');
  } else if (capability.lifecycle === 'deprecated') {
    isAwaitingHuman = true;
    reasonCodes.push('CAPABILITY_DEPRECATED_REVIEW');
  }

  // 2. Gate de Lifecycle da Route
  if (route.lifecycle === 'retired') {
    isDenied = true;
    reasonCodes.push('ROUTE_RETIRED');
  } else if (route.lifecycle === 'deprecated') {
    isAwaitingHuman = true;
    reasonCodes.push('ROUTE_DEPRECATED_REVIEW');
  }

  // 3. Gate de Terms Resolution
  if (termsResult.status === 'insufficient_context') {
    isDenied = true;
    reasonCodes.push('TERMS_CONTEXT_INSUFFICIENT');
  } else if (
    termsResult.status === 'no_terms' ||
    termsResult.status === 'no_applicable_terms' ||
    termsResult.status === 'unresolved_conflict'
  ) {
    isDenied = true;
    reasonCodes.push(`TERMS_${termsResult.status.toUpperCase()}`);
  }

  // 4. Gate do Policy Engine (0.5C)
  const policyDecision = evaluatePolicy({
    policy,
    route,
    termsResult,
    context: termsContext,
    containsSecretMaterial,
    evaluatedAt,
  });

  if (policyDecision.egressAxis.verdict === 'deny') {
    isDenied = true;
    reasonCodes.push(policyDecision.egressAxis.reasonCode);
  }

  if (policyDecision.zeroCostAxis.verdict === 'deny') {
    isDenied = true;
    reasonCodes.push(policyDecision.zeroCostAxis.reasonCode);
  }

  // 5. Gate de Runtime Facts
  const materialRuntimeFacts: {
    freshness?: RouteRuntimeFacts['freshness'];
    availability?: RouteRuntimeFacts['availability'];
    cooldown?: RouteRuntimeFacts['cooldown'];
    health?: RouteRuntimeFacts['health'];
    freeAllowanceAvailable?: RouteRuntimeFacts['freeAllowanceAvailable'];
  } = {};

  if (runtimeFacts) {
    if (runtimeFacts.freshness === 'stale') {
      isDenied = true;
      reasonCodes.push('RUNTIME_FACTS_STALE');
      materialRuntimeFacts.freshness = 'stale';
    }

    if (runtimeFacts.availability === 'unavailable') {
      isDenied = true;
      reasonCodes.push('ROUTE_UNAVAILABLE');
      materialRuntimeFacts.availability = 'unavailable';
    }

    if (runtimeFacts.cooldown === 'active') {
      isDenied = true;
      reasonCodes.push('ROUTE_COOLDOWN_ACTIVE');
      materialRuntimeFacts.cooldown = 'active';
    }

    if (runtimeFacts.health === 'unhealthy') {
      isDenied = true;
      reasonCodes.push('ROUTE_UNHEALTHY');
      materialRuntimeFacts.health = 'unhealthy';
    } else if (runtimeFacts.health === 'degraded') {
      materialRuntimeFacts.health = 'degraded';
    }
  }

  // 6. Verificação de Policy Runtime Requirements
  for (const requirement of policyDecision.requiredRuntimeRequirements) {
    if (requirement === 'FREE_ALLOWANCE_AVAILABLE') {
      if (!runtimeFacts || runtimeFacts.freeAllowanceAvailable === 'unknown' || runtimeFacts.freeAllowanceAvailable === undefined) {
        isDenied = true;
        reasonCodes.push('FREE_ALLOWANCE_UNKNOWN');
        materialRuntimeFacts.freeAllowanceAvailable = 'unknown';
      } else if (runtimeFacts.freeAllowanceAvailable === false) {
        isDenied = true;
        reasonCodes.push('FREE_ALLOWANCE_EXHAUSTED');
        materialRuntimeFacts.freeAllowanceAvailable = false;
      } else {
        materialRuntimeFacts.freeAllowanceAvailable = true;
        if (runtimeFacts.freshness !== 'fresh') {
          isDenied = true;
          reasonCodes.push('RUNTIME_FACTS_STALE');
        }
      }
    }
  }

  // Identificar applied terms revision IDs
  const appliedTermsRevisionIds: RouteTermsRevisionId[] = [];
  if (termsResult.status === 'single_applicable') {
    appliedTermsRevisionIds.push(termsResult.terms.termsRevisionId);
  } else if (termsResult.status === 'composable_terms') {
    for (const t of termsResult.terms) {
      appliedTermsRevisionIds.push(t.termsRevisionId);
    }
  }

  let status: RouteEvaluationStatus;
  if (isDenied) {
    status = 'ineligible';
  } else if (isAwaitingHuman) {
    status = 'awaiting_human';
  } else {
    status = 'eligible';
    reasonCodes.push('ROUTE_ELIGIBLE');
  }

  return {
    routeEvaluationId,
    decisionId,
    materialContextId,
    capabilityRevisionId: capability.capabilityRevisionId,
    bindingRevisionId: binding.bindingRevisionId,
    routeRevisionId: route.routeRevisionId,
    appliedTermsRevisionIds,
    policyRevisionId: policy.policyRevisionId,
    status,
    reasonCodes,
    materialRuntimeFacts: Object.keys(materialRuntimeFacts).length > 0 ? materialRuntimeFacts : undefined,
    evaluatedAt,
  };
}
