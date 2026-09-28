/**
 * NEX+ · Canonical Job Claims & Operational Lease
 * Invariantes Defensivos e Validações Fail-Closed — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3B)
 */

import type {
  AcquireJobClaimParams,
  RenewJobClaimParams,
  ReleaseJobClaimParams,
} from './contracts';
import { JobClaimInvariantsError } from './errors';

export const FENCING_TOKEN_REGEX = /^[1-9][0-9]*$/;

export function assertJobId(jobId: unknown): asserts jobId is string {
  if (typeof jobId !== 'string' || jobId.trim().length === 0) {
    throw new JobClaimInvariantsError('jobId must be a non-empty string.');
  }
}

export function assertWorkerId(workerId: unknown): asserts workerId is string {
  if (typeof workerId !== 'string' || workerId.trim().length === 0) {
    throw new JobClaimInvariantsError('workerId must be a non-empty string.');
  }
}

export function assertFencingToken(fencingToken: unknown): asserts fencingToken is string {
  if (typeof fencingToken !== 'string' || !FENCING_TOKEN_REGEX.test(fencingToken)) {
    throw new JobClaimInvariantsError(
      `fencingToken must be a positive decimal string matching ^[1-9][0-9]*$, received: ${String(fencingToken)}`
    );
  }
}

export function assertLeaseDurationMs(leaseDurationMs: unknown): asserts leaseDurationMs is number {
  if (
    typeof leaseDurationMs !== 'number' ||
    !Number.isFinite(leaseDurationMs) ||
    !Number.isInteger(leaseDurationMs) ||
    !Number.isSafeInteger(leaseDurationMs) ||
    leaseDurationMs <= 0
  ) {
    throw new JobClaimInvariantsError(
      `leaseDurationMs must be a positive finite integer > 0, received: ${String(leaseDurationMs)}`
    );
  }
}

export function assertAcquireJobClaimParams(params: unknown): asserts params is AcquireJobClaimParams {
  if (!params || typeof params !== 'object') {
    throw new JobClaimInvariantsError('AcquireJobClaimParams must be a non-null object.');
  }

  const p = params as Record<string, unknown>;
  assertJobId(p.jobId);
  assertWorkerId(p.workerId);
  assertLeaseDurationMs(p.leaseDurationMs);
}

export function assertRenewJobClaimParams(params: unknown): asserts params is RenewJobClaimParams {
  if (!params || typeof params !== 'object') {
    throw new JobClaimInvariantsError('RenewJobClaimParams must be a non-null object.');
  }

  const p = params as Record<string, unknown>;
  assertJobId(p.jobId);
  assertWorkerId(p.workerId);
  assertFencingToken(p.fencingToken);
  assertLeaseDurationMs(p.leaseDurationMs);
}

export function assertReleaseJobClaimParams(params: unknown): asserts params is ReleaseJobClaimParams {
  if (!params || typeof params !== 'object') {
    throw new JobClaimInvariantsError('ReleaseJobClaimParams must be a non-null object.');
  }

  const p = params as Record<string, unknown>;
  assertJobId(p.jobId);
  assertWorkerId(p.workerId);
  assertFencingToken(p.fencingToken);
}
