/**
 * NEX+ · Canonical Job Claims & Operational Lease
 * Erros do Boundary de Claims — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3B)
 */

export type JobClaimErrorCode =
  | 'INVALID_CLAIM_PARAM'
  | 'JOB_NOT_FOUND'
  | 'JOB_CLAIM_STALE'
  | 'CORRUPTED_CLAIM_STORAGE';

export interface JobClaimErrorOptions {
  readonly code: JobClaimErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

export class JobClaimError extends Error {
  readonly code: JobClaimErrorCode;

  constructor(options: JobClaimErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'JobClaimError';
    this.code = options.code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class JobClaimInvariantsError extends JobClaimError {
  constructor(message: string, cause?: unknown) {
    super({
      code: 'INVALID_CLAIM_PARAM',
      message: `[JobClaim] Invariant violation: ${message}`,
      cause,
    });
    this.name = 'JobClaimInvariantsError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class JobClaimJobNotFoundError extends JobClaimError {
  readonly jobId: string;

  constructor(jobId: string, cause?: unknown) {
    super({
      code: 'JOB_NOT_FOUND',
      message: `[JobClaim] Job '${jobId}' does not exist in nex_job_heads. Claim cannot be acquired.`,
      cause,
    });
    this.name = 'JobClaimJobNotFoundError';
    this.jobId = jobId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class JobClaimStaleError extends JobClaimError {
  readonly jobId: string;
  readonly workerId: string;
  readonly fencingToken: string;

  constructor(jobId: string, workerId: string, fencingToken: string, detail?: string) {
    const detailMsg = detail ? ` (${detail})` : '';
    super({
      code: 'JOB_CLAIM_STALE',
      message: `[JobClaim] Claim operation rejected: claim is stale, expired, released, or belongs to another worker/fence for Job '${jobId}', worker '${workerId}', fencingToken '${fencingToken}'${detailMsg}.`,
    });
    this.name = 'JobClaimStaleError';
    this.jobId = jobId;
    this.workerId = workerId;
    this.fencingToken = fencingToken;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CorruptedJobClaimStorageError extends JobClaimError {
  readonly jobId?: string;

  constructor(message: string, jobId?: string, cause?: unknown) {
    const jobMsg = jobId ? ` for Job '${jobId}'` : '';
    super({
      code: 'CORRUPTED_CLAIM_STORAGE',
      message: `[JobClaim] Corrupted storage row detected${jobMsg}: ${message}`,
      cause,
    });
    this.name = 'CorruptedJobClaimStorageError';
    this.jobId = jobId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
