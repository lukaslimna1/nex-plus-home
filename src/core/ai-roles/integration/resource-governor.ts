/**
 * NEX+ · AI Role Registry & Incumbent Bindings
 * Integração com o Resource Governor (Core 0.6) — Escopo 0.7A
 *
 * Converte resoluções de papéis de IA para referências de modelos locais e requisições de recursos físicos.
 * Mantém a soberania de L0 e do Resource Governor sem duplicar lógica de admissão ou de governança.
 */

import type { DecisionId, RouteEvaluationId } from '../../execution/contracts';
import type { RouteRevisionId } from '../../capabilities/contracts';
import type { DecisionMaterialContextId } from '../../evaluation/contracts';

import type {
  ApprovedLocalModelRef,
  ResourceProfileRevisionId,
  ResourceRequest,
  ResourceRequestId,
  ResourceRequestIntent,
} from '../../resource-governor/contracts';

import type { ResolvedAiRole } from '../contracts';

export class AiRoleResourceGovernorIntegrationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(`[AiRole ResourceGovernor Integration] ${message}`);
    this.name = 'AiRoleResourceGovernorIntegrationError';
    this.code = code;
  }
}

/**
 * Converte uma resolução de papel de IA em uma ApprovedLocalModelRef do Resource Governor,
 * se e somente se o target for um local_model compatível com o runtime local do Ollama.
 */
export function toApprovedLocalModelRef(
  resolved: ResolvedAiRole,
): ApprovedLocalModelRef | undefined {
  if (!resolved || resolved.status !== 'resolved' || !resolved.target) {
    return undefined;
  }

  if (resolved.target.kind !== 'local_model') {
    return undefined;
  }

  if (resolved.target.runtimeKey.toLowerCase() !== 'ollama') {
    return undefined;
  }

  return Object.freeze({
    runtime: 'ollama_local',
    modelName: resolved.target.modelName,
    digest: resolved.target.digest,
  });
}

export interface CreateResourceRequestFromRoleParams {
  readonly requestId: ResourceRequestId;
  readonly resolvedRole: ResolvedAiRole;
  readonly decisionId: DecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly routeEvaluationId: RouteEvaluationId;
  readonly routeRevisionId: RouteRevisionId;
  readonly profileRevisionId: ResourceProfileRevisionId;
  readonly intent: ResourceRequestIntent;
  readonly requestedAt: string;
  readonly targetGpuUuid?: string;
  readonly requiresGpu?: boolean;
  readonly estimatedAdditionalRamBytes?: number;
  readonly estimatedAdditionalVramBytes?: number;
}

/**
 * Cria uma ResourceRequest a partir de uma resolução de papel funcional,
 * extraindo o targetModel do executor local resolvido sem que o caller precise conhecer
 * os nomes concretos de modelos subjacentes.
 */
export function createResourceRequestFromResolvedRole(
  params: CreateResourceRequestFromRoleParams,
): ResourceRequest {
  const { resolvedRole } = params;

  if (!resolvedRole || resolvedRole.status !== 'resolved') {
    throw new AiRoleResourceGovernorIntegrationError(
      'Cannot create ResourceRequest from an unresolved AI role.',
      'UNRESOLVED_AI_ROLE',
    );
  }

  if (resolvedRole.target.kind !== 'local_model') {
    throw new AiRoleResourceGovernorIntegrationError(
      `Cannot create ResourceRequest for non-local target kind '${resolvedRole.target.kind}'.`,
      'NON_LOCAL_EXECUTOR_TARGET',
    );
  }

  if (resolvedRole.routeRevisionId !== params.routeRevisionId) {
    throw new AiRoleResourceGovernorIntegrationError(
      `routeRevisionId mismatch: resolvedRole specifies '${resolvedRole.routeRevisionId}' but request parameter is '${params.routeRevisionId}'.`,
      'ROUTE_REVISION_MISMATCH',
    );
  }

  return Object.freeze({
    requestId: params.requestId,
    decisionId: params.decisionId,
    materialContextId: params.materialContextId,
    routeEvaluationId: params.routeEvaluationId,
    routeRevisionId: params.routeRevisionId,
    profileRevisionId: params.profileRevisionId,
    targetModel: resolvedRole.target.modelName,
    targetGpuUuid: params.targetGpuUuid,
    requiresGpu: params.requiresGpu,
    estimatedAdditionalRamBytes: params.estimatedAdditionalRamBytes,
    estimatedAdditionalVramBytes: params.estimatedAdditionalVramBytes,
    intent: params.intent,
    requestedAt: params.requestedAt,
  });
}
