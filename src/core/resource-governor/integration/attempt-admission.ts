/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Integração com DispatchAdmission do Core 0.5 — Escopo 0.6
 *
 * Admissão formal de recursos físicos de L0 e wrapper de AttemptCreatedEvent
 * correlacionando causalmente DispatchAdmission (0.5), GovernorDecision e ResourceAdmission (0.6).
 * ResourceAdmission é estritamente uma projeção imutável da GovernorDecision admitida.
 */

import type { AttemptCreatedEvent, AttemptId } from '../../execution/contracts';
import type { DecisionMaterialContextId, DispatchAdmission } from '../../evaluation/contracts';
import { buildAttemptCreatedEvent } from '../../evaluation/continuation';

import type {
  GovernorDecision,
  ResourceAdmission,
  ResourceAdmissionId,
  ResourceLeaseId,
  ResourceRequest,
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
  readonly admissionId: ResourceAdmissionId;
  readonly request: ResourceRequest;
  readonly governorDecision: GovernorDecision;
  readonly dispatchAdmission: DispatchAdmission;
  readonly leaseId?: ResourceLeaseId;
  readonly admittedAt: string;
}

/**
 * Materializa uma ResourceAdmission imutável como projeção direta da GovernorDecision e DispatchAdmission.
 * Deriva profileRevisionId, resourceSnapshotId e materialFacts diretamente da GovernorDecision admitida,
 * e targetModel / targetGpuUuid diretamente do ResourceRequest validado.
 */
export function materializeResourceAdmission(
  params: MaterializeResourceAdmissionParams,
): ResourceAdmission {
  const {
    admissionId,
    request,
    governorDecision,
    dispatchAdmission,
    leaseId,
    admittedAt,
  } = params;

  if (!admissionId) {
    throw new ResourceAdmissionMismatchError(
      'admissionId is mandatory and cannot be omitted or randomly generated in domain logic.',
      'INVALID_ADMISSION_ID',
    );
  }

  if (!admittedAt || isNaN(Date.parse(admittedAt))) {
    throw new ResourceAdmissionMismatchError(
      `admittedAt must be a valid ISO 8601 timestamp (got '${admittedAt}').`,
      'INVALID_TIMESTAMP',
    );
  }

  // 1. Gate de Disposição: Somente 'admit' pode materializar ResourceAdmission
  if (governorDecision.disposition !== 'admit') {
    throw new ResourceAdmissionMismatchError(
      `Cannot materialize ResourceAdmission: GovernorDecision disposition is '${governorDecision.disposition}', expected 'admit'.`,
      'INVALID_GOVERNOR_DISPOSITION',
    );
  }

  // 2. Validação Causal GovernorDecision <-> ResourceRequest
  if (governorDecision.requestId !== request.requestId) {
    throw new ResourceAdmissionMismatchError(
      `requestId mismatch: governorDecision '${governorDecision.requestId}' vs request '${request.requestId}'.`,
      'REQUEST_ID_MISMATCH',
    );
  }

  if (governorDecision.profileRevisionId !== request.profileRevisionId) {
    throw new ResourceAdmissionMismatchError(
      `profileRevisionId mismatch: governorDecision '${governorDecision.profileRevisionId}' vs request '${request.profileRevisionId}'.`,
      'PROFILE_REVISION_MISMATCH',
    );
  }

  // 3. Validação Causal ResourceRequest <-> DispatchAdmission
  if (request.decisionId !== dispatchAdmission.decisionId) {
    throw new ResourceAdmissionMismatchError(
      `decisionId mismatch: request '${request.decisionId}' vs dispatchAdmission '${dispatchAdmission.decisionId}'.`,
      'DECISION_ID_MISMATCH',
    );
  }

  if (request.materialContextId !== dispatchAdmission.materialContextId) {
    throw new ResourceAdmissionMismatchError(
      `materialContextId mismatch: request '${request.materialContextId}' vs dispatchAdmission '${dispatchAdmission.materialContextId}'.`,
      'CONTEXT_ID_MISMATCH',
    );
  }

  if (request.routeEvaluationId !== dispatchAdmission.routeEvaluationId) {
    throw new ResourceAdmissionMismatchError(
      `routeEvaluationId mismatch: request '${request.routeEvaluationId}' vs dispatchAdmission '${dispatchAdmission.routeEvaluationId}'.`,
      'EVALUATION_ID_MISMATCH',
    );
  }

  if (request.routeRevisionId !== dispatchAdmission.routeRevisionId) {
    throw new ResourceAdmissionMismatchError(
      `routeRevisionId mismatch: request '${request.routeRevisionId}' vs dispatchAdmission '${dispatchAdmission.routeRevisionId}'.`,
      'ROUTE_REVISION_MISMATCH',
    );
  }

  return Object.freeze({
    admissionId,
    requestId: request.requestId,
    decisionId: dispatchAdmission.decisionId,
    materialContextId: dispatchAdmission.materialContextId,
    routeEvaluationId: dispatchAdmission.routeEvaluationId,
    routeRevisionId: dispatchAdmission.routeRevisionId,
    profileRevisionId: governorDecision.profileRevisionId,
    resourceSnapshotId: governorDecision.resourceSnapshotId,
    leaseId,
    targetModel: request.targetModel,
    targetGpuUuid: request.targetGpuUuid,
    materialFacts: Object.freeze({ ...governorDecision.materialFacts }),
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

  // 2. Delega para o construtor canônico de L0 (que valida currentMaterialContextId e claim atômico)
  return buildAttemptCreatedEvent({
    admissionId: dispatchAdmission.admissionId,
    attemptId,
    createdAt,
    currentMaterialContextId,
    effectiveOperation: dispatchAdmission.authorizationScope?.operation,
    effectiveResourceTarget: dispatchAdmission.authorizationScope?.resourceTarget,
  });
}
