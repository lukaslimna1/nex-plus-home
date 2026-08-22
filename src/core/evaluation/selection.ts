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
import type {
  AttemptCreatedEvent,
  AttemptId,
  DecisionId,
  RouteEvaluationId,
} from '../execution/contracts';

import type {
  ConfirmationDecision,
  ContextualAuthorizationDecision,
  ContextualAuthorizationRequirement,
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

import {
  DispatchAdmissionNotFoundError,
  DispatchAdmissionConflictError,
  DispatchAdmissionAlreadyConsumedError,
} from './admission-authority';

import { evaluateCandidateRoute } from './route-evaluation';

interface AdmissionStoreEntry {
  readonly admission: DispatchAdmission;
  consumed: boolean;
  consumedByAttemptId?: AttemptId;
}

const internalStore = new Map<DispatchAdmissionId, AdmissionStoreEntry>();

function deepFreezeAdmission(admission: DispatchAdmission): DispatchAdmission {
  const scopeCopy = admission.authorizationScope
    ? Object.freeze({
        operation: admission.authorizationScope.operation,
        resourceTarget: admission.authorizationScope.resourceTarget,
      })
    : undefined;

  return Object.freeze({
    admissionId: admission.admissionId,
    decisionId: admission.decisionId,
    materialContextId: admission.materialContextId,
    routeEvaluationId: admission.routeEvaluationId,
    capabilityRevisionId: admission.capabilityRevisionId,
    bindingRevisionId: admission.bindingRevisionId,
    routeRevisionId: admission.routeRevisionId,
    policyRevisionId: admission.policyRevisionId,
    authorizationDecisionId: admission.authorizationDecisionId,
    confirmationDecisionId: admission.confirmationDecisionId,
    authorizationScope: scopeCopy,
    admittedAt: admission.admittedAt,
  });
}

function areAdmissionsEqual(a: DispatchAdmission, b: DispatchAdmission): boolean {
  if (
    a.admissionId !== b.admissionId ||
    a.decisionId !== b.decisionId ||
    a.materialContextId !== b.materialContextId ||
    a.routeEvaluationId !== b.routeEvaluationId ||
    a.capabilityRevisionId !== b.capabilityRevisionId ||
    a.bindingRevisionId !== b.bindingRevisionId ||
    a.routeRevisionId !== b.routeRevisionId ||
    a.policyRevisionId !== b.policyRevisionId ||
    a.authorizationDecisionId !== b.authorizationDecisionId ||
    a.confirmationDecisionId !== b.confirmationDecisionId ||
    a.admittedAt !== b.admittedAt
  ) {
    return false;
  }

  if (!a.authorizationScope && !b.authorizationScope) {
    return true;
  }
  if (!a.authorizationScope || !b.authorizationScope) {
    return false;
  }
  return (
    a.authorizationScope.operation === b.authorizationScope.operation &&
    a.authorizationScope.resourceTarget === b.authorizationScope.resourceTarget
  );
}

/**
 * Emissão privada de DispatchAdmission (SEM EXPORT).
 * Invocada EXCLUSIVAMENTE dentro deste módulo por evaluateDecision().
 */
function issueDispatchAdmission(rawAdmission: DispatchAdmission): DispatchAdmission {
  if (!rawAdmission || !rawAdmission.admissionId) {
    throw new Error('[L0 Admission Runtime] Cannot issue admission without valid admissionId.');
  }

  const existing = internalStore.get(rawAdmission.admissionId);
  if (existing) {
    if (areAdmissionsEqual(existing.admission, rawAdmission)) {
      return existing.admission;
    }
    throw new DispatchAdmissionConflictError(rawAdmission.admissionId);
  }

  const frozen = deepFreezeAdmission(rawAdmission);
  internalStore.set(rawAdmission.admissionId, {
    admission: frozen,
    consumed: false,
  });
  return frozen;
}

interface ClaimAdmissionParams {
  readonly admissionId: DispatchAdmissionId;
  readonly attemptId: AttemptId;
  readonly currentMaterialContextId: DecisionMaterialContextId;
  readonly effectiveOperation?: string;
  readonly effectiveResourceTarget?: string;
}

/**
 * Claim privado de DispatchAdmission (SEM EXPORT).
 * Invocado EXCLUSIVAMENTE dentro deste módulo por buildAttemptCreatedEvent().
 */
function claimAdmissionForAttempt(params: ClaimAdmissionParams): DispatchAdmission {
  const {
    admissionId,
    attemptId,
    currentMaterialContextId,
    effectiveOperation,
    effectiveResourceTarget,
  } = params;

  if (!admissionId) {
    throw new Error('[L0 Admission Runtime] admissionId is required to claim DispatchAdmission.');
  }
  if (!attemptId) {
    throw new Error('[L0 Admission Runtime] attemptId is required to claim DispatchAdmission.');
  }

  const entry = internalStore.get(admissionId);
  if (!entry) {
    throw new DispatchAdmissionNotFoundError(admissionId);
  }

  if (entry.consumed) {
    throw new DispatchAdmissionAlreadyConsumedError(admissionId, entry.consumedByAttemptId);
  }

  // 1. Validação de Contexto Material (NÃO consome em caso de falha)
  if (entry.admission.materialContextId !== currentMaterialContextId) {
    throw new Error(
      `[L0 Admission] DispatchAdmission material context mismatch: admission was issued for '${entry.admission.materialContextId}', but current context is '${currentMaterialContextId}'. Re-evaluation is required.`,
    );
  }

  // 2. Validação de Operação Efetiva (NÃO consome em caso de falha)
  if (entry.admission.authorizationScope?.operation) {
    if (!effectiveOperation || effectiveOperation !== entry.admission.authorizationScope.operation) {
      throw new Error(
        `[L0 Admission] Operation mismatch: admission was authorized for operation '${entry.admission.authorizationScope.operation}', but attempt requested '${effectiveOperation ?? 'none'}'.`,
      );
    }
  }

  // 3. Validação de ResourceTarget Efetivo (NÃO consome em caso de falha)
  if (entry.admission.authorizationScope?.resourceTarget !== undefined) {
    if (effectiveResourceTarget !== entry.admission.authorizationScope.resourceTarget) {
      throw new Error(
        `[L0 Admission] ResourceTarget mismatch: admission was authorized for resourceTarget '${entry.admission.authorizationScope.resourceTarget}', but attempt requested '${effectiveResourceTarget ?? 'none'}'.`,
      );
    }
  }

  // 4. Somente após todos os checks passarem: claim atômico e síncrono
  entry.consumed = true;
  entry.consumedByAttemptId = attemptId;

  return entry.admission;
}

function isValidOperation(op: unknown): op is string {
  return typeof op === 'string' && op.length > 0 && op === op.trim();
}

export interface EvaluateDecisionParams {
  readonly decisionId: DecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly interpretation: InterpretationReadiness;
  readonly targetCapabilityRevisionId?: CapabilityRevisionId;
  readonly capabilityRegistry: CapabilityRegistryStore;
  readonly policy: PolicyRevision;
  readonly authorization?: ContextualAuthorizationDecision;
  readonly authorizationRequired?: boolean;
  readonly requiredAuthorizationScope?: ContextualAuthorizationRequirement;
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
    requiredAuthorizationScope,
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

  // 3. Gate de Autorização Humana (0.5C / 0.5E / 0.85D)
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

    // Validação de Escopo Explícito de Autorização (INV-01 / 0.85D Passagem 2 / Blocker I)
    if (
      !requiredAuthorizationScope ||
      !isValidOperation(requiredAuthorizationScope.operation) ||
      (requiredAuthorizationScope.resourceTarget !== undefined &&
        !isValidOperation(requiredAuthorizationScope.resourceTarget))
    ) {
      const escalation: HumanEscalation = {
        escalationId: `esc_auth_scope_req_${decisionId}` as HumanEscalationId,
        decisionId,
        materialContextId,
        kind: 'authorization_pending',
        reasonCode: 'AUTHORIZATION_SCOPE_REQUIRED',
        detail: 'Explicit authorization scope (operation and optional resourceTarget) without whitespace is required when authorizationRequired=true.',
        escalatedAt: decidedAt,
      };

      return {
        decisionId,
        materialContextId,
        disposition: 'awaiting_human',
        reasonCode: 'AUTHORIZATION_SCOPE_REQUIRED',
        evaluations: [],
        escalation,
        decidedAt,
      };
    }

    if (authorization.operation !== requiredAuthorizationScope.operation) {
      const escalation: HumanEscalation = {
        escalationId: `esc_auth_op_${decisionId}` as HumanEscalationId,
        decisionId,
        materialContextId,
        kind: 'authorization_pending',
        reasonCode: 'AUTHORIZATION_OPERATION_MISMATCH',
        detail: `Authorization operation '${authorization.operation}' does not match required operation '${requiredAuthorizationScope.operation}'.`,
        escalatedAt: decidedAt,
      };

      return {
        decisionId,
        materialContextId,
        disposition: 'awaiting_human',
        reasonCode: 'AUTHORIZATION_OPERATION_MISMATCH',
        evaluations: [],
        escalation,
        decidedAt,
      };
    }

    if (
      requiredAuthorizationScope.resourceTarget !== undefined &&
      authorization.resourceTarget !== requiredAuthorizationScope.resourceTarget
    ) {
      const escalation: HumanEscalation = {
        escalationId: `esc_auth_res_${decisionId}` as HumanEscalationId,
        decisionId,
        materialContextId,
        kind: 'authorization_pending',
        reasonCode: 'AUTHORIZATION_RESOURCE_MISMATCH',
        detail: `Authorization resourceTarget '${authorization.resourceTarget}' does not match required resourceTarget '${requiredAuthorizationScope.resourceTarget}'.`,
        escalatedAt: decidedAt,
      };

      return {
        decisionId,
        materialContextId,
        disposition: 'awaiting_human',
        reasonCode: 'AUTHORIZATION_RESOURCE_MISMATCH',
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
      if (requiredAuthorizationScope) {
        if (
          !isValidOperation(requiredAuthorizationScope.operation) ||
          (requiredAuthorizationScope.resourceTarget !== undefined &&
            !isValidOperation(requiredAuthorizationScope.resourceTarget))
        ) {
          const escalation: HumanEscalation = {
            escalationId: `esc_auth_scope_req_${decisionId}` as HumanEscalationId,
            decisionId,
            materialContextId,
            kind: 'authorization_pending',
            reasonCode: 'AUTHORIZATION_SCOPE_REQUIRED',
            detail: 'Explicit authorization scope without whitespace is required.',
            escalatedAt: decidedAt,
          };

          return {
            decisionId,
            materialContextId,
            disposition: 'awaiting_human',
            reasonCode: 'AUTHORIZATION_SCOPE_REQUIRED',
            evaluations: [],
            escalation,
            decidedAt,
          };
        }

        if (authorization.operation !== requiredAuthorizationScope.operation) {
          const escalation: HumanEscalation = {
            escalationId: `esc_auth_op_${decisionId}` as HumanEscalationId,
            decisionId,
            materialContextId,
            kind: 'authorization_pending',
            reasonCode: 'AUTHORIZATION_OPERATION_MISMATCH',
            detail: `Authorization operation '${authorization.operation}' does not match required operation '${requiredAuthorizationScope.operation}'.`,
            escalatedAt: decidedAt,
          };

          return {
            decisionId,
            materialContextId,
            disposition: 'awaiting_human',
            reasonCode: 'AUTHORIZATION_OPERATION_MISMATCH',
            evaluations: [],
            escalation,
            decidedAt,
          };
        }
        if (
          requiredAuthorizationScope.resourceTarget !== undefined &&
          authorization.resourceTarget !== requiredAuthorizationScope.resourceTarget
        ) {
          const escalation: HumanEscalation = {
            escalationId: `esc_auth_res_${decisionId}` as HumanEscalationId,
            decisionId,
            materialContextId,
            kind: 'authorization_pending',
            reasonCode: 'AUTHORIZATION_RESOURCE_MISMATCH',
            detail: `Authorization resourceTarget '${authorization.resourceTarget}' does not match required resourceTarget '${requiredAuthorizationScope.resourceTarget}'.`,
            escalatedAt: decidedAt,
          };

          return {
            decisionId,
            materialContextId,
            disposition: 'awaiting_human',
            reasonCode: 'AUTHORIZATION_RESOURCE_MISMATCH',
            evaluations: [],
            escalation,
            decidedAt,
          };
        }
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
    const rawAdmission: DispatchAdmission = {
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
      authorizationScope: requiredAuthorizationScope,
      admittedAt: decidedAt,
    };
    const admission = issueDispatchAdmission(rawAdmission);

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
    const rawAdmission: DispatchAdmission = {
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
      authorizationScope: requiredAuthorizationScope,
      admittedAt: decidedAt,
    };
    const admission = issueDispatchAdmission(rawAdmission);

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

export interface BuildAttemptCreatedEventParams {
  readonly admissionId: DispatchAdmissionId;
  readonly attemptId: AttemptId;
  readonly createdAt: string;
  readonly currentMaterialContextId: DecisionMaterialContextId;
  readonly effectiveOperation?: string;
  readonly effectiveResourceTarget?: string;
}

/**
 * Constrói o evento canônico AttemptCreatedEvent através do claim de uma DispatchAdmission canônica.
 *
 * PROPRIEDADES DE AUTORIDADE DE L0 (Passagem 2 - Issuer Módulo-Privado):
 * 1. Somente o fluxo interno de evaluateDecision() emite DispatchAdmission.
 * 2. O issuer e o claim NÃO são exportados; permanecem estritamente privados a este módulo.
 * 3. O claim é síncrono, atômico e estritamente SINGLE-USE: uma admission só pode ser consumida uma vez.
 * 4. Validações de materialContextId, effectiveOperation e effectiveResourceTarget não queimam token em falha.
 * 5. Todas as referências derivam exclusivamente da admissão canônica registrada no store privado.
 */
export function buildAttemptCreatedEvent(
  params: BuildAttemptCreatedEventParams,
): AttemptCreatedEvent {
  if (!params || typeof params !== 'object') {
    throw new Error('[L0 Admission] BuildAttemptCreatedEventParams is required.');
  }

  const {
    admissionId,
    attemptId,
    createdAt,
    currentMaterialContextId,
    effectiveOperation,
    effectiveResourceTarget,
  } = params;

  if (!admissionId || !attemptId || !createdAt || !currentMaterialContextId) {
    throw new Error(
      '[L0 Admission] admissionId, attemptId, createdAt, and currentMaterialContextId are required.',
    );
  }

  // 1. Claim atômico e síncrono no runtime privado de módulo
  const canonicalAdmission = claimAdmissionForAttempt({
    admissionId,
    attemptId,
    currentMaterialContextId,
    effectiveOperation,
    effectiveResourceTarget,
  });

  // 2. Derivar AttemptCreatedEvent SOMENTE da Admission Canônica
  return {
    type: 'AttemptCreated',
    attemptId,
    decisionId: canonicalAdmission.decisionId,
    routeEvaluationId: canonicalAdmission.routeEvaluationId,
    capabilityRevisionId: canonicalAdmission.capabilityRevisionId,
    bindingRevisionId: canonicalAdmission.bindingRevisionId,
    routeRevisionId: canonicalAdmission.routeRevisionId,
    policyRevisionId: canonicalAdmission.policyRevisionId,
    createdAt,
  };
}

/**
 * Helper estritamente de teste para isolamento de suítes de teste.
 * NÃO exportado no barrel público (src/core/evaluation/index.ts).
 */
export function __resetAdmissionRuntimeForTestsOnly(): void {
  internalStore.clear();
}
