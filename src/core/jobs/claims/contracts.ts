/**
 * NEX+ · Canonical Job Claims & Operational Lease
 * Contratos de Claim, Lease e Fencing — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3B)
 *
 * Princípios Fundamentais:
 * 1. Pertence estritamente ao plano operacional do NEX (NÃO pertence ao Job Lifecycle).
 * 2. Claim ativo NÃO significa Job running.
 * 3. Lease expirada NÃO altera JobStatus.
 * 4. Fencing token é independente de Job revision e AttemptId.
 * 5. Fencing token é string decimal estritamente positiva ('1', '2', '193').
 * 6. Autoridade temporal é exclusiva do banco de dados (CURRENT_TIMESTAMP(3)).
 */

export type JobClaimState = 'active' | 'released' | 'expired';

export interface JobClaimRef {
  readonly jobId: string;
  readonly workerId: string;
  readonly fencingToken: string; // string decimal positiva: '1', '2', '193'
}

export interface JobClaimSnapshot {
  readonly jobId: string;
  readonly workerId: string;
  readonly fencingToken: string;
  readonly acquiredAt: string; // ISO 8601 UTC
  readonly renewedAt: string; // ISO 8601 UTC
  readonly leaseUntil: string; // ISO 8601 UTC
  readonly releasedAt?: string | null; // ISO 8601 UTC
  readonly state: JobClaimState;
}

export interface AcquireJobClaimParams {
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseDurationMs: number;
}

export type AcquireJobClaimResult =
  | { readonly acquired: true; readonly claim: JobClaimSnapshot }
  | { readonly acquired: false; readonly reason: 'held' };

export interface RenewJobClaimParams {
  readonly jobId: string;
  readonly workerId: string;
  readonly fencingToken: string;
  readonly leaseDurationMs: number;
}

export interface ReleaseJobClaimParams {
  readonly jobId: string;
  readonly workerId: string;
  readonly fencingToken: string;
}

export interface JobClaimPgQueryResult<T = unknown> {
  rows: T[];
  rowCount?: number | null;
}

export interface JobClaimPgExecutor {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<JobClaimPgQueryResult<T>>;
}

export interface JobClaimStore {
  acquireClaim(params: AcquireJobClaimParams): Promise<AcquireJobClaimResult>;
  renewClaim(params: RenewJobClaimParams): Promise<JobClaimSnapshot>;
  releaseClaim(params: ReleaseJobClaimParams): Promise<JobClaimSnapshot>;
  getJobClaim(jobId: string): Promise<JobClaimSnapshot | undefined>;
}
