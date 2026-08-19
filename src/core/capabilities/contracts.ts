/**
 * NEX+ · Capability Registry & Route/Terms Ledger
 * Contratos Fatuais Canônicos TypeScript — Escopo 0.5 (Bloco 0.5B)
 *
 * Plano de Autoridade (L0).
 * Imutabilidade estrita, identificadores opacos, ausência de mutação retrospectiva.
 */

// ============================================================================
// 1. IDENTIFICADORES CANÔNICOS (Branded / Semantic Aliases)
// ============================================================================

export type CapabilityKey = string & { readonly __brand?: 'CapabilityKey' };
export type CapabilityRevisionId = string & { readonly __brand?: 'CapabilityRevisionId' };

export type RouteKey = string & { readonly __brand?: 'RouteKey' };
export type RouteRevisionId = string & { readonly __brand?: 'RouteRevisionId' };

export type BindingKey = string & { readonly __brand?: 'BindingKey' };
export type BindingRevisionId = string & { readonly __brand?: 'BindingRevisionId' };

export type RouteTermsKey = string & { readonly __brand?: 'RouteTermsKey' };
export type RouteTermsRevisionId = string & { readonly __brand?: 'RouteTermsRevisionId' };

export type AdapterRevisionRef = string & { readonly __brand?: 'AdapterRevisionRef' };
export type NativeContractRevisionRef = string & { readonly __brand?: 'NativeContractRevisionRef' };

// ============================================================================
// 2. ENUMS & CLASSIFICAÇÕES GERAIS
// ============================================================================

export type LifecycleState = 'active' | 'deprecated' | 'retired';

export type DomainEffect = 'none' | 'may_mutate_domain';

export type ExecutionMode =
  | 'atomic_batch'
  | 'streaming'
  | 'non_streaming'
  | 'async_deferred'
  | (string & {});

export type NetworkTopologyScope = 'loopback' | 'lan' | 'wan';

export type ControlOwnership = 'operator_managed' | 'third_party' | 'mixed' | 'unknown';

export type ExternalServiceNature = 'ai_third_party' | 'non_ai_third_party' | 'none' | 'mixed_unknown';

// ============================================================================
// 3. CONTRATOS ESTRUTURAIS (JSON Schema 2020-12)
// ============================================================================

export interface JsonSchema2020 {
  readonly $schema?: string;
  readonly $id?: string;
  readonly type?: string | readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly items?: unknown;
  readonly [key: string]: unknown;
}

// ============================================================================
// 4. FACT PROVENANCE (Rastreabilidade Factual sem Policy)
// ============================================================================

export type FactSource =
  | 'provider_published_terms'
  | 'official_docs'
  | 'aggregator_feed'
  | 'operator_assertion'
  | 'runtime_observation'
  | 'internal_derivation'
  | (string & {});

export type AcquisitionBasis = 'declared' | 'observed' | 'derived' | 'measured' | 'imported';

export type VerificationStatus = 'unverified' | 'corroborated' | 'empirically_verified' | 'unknown';

export interface FactProvenance {
  readonly source: FactSource;
  readonly acquisitionBasis: AcquisitionBasis;
  readonly verificationStatus: VerificationStatus;
  readonly observedAt: string; // ISO 8601 UTC
  readonly effectiveFrom?: string;
  readonly validUntil?: string;
  readonly externalReference?: string;
}

// ============================================================================
// 5. CAPABILITY REVISION
// ============================================================================

export interface CapabilityRevision {
  readonly capabilityKey: CapabilityKey;
  readonly capabilityRevisionId: CapabilityRevisionId;
  readonly lifecycle: LifecycleState;
  readonly supersedesRevisionIds: readonly CapabilityRevisionId[];
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema2020;
  readonly outputSchema: JsonSchema2020;
  readonly domainEffect: DomainEffect;
}

// ============================================================================
// 6. IDEMPOTENCY PROFILE
// ============================================================================

export type IdempotencySupportType = 'none' | 'natural' | 'keyed' | 'unknown';

export interface IdempotencyScopeAndConditions {
  readonly operationScope?: string;
  readonly endpoint?: string;
  readonly apiVersion?: string;
  readonly accountScope?: string;
  readonly keyPlacement?: string;
  readonly retentionWindow?: string;
  readonly payloadRestrictions?: string;
  readonly provenance?: FactProvenance;
}

export interface IdempotencyProfile {
  readonly supportType: IdempotencySupportType;
  readonly scopeAndConditions?: IdempotencyScopeAndConditions;
}

// ============================================================================
// 7. ROUTE REVISION
// ============================================================================

export interface RouteRevision {
  readonly routeKey: RouteKey;
  readonly routeRevisionId: RouteRevisionId;
  readonly lifecycle: LifecycleState;
  readonly supersedesRevisionIds: readonly RouteRevisionId[];
  readonly adapterRevisionRef: AdapterRevisionRef;
  readonly nativeContractRevisionRef?: NativeContractRevisionRef;
  readonly supportedExecutionModes: readonly ExecutionMode[];
  readonly idempotencyProfile: IdempotencyProfile;
  readonly networkTopologyScopes: readonly NetworkTopologyScope[];
  readonly controlOwnership: ControlOwnership;
  readonly externalServiceNature: ExternalServiceNature;
  readonly crossesEgressBoundary: boolean;
  readonly domainEffect: DomainEffect;
}

// ============================================================================
// 8. CAPABILITY-ROUTE BINDING REVISION
// ============================================================================

export interface CapabilityRouteBindingRevision {
  readonly bindingKey: BindingKey;
  readonly bindingRevisionId: BindingRevisionId;
  readonly capabilityRevisionId: CapabilityRevisionId;
  readonly routeRevisionId: RouteRevisionId;
  readonly adapterRevisionRef: AdapterRevisionRef;
  readonly nativeContractRevisionRef?: NativeContractRevisionRef;
  readonly supportedExecutionModes: readonly ExecutionMode[];
  readonly domainEffectAtested: DomainEffect;
  readonly compatibilityProvenance: FactProvenance;
  readonly supersedesRevisionIds: readonly BindingRevisionId[];
}

// ============================================================================
// 9. BILLING & FREE ENTITLEMENTS (Terms Ledger)
// ============================================================================

export type BillingStatus = 'known_none' | 'known_components' | 'unknown';

export type BillingComponentType =
  | 'fixed_subscription'
  | 'flat_contractual'
  | 'metered_usage'
  | 'metered_overage'
  | 'one_time'
  | 'unknown'
  | (string & {});

export interface BillingComponent {
  readonly type: BillingComponentType;
  readonly amount?: number;
  readonly unit?: string;
  readonly currency?: string;
  readonly period?: string;
  readonly applicability?: string;
  readonly provenance?: FactProvenance;
}

export type FreeEntitlementStatus = 'known_none' | 'known_entitlements' | 'unknown';

export type FreeEntitlementType =
  | 'recurring_free_allowance'
  | 'recurring_full_free'
  | 'promotional_credit'
  | 'trial'
  | 'custom_allowance'
  | (string & {});

export interface FreeEntitlement {
  readonly type: FreeEntitlementType;
  readonly quotaAmount?: number;
  readonly unit?: string;
  readonly renewalPeriod?: string;
  readonly validityWindow?: string;
  readonly applicabilityScope?: string;
  readonly provenance?: FactProvenance;
  readonly verificationStatus?: VerificationStatus;
}

export interface TermsApplicability {
  readonly endpoint?: string;
  readonly region?: string;
  readonly accountTier?: string;
  readonly credentialProfileRef?: string;
  readonly requestMode?: string;
  readonly routeMode?: string;
}

export interface PrivacyDataTerms {
  readonly retentionDays?: number | 'unknown';
  readonly trainingUsage?: boolean | 'unknown';
  readonly trainingOptOutGuaranteed?: boolean | 'unknown';
  readonly zeroDataRetentionGuaranteed?: boolean | 'unknown';
  readonly residencyRegion?: string | 'unknown';
  readonly provenance?: FactProvenance;
}

export interface RouteTermsRevision {
  readonly termsKey: RouteTermsKey;
  readonly termsRevisionId: RouteTermsRevisionId;
  readonly routeRevisionId: RouteRevisionId;
  readonly supersedesRevisionIds: readonly RouteTermsRevisionId[];
  readonly applicability?: TermsApplicability;
  readonly provenance: FactProvenance;
  readonly billingStatus: BillingStatus;
  readonly billingComponents: readonly BillingComponent[];
  readonly freeEntitlementStatus: FreeEntitlementStatus;
  readonly freeEntitlements: readonly FreeEntitlement[];
  readonly privacyDataTerms?: PrivacyDataTerms;
  readonly effectiveFrom: string;
  readonly validUntil?: string;
}

// ============================================================================
// 10. ROUTE OBSERVATION (Efêmera de Runtime) & MATERIAL SNAPSHOT
// ============================================================================

export type RouteObservationHealth = 'healthy' | 'degraded' | 'unreachable' | 'cooldown' | 'unknown';

export interface RouteObservation {
  readonly routeKey: RouteKey;
  readonly routeRevisionId: RouteRevisionId;
  readonly health: RouteObservationHealth;
  readonly quotaRemaining?: number;
  readonly cooldownUntil?: string;
  readonly observedLatencyMs?: number;
  readonly recentError?: string;
  readonly observedAt: string;
}

export interface MaterialFactSnapshot {
  readonly observedQuotaRemaining?: number;
  readonly observedHealth?: RouteObservationHealth;
  readonly resolvedTermsApplicability?: Readonly<Record<string, unknown>>;
  readonly snapshotTimestamp: string;
  readonly provenance: FactProvenance;
}

// ============================================================================
// 11. TERMS RESOLUTION & CONTEXT
// ============================================================================

export interface TermsResolutionContext {
  readonly at: string; // ISO 8601 UTC timestamp de avaliação
  readonly endpoint?: string;
  readonly region?: string;
  readonly accountTier?: string;
  readonly credentialProfileRef?: string;
  readonly requestMode?: string;
  readonly routeMode?: string;
}

export type TermsResolutionResult =
  | { readonly status: 'no_terms' }
  | { readonly status: 'no_applicable_terms' }
  | {
      readonly status: 'insufficient_context';
      readonly missingDimensions: readonly string[];
      readonly candidateTerms: readonly RouteTermsRevision[];
      readonly reason: string;
    }
  | { readonly status: 'single_applicable'; readonly terms: RouteTermsRevision }
  | { readonly status: 'composable_terms'; readonly terms: readonly RouteTermsRevision[] }
  | {
      readonly status: 'unresolved_conflict';
      readonly conflictingTerms: readonly RouteTermsRevision[];
      readonly reason: string;
    };
