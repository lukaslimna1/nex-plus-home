/**
 * NEX+ · Route Eligibility, Selection & Escalation
 * Contratos Canônicos TypeScript — Escopo 0.5 (Bloco 0.5E)
 *
 * Plano de Autoridade (L0).
 * Imutabilidade estrita, identificadores opacos de contexto material,
 * desacoplamento de heurísticas de runtime/LLM e preservação de invariantes INV-01..INV-24.
 */

import type {
  CapabilityKey,
  CapabilityRevisionId,
  BindingRevisionId,
  RouteRevisionId,
  RouteTermsRevisionId,
  FactProvenance,
} from '../capabilities/contracts';

import type { PolicyRevisionId, HumanAuthorizationDecision } from '../policy/contracts';
import type { DecisionId, RouteEvaluationId } from '../execution/contracts';

// ============================================================================
// 1. IDENTIFICADORES CANÔNICOS (Branded Aliases)
// ============================================================================

export type DecisionMaterialContextId = string & { readonly __brand?: 'DecisionMaterialContextId' };
export type AuthorizationDecisionId = string & { readonly __brand?: 'AuthorizationDecisionId' };
export type ConfirmationDecisionId = string & { readonly __brand?: 'ConfirmationDecisionId' };
export type HumanEscalationId = string & { readonly __brand?: 'HumanEscalationId' };
export type DispatchAdmissionId = string & { readonly __brand?: 'DispatchAdmissionId' };
export type SelectionPlanId = string & { readonly __brand?: 'SelectionPlanId' };

// ============================================================================
// 2. HUMAN CONFIRMATION, AUTHORIZATION & INTERPRETATION READINESS
// ============================================================================

export interface ContextualAuthorizationDecision extends HumanAuthorizationDecision {
  readonly authorizationId?: AuthorizationDecisionId;
  readonly materialContextId?: DecisionMaterialContextId;
}

export type ConfirmationVerdict = 'confirmed' | 'declined' | 'pending' | 'not_required';

export interface ConfirmationDecision {
  readonly confirmationId: ConfirmationDecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly actorRef: string;
  readonly operation: string;
  readonly targetRef?: string;
  readonly materialParametersRef?: string;
  readonly verdict: ConfirmationVerdict;
  readonly reasonCode: string;
  readonly confirmedAt?: string; // ISO 8601 UTC
}

export type InterpretationClarity = 'clear' | 'ambiguous';

export interface InterpretationReadiness {
  readonly clarity: InterpretationClarity;
  readonly potentiallyMutating: boolean;
  readonly capabilityKey?: CapabilityKey;
  readonly materialParameters?: Readonly<Record<string, unknown>>;
  readonly reason?: string;
}

// ============================================================================
// 3. RUNTIME FACTS (Observações Fáticas de Runtime)
// ============================================================================

export type RuntimeAvailability = 'available' | 'unavailable' | 'unknown';
export type RuntimeHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
export type RuntimeCooldown = 'clear' | 'active' | 'unknown';
export type RuntimeFreshness = 'fresh' | 'stale' | 'unknown';

export interface RouteRuntimeFacts {
  readonly routeRevisionId: RouteRevisionId;
  readonly availability: RuntimeAvailability;
  readonly health: RuntimeHealth;
  readonly cooldown: RuntimeCooldown;
  readonly freeAllowanceAvailable?: boolean | 'unknown';
  readonly freshness: RuntimeFreshness;
  readonly observedAt: string;
  readonly provenance: FactProvenance;
}

// ============================================================================
// 4. ROUTE SELECTION PLAN (Input Soberano Determinístico de L0)
// ============================================================================

export interface RouteSelectionPlan {
  readonly planId: SelectionPlanId;
  readonly preferredRoutes: readonly RouteRevisionId[];
  readonly createdAt: string;
}

// ============================================================================
// 5. ROUTE EVALUATION RECORD
// ============================================================================

export type RouteEvaluationStatus = 'eligible' | 'ineligible' | 'awaiting_human';

export interface RouteEvaluation {
  readonly routeEvaluationId: RouteEvaluationId;
  readonly decisionId: DecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly capabilityRevisionId: CapabilityRevisionId;
  readonly bindingRevisionId: BindingRevisionId;
  readonly routeRevisionId: RouteRevisionId;
  readonly appliedTermsRevisionIds: readonly RouteTermsRevisionId[];
  readonly policyRevisionId: PolicyRevisionId;
  readonly status: RouteEvaluationStatus;
  readonly reasonCodes: readonly string[];
  readonly materialRuntimeFacts?: Partial<RouteRuntimeFacts>;
  readonly evaluatedAt: string;
}

// ============================================================================
// 6. HUMAN ESCALATION (Handover Formal de L0)
// ============================================================================

export type HumanEscalationKind =
  | 'confirmation_required'
  | 'authorization_pending'
  | 'multiple_eligible_routes'
  | 'indeterminate_mutation'
  | 'deprecated_route_review'
  | 'clarification_required'
  | 'unresolved_conflict';

export interface HumanEscalation {
  readonly escalationId: HumanEscalationId;
  readonly decisionId: DecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly kind: HumanEscalationKind;
  readonly reasonCode: string;
  readonly detail: string;
  readonly candidateRouteRevisionIds?: readonly RouteRevisionId[];
  readonly escalatedAt: string;
}

// ============================================================================
// 7. DISPATCH ADMISSION (Autorização Formal de Entrada em Attempt)
// ============================================================================

export interface DispatchAdmission {
  readonly admissionId: DispatchAdmissionId;
  readonly decisionId: DecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly routeEvaluationId: RouteEvaluationId;
  readonly capabilityRevisionId: CapabilityRevisionId;
  readonly bindingRevisionId: BindingRevisionId;
  readonly routeRevisionId: RouteRevisionId;
  readonly policyRevisionId: PolicyRevisionId;
  readonly authorizationDecisionId?: AuthorizationDecisionId;
  readonly confirmationDecisionId?: ConfirmationDecisionId;
  readonly admittedAt: string;
}

// ============================================================================
// 8. DECISION RESULT & DISPOSITIONS
// ============================================================================

export type DecisionDispositionType =
  | 'route_selected'
  | 'clarification_required'
  | 'awaiting_human'
  | 'authorization_denied'
  | 'policy_denied'
  | 'no_eligible_route'
  | 'cancelled';

export interface DecisionResult {
  readonly decisionId: DecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly disposition: DecisionDispositionType;
  readonly reasonCode: string;
  readonly evaluations: readonly RouteEvaluation[];
  readonly admission?: DispatchAdmission;
  readonly escalation?: HumanEscalation;
  readonly selectedRouteRevisionId?: RouteRevisionId;
  readonly decidedAt: string;
}

// ============================================================================
// 9. CONTINUATION (Diretivas Pós-Tentativa)
// ============================================================================

export type ContinuationDirective =
  | 'stop'
  | 'new_route_evaluation_required'
  | 'human_escalation_required';

export interface ContinuationAssessment {
  readonly directive: ContinuationDirective;
  readonly reasonCode: string;
  readonly escalation?: HumanEscalation;
}
