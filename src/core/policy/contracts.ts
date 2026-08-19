/**
 * NEX+ · Policy Engine · Egress, Zero-Cost & ACL Boundary
 * Contratos Canônicos TypeScript — Escopo 0.5 (Bloco 0.5C)
 *
 * Plano de Autoridade (L0).
 * Imutabilidade estrita, identificadores opacos, ausência de mutação retrospectiva.
 */

import type {
  RouteRevisionId,
  NetworkTopologyScope,
  FactProvenance,
} from '../capabilities/contracts';

// ============================================================================
// 1. IDENTIFICADORES CANÔNICOS DE POLICY
// ============================================================================

export type PolicyKey = string & { readonly __brand?: 'PolicyKey' };
export type PolicyRevisionId = string & { readonly __brand?: 'PolicyRevisionId' };

// ============================================================================
// 2. CLASSES DE SENSIBILIDADE (Duas Classes Estritas)
// ============================================================================

export type SensitivityClass = 'NORMAL' | 'LOCAL_ONLY';

// ============================================================================
// 3. REASON CODES DETERMINÍSTICOS
// ============================================================================

export type EgressReasonCode =
  | 'EGRESS_LOCAL_ONLY_EXTERNAL_PROVIDER'
  | 'EGRESS_LOCAL_ONLY_EXTERNAL_NON_AI'
  | 'EGRESS_LOCAL_ONLY_UNKNOWN_EXTERNAL_PATH'
  | 'EGRESS_NORMAL_ALLOWED'
  | 'EGRESS_NO_EXTERNAL_PROVIDER'
  | (string & {});

export type ZeroCostReasonCode =
  | 'ZERO_COST_NOT_REQUIRED'
  | 'ZERO_COST_NO_EXTERNAL_CHARGE'
  | 'ZERO_COST_RECURRING_FULL_FREE'
  | 'ZERO_COST_RECURRING_ALLOWANCE_PRINCIPLE'
  | 'ZERO_COST_PROMOTIONAL_ONLY'
  | 'ZERO_COST_TRIAL_ONLY'
  | 'ZERO_COST_PAID_ONLY'
  | 'ZERO_COST_TERMS_UNKNOWN'
  | 'ZERO_COST_TERMS_CONFLICT'
  | 'ZERO_COST_CONTEXT_INSUFFICIENT'
  | 'ZERO_COST_NO_APPLICABLE_TERMS'
  | 'ZERO_COST_NO_TERMS'
  | (string & {});

export type PolicyRuntimeRequirement =
  | 'FREE_ALLOWANCE_AVAILABLE'
  | (string & {});

// ============================================================================
// 4. POLICY REVISION
// ============================================================================

export interface PolicyRevision {
  readonly policyKey: PolicyKey;
  readonly policyRevisionId: PolicyRevisionId;
  readonly supersedesRevisionIds: readonly PolicyRevisionId[];
  readonly description?: string;
  readonly defaultSensitivity: SensitivityClass;
  readonly zeroCostRequired: boolean;
}

// ============================================================================
// 5. AXIS DECISION & POLICY DECISION
// ============================================================================

export type AxisVerdict = 'allow' | 'deny';

export interface AxisDecision<R extends string = string> {
  readonly verdict: AxisVerdict;
  readonly reasonCode: R;
}

export interface PolicyDecision {
  readonly policyRevisionId: PolicyRevisionId;
  readonly routeRevisionId: RouteRevisionId;
  readonly effectiveSensitivity: SensitivityClass;
  readonly containsSecretMaterial: boolean;
  readonly egressAxis: AxisDecision<EgressReasonCode>;
  readonly zeroCostAxis: AxisDecision<ZeroCostReasonCode>;
  readonly requiredRuntimeRequirements: readonly PolicyRuntimeRequirement[];
  readonly evaluatedAt: string; // ISO 8601 UTC
}

// ============================================================================
// 6. HUMAN AUTHORIZATION BOUNDARY (Segregação de Responsabilidade)
// ============================================================================

export type HumanAuthorizationVerdict = 'authorized' | 'denied' | 'pending' | 'not_required';

export interface HumanAuthorizationDecision {
  readonly actorRef: string;
  readonly operation: string;
  readonly resourceTarget?: string;
  readonly verdict: HumanAuthorizationVerdict;
  readonly reasonCode: string;
  readonly provenance?: FactProvenance;
  readonly authorizedAt?: string;
}
