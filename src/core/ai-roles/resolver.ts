/**
 * NEX+ · AI Role Registry & Incumbent Bindings
 * Resolver Determinístico de Papéis Funcionais de IA — Escopo 0.7A
 *
 * Função pura que resolve qual ocupante concreto (binding) está ativo para um determinado papel funcional.
 * Não realiza roteamento inteligente, balanceamento, heurísticas de custo/velocidade nem consultas de rede.
 * Preserva estritamente a autoridade de Policy/Route do Core 0.5.
 */

import type {
  AiRoleBindingRevision,
  AiRoleBindingRevisionId,
  AiRoleKey,
  AiRoleRegistry,
  AiRoleRevision,
  AiRoleRevisionId,
  ResolveAiRoleResult,
} from './contracts';

export interface ResolveAiRoleParams {
  readonly roleKey: AiRoleKey;
  readonly roleRevisionId?: AiRoleRevisionId;
  readonly bindingRevisionId?: AiRoleBindingRevisionId;
  readonly registry: AiRoleRegistry;
}

export function resolveAiRole(params: ResolveAiRoleParams): ResolveAiRoleResult {
  const { roleKey, roleRevisionId, bindingRevisionId, registry } = params;

  if (!roleKey) {
    return {
      status: 'role_not_found',
      roleKey: '' as AiRoleKey,
    };
  }

  // 1. Resolução da Revisão de Papel (RoleRevision)
  let targetRole: AiRoleRevision | undefined = undefined;

  if (roleRevisionId) {
    const directRole = registry.getRoleRevision(roleRevisionId);
    if (!directRole || directRole.roleKey !== roleKey) {
      return {
        status: 'role_not_found',
        roleKey,
        roleRevisionId,
      };
    }
    targetRole = directRole;
  } else {
    const roleHeads = registry.getRoleHeads(roleKey);
    if (roleHeads.length === 0) {
      return {
        status: 'role_not_found',
        roleKey,
      };
    }

    if (roleHeads.length > 1) {
      return {
        status: 'role_ambiguous',
        roleKey,
        candidateRoleRevisionIds: Object.freeze(roleHeads.map((h) => h.roleRevisionId)),
      };
    }

    targetRole = roleHeads[0];
  }

  // 2. Validação de Ciclo de Vida do Papel
  if (targetRole.lifecycle !== 'active') {
    return {
      status: 'role_not_active',
      roleRevision: targetRole,
    };
  }

  // 3. Resolução da Revisão de Binding (BindingRevision)
  let targetBinding: AiRoleBindingRevision | undefined = undefined;

  if (bindingRevisionId) {
    const directBinding = registry.getBindingRevision(bindingRevisionId);
    if (!directBinding) {
      return {
        status: 'binding_not_found',
        roleRevision: targetRole,
      };
    }

    if (
      directBinding.roleRevisionId !== targetRole.roleRevisionId ||
      directBinding.roleKey !== targetRole.roleKey
    ) {
      return {
        status: 'invalid_correlation',
        detail: `Binding revision '${bindingRevisionId}' correlates with role '${directBinding.roleKey}/${directBinding.roleRevisionId}', not target role '${targetRole.roleKey}/${targetRole.roleRevisionId}'.`,
      };
    }

    targetBinding = directBinding;
  } else {
    const bindingHeads = registry.getBindingHeadsForRole(targetRole.roleRevisionId);
    if (bindingHeads.length === 0) {
      return {
        status: 'binding_not_found',
        roleRevision: targetRole,
      };
    }

    if (bindingHeads.length > 1) {
      return {
        status: 'binding_ambiguous',
        roleRevision: targetRole,
        candidateBindingRevisionIds: Object.freeze(bindingHeads.map((b) => b.bindingRevisionId)),
      };
    }

    targetBinding = bindingHeads[0];
  }

  // 4. Validação de Ciclo de Vida do Binding
  if (targetBinding.lifecycle !== 'active') {
    return {
      status: 'binding_not_active',
      bindingRevision: targetBinding,
    };
  }

  // 5. Retorno Resolvido Canônico
  return {
    status: 'resolved',
    roleRevision: targetRole,
    bindingRevision: targetBinding,
    routeRevisionId: targetBinding.routeRevisionId,
    target: targetBinding.target,
  };
}
