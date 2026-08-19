/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * Implementação do Ledger Append-Only em Memória — Escopo 0.5 (Bloco 0.5D)
 *
 * Plano de Autoridade (L0).
 * Integridade causal estrita, ausência de APIs de update/delete, suporte a late signals.
 */

import type {
  AttemptEvent,
  AttemptId,
  AttemptState,
  DecisionId,
  ExecutionEvidence,
  ExecutionEvidenceId,
  ExecutionLedgerSnapshot,
  ExecutionLedgerStore,
  ExecutionSignal,
  ExecutionSignalId,
  OutcomeAssessment,
  OutcomeAssessmentId,
  Receipt,
  ReceiptId,
} from './contracts';

// ============================================================================
// 1. ERROS DETERMINÍSTICOS DO LEDGER
// ============================================================================

export class DuplicateIdError extends Error {
  readonly id: string;
  readonly entityType: string;
  constructor(id: string, entityType: string) {
    super(`[L0 Execution Ledger] Duplicate ID '${id}' for ${entityType}.`);
    this.name = 'DuplicateIdError';
    this.id = id;
    this.entityType = entityType;
  }
}

export class InvalidAttemptTransitionError extends Error {
  readonly attemptId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  constructor(attemptId: string, fromStatus: string, toStatus: string) {
    super(`[L0 Execution Ledger] Invalid attempt transition for '${attemptId}': cannot transition from '${fromStatus}' to '${toStatus}'.`);
    this.name = 'InvalidAttemptTransitionError';
    this.attemptId = attemptId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

export class InvalidAttemptReferenceError extends Error {
  readonly attemptId: string;
  constructor(attemptId: string, context: string) {
    super(`[L0 Execution Ledger] Reference to non-existent attempt '${attemptId}' during ${context}.`);
    this.name = 'InvalidAttemptReferenceError';
    this.attemptId = attemptId;
  }
}

export class InvalidSignalReferenceError extends Error {
  readonly signalId: string;
  constructor(signalId: string) {
    super(`[L0 Execution Ledger] Reference to non-existent ExecutionSignal '${signalId}'.`);
    this.name = 'InvalidSignalReferenceError';
    this.signalId = signalId;
  }
}

export class InvalidAssessmentReferenceError extends Error {
  readonly assessmentId: string;
  constructor(assessmentId: string) {
    super(`[L0 Execution Ledger] Reference to non-existent OutcomeAssessment '${assessmentId}'.`);
    this.name = 'InvalidAssessmentReferenceError';
    this.assessmentId = assessmentId;
  }
}

export class CrossAttemptReferenceError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`[L0 Execution Ledger] Cross-attempt reference violation: ${detail}.`);
    this.name = 'CrossAttemptReferenceError';
    this.detail = detail;
  }
}

// ============================================================================
// 2. IMPLEMENTAÇÃO IN-MEMORY DO EXECUTION LEDGER STORE
// ============================================================================

export function createExecutionLedgerStore(
  initialData?: Partial<ExecutionLedgerSnapshot>,
): ExecutionLedgerStore {
  const attemptEventsList: AttemptEvent[] = [];
  const attemptStatesById = new Map<AttemptId, AttemptState>();

  const signalsById = new Map<ExecutionSignalId, ExecutionSignal>();
  const signalsByAttempt = new Map<AttemptId, ExecutionSignal[]>();

  const evidenceById = new Map<ExecutionEvidenceId, ExecutionEvidence>();
  const evidenceByAttempt = new Map<AttemptId, ExecutionEvidence[]>();

  const assessmentsById = new Map<OutcomeAssessmentId, OutcomeAssessment>();
  const assessmentsByAttempt = new Map<AttemptId, OutcomeAssessment[]>();

  const receiptsById = new Map<ReceiptId, Receipt>();

  function appendAttemptEvent(event: AttemptEvent): void {
    if (event.type === 'AttemptCreated') {
      if (attemptStatesById.has(event.attemptId)) {
        throw new DuplicateIdError(event.attemptId as string, 'Attempt');
      }

      const state: AttemptState = {
        attemptId: event.attemptId,
        decisionId: event.decisionId,
        routeEvaluationId: event.routeEvaluationId,
        capabilityRevisionId: event.capabilityRevisionId,
        bindingRevisionId: event.bindingRevisionId,
        routeRevisionId: event.routeRevisionId,
        policyRevisionId: event.policyRevisionId,
        status: 'created',
        createdAt: event.createdAt,
      };

      attemptStatesById.set(event.attemptId, state);
      attemptEventsList.push(event);
      return;
    }

    if (event.type === 'AttemptStarted') {
      const current = attemptStatesById.get(event.attemptId);
      if (!current) {
        throw new InvalidAttemptReferenceError(event.attemptId as string, 'AttemptStarted');
      }
      if (current.status !== 'created') {
        throw new InvalidAttemptTransitionError(event.attemptId as string, current.status, 'running');
      }

      const updated: AttemptState = {
        ...current,
        status: 'running',
        startedAt: event.startedAt,
      };

      attemptStatesById.set(event.attemptId, updated);
      attemptEventsList.push(event);
      return;
    }

    if (event.type === 'AttemptTerminal') {
      const current = attemptStatesById.get(event.attemptId);
      if (!current) {
        throw new InvalidAttemptReferenceError(event.attemptId as string, 'AttemptTerminal');
      }
      if (current.status !== 'running') {
        throw new InvalidAttemptTransitionError(event.attemptId as string, current.status, event.terminalStatus);
      }

      const updated: AttemptState = {
        ...current,
        status: event.terminalStatus,
        finishedAt: event.finishedAt,
        terminalReason: event.terminalReason,
      };

      attemptStatesById.set(event.attemptId, updated);
      attemptEventsList.push(event);
      return;
    }
  }

  function appendExecutionSignal(signal: ExecutionSignal): void {
    if (signalsById.has(signal.signalId)) {
      throw new DuplicateIdError(signal.signalId as string, 'ExecutionSignal');
    }

    if (!attemptStatesById.has(signal.attemptId)) {
      throw new InvalidAttemptReferenceError(signal.attemptId as string, 'appendExecutionSignal');
    }

    signalsById.set(signal.signalId, signal);

    const list = signalsByAttempt.get(signal.attemptId) || [];
    list.push(signal);
    signalsByAttempt.set(signal.attemptId, list);
  }

  function appendExecutionEvidence(evidence: ExecutionEvidence): void {
    if (evidenceById.has(evidence.evidenceId)) {
      throw new DuplicateIdError(evidence.evidenceId as string, 'ExecutionEvidence');
    }

    if (!attemptStatesById.has(evidence.attemptId)) {
      throw new InvalidAttemptReferenceError(evidence.attemptId as string, 'appendExecutionEvidence');
    }

    // Validar existência e correlação causal dos sinais referenciados
    for (const sigRef of evidence.signalRefs) {
      const sig = signalsById.get(sigRef);
      if (!sig) {
        throw new InvalidSignalReferenceError(sigRef as string);
      }
      if (sig.attemptId !== evidence.attemptId) {
        throw new CrossAttemptReferenceError(
          `Evidence '${evidence.evidenceId}' (Attempt ${evidence.attemptId}) references Signal '${sigRef}' belonging to Attempt '${sig.attemptId}'`,
        );
      }
    }

    evidenceById.set(evidence.evidenceId, evidence);

    const list = evidenceByAttempt.get(evidence.attemptId) || [];
    list.push(evidence);
    evidenceByAttempt.set(evidence.attemptId, list);
  }

  function appendOutcomeAssessment(assessment: OutcomeAssessment): void {
    if (assessmentsById.has(assessment.assessmentId)) {
      throw new DuplicateIdError(assessment.assessmentId as string, 'OutcomeAssessment');
    }

    if (!attemptStatesById.has(assessment.attemptId)) {
      throw new InvalidAttemptReferenceError(assessment.attemptId as string, 'appendOutcomeAssessment');
    }

    if (assessment.supersedesAssessmentId) {
      const prev = assessmentsById.get(assessment.supersedesAssessmentId);
      if (!prev) {
        throw new InvalidAssessmentReferenceError(assessment.supersedesAssessmentId as string);
      }
      if (prev.attemptId !== assessment.attemptId) {
        throw new CrossAttemptReferenceError(
          `Assessment '${assessment.assessmentId}' (Attempt ${assessment.attemptId}) attempts to supersede Assessment '${assessment.supersedesAssessmentId}' belonging to Attempt '${prev.attemptId}'`,
        );
      }
    }

    assessmentsById.set(assessment.assessmentId, assessment);

    const list = assessmentsByAttempt.get(assessment.attemptId) || [];
    list.push(assessment);
    assessmentsByAttempt.set(assessment.attemptId, list);
  }

  function appendReceipt(receipt: Receipt): void {
    if (receiptsById.has(receipt.receiptId)) {
      throw new DuplicateIdError(receipt.receiptId as string, 'Receipt');
    }

    if (receipt.attemptId && !attemptStatesById.has(receipt.attemptId)) {
      throw new InvalidAttemptReferenceError(receipt.attemptId as string, 'appendReceipt');
    }

    if (receipt.outcomeAssessmentId) {
      const assessment = assessmentsById.get(receipt.outcomeAssessmentId);
      if (!assessment) {
        throw new InvalidAssessmentReferenceError(receipt.outcomeAssessmentId as string);
      }
      if (receipt.attemptId && assessment.attemptId !== receipt.attemptId) {
        throw new CrossAttemptReferenceError(
          `Receipt '${receipt.receiptId}' references Attempt '${receipt.attemptId}' but Assessment '${receipt.outcomeAssessmentId}' belongs to Attempt '${assessment.attemptId}'`,
        );
      }
    }

    receiptsById.set(receipt.receiptId, receipt);
  }

  // Pre-popular dados iniciais se fornecidos
  if (initialData) {
    if (initialData.attemptEvents) {
      for (const ev of initialData.attemptEvents) appendAttemptEvent(ev);
    }
    if (initialData.signals) {
      for (const sig of initialData.signals) appendExecutionSignal(sig);
    }
    if (initialData.evidence) {
      for (const ev of initialData.evidence) appendExecutionEvidence(ev);
    }
    if (initialData.assessments) {
      for (const ass of initialData.assessments) appendOutcomeAssessment(ass);
    }
    if (initialData.receipts) {
      for (const rc of initialData.receipts) appendReceipt(rc);
    }
  }

  return {
    appendAttemptEvent,
    getAttempt(attemptId: AttemptId) {
      return attemptStatesById.get(attemptId);
    },
    listAttemptEvents(attemptId: AttemptId) {
      return attemptEventsList.filter((e) => e.attemptId === attemptId);
    },
    listAttempts(decisionId?: DecisionId) {
      const all = Array.from(attemptStatesById.values());
      return decisionId ? all.filter((a) => a.decisionId === decisionId) : all;
    },

    appendExecutionSignal,
    getExecutionSignal(signalId: ExecutionSignalId) {
      return signalsById.get(signalId);
    },
    listExecutionSignals(attemptId: AttemptId) {
      return signalsByAttempt.get(attemptId) || [];
    },

    appendExecutionEvidence,
    getExecutionEvidence(evidenceId: ExecutionEvidenceId) {
      return evidenceById.get(evidenceId);
    },
    listExecutionEvidence(attemptId: AttemptId) {
      return evidenceByAttempt.get(attemptId) || [];
    },

    appendOutcomeAssessment,
    getOutcomeAssessment(assessmentId: OutcomeAssessmentId) {
      return assessmentsById.get(assessmentId);
    },
    getLatestOutcomeAssessment(attemptId: AttemptId) {
      const list = assessmentsByAttempt.get(attemptId) || [];
      if (list.length === 0) return undefined;
      // Retorna o head (assessment que não foi supersedido por nenhum outro)
      const supersededIds = new Set(list.map((a) => a.supersedesAssessmentId).filter(Boolean));
      const heads = list.filter((a) => !supersededIds.has(a.assessmentId));
      return heads[heads.length - 1] || list[list.length - 1];
    },
    listOutcomeAssessments(attemptId: AttemptId) {
      return assessmentsByAttempt.get(attemptId) || [];
    },

    appendReceipt,
    getReceipt(receiptId: ReceiptId) {
      return receiptsById.get(receiptId);
    },
    listReceipts(decisionId?: DecisionId) {
      const all = Array.from(receiptsById.values());
      return decisionId ? all.filter((r) => r.decisionId === decisionId) : all;
    },

    exportSnapshot(): ExecutionLedgerSnapshot {
      return {
        attemptEvents: Array.from(attemptEventsList),
        signals: Array.from(signalsById.values()),
        evidence: Array.from(evidenceById.values()),
        assessments: Array.from(assessmentsById.values()),
        receipts: Array.from(receiptsById.values()),
      };
    },
  };
}
