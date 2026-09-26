/**
 * NEX+ · ExecutionEvidence & Attempt Ledger
 * Mappers Defensivos & Trust Boundary de Leitura — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-2A)
 *
 * Plano de Autoridade (L0).
 * Reconstrução defensiva com validação estrita (fail-closed) de todas as linhas vindas do PostgreSQL.
 * Timestamps convertidos para ISO 8601 UTC estrito terminados em 'Z'.
 * Rejeição estrita de arrays ou valores primitivos nos campos JSONB de fatos e metadados.
 */

import type {
  AttemptEvent,
  AttemptCreatedEvent,
  AttemptStartedEvent,
  AttemptTerminalEvent,
  AttemptId,
  AttemptState,
  AttemptStatus,
  AttemptTerminalStatus,
  DecisionId,
  RouteEvaluationId,
  ExecutionSignal,
  ExecutionSignalId,
  ExecutionEvidence,
  ExecutionEvidenceId,
  ExecutionEvidenceKind,
  OutcomeAssessment,
  OutcomeAssessmentId,
  OutcomeAssessmentVerdict,
  Receipt,
  ReceiptId,
  ReceiptKind,
  ExecutionOutcomeReceipt,
  PolicyDenialReceipt,
  AuthorizationDenialReceipt,
  NoEligibleRouteReceipt,
  CancelledReceipt,
} from '../contracts';
import type {
  CapabilityRevisionId,
  BindingRevisionId,
  RouteRevisionId,
  FactProvenance,
  AcquisitionBasis,
  VerificationStatus,
} from '../../capabilities/contracts';
import type { PolicyRevisionId } from '../../policy/contracts';
import { deepCloneAndFreeze } from '../ledger';
import { CorruptedLedgerRowError } from './errors';

// ============================================================================
// 1. HELPERS DE VALIDAÇÃO DE TRUST BOUNDARY
// ============================================================================

export function formatPgTimestampToUtcInstant(
  val: unknown,
  table: string,
  fieldName: string,
  entityId?: string,
): string {
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) {
      throw new CorruptedLedgerRowError(table, `Field '${fieldName}' contains invalid Date object.`, entityId);
    }
    return val.toISOString();
  }
  if (typeof val === 'string' && val.trim().length > 0) {
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  throw new CorruptedLedgerRowError(
    table,
    `Field '${fieldName}' contains invalid timestamp value '${String(val)}'.`,
    entityId,
  );
}

export function assertPlainObject(
  val: unknown,
  table: string,
  fieldName: string,
  entityId?: string,
): Readonly<Record<string, unknown>> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new CorruptedLedgerRowError(
      table,
      `Field '${fieldName}' must be a non-null plain JSON object. Received: ${Array.isArray(val) ? 'array' : typeof val}`,
      entityId,
    );
  }
  const proto = Object.getPrototypeOf(val);
  if (proto !== Object.prototype && proto !== null) {
    const protoName = (val as any)?.constructor?.name ?? 'unknown';
    throw new CorruptedLedgerRowError(
      table,
      `Field '${fieldName}' must be a non-null plain JSON object. Received non-plain object or class instance (${protoName}).`,
      entityId,
    );
  }
  return deepCloneAndFreeze(val as Record<string, unknown>);
}

export function assertNonEmptyString(
  val: unknown,
  table: string,
  fieldName: string,
  entityId?: string,
): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new CorruptedLedgerRowError(
      table,
      `Field '${fieldName}' must be a non-empty string.`,
      entityId,
    );
  }
  return val.trim();
}

const VALID_ACQUISITION_BASES = new Set<string>([
  'declared',
  'observed',
  'derived',
  'measured',
  'imported',
]);

const VALID_VERIFICATION_STATUSES = new Set<string>([
  'unverified',
  'corroborated',
  'empirically_verified',
  'unknown',
]);

export function validateAndMapFactProvenance(
  val: unknown,
  table: string,
  fieldName: string,
  entityId?: string,
): FactProvenance {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new CorruptedLedgerRowError(
      table,
      `Field '${fieldName}' must be a non-null plain JSON object.`,
      entityId,
    );
  }
  const obj = val as Record<string, unknown>;

  const source = assertNonEmptyString(obj.source, table, `${fieldName}.source`, entityId);

  if (typeof obj.acquisitionBasis !== 'string' || !VALID_ACQUISITION_BASES.has(obj.acquisitionBasis)) {
    throw new CorruptedLedgerRowError(
      table,
      `Field '${fieldName}.acquisitionBasis' must be one of: declared, observed, derived, measured, imported. Received: '${String(obj.acquisitionBasis)}'`,
      entityId,
    );
  }

  if (typeof obj.verificationStatus !== 'string' || !VALID_VERIFICATION_STATUSES.has(obj.verificationStatus)) {
    throw new CorruptedLedgerRowError(
      table,
      `Field '${fieldName}.verificationStatus' must be one of: unverified, corroborated, empirically_verified, unknown. Received: '${String(obj.verificationStatus)}'`,
      entityId,
    );
  }

  const observedAt = formatPgTimestampToUtcInstant(
    obj.observedAt,
    table,
    `${fieldName}.observedAt`,
    entityId,
  );

  let effectiveFrom: string | undefined;
  if (obj.effectiveFrom !== undefined && obj.effectiveFrom !== null) {
    effectiveFrom = formatPgTimestampToUtcInstant(
      obj.effectiveFrom,
      table,
      `${fieldName}.effectiveFrom`,
      entityId,
    );
  }

  let validUntil: string | undefined;
  if (obj.validUntil !== undefined && obj.validUntil !== null) {
    validUntil = formatPgTimestampToUtcInstant(
      obj.validUntil,
      table,
      `${fieldName}.validUntil`,
      entityId,
    );
  }

  let externalReference: string | undefined;
  if (obj.externalReference !== undefined && obj.externalReference !== null) {
    if (typeof obj.externalReference !== 'string') {
      throw new CorruptedLedgerRowError(
        table,
        `Field '${fieldName}.externalReference' must be a string if provided.`,
        entityId,
      );
    }
    externalReference = obj.externalReference;
  }

  return Object.freeze<FactProvenance>({
    source,
    acquisitionBasis: obj.acquisitionBasis as AcquisitionBasis,
    verificationStatus: obj.verificationStatus as VerificationStatus,
    observedAt,
    ...(effectiveFrom ? { effectiveFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
    ...(externalReference !== undefined ? { externalReference } : {}),
  });
}

// ============================================================================
// 2. MAPPER: ATTEMPT STATE & HEAD
// ============================================================================

const VALID_ATTEMPT_STATUSES = new Set<AttemptStatus>([
  'created',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'unknown_completion',
]);

export function mapRowToAttemptState(row: any): AttemptState {
  if (!row || typeof row !== 'object') {
    throw new CorruptedLedgerRowError('nex_execution_attempt_heads', 'Row is null or not an object.');
  }

  const attemptId = row.attempt_id;
  if (typeof attemptId !== 'string' || attemptId.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_attempt_heads', 'Missing or empty attempt_id.');
  }

  if (typeof row.decision_id !== 'string' || row.decision_id.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_attempt_heads', 'Missing or empty decision_id.', attemptId);
  }

  if (typeof row.route_evaluation_id !== 'string' || row.route_evaluation_id.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_attempt_heads', 'Missing or empty route_evaluation_id.', attemptId);
  }

  if (typeof row.capability_revision_id !== 'string' || row.capability_revision_id.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_attempt_heads', 'Missing or empty capability_revision_id.', attemptId);
  }

  if (typeof row.binding_revision_id !== 'string' || row.binding_revision_id.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_attempt_heads', 'Missing or empty binding_revision_id.', attemptId);
  }

  if (typeof row.route_revision_id !== 'string' || row.route_revision_id.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_attempt_heads', 'Missing or empty route_revision_id.', attemptId);
  }

  if (!VALID_ATTEMPT_STATUSES.has(row.status)) {
    throw new CorruptedLedgerRowError('nex_execution_attempt_heads', `Invalid attempt status '${String(row.status)}'.`, attemptId);
  }

  const createdAt = formatPgTimestampToUtcInstant(row.created_at, 'nex_execution_attempt_heads', 'created_at', attemptId);
  const startedAt = row.started_at
    ? formatPgTimestampToUtcInstant(row.started_at, 'nex_execution_attempt_heads', 'started_at', attemptId)
    : undefined;
  const finishedAt = row.finished_at
    ? formatPgTimestampToUtcInstant(row.finished_at, 'nex_execution_attempt_heads', 'finished_at', attemptId)
    : undefined;

  return Object.freeze<AttemptState>({
    attemptId: attemptId as AttemptId,
    decisionId: row.decision_id as DecisionId,
    routeEvaluationId: row.route_evaluation_id as RouteEvaluationId,
    capabilityRevisionId: row.capability_revision_id as CapabilityRevisionId,
    bindingRevisionId: row.binding_revision_id as BindingRevisionId,
    routeRevisionId: row.route_revision_id as RouteRevisionId,
    policyRevisionId: row.policy_revision_id ? (row.policy_revision_id as PolicyRevisionId) : undefined,
    status: row.status as AttemptStatus,
    createdAt,
    startedAt,
    finishedAt,
    terminalReason: typeof row.terminal_reason === 'string' ? row.terminal_reason : undefined,
  });
}

// ============================================================================
// 3. MAPPER: ATTEMPT EVENTS
// ============================================================================

const VALID_TERMINAL_STATUSES = new Set<AttemptTerminalStatus>([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'unknown_completion',
]);

export function mapRowToAttemptEvent(row: any): AttemptEvent {
  if (!row || typeof row !== 'object') {
    throw new CorruptedLedgerRowError('nex_execution_attempt_events', 'Row is null or not an object.');
  }

  const attemptId = row.attempt_id;
  if (typeof attemptId !== 'string' || attemptId.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_attempt_events', 'Missing or empty attempt_id.');
  }

  const occurredAt = formatPgTimestampToUtcInstant(row.occurred_at, 'nex_execution_attempt_events', 'occurred_at', attemptId);

  if (!row.event_payload || typeof row.event_payload !== 'object' || Array.isArray(row.event_payload)) {
    throw new CorruptedLedgerRowError('nex_execution_attempt_events', 'event_payload must be a non-null plain JSON object.', attemptId);
  }
  const payload = row.event_payload as Record<string, unknown>;

  if (payload.type !== row.event_type) {
    throw new CorruptedLedgerRowError(
      'nex_execution_attempt_events',
      `event_payload.type '${String(payload.type)}' does not match event_type '${String(row.event_type)}'.`,
      attemptId,
    );
  }

  if (payload.attemptId !== attemptId) {
    throw new CorruptedLedgerRowError(
      'nex_execution_attempt_events',
      `event_payload.attemptId '${String(payload.attemptId)}' does not match row attempt_id '${attemptId}'.`,
      attemptId,
    );
  }

  switch (row.event_type) {
    case 'AttemptCreated': {
      const decisionId = assertNonEmptyString(payload.decisionId, 'nex_execution_attempt_events', 'event_payload.decisionId', attemptId);
      const routeEvaluationId = assertNonEmptyString(payload.routeEvaluationId, 'nex_execution_attempt_events', 'event_payload.routeEvaluationId', attemptId);
      const capabilityRevisionId = assertNonEmptyString(payload.capabilityRevisionId, 'nex_execution_attempt_events', 'event_payload.capabilityRevisionId', attemptId);
      const bindingRevisionId = assertNonEmptyString(payload.bindingRevisionId, 'nex_execution_attempt_events', 'event_payload.bindingRevisionId', attemptId);
      const routeRevisionId = assertNonEmptyString(payload.routeRevisionId, 'nex_execution_attempt_events', 'event_payload.routeRevisionId', attemptId);

      let policyRevisionId: PolicyRevisionId | undefined;
      if (payload.policyRevisionId !== undefined && payload.policyRevisionId !== null) {
        policyRevisionId = assertNonEmptyString(payload.policyRevisionId, 'nex_execution_attempt_events', 'event_payload.policyRevisionId', attemptId) as PolicyRevisionId;
      }

      const createdAt = formatPgTimestampToUtcInstant(payload.createdAt, 'nex_execution_attempt_events', 'event_payload.createdAt', attemptId);
      if (new Date(createdAt).getTime() !== new Date(occurredAt).getTime()) {
        throw new CorruptedLedgerRowError(
          'nex_execution_attempt_events',
          `Material divergence between event_payload.createdAt '${createdAt}' and occurred_at '${occurredAt}'.`,
          attemptId,
        );
      }

      return Object.freeze<AttemptCreatedEvent>({
        type: 'AttemptCreated',
        attemptId: attemptId as AttemptId,
        decisionId: decisionId as DecisionId,
        routeEvaluationId: routeEvaluationId as RouteEvaluationId,
        capabilityRevisionId: capabilityRevisionId as CapabilityRevisionId,
        bindingRevisionId: bindingRevisionId as BindingRevisionId,
        routeRevisionId: routeRevisionId as RouteRevisionId,
        ...(policyRevisionId ? { policyRevisionId } : {}),
        createdAt,
      });
    }

    case 'AttemptStarted': {
      const startedAt = formatPgTimestampToUtcInstant(payload.startedAt, 'nex_execution_attempt_events', 'event_payload.startedAt', attemptId);
      if (new Date(startedAt).getTime() !== new Date(occurredAt).getTime()) {
        throw new CorruptedLedgerRowError(
          'nex_execution_attempt_events',
          `Material divergence between event_payload.startedAt '${startedAt}' and occurred_at '${occurredAt}'.`,
          attemptId,
        );
      }

      return Object.freeze<AttemptStartedEvent>({
        type: 'AttemptStarted',
        attemptId: attemptId as AttemptId,
        startedAt,
      });
    }

    case 'AttemptTerminal': {
      if (typeof payload.terminalStatus !== 'string' || !VALID_TERMINAL_STATUSES.has(payload.terminalStatus as AttemptTerminalStatus)) {
        throw new CorruptedLedgerRowError(
          'nex_execution_attempt_events',
          `Missing or invalid terminalStatus in AttemptTerminal payload: '${String(payload.terminalStatus)}'.`,
          attemptId,
        );
      }

      let terminalReason: string | undefined;
      if (payload.terminalReason !== undefined && payload.terminalReason !== null) {
        if (typeof payload.terminalReason !== 'string') {
          throw new CorruptedLedgerRowError(
            'nex_execution_attempt_events',
            'terminalReason in AttemptTerminal must be a string if provided.',
            attemptId,
          );
        }
        terminalReason = payload.terminalReason;
      }

      const finishedAt = formatPgTimestampToUtcInstant(payload.finishedAt, 'nex_execution_attempt_events', 'event_payload.finishedAt', attemptId);
      if (new Date(finishedAt).getTime() !== new Date(occurredAt).getTime()) {
        throw new CorruptedLedgerRowError(
          'nex_execution_attempt_events',
          `Material divergence between event_payload.finishedAt '${finishedAt}' and occurred_at '${occurredAt}'.`,
          attemptId,
        );
      }

      return Object.freeze<AttemptTerminalEvent>({
        type: 'AttemptTerminal',
        attemptId: attemptId as AttemptId,
        terminalStatus: payload.terminalStatus as AttemptTerminalStatus,
        finishedAt,
        ...(terminalReason !== undefined ? { terminalReason } : {}),
      });
    }

    default:
      throw new CorruptedLedgerRowError(
        'nex_execution_attempt_events',
        `Unrecognized event_type '${String(row.event_type)}'.`,
        attemptId,
      );
  }
}

// ============================================================================
// 4. MAPPER: EXECUTION SIGNAL
// ============================================================================

export function mapRowToExecutionSignal(row: any): ExecutionSignal {
  if (!row || typeof row !== 'object') {
    throw new CorruptedLedgerRowError('nex_execution_signals', 'Row is null or not an object.');
  }

  const signalId = row.signal_id;
  if (typeof signalId !== 'string' || signalId.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_signals', 'Missing or empty signal_id.');
  }

  if (typeof row.attempt_id !== 'string' || row.attempt_id.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_signals', 'Missing or empty attempt_id.', signalId);
  }

  if (typeof row.kind !== 'string' || row.kind.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_signals', 'Missing or empty kind.', signalId);
  }

  const observedAt = formatPgTimestampToUtcInstant(row.observed_at, 'nex_execution_signals', 'observed_at', signalId);
  const safeMetadata = assertPlainObject(row.safe_metadata, 'nex_execution_signals', 'safe_metadata', signalId);
  const provenance = validateAndMapFactProvenance(row.provenance, 'nex_execution_signals', 'provenance', signalId);

  return Object.freeze<ExecutionSignal>({
    signalId: signalId as ExecutionSignalId,
    attemptId: row.attempt_id as AttemptId,
    kind: row.kind,
    safeMetadata,
    provenance,
    observedAt,
  });
}

// ============================================================================
// 5. MAPPER: EXECUTION EVIDENCE
// ============================================================================

const VALID_EVIDENCE_KINDS = new Set<ExecutionEvidenceKind>([
  'dispatch_confirmed',
  'pre_dispatch_failure',
  'effect_observed',
  'no_effect_verified',
  'result_verified',
  'technical_unproven',
]);

export function mapRowsToExecutionEvidence(
  headerRow: any,
  signalRows: any[],
): ExecutionEvidence {
  if (!headerRow || typeof headerRow !== 'object') {
    throw new CorruptedLedgerRowError('nex_execution_evidence', 'Header row is null or not an object.');
  }

  const evidenceId = headerRow.evidence_id;
  if (typeof evidenceId !== 'string' || evidenceId.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_evidence', 'Missing or empty evidence_id.');
  }

  if (typeof headerRow.attempt_id !== 'string' || headerRow.attempt_id.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_evidence', 'Missing or empty attempt_id.', evidenceId);
  }

  if (!VALID_EVIDENCE_KINDS.has(headerRow.kind)) {
    throw new CorruptedLedgerRowError('nex_execution_evidence', `Invalid evidence kind '${String(headerRow.kind)}'.`, evidenceId);
  }

  let noSideEffectGuarantee: 'structural' | 'none' | undefined;
  if (headerRow.no_side_effect_guarantee !== null && headerRow.no_side_effect_guarantee !== undefined) {
    if (headerRow.no_side_effect_guarantee !== 'structural' && headerRow.no_side_effect_guarantee !== 'none') {
      throw new CorruptedLedgerRowError(
        'nex_execution_evidence',
        `Invalid no_side_effect_guarantee '${String(headerRow.no_side_effect_guarantee)}'. Must be 'structural', 'none', or null.`,
        evidenceId,
      );
    }
    noSideEffectGuarantee = headerRow.no_side_effect_guarantee;
  }

  const recordedAt = formatPgTimestampToUtcInstant(headerRow.recorded_at, 'nex_execution_evidence', 'recorded_at', evidenceId);
  const safeFacts = assertPlainObject(headerRow.safe_facts, 'nex_execution_evidence', 'safe_facts', evidenceId);
  const provenance = validateAndMapFactProvenance(headerRow.provenance, 'nex_execution_evidence', 'provenance', evidenceId);

  const signalRefs = Object.freeze(
    signalRows
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((sr) => {
        if (typeof sr.signal_id !== 'string' || sr.signal_id.trim().length === 0) {
          throw new CorruptedLedgerRowError('nex_execution_evidence_signals', 'Missing signal_id in relation.', evidenceId);
        }
        if (sr.attempt_id && sr.attempt_id !== headerRow.attempt_id) {
          throw new CorruptedLedgerRowError(
            'nex_execution_evidence_signals',
            `Relation attempt_id '${sr.attempt_id}' does not match evidence attempt_id '${headerRow.attempt_id}'.`,
            evidenceId,
          );
        }
        return sr.signal_id as ExecutionSignalId;
      }),
  );

  return Object.freeze<ExecutionEvidence>({
    evidenceId: evidenceId as ExecutionEvidenceId,
    attemptId: headerRow.attempt_id as AttemptId,
    signalRefs,
    kind: headerRow.kind as ExecutionEvidenceKind,
    safeFacts,
    provenance,
    recordedAt,
    ...(noSideEffectGuarantee ? { noSideEffectGuarantee } : {}),
  });
}

// ============================================================================
// 6. MAPPER: OUTCOME ASSESSMENT
// ============================================================================

const VALID_ASSESSMENT_VERDICTS = new Set<OutcomeAssessmentVerdict>([
  'confirmed_mutation',
  'confirmed_no_mutation',
  'confirmed_result',
  'indeterminate',
]);

export function mapRowsToOutcomeAssessment(
  headerRow: any,
  evidenceRows: any[],
): OutcomeAssessment {
  if (!headerRow || typeof headerRow !== 'object') {
    throw new CorruptedLedgerRowError('nex_execution_outcome_assessments', 'Header row is null or not an object.');
  }

  const assessmentId = headerRow.assessment_id;
  if (typeof assessmentId !== 'string' || assessmentId.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_outcome_assessments', 'Missing or empty assessment_id.');
  }

  if (typeof headerRow.attempt_id !== 'string' || headerRow.attempt_id.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_outcome_assessments', 'Missing or empty attempt_id.', assessmentId);
  }

  if (!VALID_ASSESSMENT_VERDICTS.has(headerRow.verdict)) {
    throw new CorruptedLedgerRowError('nex_execution_outcome_assessments', `Invalid verdict '${String(headerRow.verdict)}'.`, assessmentId);
  }

  if (typeof headerRow.reason_code !== 'string' || headerRow.reason_code.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_outcome_assessments', 'Missing or empty reason_code.', assessmentId);
  }

  const assessedAt = formatPgTimestampToUtcInstant(headerRow.assessed_at, 'nex_execution_outcome_assessments', 'assessed_at', assessmentId);

  const evidenceRefs = Object.freeze(
    evidenceRows
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((er) => {
        if (typeof er.evidence_id !== 'string' || er.evidence_id.trim().length === 0) {
          throw new CorruptedLedgerRowError('nex_execution_outcome_evidence', 'Missing evidence_id in relation.', assessmentId);
        }
        if (er.attempt_id && er.attempt_id !== headerRow.attempt_id) {
          throw new CorruptedLedgerRowError(
            'nex_execution_outcome_evidence',
            `Relation attempt_id '${er.attempt_id}' does not match assessment attempt_id '${headerRow.attempt_id}'.`,
            assessmentId,
          );
        }
        return er.evidence_id as ExecutionEvidenceId;
      }),
  );

  return Object.freeze<OutcomeAssessment>({
    assessmentId: assessmentId as OutcomeAssessmentId,
    attemptId: headerRow.attempt_id as AttemptId,
    evidenceRefs,
    verdict: headerRow.verdict as OutcomeAssessmentVerdict,
    reasonCode: headerRow.reason_code,
    supersedesAssessmentId: headerRow.supersedes_assessment_id ? (headerRow.supersedes_assessment_id as OutcomeAssessmentId) : undefined,
    assessedAt,
  });
}

// ============================================================================
// 7. MAPPER: RECEIPT
// ============================================================================

const VALID_RECEIPT_KINDS = new Set<ReceiptKind>([
  'execution_outcome',
  'policy_denial',
  'authorization_denial',
  'cancelled',
  'no_eligible_route',
]);

export function mapRowToReceipt(row: any): Receipt {
  if (!row || typeof row !== 'object') {
    throw new CorruptedLedgerRowError('nex_execution_receipts', 'Row is null or not an object.');
  }

  const receiptId = row.receipt_id;
  if (typeof receiptId !== 'string' || receiptId.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_receipts', 'Missing or empty receipt_id.');
  }

  if (typeof row.decision_id !== 'string' || row.decision_id.trim().length === 0) {
    throw new CorruptedLedgerRowError('nex_execution_receipts', 'Missing or empty decision_id.', receiptId);
  }

  if (!VALID_RECEIPT_KINDS.has(row.kind)) {
    throw new CorruptedLedgerRowError('nex_execution_receipts', `Invalid receipt kind '${String(row.kind)}'.`, receiptId);
  }

  if (typeof row.verdict_summary !== 'string') {
    throw new CorruptedLedgerRowError('nex_execution_receipts', 'Missing verdict_summary.', receiptId);
  }

  if (typeof row.reason_code !== 'string') {
    throw new CorruptedLedgerRowError('nex_execution_receipts', 'Missing reason_code.', receiptId);
  }

  const materializedAt = formatPgTimestampToUtcInstant(row.materialized_at, 'nex_execution_receipts', 'materialized_at', receiptId);
  const safeStructuredFacts = assertPlainObject(row.safe_structured_facts, 'nex_execution_receipts', 'safe_structured_facts', receiptId);

  switch (row.kind) {
    case 'execution_outcome': {
      if (!row.attempt_id || !row.outcome_assessment_id || !row.route_evaluation_id) {
        throw new CorruptedLedgerRowError(
          'nex_execution_receipts',
          'Receipt of kind execution_outcome is missing attempt_id, outcome_assessment_id or route_evaluation_id.',
          receiptId,
        );
      }
      return Object.freeze<ExecutionOutcomeReceipt>({
        receiptId: receiptId as ReceiptId,
        decisionId: row.decision_id as DecisionId,
        kind: 'execution_outcome',
        routeEvaluationId: row.route_evaluation_id as RouteEvaluationId,
        attemptId: row.attempt_id as AttemptId,
        outcomeAssessmentId: row.outcome_assessment_id as OutcomeAssessmentId,
        verdictSummary: row.verdict_summary,
        reasonCode: row.reason_code,
        safeStructuredFacts,
        materializedAt,
      });
    }

    case 'policy_denial': {
      return Object.freeze<PolicyDenialReceipt>({
        receiptId: receiptId as ReceiptId,
        decisionId: row.decision_id as DecisionId,
        kind: 'policy_denial',
        verdictSummary: row.verdict_summary,
        reasonCode: row.reason_code,
        safeStructuredFacts,
        materializedAt,
      });
    }

    case 'authorization_denial': {
      return Object.freeze<AuthorizationDenialReceipt>({
        receiptId: receiptId as ReceiptId,
        decisionId: row.decision_id as DecisionId,
        kind: 'authorization_denial',
        verdictSummary: row.verdict_summary,
        reasonCode: row.reason_code,
        safeStructuredFacts,
        materializedAt,
      });
    }

    case 'cancelled': {
      return Object.freeze<CancelledReceipt>({
        receiptId: receiptId as ReceiptId,
        decisionId: row.decision_id as DecisionId,
        kind: 'cancelled',
        verdictSummary: row.verdict_summary,
        reasonCode: row.reason_code,
        safeStructuredFacts,
        materializedAt,
      });
    }

    case 'no_eligible_route': {
      return Object.freeze<NoEligibleRouteReceipt>({
        receiptId: receiptId as ReceiptId,
        decisionId: row.decision_id as DecisionId,
        kind: 'no_eligible_route',
        verdictSummary: row.verdict_summary,
        reasonCode: row.reason_code,
        safeStructuredFacts,
        materializedAt,
      });
    }

    default:
      throw new CorruptedLedgerRowError('nex_execution_receipts', `Unhandled receipt kind '${String(row.kind)}'.`, receiptId);
  }
}
