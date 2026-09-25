/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * Porta Assíncrona de Persistência — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-2A)
 *
 * Plano de Autoridade (L0).
 * Interface assíncrona para persistência durável no PostgreSQL, preservando
 * a semântica canônica do Execution Ledger (Job != Attempt).
 */

import type {
  AttemptEvent,
  AttemptId,
  AttemptState,
  DecisionId,
  ExecutionEvidence,
  ExecutionEvidenceId,
  ExecutionSignal,
  ExecutionSignalId,
  OutcomeAssessment,
  OutcomeAssessmentId,
  Receipt,
  ReceiptId,
} from '../contracts';

export interface DurableExecutionLedgerStore {
  // --------------------------------------------------------------------------
  // 1. Attempt Lifecycle
  // --------------------------------------------------------------------------
  appendAttemptEvent(event: AttemptEvent): Promise<void>;
  getAttempt(attemptId: AttemptId): Promise<AttemptState | undefined>;
  listAttemptEvents(attemptId: AttemptId): Promise<readonly AttemptEvent[]>;
  listAttempts(decisionId?: DecisionId): Promise<readonly AttemptState[]>;

  // --------------------------------------------------------------------------
  // 2. Execution Signals
  // --------------------------------------------------------------------------
  appendExecutionSignal(signal: ExecutionSignal): Promise<void>;
  getExecutionSignal(signalId: ExecutionSignalId): Promise<ExecutionSignal | undefined>;
  listExecutionSignals(attemptId: AttemptId): Promise<readonly ExecutionSignal[]>;

  // --------------------------------------------------------------------------
  // 3. Execution Evidence
  // --------------------------------------------------------------------------
  appendExecutionEvidence(evidence: ExecutionEvidence): Promise<void>;
  getExecutionEvidence(evidenceId: ExecutionEvidenceId): Promise<ExecutionEvidence | undefined>;
  listExecutionEvidence(attemptId: AttemptId): Promise<readonly ExecutionEvidence[]>;

  // --------------------------------------------------------------------------
  // 4. Outcome Assessment
  // --------------------------------------------------------------------------
  appendOutcomeAssessment(assessment: OutcomeAssessment): Promise<void>;
  getOutcomeAssessment(assessmentId: OutcomeAssessmentId): Promise<OutcomeAssessment | undefined>;
  getLatestOutcomeAssessment(attemptId: AttemptId): Promise<OutcomeAssessment | undefined>;
  listOutcomeAssessments(attemptId: AttemptId): Promise<readonly OutcomeAssessment[]>;

  // --------------------------------------------------------------------------
  // 5. Receipts
  // --------------------------------------------------------------------------
  appendReceipt(receipt: Receipt): Promise<void>;
  getReceipt(receiptId: ReceiptId): Promise<Receipt | undefined>;
  listReceipts(decisionId?: DecisionId): Promise<readonly Receipt[]>;
}
