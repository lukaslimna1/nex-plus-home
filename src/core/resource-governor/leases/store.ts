/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Store e Máquina de Estados de Resource Leases — Escopo 0.6 (Fase B)
 *
 * Gerencia reservas temporárias de RAM/VRAM e proteção de modelos contra descarregamento indevido.
 * Implementação in-memory de Fase 0 com imutabilidade defensiva profunda.
 * Nenhuma função utiliza relógio interno do sistema.
 */

import type { RouteRevisionId } from '../../capabilities/contracts';
import type { DecisionId } from '../../execution/contracts';
import type { DecisionMaterialContextId } from '../../evaluation/contracts';

import type {
  ResourceLease,
  ResourceLeaseId,
  ResourceLeaseState,
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

export interface CreateReservationParams {
  readonly leaseId: ResourceLeaseId;
  readonly requestId: ResourceRequestId;
  readonly decisionId: DecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly routeRevisionId: RouteRevisionId;
  readonly targetModel?: string;
  readonly targetGpuUuid?: string;
  readonly reservedRamBytes?: number;
  readonly reservedVramBytes?: number;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface ResourceLeaseStore {
  createReservation(params: CreateReservationParams): ResourceLease;
  activateLease(leaseId: ResourceLeaseId, activatedAt?: string): ResourceLease;
  releaseLease(leaseId: ResourceLeaseId, releasedAt?: string): ResourceLease;
  reconcileExpiredLeases(at: string): readonly ResourceLease[];
  getLease(leaseId: ResourceLeaseId): ResourceLease | undefined;
  listLeases(): readonly ResourceLease[];
  listActiveLeases(): readonly ResourceLease[];
  listReservedLeases(): readonly ResourceLease[];
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

      if (leases.has(params.leaseId)) {
        throw new ResourceLeaseError(`Duplicate leaseId '${params.leaseId}' is rejected.`, 'DUPLICATE_LEASE_ID');
      }

      const reservedRamBytes = Math.max(0, params.reservedRamBytes || 0);
      const reservedVramBytes = Math.max(0, params.reservedVramBytes || 0);

      const lease: ResourceLease = {
        leaseId: params.leaseId,
        requestId: params.requestId,
        decisionId: params.decisionId,
        materialContextId: params.materialContextId,
        routeRevisionId: params.routeRevisionId,
        targetModel: params.targetModel,
        targetGpuUuid: params.targetGpuUuid,
        reservedRamBytes,
        reservedVramBytes,
        state: 'reserved',
        createdAt: params.createdAt,
        expiresAt: params.expiresAt,
      };

      const frozen = deepFreeze({ ...lease });
      leases.set(params.leaseId, frozen);
      return frozen;
    },

    activateLease(leaseId: ResourceLeaseId, activatedAt?: string): ResourceLease {
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
        activatedAt: activatedAt || new Date().toISOString(),
      };

      const frozen = deepFreeze(updated);
      leases.set(leaseId, frozen);
      return frozen;
    },

    releaseLease(leaseId: ResourceLeaseId, releasedAt?: string): ResourceLease {
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
        releasedAt: releasedAt || new Date().toISOString(),
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
