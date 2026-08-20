/**
 * NEX+ · AI Role Registry & Incumbent Bindings
 * Contratos Canônicos de Papéis Funcionais e Bindings de IA — Escopo 0.7A
 *
 * Princípio Soberano: Função é estável, ocupante é substituível.
 * Papéis de IA definem intenção funcional e NÃO concedem autoridade de Policy/Route/Egress.
 * Provedores e modelos concretos são ocupantes revisáveis e desacoplados.
 */

import type { RouteRevisionId } from '../capabilities/contracts';

// ============================================================================
// 1. BRANDED IDENTIFIERS
// ============================================================================

export type AiRoleKey = string & { readonly __brand: 'AiRoleKey' };
export type AiRoleRevisionId = string & { readonly __brand: 'AiRoleRevisionId' };
export type AiRoleBindingKey = string & { readonly __brand: 'AiRoleBindingKey' };
export type AiRoleBindingRevisionId = string & { readonly __brand: 'AiRoleBindingRevisionId' };

// ============================================================================
// 2. LIFECYCLE
// ============================================================================

export type AiRoleLifecycleState = 'active' | 'deprecated' | 'retired';

// ============================================================================
// 3. AI ROLE REVISION
// ============================================================================

export interface AiRoleRevision {
  readonly roleKey: AiRoleKey;
  readonly roleRevisionId: AiRoleRevisionId;
  readonly lifecycle: AiRoleLifecycleState;
  readonly supersedesRevisionIds: readonly AiRoleRevisionId[];
  readonly title: string;
  readonly description?: string;
}

// ============================================================================
// 4. EXECUTOR TARGET REFERENCE
// ============================================================================

export interface LocalModelExecutorTargetRef {
  readonly kind: 'local_model';
  readonly runtimeKey: string; // Ex: 'ollama', 'onnx_runtime', 'mlc'
  readonly modelName: string;
  readonly digest?: string;
}

export interface ExternalProviderModelExecutorTargetRef {
  readonly kind: 'external_provider_model';
  readonly providerKey: string; // Ex: 'google_genai', 'groq', 'openai', 'anthropic'
  readonly modelName?: string;
  readonly credentialProfileRef?: string; // Referência opaca a perfil de credencial (NUNCA secret/token)
}

export type AiExecutorTargetRef =
  | LocalModelExecutorTargetRef
  | ExternalProviderModelExecutorTargetRef;

// ============================================================================
// 5. AI ROLE BINDING REVISION
// ============================================================================

export interface AiRoleBindingRevision {
  readonly bindingKey: AiRoleBindingKey;
  readonly bindingRevisionId: AiRoleBindingRevisionId;
  readonly roleKey: AiRoleKey;
  readonly roleRevisionId: AiRoleRevisionId;
  readonly routeRevisionId: RouteRevisionId;
  readonly target: AiExecutorTargetRef;
  readonly lifecycle: AiRoleLifecycleState;
  readonly supersedesRevisionIds: readonly AiRoleBindingRevisionId[];
  readonly provenance?: string;
}

// ============================================================================
// 6. REGISTRY & RESOLUTION CONTRACTS
// ============================================================================

export interface AiRoleRegistry {
  appendRoleRevision(revision: AiRoleRevision): void;
  appendBindingRevision(revision: AiRoleBindingRevision): void;
  getRoleRevision(roleRevisionId: AiRoleRevisionId): AiRoleRevision | undefined;
  getBindingRevision(bindingRevisionId: AiRoleBindingRevisionId): AiRoleBindingRevision | undefined;
  getRoleHeads(roleKey: AiRoleKey): readonly AiRoleRevision[];
  getBindingHeadsForRole(roleRevisionId: AiRoleRevisionId): readonly AiRoleBindingRevision[];
  listRoleRevisions(): readonly AiRoleRevision[];
  listBindingRevisions(): readonly AiRoleBindingRevision[];
}

export interface ResolvedAiRole {
  readonly status: 'resolved';
  readonly roleRevision: AiRoleRevision;
  readonly bindingRevision: AiRoleBindingRevision;
  readonly routeRevisionId: RouteRevisionId;
  readonly target: AiExecutorTargetRef;
}

export interface RoleNotFoundResolution {
  readonly status: 'role_not_found';
  readonly roleKey: AiRoleKey;
  readonly roleRevisionId?: AiRoleRevisionId;
}

export interface RoleAmbiguousResolution {
  readonly status: 'role_ambiguous';
  readonly roleKey: AiRoleKey;
  readonly candidateRoleRevisionIds: readonly AiRoleRevisionId[];
}

export interface RoleNotActiveResolution {
  readonly status: 'role_not_active';
  readonly roleRevision: AiRoleRevision;
}

export interface BindingNotFoundResolution {
  readonly status: 'binding_not_found';
  readonly roleRevision: AiRoleRevision;
}

export interface BindingAmbiguousResolution {
  readonly status: 'binding_ambiguous';
  readonly roleRevision: AiRoleRevision;
  readonly candidateBindingRevisionIds: readonly AiRoleBindingRevisionId[];
}

export interface BindingNotActiveResolution {
  readonly status: 'binding_not_active';
  readonly bindingRevision: AiRoleBindingRevision;
}

export interface InvalidCorrelationResolution {
  readonly status: 'invalid_correlation';
  readonly detail: string;
}

export type ResolveAiRoleResult =
  | ResolvedAiRole
  | RoleNotFoundResolution
  | RoleAmbiguousResolution
  | RoleNotActiveResolution
  | BindingNotFoundResolution
  | BindingAmbiguousResolution
  | BindingNotActiveResolution
  | InvalidCorrelationResolution;
