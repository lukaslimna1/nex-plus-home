/**
 * NEX+ · AI Role Registry & Incumbent Bindings
 * Configuração Canônica dos Ocupantes Incumbentes — Escopo 0.7A
 *
 * Confinamento arquitetural dos nomes concretos de modelos e runtimes atuais.
 * Estes nomes NÃO representam a identidade funcional do NEX+, apenas os incumbentes atuais.
 */

import type { RouteRevisionId } from '../capabilities/contracts';

import type {
  AiExecutorTargetRef,
  AiRoleBindingKey,
  AiRoleBindingRevision,
  AiRoleBindingRevisionId,
  AiRoleKey,
  AiRoleRevision,
  AiRoleRevisionId,
  LocalModelExecutorTargetRef,
} from './contracts';

// ============================================================================
// 1. CANONICAL FUNCTIONAL ROLE KEYS
// ============================================================================

export const ROLE_LOCAL_RESIDENT = 'local_resident' as AiRoleKey;
export const ROLE_LOCAL_HEAVY = 'local_heavy' as AiRoleKey;

// ============================================================================
// 2. CANONICAL INCUMBENT EXECUTOR TARGETS
// ============================================================================

export const INCUMBENT_LOCAL_RESIDENT_TARGET: LocalModelExecutorTargetRef = Object.freeze({
  kind: 'local_model',
  runtimeKey: 'ollama',
  modelName: 'ministral-3:3b',
});

export const INCUMBENT_LOCAL_HEAVY_TARGET: LocalModelExecutorTargetRef = Object.freeze({
  kind: 'local_model',
  runtimeKey: 'ollama',
  modelName: 'qwen3.5:9b',
});

// ============================================================================
// 3. FACTORY HELPERS FOR CANONICAL ROLE & BINDING REVISIONS
// ============================================================================

export interface CreateRoleRevisionParams {
  readonly roleKey: AiRoleKey;
  readonly roleRevisionId: AiRoleRevisionId;
  readonly title: string;
  readonly description?: string;
  readonly supersedesRevisionIds?: readonly AiRoleRevisionId[];
}

export function createCanonicalRoleRevision(
  params: CreateRoleRevisionParams,
): AiRoleRevision {
  return Object.freeze({
    roleKey: params.roleKey,
    roleRevisionId: params.roleRevisionId,
    lifecycle: 'active',
    supersedesRevisionIds: Object.freeze([...(params.supersedesRevisionIds || [])]),
    title: params.title,
    description: params.description,
  });
}

export interface CreateBindingRevisionParams {
  readonly bindingKey: AiRoleBindingKey;
  readonly bindingRevisionId: AiRoleBindingRevisionId;
  readonly roleKey: AiRoleKey;
  readonly roleRevisionId: AiRoleRevisionId;
  readonly routeRevisionId: RouteRevisionId;
  readonly target: AiExecutorTargetRef;
  readonly supersedesRevisionIds?: readonly AiRoleBindingRevisionId[];
  readonly provenance?: string;
}

export function createCanonicalBindingRevision(
  params: CreateBindingRevisionParams,
): AiRoleBindingRevision {
  return Object.freeze({
    bindingKey: params.bindingKey,
    bindingRevisionId: params.bindingRevisionId,
    roleKey: params.roleKey,
    roleRevisionId: params.roleRevisionId,
    routeRevisionId: params.routeRevisionId,
    target: Object.freeze({ ...params.target }),
    lifecycle: 'active',
    supersedesRevisionIds: Object.freeze([...(params.supersedesRevisionIds || [])]),
    provenance: params.provenance,
  });
}
