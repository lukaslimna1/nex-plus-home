/**
 * NEX+ · Route Eligibility, Selection & Escalation
 * Tipos de Erro de DispatchAdmission — Escopo 0.85D (Passagem 2)
 *
 * Contratos de Erro de Autoridade de Admissão de L0.
 * Este módulo exporta EXCLUSIVAMENTE classes de erro e nenhum runtime, store, issuer ou autoridade mutável.
 */

import type { AttemptId } from '../execution/contracts';
import type { DispatchAdmissionId } from './contracts';

export class DispatchAdmissionNotFoundError extends Error {
  readonly code = 'DISPATCH_ADMISSION_NOT_FOUND';
  readonly admissionId: DispatchAdmissionId;

  constructor(admissionId: DispatchAdmissionId) {
    super(
      `[L0 Admission Authority] DispatchAdmission '${admissionId}' was not found in runtime authority. Re-evaluation is required.`,
    );
    this.name = 'DispatchAdmissionNotFoundError';
    this.admissionId = admissionId;
  }
}

export class DispatchAdmissionConflictError extends Error {
  readonly code = 'DISPATCH_ADMISSION_CONFLICT';
  readonly admissionId: DispatchAdmissionId;

  constructor(admissionId: DispatchAdmissionId) {
    super(
      `[L0 Admission Authority] DispatchAdmission '${admissionId}' already exists with different payload. Overwrite is strictly prohibited.`,
    );
    this.name = 'DispatchAdmissionConflictError';
    this.admissionId = admissionId;
  }
}

export class DispatchAdmissionAlreadyConsumedError extends Error {
  readonly code = 'DISPATCH_ADMISSION_ALREADY_CONSUMED';
  readonly admissionId: DispatchAdmissionId;
  readonly consumedByAttemptId?: AttemptId;

  constructor(admissionId: DispatchAdmissionId, consumedByAttemptId?: AttemptId) {
    super(
      `[L0 Admission Authority] DispatchAdmission '${admissionId}' has already been consumed${
        consumedByAttemptId ? ` by Attempt '${consumedByAttemptId}'` : ''
      }. Admissions are single-use. Re-evaluation is required.`,
    );
    this.name = 'DispatchAdmissionAlreadyConsumedError';
    this.admissionId = admissionId;
    this.consumedByAttemptId = consumedByAttemptId;
  }
}
