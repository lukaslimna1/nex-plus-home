/**
 * NEX+ · Contratos Canônicos de Observação, Revisão & Temporalidade
 * Escopo 0.85 (Bloco 0.85A · Hardening Pós-Auditoria)
 *
 * Núcleo transversal de governança de dados:
 * Imutabilidade estrita, identificadores opacos (branded), discriminated unions
 * com narrowing estrito em compile-time e validadores runtime fechados.
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
// 2. ATORES E AUTORIDADE (Discriminated Union Fechada)
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
export type ActorKind = Actor['kind'];

// ============================================================================
// 3. SUJEITO DA OBSERVAÇÃO / PROJEÇÃO
// ============================================================================

export interface ObservationSubject {
  readonly domain: string;
  readonly entityType: string;
  readonly entityId: string;
}

// ============================================================================
// 4. FONTES E ARTEFATOS DE EVIDÊNCIA (Discriminated Union)
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

export interface BaseEvidenceArtifactRef {
  readonly artifactId: EvidenceArtifactRefId;
  readonly sourceRefId?: SourceRefId;
  readonly sha256?: string;
  readonly mimeType?: string;
  readonly locationRef?: string;
  readonly safeDescription?: string;
  readonly capturedAt: string; // ISO 8601 UTC ('Z')
}

export type NonExecutionEvidenceArtifactKind =
  | 'url_resource'
  | 'api_response'
  | 'document'
  | 'screenshot'
  | 'snapshot'
  | 'text_snippet'
  | 'human_message';

export interface GenericEvidenceArtifactRef extends BaseEvidenceArtifactRef {
  readonly kind: NonExecutionEvidenceArtifactKind;
  readonly executionEvidenceId?: never;
}

export interface ExecutionEvidenceArtifactRef extends BaseEvidenceArtifactRef {
  readonly kind: 'execution_evidence_ref';
  readonly executionEvidenceId: ExecutionEvidenceId; // Obrigatório nesta variante
}

export type EvidenceArtifactRef = GenericEvidenceArtifactRef | ExecutionEvidenceArtifactRef;
export type EvidenceArtifactKind = EvidenceArtifactRef['kind'];

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

  // Temporalidade explícita e canônica (UTC 'Z')
  readonly occurredAt?: string; // ISO 8601 UTC ('Z') - quando o fato ocorreu no mundo real
  readonly observedAt: string;  // ISO 8601 UTC ('Z') - quando o ator observou
  readonly capturedAt: string;  // ISO 8601 UTC ('Z') - quando o sistema gravou
  readonly receivedAt?: string;  // ISO 8601 UTC ('Z') - quando recebido externamente
}

// ============================================================================
// 6. EIXOS INDEPENDENTES: FRESHNESS & CONFIDENCE
// ============================================================================

export type FreshnessState = 'fresh' | 'stale' | 'unknown';

export interface FreshnessInfo {
  readonly state: FreshnessState;
  readonly evaluatedAt: string; // ISO 8601 UTC ('Z')
  readonly recheckAfter?: string; // ISO 8601 UTC ('Z')
  readonly reason?: string;
}

export type ConfidenceLevel = 'low' | 'medium' | 'high' | 'unassessed';

export interface ConfidenceAssessment {
  readonly level: ConfidenceLevel;
  readonly assessedAt: string; // ISO 8601 UTC ('Z')
  readonly basis?: string;
  readonly limitations?: readonly string[];
}

// ============================================================================
// 7. REVIEW EVENT & CANONICAL EFFECT (Discriminated Union Estrita)
// ============================================================================

export type NonCanonicalReviewDecision =
  | 'provisional'
  | 'corroborated'
  | 'contested'
  | 'divergent'
  | 'awaiting_evidence'
  | 'inconclusive'
  | 'rejected';

export interface PromoteCanonicalEffect {
  readonly action: 'promote';
  readonly targetCanonicalState: Readonly<Record<string, unknown>>;
}

export interface ReclassifyCanonicalEffect {
  readonly action: 'reclassify';
  readonly targetCanonicalState: Readonly<Record<string, unknown>>;
}

export type CanonicalEffect = PromoteCanonicalEffect | ReclassifyCanonicalEffect;

export interface BaseReviewEvent {
  readonly reviewId: ReviewEventId;
  readonly targetObservationIds: readonly ObservationRecordId[];
  readonly previousReviewIds?: readonly ReviewEventId[];
  readonly consideredEvidenceIds?: readonly EvidenceArtifactRefId[];
  readonly targetBaseRevisionId?: CanonicalProjectionRevisionId;
  readonly justification: string; // Obrigatória e não vazia
  readonly reviewedAt: string;    // ISO 8601 UTC ('Z')
}

export interface NonCanonicalReviewEvent extends BaseReviewEvent {
  readonly actor: Actor;
  readonly decision: NonCanonicalReviewDecision;
  readonly canonicalEffect?: never; // Estritamente proibido em decisões não-canônicas
}

export interface CanonicalPromotedReviewEvent extends BaseReviewEvent {
  readonly actor: HumanActor; // Exige ator humano
  readonly decision: 'canonical_promoted';
  readonly canonicalEffect: PromoteCanonicalEffect; // Obrigatório action 'promote'
}

export interface CanonicalReclassifiedReviewEvent extends BaseReviewEvent {
  readonly actor: HumanActor; // Exige ator humano
  readonly decision: 'canonical_reclassified';
  readonly canonicalEffect: ReclassifyCanonicalEffect; // Obrigatório action 'reclassify'
}

export type ReviewEvent =
  | NonCanonicalReviewEvent
  | CanonicalPromotedReviewEvent
  | CanonicalReclassifiedReviewEvent;

export type ReviewDecision = ReviewEvent['decision'];

// ============================================================================
// 8. RECONCILIATION CASE (Discriminated Union por Lifecycle)
// ============================================================================

export type ReconciliationLifecycle = 'open' | 'resolved';

export type OpenReconciliationStatus =
  | 'open'
  | 'awaiting_evidence'
  | 'divergent'
  | 'inconclusive';

export type ResolvedReconciliationStatus =
  | 'validated'
  | 'partially_validated'
  | 'divergent'
  | 'inconclusive'
  | 'reclassified';

export interface BaseReconciliationCase {
  readonly caseId: ReconciliationCaseId;
  readonly subject: ObservationSubject;
  readonly observationIds: readonly ObservationRecordId[];
  readonly reviewIds: readonly ReviewEventId[];
  readonly openedAt: string; // ISO 8601 UTC ('Z')
}

export interface OpenReconciliationCase extends BaseReconciliationCase {
  readonly lifecycle: 'open';
  readonly status: OpenReconciliationStatus;
  readonly resolvedAt?: never; // Proibido enquanto o caso estiver aberto
  readonly resolutionSummary?: string; // Contexto/anotação corrente opcional
}

export interface ResolvedReconciliationCase extends BaseReconciliationCase {
  readonly lifecycle: 'resolved';
  readonly status: ResolvedReconciliationStatus;
  readonly resolvedAt: string; // Obrigatório no encerramento
  readonly resolutionSummary: string; // Obrigatório no encerramento
}

export type ReconciliationCase = OpenReconciliationCase | ResolvedReconciliationCase;
export type ReconciliationStatus = ReconciliationCase['status'];

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
  readonly materializedAt: string; // ISO 8601 UTC ('Z')
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
  readonly policyProposalRef?: string; // Proposta de policy (se houver), nunca regra automática
}
