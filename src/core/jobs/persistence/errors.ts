/**
 * NEX+ · Job Lifecycle Core
 * Erros Determinísticos de Persistência — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-2B)
 *
 * Plano de Autoridade (L0).
 * Classes de erro especializadas e reconhecíveis para DurableJobStore.
 */

export { JobLifecycleError } from '../invariants';

export class DuplicateJobIdError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`[L0 Durable Job Store] Job with ID '${jobId}' already exists.`);
    this.name = 'DuplicateJobIdError';
    this.jobId = jobId;
    Object.setPrototypeOf(this, DuplicateJobIdError.prototype);
  }
}

export class JobNotFoundError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`[L0 Durable Job Store] Job with ID '${jobId}' not found.`);
    this.name = 'JobNotFoundError';
    this.jobId = jobId;
    Object.setPrototypeOf(this, JobNotFoundError.prototype);
  }
}

export class JobRevisionConflictError extends Error {
  readonly jobId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(jobId: string, expectedRevision: number, actualRevision: number) {
    super(
      `[L0 Durable Job Store] Revision conflict for Job '${jobId}': expected revision ${expectedRevision}, but found revision ${actualRevision}.`,
    );
    this.name = 'JobRevisionConflictError';
    this.jobId = jobId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
    Object.setPrototypeOf(this, JobRevisionConflictError.prototype);
  }
}

export class CorruptedJobStorageError extends Error {
  readonly table: string;
  readonly jobId?: string;
  readonly detail: string;

  constructor(table: string, detail: string, jobId?: string) {
    super(
      `[L0 Durable Job Store] Corrupted storage row in table '${table}'${jobId ? ` for Job '${jobId}'` : ''}: ${detail}`,
    );
    this.name = 'CorruptedJobStorageError';
    this.table = table;
    this.jobId = jobId;
    this.detail = detail;
    Object.setPrototypeOf(this, CorruptedJobStorageError.prototype);
  }
}

export class JobRehydrationDivergenceError extends Error {
  readonly jobId: string;
  readonly detail: string;

  constructor(jobId: string, detail: string) {
    super(`[L0 Durable Job Store] Rehydration divergence for Job '${jobId}': ${detail}`);
    this.name = 'JobRehydrationDivergenceError';
    this.jobId = jobId;
    this.detail = detail;
    Object.setPrototypeOf(this, JobRehydrationDivergenceError.prototype);
  }
}
