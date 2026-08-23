/**
 * NEX+ · Módulos, Referências & Eventos
 * Implementação do ModuleRegistry em Memória — Escopo 0.86 (Bloco 0.86A)
 *
 * Plano de Autoridade (L0).
 * Imutabilidade estrita, identificadores opacos, resolução determinística de Heads
 * e validação estrita de invariantes de supersession (Anti-Self, Anti-Cross, Anti-Ciclo).
 */

import type {
  ModuleKey,
  ModuleManifestRevision,
  ModuleRef,
  ModuleRevisionId,
  ResourceId,
  ResourceRef,
  ResourceType,
} from './contracts';

// ============================================================================
// 1. ERROS ESTRUTURAIS & DE INVARIANTES
// ============================================================================

export class InvalidIdentifierError extends Error {
  readonly code = 'INVALID_IDENTIFIER';
  readonly fieldName: string;
  readonly value: unknown;

  constructor(fieldName: string, value: unknown, reason: string) {
    super(`[L0 Module Registry] Invalid ${fieldName} '${String(value)}': ${reason}.`);
    this.name = 'InvalidIdentifierError';
    this.fieldName = fieldName;
    this.value = value;
  }
}

export class DuplicateModuleRevisionError extends Error {
  readonly code = 'DUPLICATE_MODULE_REVISION';
  readonly revisionId: string;
  readonly moduleKey: string;

  constructor(revisionId: string, moduleKey: string) {
    super(
      `[L0 Module Registry] Duplicate ModuleRevisionId '${revisionId}' for ModuleKey '${moduleKey}'.`,
    );
    this.name = 'DuplicateModuleRevisionError';
    this.revisionId = revisionId;
    this.moduleKey = moduleKey;
  }
}

export class SelfSupersessionError extends Error {
  readonly code = 'SELF_SUPERSESSION_PROHIBITED';
  readonly revisionId: string;

  constructor(revisionId: string) {
    super(
      `[L0 Module Registry] Self-supersession is strictly prohibited: revision '${revisionId}' cannot supersede itself.`,
    );
    this.name = 'SelfSupersessionError';
    this.revisionId = revisionId;
  }
}

export class CrossModuleSupersessionError extends Error {
  readonly code = 'CROSS_MODULE_SUPERSESSION_PROHIBITED';
  readonly sourceRevisionId: string;
  readonly sourceModuleKey: string;
  readonly targetRevisionId: string;
  readonly targetModuleKey: string;

  constructor(
    sourceRevisionId: string,
    sourceModuleKey: string,
    targetRevisionId: string,
    targetModuleKey: string,
  ) {
    super(
      `[L0 Module Registry] Cross-module supersession prohibited: revision '${sourceRevisionId}' of module '${sourceModuleKey}' cannot supersede '${targetRevisionId}' of module '${targetModuleKey}'.`,
    );
    this.name = 'CrossModuleSupersessionError';
    this.sourceRevisionId = sourceRevisionId;
    this.sourceModuleKey = sourceModuleKey;
    this.targetRevisionId = targetRevisionId;
    this.targetModuleKey = targetModuleKey;
  }
}

export class SupersededRevisionNotFoundError extends Error {
  readonly code = 'SUPERSEDED_REVISION_NOT_FOUND';
  readonly revisionId: string;
  readonly missingSupersededId: string;

  constructor(revisionId: string, missingSupersededId: string) {
    super(
      `[L0 Module Registry] Revision '${revisionId}' references non-existent superseded revision '${missingSupersededId}'.`,
    );
    this.name = 'SupersededRevisionNotFoundError';
    this.revisionId = revisionId;
    this.missingSupersededId = missingSupersededId;
  }
}

export class SupersessionCycleError extends Error {
  readonly code = 'SUPERSESSION_CYCLE_DETECTED';
  readonly cyclePath: readonly string[];

  constructor(cyclePath: readonly string[]) {
    super(
      `[L0 Module Registry] Supersession cycle detected: ${cyclePath.join(' -> ')}.`,
    );
    this.name = 'SupersessionCycleError';
    this.cyclePath = cyclePath;
  }
}

export class AmbiguousModuleHeadError extends Error {
  readonly code = 'AMBIGUOUS_MODULE_HEAD';
  readonly moduleKey: string;
  readonly activeHeadRevisionIds: readonly string[];

  constructor(moduleKey: string, activeHeadRevisionIds: readonly string[]) {
    super(
      `[L0 Module Registry] Module '${moduleKey}' has multiple active heads: [${activeHeadRevisionIds.join(', ')}]. Deterministic active head resolution is impossible without explicit supersession.`,
    );
    this.name = 'AmbiguousModuleHeadError';
    this.moduleKey = moduleKey;
    this.activeHeadRevisionIds = activeHeadRevisionIds;
  }
}

export class ModuleRevisionNotFoundError extends Error {
  readonly code = 'MODULE_REVISION_NOT_FOUND';
  readonly revisionId: string;

  constructor(revisionId: string) {
    super(`[L0 Module Registry] ModuleRevisionId '${revisionId}' not found.`);
    this.name = 'ModuleRevisionNotFoundError';
    this.revisionId = revisionId;
  }
}

// ============================================================================
// 2. VALIDADORES AUXILIARES
// ============================================================================

export function isValidIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function assertValidIdentifier(fieldName: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new InvalidIdentifierError(fieldName, value, 'must be a string');
  }
  if (value.length === 0) {
    throw new InvalidIdentifierError(fieldName, value, 'must not be empty');
  }
  if (value !== value.trim()) {
    throw new InvalidIdentifierError(fieldName, value, 'must not contain leading or trailing whitespace');
  }
}

function deepFreezeModuleManifest(revision: ModuleManifestRevision): ModuleManifestRevision {
  return Object.freeze({
    moduleKey: revision.moduleKey,
    moduleRevisionId: revision.moduleRevisionId,
    lifecycle: revision.lifecycle,
    supersedesRevisionIds: Object.freeze([...revision.supersedesRevisionIds]),
    title: revision.title,
    description: revision.description,
    ownedResourceTypes: Object.freeze([...revision.ownedResourceTypes]),
    emittedEventTypes: Object.freeze([...revision.emittedEventTypes]),
  });
}

// ============================================================================
// 3. REGISTRY EM MEMÓRIA
// ============================================================================

export interface ModuleRegistry {
  registerModuleRevision(revision: ModuleManifestRevision): void;
  getModuleRevision(revisionId: ModuleRevisionId): ModuleManifestRevision | undefined;
  listRevisionsForModule(moduleKey: ModuleKey): readonly ModuleManifestRevision[];
  listAllRevisions(): readonly ModuleManifestRevision[];
  hasModule(moduleKey: ModuleKey): boolean;
  getAllHeads(moduleKey: ModuleKey): readonly ModuleManifestRevision[];
  getActiveHead(moduleKey: ModuleKey): ModuleManifestRevision | undefined;
  createModuleRef(moduleKey: string): ModuleRef;
  createResourceRef(ownerModuleKey: string, resourceType: string, resourceId: string): ResourceRef;
}

export function createModuleRegistry(): ModuleRegistry {
  const revisionsById = new Map<ModuleRevisionId, ModuleManifestRevision>();
  const revisionsByModule = new Map<ModuleKey, ModuleManifestRevision[]>();

  function registerModuleRevision(rawRevision: ModuleManifestRevision): void {
    if (!rawRevision || typeof rawRevision !== 'object') {
      throw new Error('[L0 Module Registry] ModuleManifestRevision must be an object.');
    }

    assertValidIdentifier('moduleKey', rawRevision.moduleKey);
    assertValidIdentifier('moduleRevisionId', rawRevision.moduleRevisionId);
    assertValidIdentifier('title', rawRevision.title);

    if (typeof rawRevision.description !== 'string') {
      throw new InvalidIdentifierError('description', rawRevision.description, 'must be a string');
    }

    if (!['active', 'deprecated', 'retired'].includes(rawRevision.lifecycle)) {
      throw new Error(
        `[L0 Module Registry] Invalid lifecycle '${rawRevision.lifecycle}' for revision '${rawRevision.moduleRevisionId}'.`,
      );
    }

    if (!Array.isArray(rawRevision.supersedesRevisionIds)) {
      throw new Error(
        `[L0 Module Registry] supersedesRevisionIds must be an array for revision '${rawRevision.moduleRevisionId}'.`,
      );
    }

    for (const sId of rawRevision.supersedesRevisionIds) {
      assertValidIdentifier('supersedesRevisionId', sId);
    }

    if (!Array.isArray(rawRevision.ownedResourceTypes)) {
      throw new Error(
        `[L0 Module Registry] ownedResourceTypes must be an array for revision '${rawRevision.moduleRevisionId}'.`,
      );
    }

    for (const rType of rawRevision.ownedResourceTypes) {
      assertValidIdentifier('ownedResourceType', rType);
    }

    if (!Array.isArray(rawRevision.emittedEventTypes)) {
      throw new Error(
        `[L0 Module Registry] emittedEventTypes must be an array for revision '${rawRevision.moduleRevisionId}'.`,
      );
    }

    for (const eType of rawRevision.emittedEventTypes) {
      assertValidIdentifier('emittedEventType', eType);
    }

    // 1. Unicidade de Revision ID
    if (revisionsById.has(rawRevision.moduleRevisionId)) {
      throw new DuplicateModuleRevisionError(rawRevision.moduleRevisionId, rawRevision.moduleKey);
    }

    // 2. Anti-Self Supersession
    for (const sId of rawRevision.supersedesRevisionIds) {
      if (sId === rawRevision.moduleRevisionId) {
        throw new SelfSupersessionError(rawRevision.moduleRevisionId);
      }
    }

    // 3. Validação das revisões superseded existentes
    for (const sId of rawRevision.supersedesRevisionIds) {
      const target = revisionsById.get(sId);
      if (!target) {
        throw new SupersededRevisionNotFoundError(rawRevision.moduleRevisionId, sId);
      }

      if (target.moduleKey !== rawRevision.moduleKey) {
        throw new CrossModuleSupersessionError(
          rawRevision.moduleRevisionId,
          rawRevision.moduleKey,
          target.moduleRevisionId,
          target.moduleKey,
        );
      }
    }

    // 4. Detecção de ciclos via DFS no grafo de supersession do módulo
    const existingRevisions = revisionsByModule.get(rawRevision.moduleKey) || [];
    const allRevsForModule = [...existingRevisions, rawRevision];
    const byId = new Map<string, ModuleManifestRevision>();
    for (const rev of allRevsForModule) {
      byId.set(rev.moduleRevisionId, rev);
    }

    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    function dfs(currentId: string, path: string[]): void {
      visited.add(currentId);
      recursionStack.add(currentId);

      const rev = byId.get(currentId);
      if (rev && rev.supersedesRevisionIds) {
        for (const nextId of rev.supersedesRevisionIds) {
          if (!visited.has(nextId)) {
            dfs(nextId, [...path, nextId]);
          } else if (recursionStack.has(nextId)) {
            throw new SupersessionCycleError([...path, nextId]);
          }
        }
      }

      recursionStack.delete(currentId);
    }

    for (const rev of allRevsForModule) {
      if (!visited.has(rev.moduleRevisionId)) {
        dfs(rev.moduleRevisionId, [rev.moduleRevisionId]);
      }
    }

    // 5. Congelamento e inserção no registry
    const frozen = deepFreezeModuleManifest(rawRevision);
    revisionsById.set(frozen.moduleRevisionId, frozen);

    const moduleList = revisionsByModule.get(frozen.moduleKey) || [];
    moduleList.push(frozen);
    revisionsByModule.set(frozen.moduleKey, moduleList);
  }

  function getModuleRevision(revisionId: ModuleRevisionId): ModuleManifestRevision | undefined {
    return revisionsById.get(revisionId);
  }

  function listRevisionsForModule(moduleKey: ModuleKey): readonly ModuleManifestRevision[] {
    const list = revisionsByModule.get(moduleKey);
    return list ? Object.freeze([...list]) : [];
  }

  function listAllRevisions(): readonly ModuleManifestRevision[] {
    return Object.freeze(Array.from(revisionsById.values()));
  }

  function hasModule(moduleKey: ModuleKey): boolean {
    const list = revisionsByModule.get(moduleKey);
    return Boolean(list && list.length > 0);
  }

  function getAllHeads(moduleKey: ModuleKey): readonly ModuleManifestRevision[] {
    const list = revisionsByModule.get(moduleKey);
    if (!list || list.length === 0) return [];

    const supersededIds = new Set<string>();
    for (const rev of list) {
      for (const sId of rev.supersedesRevisionIds) {
        supersededIds.add(sId);
      }
    }

    return Object.freeze(list.filter((rev) => !supersededIds.has(rev.moduleRevisionId)));
  }

  function getActiveHead(moduleKey: ModuleKey): ModuleManifestRevision | undefined {
    const heads = getAllHeads(moduleKey);
    const activeHeads = heads.filter((h) => h.lifecycle === 'active');

    if (activeHeads.length === 0) {
      return undefined;
    }

    if (activeHeads.length === 1) {
      return activeHeads[0];
    }

    throw new AmbiguousModuleHeadError(
      moduleKey,
      activeHeads.map((h) => h.moduleRevisionId),
    );
  }

  function createModuleRef(moduleKey: string): ModuleRef {
    assertValidIdentifier('moduleKey', moduleKey);
    return Object.freeze({
      moduleKey: moduleKey as ModuleKey,
    });
  }

  function createResourceRef(
    ownerModuleKey: string,
    resourceType: string,
    resourceId: string,
  ): ResourceRef {
    assertValidIdentifier('ownerModuleKey', ownerModuleKey);
    assertValidIdentifier('resourceType', resourceType);
    assertValidIdentifier('resourceId', resourceId);

    return Object.freeze({
      ownerModule: Object.freeze({ moduleKey: ownerModuleKey as ModuleKey }),
      resourceType: resourceType as ResourceType,
      resourceId: resourceId as ResourceId,
    });
  }

  return {
    registerModuleRevision,
    getModuleRevision,
    listRevisionsForModule,
    listAllRevisions,
    hasModule,
    getAllHeads,
    getActiveHead,
    createModuleRef,
    createResourceRef,
  };
}
