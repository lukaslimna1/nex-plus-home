/**
 * NEX+ · AI Role Registry & Incumbent Bindings
 * Registry Imutável e Validador de DAG de Papéis Funcionais e Bindings — Escopo 0.7A
 *
 * Armazena e indexa revisões de papéis e bindings em memória com imutabilidade defensiva profunda.
 * Valida rigorosamente as invariantes de Directed Acyclic Graph (DAG):
 * - Anti-Self-Supersession
 * - Anti-Cross-Identity Supersession (roleKey para papéis, bindingKey para bindings)
 * - Anti-Supersession-Cycle (DFS)
 * A detecção de vigência (heads) baseia-se exclusivamente no grafo explícito de supersessão.
 */

import type {
  AiRoleBindingKey,
  AiRoleBindingRevision,
  AiRoleBindingRevisionId,
  AiRoleKey,
  AiRoleRegistry,
  AiRoleRevision,
  AiRoleRevisionId,
} from './contracts';

export class AiRoleRegistryError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(`[AiRoleRegistry] ${message}`);
    this.name = 'AiRoleRegistryError';
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

interface DagNode {
  readonly id: string;
  readonly identityKey: string;
  readonly supersedesRevisionIds: readonly string[];
}

function validateDagInvariants(nodes: readonly DagNode[], entityType: string): void {
  const byId = new Map<string, DagNode>();
  for (const n of nodes) {
    byId.set(n.id, n);
  }

  // 1 & 2: Self-supersession & Cross-identity supersession
  for (const node of nodes) {
    for (const supId of node.supersedesRevisionIds) {
      if (supId === node.id) {
        throw new AiRoleRegistryError(
          `Self-supersession is strictly prohibited: ${entityType} revision '${node.id}' cannot supersede itself.`,
          'SELF_SUPERSESSION',
        );
      }

      const target = byId.get(supId);
      if (target && target.identityKey !== node.identityKey) {
        throw new AiRoleRegistryError(
          `Cross-identity supersession is prohibited: ${entityType} revision '${node.id}' (${node.identityKey}) cannot supersede revision '${target.id}' of different identity (${target.identityKey}).`,
          'CROSS_IDENTITY_SUPERSESSION',
        );
      }
    }
  }

  // 3: Cycle detection via DFS
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function dfs(currentId: string, path: string[]): void {
    visited.add(currentId);
    recursionStack.add(currentId);

    const node = byId.get(currentId);
    if (node) {
      for (const nextId of node.supersedesRevisionIds) {
        if (recursionStack.has(nextId)) {
          throw new AiRoleRegistryError(
            `Supersession cycle detected in ${entityType}: ${[...path, nextId].join(' -> ')}.`,
            'SUPERSESSION_CYCLE',
          );
        }
        if (!visited.has(nextId)) {
          dfs(nextId, [...path, nextId]);
        }
      }
    }

    recursionStack.delete(currentId);
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      dfs(node.id, [node.id]);
    }
  }
}

export function createAiRoleRegistry(): AiRoleRegistry {
  const rolesById = new Map<AiRoleRevisionId, AiRoleRevision>();
  const bindingsById = new Map<AiRoleBindingRevisionId, AiRoleBindingRevision>();

  return {
    appendRoleRevision(revision: AiRoleRevision): void {
      if (!revision || !revision.roleKey || !revision.roleRevisionId) {
        throw new AiRoleRegistryError(
          'roleKey and roleRevisionId are mandatory.',
          'INVALID_ROLE_REVISION',
        );
      }

      if (rolesById.has(revision.roleRevisionId)) {
        throw new AiRoleRegistryError(
          `Duplicate RoleRevisionId '${revision.roleRevisionId}' is rejected.`,
          'DUPLICATE_ROLE_REVISION_ID',
        );
      }

      const supersedes = Object.freeze([...(revision.supersedesRevisionIds || [])]);

      // Validação DAG preliminar com nós existentes + novo nó
      const candidateNodes: DagNode[] = [
        ...Array.from(rolesById.values()).map((r) => ({
          id: r.roleRevisionId,
          identityKey: r.roleKey,
          supersedesRevisionIds: r.supersedesRevisionIds,
        })),
        {
          id: revision.roleRevisionId,
          identityKey: revision.roleKey,
          supersedesRevisionIds: supersedes,
        },
      ];

      validateDagInvariants(candidateNodes, 'AiRole');

      const frozen = deepFreeze({
        roleKey: revision.roleKey,
        roleRevisionId: revision.roleRevisionId,
        lifecycle: revision.lifecycle,
        supersedesRevisionIds: supersedes,
        title: revision.title,
        description: revision.description,
      });

      rolesById.set(revision.roleRevisionId, frozen);
    },

    appendBindingRevision(revision: AiRoleBindingRevision): void {
      if (
        !revision ||
        !revision.bindingKey ||
        !revision.bindingRevisionId ||
        !revision.roleKey ||
        !revision.roleRevisionId ||
        !revision.routeRevisionId ||
        !revision.target
      ) {
        throw new AiRoleRegistryError(
          'Mandatory fields missing for AiRoleBindingRevision.',
          'INVALID_BINDING_REVISION',
        );
      }

      if (bindingsById.has(revision.bindingRevisionId)) {
        throw new AiRoleRegistryError(
          `Duplicate BindingRevisionId '${revision.bindingRevisionId}' is rejected.`,
          'DUPLICATE_BINDING_REVISION_ID',
        );
      }

      // Validação de Integridade Referencial: RoleRevision deve existir no registry
      const targetRole = rolesById.get(revision.roleRevisionId);
      if (!targetRole) {
        throw new AiRoleRegistryError(
          `Referenced roleRevisionId '${revision.roleRevisionId}' does not exist in registry.`,
          'REFERENCED_ROLE_NOT_FOUND',
        );
      }

      if (targetRole.roleKey !== revision.roleKey) {
        throw new AiRoleRegistryError(
          `Binding roleKey '${revision.roleKey}' does not match referenced role's key '${targetRole.roleKey}'.`,
          'ROLE_KEY_MISMATCH',
        );
      }

      const supersedes = Object.freeze([...(revision.supersedesRevisionIds || [])]);

      // Validação DAG preliminar para bindings
      const candidateNodes: DagNode[] = [
        ...Array.from(bindingsById.values()).map((b) => ({
          id: b.bindingRevisionId,
          identityKey: b.bindingKey,
          supersedesRevisionIds: b.supersedesRevisionIds,
        })),
        {
          id: revision.bindingRevisionId,
          identityKey: revision.bindingKey,
          supersedesRevisionIds: supersedes,
        },
      ];

      validateDagInvariants(candidateNodes, 'AiRoleBinding');

      const frozen = deepFreeze({
        bindingKey: revision.bindingKey,
        bindingRevisionId: revision.bindingRevisionId,
        roleKey: revision.roleKey,
        roleRevisionId: revision.roleRevisionId,
        routeRevisionId: revision.routeRevisionId,
        target: deepFreeze({ ...revision.target }),
        lifecycle: revision.lifecycle,
        supersedesRevisionIds: supersedes,
        provenance: revision.provenance,
      });

      bindingsById.set(revision.bindingRevisionId, frozen);
    },

    getRoleRevision(roleRevisionId: AiRoleRevisionId): AiRoleRevision | undefined {
      const found = rolesById.get(roleRevisionId);
      return found ? deepFreeze({ ...found }) : undefined;
    },

    getBindingRevision(bindingRevisionId: AiRoleBindingRevisionId): AiRoleBindingRevision | undefined {
      const found = bindingsById.get(bindingRevisionId);
      return found ? deepFreeze({ ...found }) : undefined;
    },

    getRoleHeads(roleKey: AiRoleKey): readonly AiRoleRevision[] {
      const matching = Array.from(rolesById.values()).filter((r) => r.roleKey === roleKey);
      if (matching.length === 0) return Object.freeze([]);

      // Coleta todos os IDs que foram explicitamente superados por qualquer revisão do mesmo roleKey
      const supersededIds = new Set<AiRoleRevisionId>();
      for (const r of matching) {
        for (const supId of r.supersedesRevisionIds) {
          supersededIds.add(supId);
        }
      }

      // Heads são as revisões cujo ID não consta no conjunto de superados
      const heads = matching.filter((r) => !supersededIds.has(r.roleRevisionId));
      return Object.freeze(heads.map((h) => deepFreeze({ ...h })));
    },

    getBindingHeadsForRole(roleRevisionId: AiRoleRevisionId): readonly AiRoleBindingRevision[] {
      const matching = Array.from(bindingsById.values()).filter(
        (b) => b.roleRevisionId === roleRevisionId,
      );
      if (matching.length === 0) return Object.freeze([]);

      // Coleta todos os IDs que foram superados explicitamente no escopo daquele roleRevisionId
      const supersededIds = new Set<AiRoleBindingRevisionId>();
      for (const b of matching) {
        for (const supId of b.supersedesRevisionIds) {
          supersededIds.add(supId);
        }
      }

      // Heads são as revisões de binding não superadas
      const heads = matching.filter((b) => !supersededIds.has(b.bindingRevisionId));
      return Object.freeze(heads.map((h) => deepFreeze({ ...h })));
    },

    listRoleRevisions(): readonly AiRoleRevision[] {
      return Object.freeze(Array.from(rolesById.values()).map((r) => deepFreeze({ ...r })));
    },

    listBindingRevisions(): readonly AiRoleBindingRevision[] {
      return Object.freeze(Array.from(bindingsById.values()).map((b) => deepFreeze({ ...b })));
    },
  };
}
