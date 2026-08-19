/**
 * NEX+ · Route Eligibility, Selection & Escalation
 * Seletor Determinístico de Decisão e Admissão — Escopo 0.5 (Bloco 0.5E)
 *
 * Plano de Autoridade (L0).
 * Avaliação global de Decisão: Gates de Interpretação, Autorização, Confirmação,
 * Seleção Determinística com RouteSelectionPlan e geração de DispatchAdmission / HumanEscalation.
 */

import type {
  CapabilityRevision,
  CapabilityRevisionId,
  RouteRevisionId,
  TermsResolutionContext,
} from '../capabilities/contracts';

import type { createCapabilityRegistry } from '../capabilities/registry';

export type CapabilityRegistryStore = ReturnType<typeof createCapabilityRegistry>;

import type { PolicyRevision } from '../policy/contracts';
import type { DecisionId, RouteEvaluationId } from '../execution/contracts';

import type {
  ConfirmationDecision,
  ContextualAuthorizationDecision,
  DecisionMaterialContextId,
  DecisionResult,
  DispatchAdmission,
  DispatchAdmissionId,
  HumanEscalation,
  HumanEscalationId,
  InterpretationReadiness,
  RouteEvaluation,
  RouteRuntimeFacts,
  RouteSelectionPlan,
} from './contracts';

import { evaluateCandidateRoute } from './route-evaluation';

export interface EvaluateDecisionParams {
  readonly decisionId: DecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly interpretation: InterpretationReadiness;
  readonly targetCapabilityRevisionId?: CapabilityRevisionId;
  readonly capabilityRegistry: CapabilityRegistryStore;
  readonly policy: PolicyRevision;
  readonly authorization?: ContextualAuthorizationDecision;
  readonly authorizationRequired?: boolean;
  readonly confirmation?: ConfirmationDecision;
  readonly confirmationRequired?: boolean;
  readonly containsSecretMaterial: boolean;
  readonly termsContext: TermsResolutionContext;
  readonly runtimeFactsMap?: Map<RouteRevisionId, RouteRuntimeFacts>;
  readonly selectionPlan?: RouteSelectionPlan;
  readonly decidedAt: string;
}

/**
 * Avalia deterministicamente uma Decisão completa de L0:
 * - Computa todos os gates aplicáveis sem ordem universal imposta.
 * - Suporta suspensões (clarification_required, awaiting_human) e terminações formais.
 * - Proíbe seleção por ordem incidental de Arrays/Maps.
 * - Emite DispatchAdmission vinculada estritamente ao DecisionMaterialContextId.
 */
export function evaluateDecision(params: EvaluateDecisionParams): DecisionResult {
  const {
    decisionId,
    materialContextId,
    interpretation,
    targetCapabilityRevisionId,
    capabilityRegistry,
    policy,
    authorization,
    authorizationRequired = false,
    confirmation,
    confirmationRequired = false,
    containsSecretMaterial,
    termsContext,
    runtimeFactsMap,
    selectionPlan,
    decidedAt,
  } = params;

  // 0. Validação de integridade do RouteSelectionPlan (se fornecido)
  if (selectionPlan) {
    const unique = new Set(selectionPlan.preferredRoutes);
    if (unique.size !== selectionPlan.preferredRoutes.length) {
      throw new Error(
        `[L0 Selection Plan] Duplicate RouteRevisionId found in RouteSelectionPlan '${selectionPlan.planId}'.`,
      );
    }
  }

  // 1. Gate de Interpretação & Readiness (INV-06)
  if (interpretation.clarity === 'ambiguous' && interpretation.potentiallyMutating) {
    const escalation: HumanEscalation = {
      escalationId: `esc_clarify_${decisionId}` as HumanEscalationId,
      decisionId,
      materialContextId,
      kind: 'clarification_required',
      reasonCode: 'INTERPRETATION_AMBIGUOUS',
      detail: interpretation.reason || 'Mutative intent is ambiguous and requires human clarification.',
      escalatedAt: decidedAt,
    };

    return {
      decisionId,
      materialContextId,
      disposition: 'clarification_required',
      reasonCode: 'INTERPRETATION_AMBIGUOUS',
      evaluations: [],
      escalation,
      decidedAt,
    };
  }

  if (!interpretation.capabilityKey) {
    return {
      decisionId,
      materialContextId,
      disposition: 'clarification_required',
      reasonCode: 'CAPABILITY_NOT_REGISTERED',
      evaluations: [],
      decidedAt,
    };
  }

  // 2. Localizar Capability no Registry (Resolução Soberana de Heads)
  const capabilityHeads = capabilityRegistry.getCapabilityHeads(interpretation.capabilityKey);
  if (capabilityHeads.length === 0) {
    return {
      decisionId,
      materialContextId,
      disposition: 'clarification_required',
      reasonCode: 'CAPABILITY_NOT_REGISTERED',
      evaluations: [],
      decidedAt,
    };
  }

  const requestedRevId = targetCapabilityRevisionId || interpretation.capabilityRevisionId;
  let capability: CapabilityRevision;

  if (requestedRevId) {
    const matchingHead = capabilityHeads.find((h) => h.capabilityRevisionId === requestedRevId);
    if (!matchingHead) {
      const escalation: HumanEscalation = {
        escalationId: `esc_cap_rev_inv_${decisionId}` as HumanEscalationId,
        decisionId,
        materialContextId,
        kind: 'clarification_required',
        reasonCode: 'CAPABILITY_REVISION_INVALID',
        detail: `Requested CapabilityRevisionId '${requestedRevId}' is not an active head for capabilityKey '${interpretation.capabilityKey}'.`,
        escalatedAt: decidedAt,
      };

      return {
        decisionId,
        materialContextId,
        disposition: 'clarification_required',
        reasonCode: 'CAPABILITY_REVISION_INVALID',
        evaluations: [],
        escalation,
        decidedAt,
      };
    }
    capability = matchingHead;
  } else {
    if (capabilityHeads.length === 1) {
      capability = capabilityHeads[0];
    } else {
      // Múltiplos heads sem especificação explícita: PROIBIDO usar heads[0] ou ordem do Array
      const escalation: HumanEscalation = {
        escalationId: `esc_mult_cap_${decisionId}` as HumanEscalationId,
        decisionId,
        materialContextId,
        kind: 'clarification_required',
        reasonCode: 'MULTIPLE_CAPABILITY_REVISIONS',
        detail: `Multiple active capability revisions found for '${interpretation.capabilityKey}' without an explicit capabilityRevisionId.`,
        escalatedAt: decidedAt,
      };

      return {
        decisionId,
        materialContextId,
        disposition: 'awaiting_human',
        reasonCode: 'MULTIPLE_CAPABILITY_REVISIONS',
        evaluations: [],
        escalation,
        decidedAt,
      };
    }
  }

  // 3. Gate de Autorização Humana (0.5C / 0.5E)
  if (authorizationRequired) {
    if (!authorization) {
      const escalation: HumanEscalation = {
        escalationId: `esc_auth_req_${decisionId}` as HumanEscalationId,
        decisionId,
        materialContextId,
        kind: 'authorization_pending',
        reasonCode: 'AUTHORIZATION_REQUIRED',
        detail: 'Human authorization is required but absent.',
        escalatedAt: decidedAt,
      };

      return {
        decisionId,
        materialContextId,
        disposition: 'awaiting_human',
        reasonCode: 'AUTHORIZATION_REQUIRED',
        evaluations: [],
        escalation,
        decidedAt,
      };
    }

    if (authorization.materialContextId !== materialContextId) {
      const escalation: HumanEscalation = {
        escalationId: `esc_auth_ctx_${decisionId}` as HumanEscalationId,
        decisionId,
        materialContextId,
        kind: 'authorization_pending',
        reasonCode: 'AUTHORIZATION_CONTEXT_MISMATCH',
        detail: 'Authorization decision was granted for a different material context.',
        escalatedAt: decidedAt,
      };

      return {
        decisionId,
        materialContextId,
        disposition: 'awaiting_human',
        reasonCode: 'AUTHORIZATION_CONTEXT_MISMATCH',
        evaluations: [],
        escalation,
        decidedAt,
      };
    }

    if (authorization.verdict === 'denied') {
      return {
        decisionId,
        materialContextId,
        disposition: 'authorization_denied',
        reasonCode: authorization.reasonCode || 'AUTHORIZATION_DENIED',
        evaluations: [],
        decidedAt,
      };
    }

    if (authorization.verdict === 'pending') {
      const escalation: HumanEscalation = {
        escalationId: `esc_auth_pend_${decisionId}` as HumanEscalationId,
        decisionId,
        materialContextId,
        kind: 'authorization_pending',
        reasonCode: 'AUTHORIZATION_PENDING',
        detail: 'Human authorization is pending.',
        escalatedAt: decidedAt,
      };

      return {
        decisionId,
        materialContextId,
        disposition: 'awaiting_human',
        reasonCode: 'AUTHORIZATION_PENDING',
        evaluations: [],
        escalation,
        decidedAt,
      };
    }

    if (authorization.verdict === 'not_required') {
      const escalation: HumanEscalation = {
        escalationId: `esc_auth_not_sat_${decisionId}` as HumanEscalationId,
        decisionId,
        materialContextId,
        kind: 'authorization_pending',
        reasonCode: 'AUTHORIZATION_REQUIRED_NOT_SATISFIED',
        detail: 'Authorization verdict not_required does not satisfy authorizationRequired=true.',
        escalatedAt: decidedAt,
      };

      return {
        decisionId,
        materialContextId,
        disposition: 'awaiting_human',
        reasonCode: 'AUTHORIZATION_REQUIRED_NOT_SATISFIED',
        evaluations: [],
        escalation,
        decidedAt,
      };
    }
  } else {
    // authorizationRequired = false
    if (authorization) {
      if (authorization.materialContextId !== materialContextId) {
        const escalation: HumanEscalation = {
          escalationId: `esc_auth_ctx_${decisionId}` as HumanEscalationId,
          decisionId,
          materialContextId,
          kind: 'authorization_pending',
          reasonCode: 'AUTHORIZATION_CONTEXT_MISMATCH',
          detail: 'Authorization decision was granted for a different material context.',
          escalatedAt: decidedAt,
        };

        return {
          decisionId,
          materialContextId,
          disposition: 'awaiting_human',
          reasonCode: 'AUTHORIZATION_CONTEXT_MISMATCH',
          evaluations: [],
          escalation,
          decidedAt,
        };
      }
      if (authorization.verdict === 'denied') {
        return {
          decisionId,
          materialContextId,
          disposition: 'authorization_denied',
          reasonCode: authorization.reasonCode || 'AUTHORIZATION_DENIED',
          evaluations: [],
          decidedAt,
        };
      }
      if (authorization.verdict === 'pending') {
        const escalation: HumanEscalation = {
          escalationId: `esc_auth_pend_${decisionId}` as HumanEscalationId,
          decisionId,
          materialContextId,
          kind: 'authorization_pending',
          reasonCode: 'AUTHORIZATION_PENDING',
          detail: 'Human authorization is pending.',
          escalatedAt: decidedAt,
        };

        return {
          decisionId,
          materialContextId,
          disposition: 'awaiting_human',
          reasonCode: 'AUTHORIZATION_PENDING',
          evaluations: [],
          escalation,
          decidedAt,
        };
      }
    }
  }

  // 4. Gate de Confirmação Humana (0.5E)
  if (confirmationRequired) {
    if (!confirmation) {
      const escalation: HumanEscalation = {
        escalationId: `esc_conf_req_${decisionId}` as HumanEscalationId,
        decisionId,
        materialContextId,
        kind: 'confirmation_required',
        reasonCode: 'CONFIRMATION_REQUIRED',
        detail: 'Operation requires human confirmation before dispatch.',
        escalatedAt: decidedAt,
      };

      return {
        decisionId,
        materialContextId,
        disposition: 'awaiting_human',
        reasonCode: 'CONFIRMATION_REQUIRED',
        evaluations: [],
        escalation,
        decidedAt,
      };
    }

    if (confirmation.materialContextId !== materialContextId) {
      const escalation: HumanEscalation = {
        escalationId: `esc_conf_ctx_${decisionId}` as HumanEscalationId,
        decisionId,
        materialContextId,
        kind: 'confirmation_required',
        reasonCode: 'CONFIRMATION_CONTEXT_MISMATCH',
        detail: 'Confirmation was granted for a different material context.',
        escalatedAt: decidedAt,
      };

      return {
        decisionId,
        materialContextId,
        disposition: 'awaiting_human',
        reasonCode: 'CONFIRMATION_CONTEXT_MISMATCH',
        evaluations: [],
        escalation,
        decidedAt,
      };
    }

    if (confirmation.verdict === 'declined') {
      return {
        decisionId,
        materialContextId,
        disposition: 'cancelled',
        reasonCode: confirmation.reasonCode || 'CONFIRMATION_DECLINED',
        evaluations: [],
        decidedAt,
      };
    }

    if (confirmation.verdict === 'pending') {
      const escalation: HumanEscalation = {
        escalationId: `esc_conf_pend_${decisionId}` as HumanEscalationId,
        decisionId,
        materialContextId,
        kind: 'confirmation_required',
        reasonCode: 'CONFIRMATION_PENDING',
        detail: 'Human confirmation is pending.',
        escalatedAt: decidedAt,
      };

      return {
        decisionId,
        materialContextId,
        disposition: 'awaiting_human',
        reasonCode: 'CONFIRMATION_PENDING',
        evaluations: [],
        escalation,
        decidedAt,
      };
    }

    if (confirmation.verdict === 'not_required') {
      const escalation: HumanEscalation = {
        escalationId: `esc_conf_not_sat_${decisionId}` as HumanEscalationId,
        decisionId,
        materialContextId,
        kind: 'confirmation_required',
        reasonCode: 'CONFIRMATION_REQUIRED_NOT_SATISFIED',
        detail: 'Confirmation verdict not_required does not satisfy confirmationRequired=true.',
        escalatedAt: decidedAt,
      };

      return {
        decisionId,
        materialContextId,
        disposition: 'awaiting_human',
        reasonCode: 'CONFIRMATION_REQUIRED_NOT_SATISFIED',
        evaluations: [],
        escalation,
        decidedAt,
      };
    }
  } else {
    // confirmationRequired = false
    if (confirmation) {
      if (confirmation.verdict === 'declined') {
        return {
          decisionId,
          materialContextId,
          disposition: 'cancelled',
          reasonCode: confirmation.reasonCode || 'CONFIRMATION_DECLINED',
          evaluations: [],
          decidedAt,
        };
      }
      if (confirmation.verdict === 'pending') {
        const escalation: HumanEscalation = {
          escalationId: `esc_conf_pend_${decisionId}` as HumanEscalationId,
          decisionId,
          materialContextId,
          kind: 'confirmation_required',
          reasonCode: 'CONFIRMATION_PENDING',
          detail: 'Human confirmation is pending.',
          escalatedAt: decidedAt,
        };

        return {
          decisionId,
          materialContextId,
          disposition: 'awaiting_human',
          reasonCode: 'CONFIRMATION_PENDING',
          evaluations: [],
          escalation,
          decidedAt,
        };
      }
    }
  }

  // 5. Avaliação das Rotas Candidatas via Binding Heads Atuais
  const bindings = capabilityRegistry.getBindingHeadsForCapability(capability.capabilityRevisionId);
  if (bindings.length === 0) {
    return {
      decisionId,
      materialContextId,
      disposition: 'no_eligible_route',
      reasonCode: 'NO_ROUTES_FOR_CAPABILITY',
      evaluations: [],
      decidedAt,
    };
  }

  const evaluations: RouteEvaluation[] = [];

  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i];
    const route = capabilityRegistry.getRouteRevision(binding.routeRevisionId);
    if (!route) continue;

    const termsResult = capabilityRegistry.getTermsForRoute(route.routeRevisionId, termsContext);
    const runtimeFacts = runtimeFactsMap?.get(route.routeRevisionId);

    const evaluation = evaluateCandidateRoute({
      decisionId,
      materialContextId,
      routeEvaluationId: `eval_${decisionId}_${route.routeRevisionId}` as RouteEvaluationId,
      capability,
      binding,
      route,
      termsResult,
      termsContext,
      policy,
      containsSecretMaterial,
      runtimeFacts,
      evaluatedAt: decidedAt,
    });

    evaluations.push(evaluation);
  }

  const eligible = evaluations.filter((e) => e.status === 'eligible');
  const awaiting = evaluations.filter((e) => e.status === 'awaiting_human');

  // 6. Resolução de Elegibilidade & Seleção Determinística
  if (eligible.length === 0) {
    if (awaiting.length > 0) {
      const escalation: HumanEscalation = {
        escalationId: `esc_dep_${decisionId}` as HumanEscalationId,
        decisionId,
        materialContextId,
        kind: 'deprecated_route_review',
        reasonCode: awaiting[0].reasonCodes[0] || 'ROUTE_DEPRECATED_REVIEW',
        detail: 'The only candidate routes require human review due to deprecation.',
        candidateRouteRevisionIds: awaiting.map((a) => a.routeRevisionId),
        escalatedAt: decidedAt,
      };

      return {
        decisionId,
        materialContextId,
        disposition: 'awaiting_human',
        reasonCode: awaiting[0].reasonCodes[0] || 'ROUTE_DEPRECATED_REVIEW',
        evaluations,
        escalation,
        decidedAt,
      };
    }

    const allPolicyDenied =
      evaluations.length > 0 &&
      evaluations.every((e) =>
        e.reasonCodes.some((r) => r.startsWith('EGRESS_') || r.startsWith('ZERO_COST_')),
      );

    if (allPolicyDenied) {
      const policyReason =
        evaluations[0].reasonCodes.find((r) => r.startsWith('EGRESS_') || r.startsWith('ZERO_COST_')) ||
        'POLICY_DENIED';

      return {
        decisionId,
        materialContextId,
        disposition: 'policy_denied',
        reasonCode: policyReason,
        evaluations,
        decidedAt,
      };
    }

    return {
      decisionId,
      materialContextId,
      disposition: 'no_eligible_route',
      reasonCode: 'NO_ELIGIBLE_ROUTE',
      evaluations,
      decidedAt,
    };
  }

  // Caso A: Se houver RouteSelectionPlan, o plano tem precedência soberana
  if (selectionPlan) {
    const chosenRouteId = selectionPlan.preferredRoutes.find((rId) =>
      eligible.some((e) => e.routeRevisionId === rId),
    );

    if (!chosenRouteId) {
      return {
        decisionId,
        materialContextId,
        disposition: 'no_eligible_route',
        reasonCode: 'SELECTION_PLAN_CONTAINED_NO_ELIGIBLE_ROUTE',
        evaluations,
        decidedAt,
      };
    }

    const chosenEval = eligible.find((e) => e.routeRevisionId === chosenRouteId)!;
    const admission: DispatchAdmission = {
      admissionId: `adm_${decisionId}_${chosenEval.routeRevisionId}` as DispatchAdmissionId,
      decisionId,
      materialContextId,
      routeEvaluationId: chosenEval.routeEvaluationId,
      capabilityRevisionId: chosenEval.capabilityRevisionId,
      bindingRevisionId: chosenEval.bindingRevisionId,
      routeRevisionId: chosenEval.routeRevisionId,
      policyRevisionId: chosenEval.policyRevisionId,
      authorizationDecisionId: authorization?.authorizationId,
      confirmationDecisionId: confirmation?.confirmationId,
      admittedAt: decidedAt,
    };

    return {
      decisionId,
      materialContextId,
      disposition: 'route_selected',
      reasonCode: 'ROUTE_SELECTED_BY_PLAN',
      evaluations,
      admission,
      selectedRouteRevisionId: chosenRouteId,
      decidedAt,
    };
  }

  // Caso B: Exatamente 1 rota elegível sem plano
  if (eligible.length === 1) {
    const chosenEval = eligible[0];
    const admission: DispatchAdmission = {
      admissionId: `adm_${decisionId}_${chosenEval.routeRevisionId}` as DispatchAdmissionId,
      decisionId,
      materialContextId,
      routeEvaluationId: chosenEval.routeEvaluationId,
      capabilityRevisionId: chosenEval.capabilityRevisionId,
      bindingRevisionId: chosenEval.bindingRevisionId,
      routeRevisionId: chosenEval.routeRevisionId,
      policyRevisionId: chosenEval.policyRevisionId,
      authorizationDecisionId: authorization?.authorizationId,
      confirmationDecisionId: confirmation?.confirmationId,
      admittedAt: decidedAt,
    };

    return {
      decisionId,
      materialContextId,
      disposition: 'route_selected',
      reasonCode: 'ROUTE_SELECTED',
      evaluations,
      admission,
      selectedRouteRevisionId: chosenEval.routeRevisionId,
      decidedAt,
    };
  }

  // Caso C: Múltiplas rotas elegíveis sem plano: suspensão para intervenção humana
  const escalation: HumanEscalation = {
    escalationId: `esc_mult_${decisionId}` as HumanEscalationId,
    decisionId,
    materialContextId,
    kind: 'multiple_eligible_routes',
    reasonCode: 'MULTIPLE_ELIGIBLE_ROUTES',
    detail: 'Multiple eligible routes available without an explicit deterministic selection plan.',
    candidateRouteRevisionIds: eligible.map((e) => e.routeRevisionId),
    escalatedAt: decidedAt,
  };

  return {
    decisionId,
    materialContextId,
    disposition: 'awaiting_human',
    reasonCode: 'MULTIPLE_ELIGIBLE_ROUTES',
    evaluations,
    escalation,
    decidedAt,
  };
}
