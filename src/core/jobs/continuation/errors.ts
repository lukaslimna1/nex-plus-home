/**
 * NEX+ · Continuation Checkpoint Errors
 * Erros Estruturados — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-4A)
 */

import type { JobCheckpointId } from './contracts';

export type JobCheckpointInvariantErrorCode =
  | 'CHECKPOINT_ID_INVALID'
  | 'JOB_TERMINAL_INVALID'
  | 'JOB_STATUS_INVALID'
  | 'JOB_REVISION_MISMATCH'
  | 'JOB_REVISION_INVALID'
  | 'ATTEMPT_NOT_IN_LINEAGE'
  | 'ATTEMPT_NOT_LATEST'
  | 'ATTEMPT_NOT_TERMINAL'
  | 'ATTEMPT_STATUS_INVALID'
  | 'OUTCOME_ASSESSMENT_ATTEMPT_MISMATCH'
  | 'OUTCOME_ASSESSMENT_VERDICT_INVALID'
  | 'CAPABILITY_REVISION_MISMATCH'
  | 'BINDING_REVISION_MISMATCH'
  | 'ROUTE_REVISION_MISMATCH'
  | 'DOMAIN_EFFECT_INVALID'
  | 'DECISION_MATERIAL_CONTEXT_INVALID'
  | 'TIMESTAMP_INVALID'
  | 'EXTRA_FIELDS_DETECTED'
  | 'STRUCTURAL_VALIDATION_FAILED';

export interface JobCheckpointInvariantErrorOptions {
  readonly code: JobCheckpointInvariantErrorCode;
  readonly message: string;
  readonly checkpointId?: JobCheckpointId | string;
  readonly cause?: unknown;
}

export class JobCheckpointInvariantError extends Error {
  readonly code: JobCheckpointInvariantErrorCode;
  readonly checkpointId?: JobCheckpointId | string;

  constructor(options: JobCheckpointInvariantErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'JobCheckpointInvariantError';
    this.code = options.code;
    this.checkpointId = options.checkpointId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type JobCheckpointValidationErrorCode =
  | 'JOB_IS_TERMINAL'
  | 'JOB_ID_MISMATCH'
  | 'JOB_REVISION_MISMATCH'
  | 'ATTEMPT_ID_MISMATCH'
  | 'ATTEMPT_NOT_LATEST_IN_LINEAGE'
  | 'ATTEMPT_NOT_TERMINAL'
  | 'OUTCOME_ASSESSMENT_SUPERSEDED'
  | 'OUTCOME_ASSESSMENT_ATTEMPT_MISMATCH'
  | 'CAPABILITY_REVISION_MISMATCH'
  | 'BINDING_REVISION_MISMATCH'
  | 'ROUTE_REVISION_MISMATCH'
  | 'CORRUPTED_DOMAIN_EFFECT_BASIS'
  | 'CONTINUATION_DIRECTIVE_RECOMPUTATION_MISMATCH'
  | 'STRUCTURAL_VALIDATION_FAILED'
  | 'INVALID_RUNTIME_FACTS';

export interface JobCheckpointValidationErrorOptions {
  readonly code: JobCheckpointValidationErrorCode;
  readonly message: string;
  readonly checkpointId: JobCheckpointId | string;
  readonly cause?: unknown;
}

export class JobCheckpointValidationError extends Error {
  readonly code: JobCheckpointValidationErrorCode;
  readonly checkpointId: JobCheckpointId | string;

  constructor(options: JobCheckpointValidationErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'JobCheckpointValidationError';
    this.code = options.code;
    this.checkpointId = options.checkpointId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DuplicateJobCheckpointError extends Error {
  readonly checkpointId: string;

  constructor(checkpointId: string, message?: string) {
    super(message ?? `[JobCheckpointStore] Duplicate CheckpointId '${checkpointId}'.`);
    this.name = 'DuplicateJobCheckpointError';
    this.checkpointId = checkpointId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CorruptedJobCheckpointStorageError extends Error {
  readonly checkpointId?: string;

  constructor(message: string, checkpointId?: string) {
    super(`[JobCheckpointStore] Corrupted storage record: ${message}`);
    this.name = 'CorruptedJobCheckpointStorageError';
    this.checkpointId = checkpointId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
