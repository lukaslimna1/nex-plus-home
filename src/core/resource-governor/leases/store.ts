/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Store e Máquina de Estados de Resource Leases — Escopo 0.6
 *
 * Gerencia reservas temporárias de RAM/VRAM e proteção de modelos contra descarregamento indevido.
 * Implementação in-memory de Fase 0 com imutabilidade defensiva profunda e validação estrita.
 * Nenhuma função utiliza relógio interno do sistema (Date.now / new Date).
 */

import type { RouteRevisionId } from '../../capabilities/contracts';
import type { DecisionId } from '../../execution/contracts';
import type { DecisionMaterialContextId } from '../../evaluation/contracts';

import type {
  CreateReservationParams,
  ResourceLease,
  ResourceLeaseId,
  ResourceLeaseStore,
  ResourceRequestId,
} from '../contracts';

export class ResourceLeaseError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(`[ResourceLeaseStore] ${message}`);
    this.name = 'ResourceLeaseError';
    this.code = code;
  }
}

function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      deepFreeze(item);
    }
    return Object.freeze(obj) as unknown as Readonly<T>;
  }
  for (const key of Object.keys(obj)) {
    const val = (obj as any)[key];
    if (val !== null && typeof val === 'object') {
      deepFreeze(val);
    }
  }
  return Object.freeze(obj) as Readonly<T>;
}

export function createResourceLeaseStore(): ResourceLeaseStore {
  const leases = new Map<ResourceLeaseId, ResourceLease>();

  return {
    createReservation(params: CreateReservationParams): ResourceLease {
      if (!params.leaseId || !params.requestId || !params.decisionId || !params.materialContextId || !params.routeRevisionId) {
        throw new ResourceLeaseError('Mandatory lineage fields missing for lease reservation.', 'INVALID_LEASE_PARAMS');
      }

      if (!params.createdAt || isNaN(Date.parse(params.createdAt))) {
        throw new ResourceLeaseError(`Invalid or missing createdAt timestamp '${params.createdAt}'.`, 'INVALID_TIMESTAMP');
      }

      if (leases.has(params.leaseId)) {
        throw new ResourceLeaseError(`Duplicate leaseId '${params.leaseId}' is rejected.`, 'DUPLICATE_LEASE_ID');
      }

      const rawRam = params.reservedRamBytes !== undefined ? params.reservedRamBytes : 0;
      const rawVram = params.reservedVramBytes !== undefined ? params.reservedVramBytes : 0;

      if (!Number.isFinite(rawRam) || rawRam < 0) {
        throw new ResourceLeaseError(
          `reservedRamBytes must be a finite number >= 0 (got '${params.reservedRamBytes}').`,
          'INVALID_NUMERIC_RESERVATION',
        );
      }

      if (!Number.isFinite(rawVram) || rawVram < 0) {
        throw new ResourceLeaseError(
          `reservedVramBytes must be a finite number >= 0 (got '${params.reservedVramBytes}').`,
          'INVALID_NUMERIC_RESERVATION',
        );
      }

      if (params.expiresAt && isNaN(Date.parse(params.expiresAt))) {
        throw new ResourceLeaseError(`Invalid expiresAt timestamp '${params.expiresAt}'.`, 'INVALID_TIMESTAMP');
      }

      const lease: ResourceLease = {
        leaseId: params.leaseId,
        requestId: params.requestId,
        decisionId: params.decisionId,
        materialContextId: params.materialContextId,
        routeRevisionId: params.routeRevisionId,
        targetModel: params.targetModel,
        targetGpuUuid: params.targetGpuUuid,
        reservedRamBytes: rawRam,
        reservedVramBytes: rawVram,
        state: 'reserved',
        createdAt: params.createdAt,
        activatedAt: undefined,
        releasedAt: undefined,
        expiresAt: params.expiresAt,
      };

      const frozen = deepFreeze({ ...lease });
      leases.set(params.leaseId, frozen);
      return frozen;
    },

    activateLease(leaseId: ResourceLeaseId, activatedAt: string): ResourceLease {
      if (!activatedAt || isNaN(Date.parse(activatedAt))) {
        throw new ResourceLeaseError(
          `activateLease requires an explicit valid timestamp (got '${activatedAt}').`,
          'INVALID_TIMESTAMP',
        );
      }

      const current = leases.get(leaseId);
      if (!current) {
        throw new ResourceLeaseError(`Lease '${leaseId}' not found.`, 'LEASE_NOT_FOUND');
      }

      if (current.state !== 'reserved') {
        throw new ResourceLeaseError(
          `Cannot activate lease '${leaseId}' in state '${current.state}'. Only 'reserved' leases can be activated.`,
          'INVALID_LEASE_TRANSITION',
        );
      }

      const updated: ResourceLease = {
        ...current,
        state: 'active',
        activatedAt,
      };

      const frozen = deepFreeze(updated);
      leases.set(leaseId, frozen);
      return frozen;
    },

    releaseLease(leaseId: ResourceLeaseId, releasedAt: string): ResourceLease {
      if (!releasedAt || isNaN(Date.parse(releasedAt))) {
        throw new ResourceLeaseError(
          `releaseLease requires an explicit valid timestamp (got '${releasedAt}').`,
          'INVALID_TIMESTAMP',
        );
      }

      const current = leases.get(leaseId);
      if (!current) {
        throw new ResourceLeaseError(`Lease '${leaseId}' not found.`, 'LEASE_NOT_FOUND');
      }

      if (current.state === 'released' || current.state === 'expired') {
        throw new ResourceLeaseError(
          `Cannot release lease '${leaseId}' in terminal state '${current.state}'.`,
          'INVALID_LEASE_TRANSITION',
        );
      }

      const updated: ResourceLease = {
        ...current,
        state: 'released',
        releasedAt,
      };

      const frozen = deepFreeze(updated);
      leases.set(leaseId, frozen);
      return frozen;
    },

    reconcileExpiredLeases(at: string): readonly ResourceLease[] {
      if (!at || isNaN(Date.parse(at))) {
        throw new ResourceLeaseError(`Invalid reconciliation timestamp '${at}'.`, 'INVALID_TIMESTAMP');
      }

      const targetEpoch = Date.parse(at);
      const expiredList: ResourceLease[] = [];

      for (const [id, lease] of leases.entries()) {
        if ((lease.state === 'reserved' || lease.state === 'active') && lease.expiresAt) {
          const expiresEpoch = Date.parse(lease.expiresAt);
          if (!isNaN(expiresEpoch) && expiresEpoch <= targetEpoch) {
            const updated: ResourceLease = {
              ...lease,
              state: 'expired',
            };
            const frozen = deepFreeze(updated);
            leases.set(id, frozen);
            expiredList.push(frozen);
          }
        }
      }

      return Object.freeze(expiredList);
    },

    getLease(leaseId: ResourceLeaseId): ResourceLease | undefined {
      const lease = leases.get(leaseId);
      return lease ? deepFreeze({ ...lease }) : undefined;
    },

    listLeases(): readonly ResourceLease[] {
      return Object.freeze(Array.from(leases.values()).map((l) => deepFreeze({ ...l })));
    },

    listActiveLeases(): readonly ResourceLease[] {
      return Object.freeze(
        Array.from(leases.values())
          .filter((l) => l.state === 'active')
          .map((l) => deepFreeze({ ...l })),
      );
    },

    listReservedLeases(): readonly ResourceLease[] {
      return Object.freeze(
        Array.from(leases.values())
          .filter((l) => l.state === 'reserved')
          .map((l) => deepFreeze({ ...l })),
      );
    },
  };
}
