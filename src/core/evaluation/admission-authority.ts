/**
 * NEX+ · Route Eligibility, Selection & Escalation
 * Autoridade Runtime de DispatchAdmission em Memória — Escopo 0.85D (Bloco 0.85D / L0)
 *
 * Plano de Autoridade (L0).
 * Autoridade de registro e resolução de DispatchAdmission imutáveis em memória.
 * Garante que AttemptCreatedEvent seja emitido estritamente a partir de admissões
 * canônicas emitidas por L0, impedindo adulteração ou clonagem por callers.
 *
 * NOTA DE ESCOPO: Esta autoridade opera estritamente em memória no boundary L0 atual.
 * Persistência durável, rehydration e scheduler pertencem exclusivamente ao Escopo 0.86C.
 */

import type {
  DispatchAdmission,
  DispatchAdmissionId,
} from './contracts';

export class DispatchAdmissionNotFoundError extends Error {
  readonly code = 'DISPATCH_ADMISSION_NOT_FOUND';
  constructor(admissionId: string) {
    super(
      `[L0 Admission Authority] DispatchAdmission '${admissionId}' was not found in runtime authority. Re-evaluation is required.`,
    );
    this.name = 'DispatchAdmissionNotFoundError';
  }
}

export class DispatchAdmissionConflictError extends Error {
  readonly code = 'DISPATCH_ADMISSION_CONFLICT';
  constructor(admissionId: string) {
    super(
      `[L0 Admission Authority] DispatchAdmission '${admissionId}' already exists with different payload. Overwrite is strictly prohibited.`,
    );
    this.name = 'DispatchAdmissionConflictError';
  }
}

function deepFreezeAdmission(admission: DispatchAdmission): DispatchAdmission {
  const scopeCopy = admission.authorizationScope
    ? Object.freeze({
        operation: admission.authorizationScope.operation,
        resourceTarget: admission.authorizationScope.resourceTarget,
      })
    : undefined;

  return Object.freeze({
    admissionId: admission.admissionId,
    decisionId: admission.decisionId,
    materialContextId: admission.materialContextId,
    routeEvaluationId: admission.routeEvaluationId,
    capabilityRevisionId: admission.capabilityRevisionId,
    bindingRevisionId: admission.bindingRevisionId,
    routeRevisionId: admission.routeRevisionId,
    policyRevisionId: admission.policyRevisionId,
    authorizationDecisionId: admission.authorizationDecisionId,
    confirmationDecisionId: admission.confirmationDecisionId,
    authorizationScope: scopeCopy,
    admittedAt: admission.admittedAt,
  });
}

function areAdmissionsEqual(a: DispatchAdmission, b: DispatchAdmission): boolean {
  if (
    a.admissionId !== b.admissionId ||
    a.decisionId !== b.decisionId ||
    a.materialContextId !== b.materialContextId ||
    a.routeEvaluationId !== b.routeEvaluationId ||
    a.capabilityRevisionId !== b.capabilityRevisionId ||
    a.bindingRevisionId !== b.bindingRevisionId ||
    a.routeRevisionId !== b.routeRevisionId ||
    a.policyRevisionId !== b.policyRevisionId ||
    a.authorizationDecisionId !== b.authorizationDecisionId ||
    a.confirmationDecisionId !== b.confirmationDecisionId ||
    a.admittedAt !== b.admittedAt
  ) {
    return false;
  }

  if (!a.authorizationScope && !b.authorizationScope) {
    return true;
  }
  if (!a.authorizationScope || !b.authorizationScope) {
    return false;
  }
  return (
    a.authorizationScope.operation === b.authorizationScope.operation &&
    a.authorizationScope.resourceTarget === b.authorizationScope.resourceTarget
  );
}

export interface DispatchAdmissionAuthority {
  registerAdmission(admission: DispatchAdmission): DispatchAdmission;
  getAdmission(admissionId: DispatchAdmissionId): DispatchAdmission | undefined;
  hasAdmission(admissionId: DispatchAdmissionId): boolean;
  clear(): void;
}

export class InMemoryDispatchAdmissionAuthority implements DispatchAdmissionAuthority {
  private readonly store = new Map<DispatchAdmissionId, DispatchAdmission>();

  registerAdmission(admission: DispatchAdmission): DispatchAdmission {
    if (!admission || !admission.admissionId) {
      throw new Error('[L0 Admission Authority] Cannot register admission without valid admissionId.');
    }

    const existing = this.store.get(admission.admissionId);
    if (existing) {
      if (areAdmissionsEqual(existing, admission)) {
        return existing;
      }
      throw new DispatchAdmissionConflictError(admission.admissionId);
    }

    const frozen = deepFreezeAdmission(admission);
    this.store.set(admission.admissionId, frozen);
    return frozen;
  }

  getAdmission(admissionId: DispatchAdmissionId): DispatchAdmission | undefined {
    return this.store.get(admissionId);
  }

  hasAdmission(admissionId: DispatchAdmissionId): boolean {
    return this.store.has(admissionId);
  }

  clear(): void {
    this.store.clear();
  }
}

export function createDispatchAdmissionAuthority(): DispatchAdmissionAuthority {
  return new InMemoryDispatchAdmissionAuthority();
}

export const defaultDispatchAdmissionAuthority = createDispatchAdmissionAuthority();
