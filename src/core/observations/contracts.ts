/**
 * NEX+ · Contratos Canônicos de Observação, Revisão & Temporalidade
 * Escopo 0.85 (Bloco 0.85A)
 *
 * Núcleo transversal de governança de dados:
 * Imutabilidade estrita, identificadores opacos (branded), separação de eixos
 * (Freshness != Review Status != Confidence), rastreabilidade temporal e
 * barreira estrita contra promoção canônica sem autoridade humana.
 */

import type { FactProvenance } from '../capabilities/contracts';
import type { ExecutionEvidenceId } from '../execution/contracts';

// ============================================================================
// 1. IDENTIFICADORES BRANDED (Semantic Aliases)
// ============================================================================

export type ObservationRecordId = string & { readonly __brand?: 'ObservationRecordId' };
export type SourceRefId = string & { readonly __brand?: 'SourceRefId' };
export type EvidenceArtifactRefId = string & { readonly __brand?: 'EvidenceArtifactRefId' };
export type ReviewEventId = string & { readonly __brand?: 'ReviewEventId' };
export type ReconciliationCaseId = string & { readonly __brand?: 'ReconciliationCaseId' };
export type CanonicalProjectionRevisionId = string & { readonly __brand?: 'CanonicalProjectionRevisionId' };
export type ContextualPrecedentRefId = string & { readonly __brand?: 'ContextualPrecedentRefId' };

// ============================================================================
// 2. ATORES E AUTORIDADE (Discriminated Union)
// ============================================================================

export interface HumanActor {
  readonly kind: 'human';
  readonly humanId: string;
  readonly role?: string;
  readonly authorityRef?: string;
}

export interface MaxActor {
  readonly kind: 'max';
  readonly maxVersion: string;
  readonly sessionRef?: string;
}

export interface SystemActor {
  readonly kind: 'system';
  readonly component: string;
  readonly version?: string;
}

export interface IntegrationActor {
  readonly kind: 'integration';
  readonly provider: string;
  readonly integrationId?: string;
}

export type Actor = HumanActor | MaxActor | SystemActor | IntegrationActor;

// ============================================================================
// 3. SUJEITO DA OBSERVAÇÃO / PROJEÇÃO
// ============================================================================

export interface ObservationSubject {
  readonly domain: string;
  readonly entityType: string;
  readonly entityId: string;
}

// ============================================================================
// 4. FONTES E ARTEFATOS DE EVIDÊNCIA
// ============================================================================

export type SourceRefKind =
  | 'url'
  | 'api_endpoint'
  | 'system_feed'
  | 'human_statement'
  | 'document_source'
  | 'internal_process';

export interface SourceRef {
  readonly sourceId: SourceRefId;
  readonly kind: SourceRefKind;
  readonly name: string;
  readonly locationOrUri?: string;
  readonly safeMetadata?: Readonly<Record<string, unknown>>;
}

export type EvidenceArtifactKind =
  | 'url_resource'
  | 'api_response'
  | 'document'
  | 'screenshot'
  | 'snapshot'
  | 'text_snippet'
  | 'human_message'
  | 'execution_evidence_ref';

export interface EvidenceArtifactRef {
  readonly artifactId: EvidenceArtifactRefId;
  readonly kind: EvidenceArtifactKind;
  readonly sourceRefId?: SourceRefId;
  readonly executionEvidenceId?: ExecutionEvidenceId;
  readonly sha256?: string;
  readonly mimeType?: string;
  readonly locationRef?: string;
  readonly safeDescription?: string;
  readonly capturedAt: string; // ISO 8601 UTC
}

// ============================================================================
// 5. OBSERVATION RECORD (Registro Factual de Observação)
// ============================================================================

export interface ObservationRecord {
  readonly observationId: ObservationRecordId;
  readonly subject: ObservationSubject;
  readonly observedClaim: string;
  readonly rawValue: unknown;
  readonly normalizedValue?: unknown;
  readonly actor: Actor;
  readonly channel?: string;
  readonly acquisitionMethod?: string;
  readonly sourceRefs: readonly SourceRefId[];
  readonly evidenceRefs: readonly EvidenceArtifactRefId[];
  readonly provenance?: FactProvenance;
  readonly executionEvidenceRef?: ExecutionEvidenceId;

  // Temporalidade explícita e descolada
  readonly occurredAt?: string; // ISO 8601 UTC (quando o fato ocorreu no mundo real, se conhecido)
  readonly observedAt: string;  // ISO 8601 UTC (quando o ator observou)
  readonly capturedAt: string;  // ISO 8601 UTC (quando o sistema registrou)
  readonly receivedAt?: string;  // ISO 8601 UTC (quando foi recebido externamente)
}

// ============================================================================
// 6. EIXOS INDEPENDENTES: FRESHNESS & CONFIDENCE
// ============================================================================

export type FreshnessState = 'fresh' | 'stale' | 'unknown';

export interface FreshnessInfo {
  readonly state: FreshnessState;
  readonly evaluatedAt: string; // ISO 8601 UTC
  readonly recheckAfter?: string; // ISO 8601 UTC
  readonly reason?: string;
}

export type ConfidenceLevel = 'low' | 'medium' | 'high' | 'unassessed';

export interface ConfidenceAssessment {
  readonly level: ConfidenceLevel;
  readonly assessedAt: string; // ISO 8601 UTC
  readonly basis?: string;
  readonly limitations?: readonly string[];
}

// ============================================================================
// 7. REVIEW EVENT & DECISÃO DE GOVERNANÇA
// ============================================================================

export type ReviewDecision =
  | 'provisional'
  | 'corroborated'
  | 'contested'
  | 'divergent'
  | 'awaiting_evidence'
  | 'inconclusive'
  | 'canonical_promoted'
  | 'canonical_reclassified'
  | 'rejected';

export interface CanonicalEffect {
  readonly action: 'promote' | 'reclassify' | 'deprecate';
  readonly targetCanonicalState: Readonly<Record<string, unknown>>;
}

export interface ReviewEvent {
  readonly reviewId: ReviewEventId;
  readonly actor: Actor;
  readonly targetObservationIds: readonly ObservationRecordId[];
  readonly previousReviewIds?: readonly ReviewEventId[];
  readonly consideredEvidenceIds?: readonly EvidenceArtifactRefId[];
  readonly targetBaseRevisionId?: CanonicalProjectionRevisionId;
  readonly decision: ReviewDecision;
  readonly canonicalEffect?: CanonicalEffect;
  readonly justification: string; // Obrigatória e não vazia
  readonly reviewedAt: string;    // ISO 8601 UTC
}

// ============================================================================
// 8. RECONCILIATION CASE (Divergências e Conflitos)
// ============================================================================

export type ReconciliationStatus =
  | 'open'
  | 'validated'
  | 'partially_validated'
  | 'divergent'
  | 'inconclusive'
  | 'awaiting_evidence'
  | 'reclassified';

export interface ReconciliationCase {
  readonly caseId: ReconciliationCaseId;
  readonly subject: ObservationSubject;
  readonly status: ReconciliationStatus;
  readonly observationIds: readonly ObservationRecordId[];
  readonly reviewIds: readonly ReviewEventId[];
  readonly openedAt: string; // ISO 8601 UTC
  readonly resolvedAt?: string; // ISO 8601 UTC
  readonly resolutionSummary?: string;
}

// ============================================================================
// 9. CANONICAL PROJECTION (Projeção Auditável do Histórico)
// ============================================================================

export interface CanonicalProjection {
  readonly projectionRevisionId: CanonicalProjectionRevisionId;
  readonly subject: ObservationSubject;
  readonly canonicalState: Readonly<Record<string, unknown>>;
  readonly underlyingObservationIds: readonly ObservationRecordId[];
  readonly authorizingReviewIds: readonly ReviewEventId[];
  readonly reconciliationCaseId?: ReconciliationCaseId;
  readonly supersedesRevisionId?: CanonicalProjectionRevisionId;
  readonly materializedAt: string; // ISO 8601 UTC
  readonly explanation: string;    // Justificativa explicável
}

// ============================================================================
// 10. PRECEDENTE CONTEXTUAL (Precedente != PolicyRevision)
// ============================================================================

export interface ContextualPrecedent {
  readonly precedentId: ContextualPrecedentRefId;
  readonly reviewEventId: ReviewEventId;
  readonly contextSummary: string;
  readonly applicabilityConditions: readonly string[];
  readonly policyProposalRef?: string; // Proposta de policy (se houver), nunca virando regra automática
}
