/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * Implementação do Ledger Append-Only em Memória — Escopo 0.5 (Bloco 0.5D / Hardening)
 *
 * Plano de Autoridade (L0).
 * Integridade causal estrita, lineage linear de OutcomeAssessment, validação de EvidenceRefs,
 * validação discriminada de Receipt e imutabilidade defensiva do store.
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

export class InvalidEvidenceReferenceError extends Error {
  readonly evidenceId: string;
  constructor(evidenceId: string) {
    super(`[L0 Execution Ledger] Reference to non-existent ExecutionEvidence '${evidenceId}'.`);
    this.name = 'InvalidEvidenceReferenceError';
    this.evidenceId = evidenceId;
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

export class InvalidAssessmentLineageError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`[L0 Execution Ledger] Invalid assessment lineage: ${detail}.`);
    this.name = 'InvalidAssessmentLineageError';
    this.detail = detail;
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

export class InvalidReceiptStructureError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`[L0 Execution Ledger] Invalid receipt structure: ${detail}.`);
    this.name = 'InvalidReceiptStructureError';
    this.detail = detail;
  }
}

// ============================================================================
// 2. HELPERS DEFENSIVOS DE IMUTABILIDADE PROFUNDA
// ============================================================================

export function deepCloneAndFreeze<T>(val: T): Readonly<T> {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    const copy = val.map((item) => deepCloneAndFreeze(item));
    return Object.freeze(copy) as unknown as Readonly<T>;
  }
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(val)) {
    copy[k] = deepCloneAndFreeze(v);
  }
  return Object.freeze(copy) as unknown as Readonly<T>;
}

// ============================================================================
// 3. IMPLEMENTAÇÃO IN-MEMORY DO EXECUTION LEDGER STORE
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

      attemptStatesById.set(event.attemptId, deepCloneAndFreeze(state));
      attemptEventsList.push(deepCloneAndFreeze(event));
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

      attemptStatesById.set(event.attemptId, deepCloneAndFreeze(updated));
      attemptEventsList.push(deepCloneAndFreeze(event));
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

      attemptStatesById.set(event.attemptId, deepCloneAndFreeze(updated));
      attemptEventsList.push(deepCloneAndFreeze(event));
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

    const frozen = deepCloneAndFreeze(signal);
    signalsById.set(signal.signalId, frozen);

    const list = signalsByAttempt.get(signal.attemptId) || [];
    list.push(frozen);
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

    const frozen = deepCloneAndFreeze(evidence);
    evidenceById.set(evidence.evidenceId, frozen);

    const list = evidenceByAttempt.get(evidence.attemptId) || [];
    list.push(frozen);
    evidenceByAttempt.set(evidence.attemptId, list);
  }

  function appendOutcomeAssessment(assessment: OutcomeAssessment): void {
    if (assessmentsById.has(assessment.assessmentId)) {
      throw new DuplicateIdError(assessment.assessmentId as string, 'OutcomeAssessment');
    }

    if (!attemptStatesById.has(assessment.attemptId)) {
      throw new InvalidAttemptReferenceError(assessment.attemptId as string, 'appendOutcomeAssessment');
    }

    // 1. Validar cada EvidenceRef referenciada
    for (const eviRef of assessment.evidenceRefs) {
      const evi = evidenceById.get(eviRef);
      if (!evi) {
        throw new InvalidEvidenceReferenceError(eviRef as string);
      }
      if (evi.attemptId !== assessment.attemptId) {
        throw new CrossAttemptReferenceError(
          `Assessment '${assessment.assessmentId}' (Attempt ${assessment.attemptId}) references Evidence '${eviRef}' belonging to Attempt '${evi.attemptId}'`,
        );
      }
    }

    // 2. Validar lineage estrita e unívoca do Attempt
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

    const existingList = assessmentsByAttempt.get(assessment.attemptId) || [];
    if (existingList.length === 0) {
      if (assessment.supersedesAssessmentId) {
        throw new InvalidAssessmentLineageError(
          `First assessment '${assessment.assessmentId}' on Attempt '${assessment.attemptId}' cannot supersede another assessment.`,
        );
      }
    } else {
      const currentHead = existingList[existingList.length - 1];
      if (!assessment.supersedesAssessmentId) {
        throw new InvalidAssessmentLineageError(
          `Second assessment '${assessment.assessmentId}' on Attempt '${assessment.attemptId}' must supersede current head '${currentHead.assessmentId}'`,
        );
      }
      if (assessment.supersedesAssessmentId !== currentHead.assessmentId) {
        throw new InvalidAssessmentLineageError(
          `Assessment '${assessment.assessmentId}' must supersede current head '${currentHead.assessmentId}', but specified '${assessment.supersedesAssessmentId}'`,
        );
      }
    }

    const frozen = deepCloneAndFreeze(assessment);
    assessmentsById.set(assessment.assessmentId, frozen);

    existingList.push(frozen);
    assessmentsByAttempt.set(assessment.attemptId, existingList);
  }

  function appendReceipt(receipt: Receipt): void {
    if (receiptsById.has(receipt.receiptId)) {
      throw new DuplicateIdError(receipt.receiptId as string, 'Receipt');
    }

    if (receipt.kind === 'execution_outcome') {
      if (!receipt.attemptId || !receipt.outcomeAssessmentId || !receipt.routeEvaluationId) {
        throw new InvalidReceiptStructureError(
          `Receipt of kind 'execution_outcome' must have attemptId, outcomeAssessmentId, and routeEvaluationId.`,
        );
      }
      if (!attemptStatesById.has(receipt.attemptId)) {
        throw new InvalidAttemptReferenceError(receipt.attemptId as string, 'appendReceipt');
      }
      const assessment = assessmentsById.get(receipt.outcomeAssessmentId);
      if (!assessment) {
        throw new InvalidAssessmentReferenceError(receipt.outcomeAssessmentId as string);
      }
      if (assessment.attemptId !== receipt.attemptId) {
        throw new CrossAttemptReferenceError(
          `Receipt '${receipt.receiptId}' references Attempt '${receipt.attemptId}' but Assessment '${receipt.outcomeAssessmentId}' belongs to Attempt '${assessment.attemptId}'`,
        );
      }
    } else {
      // Receipts sem Attempt (policy_denial, authorization_denial, no_eligible_route, cancelled)
      const untyped = (receipt as unknown) as Record<string, unknown>;
      if (untyped.attemptId !== undefined) {
        throw new InvalidReceiptStructureError(
          `Receipt of kind '${receipt.kind}' must NOT have an attemptId (INV-09 violation).`,
        );
      }
      if (untyped.outcomeAssessmentId !== undefined) {
        throw new InvalidReceiptStructureError(
          `Receipt of kind '${receipt.kind}' must NOT have an outcomeAssessmentId.`,
        );
      }
    }

    receiptsById.set(receipt.receiptId, deepCloneAndFreeze(receipt));
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
      const state = attemptStatesById.get(attemptId);
      return state ? deepCloneAndFreeze(state) : undefined;
    },
    listAttemptEvents(attemptId: AttemptId) {
      return Object.freeze(attemptEventsList.filter((e) => e.attemptId === attemptId).map(deepCloneAndFreeze));
    },
    listAttempts(decisionId?: DecisionId) {
      const all = Array.from(attemptStatesById.values()).map(deepCloneAndFreeze);
      return Object.freeze(decisionId ? all.filter((a) => a.decisionId === decisionId) : all);
    },

    appendExecutionSignal,
    getExecutionSignal(signalId: ExecutionSignalId) {
      const sig = signalsById.get(signalId);
      return sig ? deepCloneAndFreeze(sig) : undefined;
    },
    listExecutionSignals(attemptId: AttemptId) {
      return Object.freeze((signalsByAttempt.get(attemptId) || []).map(deepCloneAndFreeze));
    },

    appendExecutionEvidence,
    getExecutionEvidence(evidenceId: ExecutionEvidenceId) {
      const evi = evidenceById.get(evidenceId);
      return evi ? deepCloneAndFreeze(evi) : undefined;
    },
    listExecutionEvidence(attemptId: AttemptId) {
      return Object.freeze((evidenceByAttempt.get(attemptId) || []).map(deepCloneAndFreeze));
    },

    appendOutcomeAssessment,
    getOutcomeAssessment(assessmentId: OutcomeAssessmentId) {
      const ass = assessmentsById.get(assessmentId);
      return ass ? deepCloneAndFreeze(ass) : undefined;
    },
    getLatestOutcomeAssessment(attemptId: AttemptId) {
      const list = assessmentsByAttempt.get(attemptId) || [];
      if (list.length === 0) return undefined;
      // Head unívoco: último elemento da cadeia estrita
      return deepCloneAndFreeze(list[list.length - 1]);
    },
    listOutcomeAssessments(attemptId: AttemptId) {
      return Object.freeze((assessmentsByAttempt.get(attemptId) || []).map(deepCloneAndFreeze));
    },

    appendReceipt,
    getReceipt(receiptId: ReceiptId) {
      const rc = receiptsById.get(receiptId);
      return rc ? deepCloneAndFreeze(rc) : undefined;
    },
    listReceipts(decisionId?: DecisionId) {
      const all = Array.from(receiptsById.values()).map(deepCloneAndFreeze);
      return Object.freeze(decisionId ? all.filter((r) => r.decisionId === decisionId) : all);
    },

    exportSnapshot(): ExecutionLedgerSnapshot {
      return Object.freeze({
        attemptEvents: Object.freeze(attemptEventsList.map(deepCloneAndFreeze)),
        signals: Object.freeze(Array.from(signalsById.values()).map(deepCloneAndFreeze)),
        evidence: Object.freeze(Array.from(evidenceById.values()).map(deepCloneAndFreeze)),
        assessments: Object.freeze(Array.from(assessmentsById.values()).map(deepCloneAndFreeze)),
        receipts: Object.freeze(Array.from(receiptsById.values()).map(deepCloneAndFreeze)),
      });
    },
  };
}
