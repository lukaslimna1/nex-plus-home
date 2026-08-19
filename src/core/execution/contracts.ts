/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * Contratos Canônicos TypeScript — Escopo 0.5 (Bloco 0.5D)
 *
 * Plano de Autoridade (L0).
 * Imutabilidade estrita, identificadores opacos, ausência de mutação retrospectiva.
 */

import type {
  CapabilityRevisionId,
  BindingRevisionId,
  RouteRevisionId,
  FactProvenance,
} from '../capabilities/contracts';

import type { PolicyRevisionId } from '../policy/contracts';

// ============================================================================
// 1. IDENTIFICADORES CANÔNICOS (Branded Aliases)
// ============================================================================

export type DecisionId = string & { readonly __brand?: 'DecisionId' };
export type RouteEvaluationId = string & { readonly __brand?: 'RouteEvaluationId' };
export type AttemptId = string & { readonly __brand?: 'AttemptId' };
export type ExecutionSignalId = string & { readonly __brand?: 'ExecutionSignalId' };
export type ExecutionEvidenceId = string & { readonly __brand?: 'ExecutionEvidenceId' };
export type OutcomeAssessmentId = string & { readonly __brand?: 'OutcomeAssessmentId' };
export type ReceiptId = string & { readonly __brand?: 'ReceiptId' };

// ============================================================================
// 2. ATTEMPT LIFECYCLE & EVENTOS APPEND-ONLY
// ============================================================================

export type AttemptStatus =
  | 'created'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'unknown_completion';

export type AttemptTerminalStatus =
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'unknown_completion';

export interface AttemptCreatedEvent {
  readonly type: 'AttemptCreated';
  readonly attemptId: AttemptId;
  readonly decisionId: DecisionId;
  readonly routeEvaluationId: RouteEvaluationId;
  readonly capabilityRevisionId: CapabilityRevisionId;
  readonly bindingRevisionId: BindingRevisionId;
  readonly routeRevisionId: RouteRevisionId;
  readonly policyRevisionId?: PolicyRevisionId;
  readonly createdAt: string; // ISO 8601 UTC
}

export interface AttemptStartedEvent {
  readonly type: 'AttemptStarted';
  readonly attemptId: AttemptId;
  readonly startedAt: string; // ISO 8601 UTC
}

export interface AttemptTerminalEvent {
  readonly type: 'AttemptTerminal';
  readonly attemptId: AttemptId;
  readonly terminalStatus: AttemptTerminalStatus;
  readonly terminalReason?: string;
  readonly finishedAt: string; // ISO 8601 UTC
}

export type AttemptEvent = AttemptCreatedEvent | AttemptStartedEvent | AttemptTerminalEvent;

export interface AttemptState {
  readonly attemptId: AttemptId;
  readonly decisionId: DecisionId;
  readonly routeEvaluationId: RouteEvaluationId;
  readonly capabilityRevisionId: CapabilityRevisionId;
  readonly bindingRevisionId: BindingRevisionId;
  readonly routeRevisionId: RouteRevisionId;
  readonly policyRevisionId?: PolicyRevisionId;
  readonly status: AttemptStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly terminalReason?: string;
}

// ============================================================================
// 3. EXECUTION SIGNAL (Sinais dos Executores / Drivers)
// ============================================================================

export type ExecutionSignalKind =
  | 'dispatch_confirmed'
  | 'pre_dispatch_failure'
  | 'technical_success'
  | 'technical_failure'
  | 'completion_unknown'
  | 'effect_observed'
  | 'no_effect_verified'
  | 'result_verified'
  | (string & {});

export interface ExecutionSignal {
  readonly signalId: ExecutionSignalId;
  readonly attemptId: AttemptId;
  readonly kind: ExecutionSignalKind;
  readonly safeMetadata: Readonly<Record<string, unknown>>;
  readonly provenance: FactProvenance;
  readonly observedAt: string;
}

// ============================================================================
// 4. EXECUTION EVIDENCE (Evidências Canônicas de L0)
// ============================================================================

export type ExecutionEvidenceKind =
  | 'dispatch_confirmed'
  | 'pre_dispatch_failure'
  | 'effect_observed'
  | 'no_effect_verified'
  | 'result_verified'
  | 'technical_unproven';

export interface ExecutionEvidence {
  readonly evidenceId: ExecutionEvidenceId;
  readonly attemptId: AttemptId;
  readonly signalRefs: readonly ExecutionSignalId[];
  readonly kind: ExecutionEvidenceKind;
  readonly safeFacts: Readonly<Record<string, unknown>>;
  readonly provenance: FactProvenance;
  readonly recordedAt: string;
}

// ============================================================================
// 5. OUTCOME ASSESSMENT (Avaliação Factual de Desfecho)
// ============================================================================

export type OutcomeAssessmentVerdict =
  | 'confirmed_mutation'
  | 'confirmed_no_mutation'
  | 'confirmed_result'
  | 'indeterminate';

export interface OutcomeAssessment {
  readonly assessmentId: OutcomeAssessmentId;
  readonly attemptId: AttemptId;
  readonly evidenceRefs: readonly ExecutionEvidenceId[];
  readonly verdict: OutcomeAssessmentVerdict;
  readonly reasonCode: string;
  readonly supersedesAssessmentId?: OutcomeAssessmentId;
  readonly assessedAt: string;
}

// ============================================================================
// 6. RECEIPT MATERIALIZADO (Registro Imutável de Decisão / Execução)
// ============================================================================

export type ReceiptKind =
  | 'execution_outcome'
  | 'policy_denial'
  | 'authorization_denial'
  | 'cancelled'
  | 'no_eligible_route';

export interface Receipt {
  readonly receiptId: ReceiptId;
  readonly decisionId: DecisionId;
  readonly kind: ReceiptKind;
  readonly routeEvaluationId?: RouteEvaluationId;
  readonly attemptId?: AttemptId;
  readonly outcomeAssessmentId?: OutcomeAssessmentId;
  readonly verdictSummary: string;
  readonly reasonCode: string;
  readonly safeStructuredFacts: Readonly<Record<string, unknown>>;
  readonly materializedAt: string;
}

// ============================================================================
// 7. EXECUTION LEDGER STORE INTERFACE
// ============================================================================

export interface ExecutionLedgerStore {
  // Attempt lifecycle append-only
  appendAttemptEvent(event: AttemptEvent): void;
  getAttempt(attemptId: AttemptId): AttemptState | undefined;
  listAttemptEvents(attemptId: AttemptId): readonly AttemptEvent[];
  listAttempts(decisionId?: DecisionId): readonly AttemptState[];

  // Signals
  appendExecutionSignal(signal: ExecutionSignal): void;
  getExecutionSignal(signalId: ExecutionSignalId): ExecutionSignal | undefined;
  listExecutionSignals(attemptId: AttemptId): readonly ExecutionSignal[];

  // Evidence
  appendExecutionEvidence(evidence: ExecutionEvidence): void;
  getExecutionEvidence(evidenceId: ExecutionEvidenceId): ExecutionEvidence | undefined;
  listExecutionEvidence(attemptId: AttemptId): readonly ExecutionEvidence[];

  // Assessments
  appendOutcomeAssessment(assessment: OutcomeAssessment): void;
  getOutcomeAssessment(assessmentId: OutcomeAssessmentId): OutcomeAssessment | undefined;
  getLatestOutcomeAssessment(attemptId: AttemptId): OutcomeAssessment | undefined;
  listOutcomeAssessments(attemptId: AttemptId): readonly OutcomeAssessment[];

  // Receipts
  appendReceipt(receipt: Receipt): void;
  getReceipt(receiptId: ReceiptId): Receipt | undefined;
  listReceipts(decisionId?: DecisionId): readonly Receipt[];

  // Snapshot / Export
  exportSnapshot(): ExecutionLedgerSnapshot;
}

export interface ExecutionLedgerSnapshot {
  readonly attemptEvents: readonly AttemptEvent[];
  readonly signals: readonly ExecutionSignal[];
  readonly evidence: readonly ExecutionEvidence[];
  readonly assessments: readonly OutcomeAssessment[];
  readonly receipts: readonly Receipt[];
}
