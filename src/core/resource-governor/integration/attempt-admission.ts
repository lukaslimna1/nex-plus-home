/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Integração com DispatchAdmission do Core 0.5 — Escopo 0.6 (Fase B)
 *
 * Admissão formal de recursos físicos de L0 e wrapper de AttemptCreatedEvent
 * correlacionando causalmente DispatchAdmission (0.5) e ResourceAdmission (0.6).
 */

import type { AttemptCreatedEvent, AttemptId } from '../../execution/contracts';
import type { DecisionMaterialContextId, DispatchAdmission } from '../../evaluation/contracts';
import { buildAttemptCreatedEvent } from '../../evaluation/continuation';

import type {
  ResourceAdmission,
  ResourceAdmissionId,
  ResourceLeaseId,
  ResourceMaterialFacts,
  ResourceProfileRevisionId,
  ResourceRequestId,
  ResourceSnapshotId,
} from '../contracts';

export class ResourceAdmissionMismatchError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(`[ResourceGovernor Integration] ${message}`);
    this.name = 'ResourceAdmissionMismatchError';
    this.code = code;
  }
}

export interface MaterializeResourceAdmissionParams {
  readonly admissionId?: ResourceAdmissionId;
  readonly requestId: ResourceRequestId;
  readonly dispatchAdmission: DispatchAdmission;
  readonly profileRevisionId: ResourceProfileRevisionId;
  readonly resourceSnapshotId: ResourceSnapshotId;
  readonly leaseId?: ResourceLeaseId;
  readonly targetModel?: string;
  readonly targetGpuUuid?: string;
  readonly materialFacts: ResourceMaterialFacts;
  readonly admittedAt: string;
}

/**
 * Materializa uma ResourceAdmission imutável a partir de uma DispatchAdmission e decisão favorável do Governor.
 */
export function materializeResourceAdmission(
  params: MaterializeResourceAdmissionParams,
): ResourceAdmission {
  const {
    admissionId = (`res_adm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}` as ResourceAdmissionId),
    requestId,
    dispatchAdmission,
    profileRevisionId,
    resourceSnapshotId,
    leaseId,
    targetModel,
    targetGpuUuid,
    materialFacts,
    admittedAt,
  } = params;

  return Object.freeze({
    admissionId,
    requestId,
    decisionId: dispatchAdmission.decisionId,
    materialContextId: dispatchAdmission.materialContextId,
    routeEvaluationId: dispatchAdmission.routeEvaluationId,
    routeRevisionId: dispatchAdmission.routeRevisionId,
    profileRevisionId,
    resourceSnapshotId,
    leaseId,
    targetModel,
    targetGpuUuid,
    materialFacts: Object.freeze({ ...materialFacts }),
    admittedAt,
  });
}

export interface BuildResourceGovernedAttemptParams {
  readonly dispatchAdmission: DispatchAdmission;
  readonly resourceAdmission: ResourceAdmission;
  readonly attemptId: AttemptId;
  readonly createdAt: string;
  readonly currentMaterialContextId: DecisionMaterialContextId;
}

/**
 * Constrói o AttemptCreatedEvent validando que a ResourceAdmission coincide estritamente
 * com a DispatchAdmission de L0 e com o contexto material corrente.
 */
export function buildResourceGovernedAttemptCreatedEvent(
  params: BuildResourceGovernedAttemptParams,
): AttemptCreatedEvent {
  const {
    dispatchAdmission,
    resourceAdmission,
    attemptId,
    createdAt,
    currentMaterialContextId,
  } = params;

  // 1. Validação Causal entre Admissões
  if (resourceAdmission.decisionId !== dispatchAdmission.decisionId) {
    throw new ResourceAdmissionMismatchError(
      `decisionId mismatch: resourceAdmission '${resourceAdmission.decisionId}' vs dispatchAdmission '${dispatchAdmission.decisionId}'.`,
      'DECISION_ID_MISMATCH',
    );
  }

  if (resourceAdmission.materialContextId !== dispatchAdmission.materialContextId) {
    throw new ResourceAdmissionMismatchError(
      `materialContextId mismatch: resourceAdmission '${resourceAdmission.materialContextId}' vs dispatchAdmission '${dispatchAdmission.materialContextId}'.`,
      'CONTEXT_ID_MISMATCH',
    );
  }

  if (resourceAdmission.routeEvaluationId !== dispatchAdmission.routeEvaluationId) {
    throw new ResourceAdmissionMismatchError(
      `routeEvaluationId mismatch: resourceAdmission '${resourceAdmission.routeEvaluationId}' vs dispatchAdmission '${dispatchAdmission.routeEvaluationId}'.`,
      'EVALUATION_ID_MISMATCH',
    );
  }

  if (resourceAdmission.routeRevisionId !== dispatchAdmission.routeRevisionId) {
    throw new ResourceAdmissionMismatchError(
      `routeRevisionId mismatch: resourceAdmission '${resourceAdmission.routeRevisionId}' vs dispatchAdmission '${dispatchAdmission.routeRevisionId}'.`,
      'ROUTE_REVISION_MISMATCH',
    );
  }

  // 2. Delega para o construtor canônico de L0 (que valida currentMaterialContextId)
  return buildAttemptCreatedEvent(
    dispatchAdmission,
    attemptId,
    createdAt,
    currentMaterialContextId,
  );
}
