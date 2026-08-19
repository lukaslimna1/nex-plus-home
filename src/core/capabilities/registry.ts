/**
 * NEX+ · Capability Registry & Route/Terms Ledger
 * Implementação Factual do Registry em Memória — Escopo 0.5 (Bloco 0.5B)
 *
 * Plano de Autoridade (L0).
 * Funções puras, validação de invariantes, ausência de heurísticas temporais.
 */

import type {
  CapabilityKey,
  CapabilityRevision,
  CapabilityRevisionId,
  CapabilityRouteBindingRevision,
  BindingRevisionId,
  RouteKey,
  RouteRevision,
  RouteRevisionId,
  RouteTermsRevision,
  RouteTermsRevisionId,
} from './contracts';

// ============================================================================
// 1. ERROS ESTRUTURAIS DETERMINÍSTICOS
// ============================================================================

export class DuplicateRevisionIdError extends Error {
  readonly revisionId: string;
  constructor(revisionId: string, entityType: string) {
    super(`[L0 Registry Error] Duplicate revision ID '${revisionId}' for ${entityType}.`);
    this.name = 'DuplicateRevisionIdError';
    this.revisionId = revisionId;
  }
}

export class SelfSupersessionError extends Error {
  readonly revisionId: string;
  constructor(revisionId: string) {
    super(`[L0 Registry Invariant] Self-supersession is strictly prohibited: revision '${revisionId}' cannot supersede itself.`);
    this.name = 'SelfSupersessionError';
    this.revisionId = revisionId;
  }
}

export class SupersessionCycleError extends Error {
  readonly cyclePath: readonly string[];
  constructor(cyclePath: readonly string[]) {
    super(`[L0 Registry Invariant] Supersession cycle detected: ${cyclePath.join(' -> ')}.`);
    this.name = 'SupersessionCycleError';
    this.cyclePath = cyclePath;
  }
}

export class CrossIdentitySupersessionError extends Error {
  readonly sourceRevisionId: string;
  readonly sourceIdentity: string;
  readonly targetRevisionId: string;
  readonly targetIdentity: string;
  constructor(
    sourceRevisionId: string,
    sourceIdentity: string,
    targetRevisionId: string,
    targetIdentity: string,
  ) {
    super(
      `[L0 Registry Invariant] Cross-identity supersession prohibited: revision '${sourceRevisionId}' (${sourceIdentity}) cannot supersede '${targetRevisionId}' (${targetIdentity}).`,
    );
    this.name = 'CrossIdentitySupersessionError';
    this.sourceRevisionId = sourceRevisionId;
    this.sourceIdentity = sourceIdentity;
    this.targetRevisionId = targetRevisionId;
    this.targetIdentity = targetIdentity;
  }
}

export class InvalidBindingReferenceError extends Error {
  readonly bindingRevisionId: string;
  readonly missingRef: string;
  constructor(bindingRevisionId: string, missingRef: string) {
    super(`[L0 Registry Error] Binding '${bindingRevisionId}' references non-existent revision '${missingRef}'.`);
    this.name = 'InvalidBindingReferenceError';
    this.bindingRevisionId = bindingRevisionId;
    this.missingRef = missingRef;
  }
}

export class InvalidTermsReferenceError extends Error {
  readonly termsRevisionId: string;
  readonly routeRevisionId: string;
  constructor(termsRevisionId: string, routeRevisionId: string) {
    super(`[L0 Registry Error] Terms '${termsRevisionId}' references non-existent RouteRevision '${routeRevisionId}'.`);
    this.name = 'InvalidTermsReferenceError';
    this.termsRevisionId = termsRevisionId;
    this.routeRevisionId = routeRevisionId;
  }
}

export class IncoherentEntitlementStateError extends Error {
  readonly termsRevisionId: string;
  readonly detail: string;
  constructor(termsRevisionId: string, detail: string) {
    super(`[L0 Registry Error] Incoherent FreeEntitlement state in Terms '${termsRevisionId}': ${detail}.`);
    this.name = 'IncoherentEntitlementStateError';
    this.termsRevisionId = termsRevisionId;
    this.detail = detail;
  }
}

// ============================================================================
// 2. HELPERS DETERMINÍSTICOS DE SUPERSESSION & HEADS
// ============================================================================

export interface IdentifiableRevisionItem {
  readonly id: string;
  readonly identityKey: string;
  readonly supersedesRevisionIds?: readonly string[];
}

/**
 * Valida as invariantes matemáticas de supersession:
 * 1. Anti-Self-Supersession
 * 2. Isolamento de Identidade Canônica (Anti-Cross-Identity)
 * 3. Grafo Acíclico Dirigido (Anti-Ciclo)
 */
export function validateSupersessionChain<T extends IdentifiableRevisionItem>(revisions: readonly T[]): void {
  const byId = new Map<string, T>();

  for (const rev of revisions) {
    byId.set(rev.id, rev);
  }

  // 1 & 2: Self-supersession & Cross-identity
  for (const rev of revisions) {
    if (!rev.supersedesRevisionIds) continue;

    for (const supersededId of rev.supersedesRevisionIds) {
      if (supersededId === rev.id) {
        throw new SelfSupersessionError(rev.id);
      }

      const target = byId.get(supersededId);
      if (target && target.identityKey !== rev.identityKey) {
        throw new CrossIdentitySupersessionError(rev.id, rev.identityKey, target.id, target.identityKey);
      }
    }
  }

  // 3: Cycle detection via DFS
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

  for (const rev of revisions) {
    if (!visited.has(rev.id)) {
      dfs(rev.id, [rev.id]);
    }
  }
}

/**
 * Retorna os HEADS vigentes de uma coleção de revisões:
 * Head = qualquer revisão cujo ID NÃO foi supersedido explicitamente por outra revisão.
 * Múltiplos heads são preservados em paralelo sem ordenação arbitrária por data/SemVer.
 */
export function getHeads<T extends { readonly id: string; readonly supersedesRevisionIds?: readonly string[] }>(
  revisions: readonly T[],
): readonly T[] {
  if (revisions.length === 0) return [];

  const supersededIds = new Set<string>();
  for (const rev of revisions) {
    if (rev.supersedesRevisionIds) {
      for (const supersededId of rev.supersedesRevisionIds) {
        supersededIds.add(supersededId);
      }
    }
  }

  return revisions.filter((rev) => !supersededIds.has(rev.id));
}

// ============================================================================
// 3. RESOLUÇÃO DE TERMOS & TRATAMENTO DE CONFLITOS FACTUAIS
// ============================================================================

export type TermsResolutionResult =
  | { readonly status: 'no_terms' }
  | { readonly status: 'single_applicable'; readonly terms: RouteTermsRevision }
  | { readonly status: 'composable_terms'; readonly terms: readonly RouteTermsRevision[] }
  | {
      readonly status: 'unresolved_conflict';
      readonly conflictingTerms: readonly RouteTermsRevision[];
      readonly reason: string;
    };

/**
 * Resolve deterministicamente os termos para uma RouteRevision.
 * Se múltiplos heads de termos coexistirem:
 * - Se forem aditivos e compatíveis -> `composable_terms`
 * - Se houver contradição fática de escopo/termos sem supersession -> `unresolved_conflict`
 * NUNCA escolhe vencedor por timestamp, SemVer ou ordem de inserção.
 */
export function resolveTermsForRoute(
  routeRevisionId: RouteRevisionId,
  allTerms: readonly RouteTermsRevision[],
): TermsResolutionResult {
  const termsForRoute = allTerms.filter((t) => t.routeRevisionId === routeRevisionId);
  if (termsForRoute.length === 0) {
    return { status: 'no_terms' };
  }

  // Obter heads não supersedidos de termos
  const headTerms = getHeads(
    termsForRoute.map((t) => ({
      ...t,
      id: t.termsRevisionId as string,
      supersedesRevisionIds: t.supersedesRevisionIds as readonly string[],
    })),
  );

  if (headTerms.length === 0) {
    return { status: 'no_terms' };
  }

  if (headTerms.length === 1) {
    return {
      status: 'single_applicable',
      terms: termsForRoute.find((t) => t.termsRevisionId === headTerms[0].id)!,
    };
  }

  // Múltiplos heads coexistindo: verificar se são compatíveis/componíveis ou conflitantes
  const matchingTerms = headTerms.map(
    (h) => termsForRoute.find((t) => t.termsRevisionId === h.id)!,
  );

  // Verificar se há conflito factual de privacidade ou cobrança contraditória
  for (let i = 0; i < matchingTerms.length; i++) {
    for (let j = i + 1; j < matchingTerms.length; j++) {
      const t1 = matchingTerms[i];
      const t2 = matchingTerms[j];

      // Se ambos definem status de billing contraditórios
      if (t1.billingStatus !== t2.billingStatus) {
        return {
          status: 'unresolved_conflict',
          conflictingTerms: matchingTerms,
          reason: `Contradictory BillingStatus between terms '${t1.termsRevisionId}' (${t1.billingStatus}) and '${t2.termsRevisionId}' (${t2.billingStatus}).`,
        };
      }

      // Se ambos definem termos de privacidade incompatíveis
      if (t1.privacyDataTerms && t2.privacyDataTerms) {
        if (
          t1.privacyDataTerms.trainingOptOutGuaranteed !== undefined &&
          t2.privacyDataTerms.trainingOptOutGuaranteed !== undefined &&
          t1.privacyDataTerms.trainingOptOutGuaranteed !== t2.privacyDataTerms.trainingOptOutGuaranteed
        ) {
          return {
            status: 'unresolved_conflict',
            conflictingTerms: matchingTerms,
            reason: `Contradictory trainingOptOutGuaranteed between terms '${t1.termsRevisionId}' and '${t2.termsRevisionId}'.`,
          };
        }
      }
    }
  }

  // Fatos aditivos compatíveis
  return {
    status: 'composable_terms',
    terms: matchingTerms,
  };
}

// ============================================================================
// 4. CAPABILITY REGISTRY FACTUAL EM MEMÓRIA
// ============================================================================

export interface CapabilityRegistryData {
  readonly capabilities: readonly CapabilityRevision[];
  readonly routes: readonly RouteRevision[];
  readonly bindings: readonly CapabilityRouteBindingRevision[];
  readonly terms: readonly RouteTermsRevision[];
}

export interface CapabilityRegistry {
  // Capabilities
  registerCapabilityRevision(rev: CapabilityRevision): void;
  getCapability(key: CapabilityKey): { readonly heads: readonly CapabilityRevision[]; readonly all: readonly CapabilityRevision[] } | undefined;
  getCapabilityRevision(id: CapabilityRevisionId): CapabilityRevision | undefined;
  listCapabilityRevisions(key?: CapabilityKey): readonly CapabilityRevision[];
  getCapabilityHeads(key: CapabilityKey): readonly CapabilityRevision[];

  // Routes
  registerRouteRevision(rev: RouteRevision): void;
  getRoute(key: RouteKey): { readonly heads: readonly RouteRevision[]; readonly all: readonly RouteRevision[] } | undefined;
  getRouteRevision(id: RouteRevisionId): RouteRevision | undefined;
  listRouteRevisions(key?: RouteKey): readonly RouteRevision[];
  getRouteHeads(key: RouteKey): readonly RouteRevision[];

  // Bindings
  registerBindingRevision(rev: CapabilityRouteBindingRevision): void;
  getBindingRevision(id: BindingRevisionId): CapabilityRouteBindingRevision | undefined;
  getBindingsForCapability(capabilityRevisionId: CapabilityRevisionId): readonly CapabilityRouteBindingRevision[];
  getBindingsForRoute(routeRevisionId: RouteRevisionId): readonly CapabilityRouteBindingRevision[];
  getRoutesForCapability(capabilityRevisionId: CapabilityRevisionId): readonly RouteRevision[];

  // Terms
  registerTermsRevision(rev: RouteTermsRevision): void;
  getTermsForRoute(routeRevisionId: RouteRevisionId): TermsResolutionResult;
  listTermsRevisions(routeRevisionId?: RouteRevisionId): readonly RouteTermsRevision[];

  // Snapshot completo
  exportSnapshot(): CapabilityRegistryData;
}

export function createCapabilityRegistry(initialData?: Partial<CapabilityRegistryData>): CapabilityRegistry {
  const capabilitiesById = new Map<CapabilityRevisionId, CapabilityRevision>();
  const routesById = new Map<RouteRevisionId, RouteRevision>();
  const bindingsById = new Map<BindingRevisionId, CapabilityRouteBindingRevision>();
  const termsById = new Map<RouteTermsRevisionId, RouteTermsRevision>();

  function registerCapability(rev: CapabilityRevision): void {
    if (capabilitiesById.has(rev.capabilityRevisionId)) {
      throw new DuplicateRevisionIdError(rev.capabilityRevisionId as string, 'CapabilityRevision');
    }

    // Validar grafo de supersession contra todas as capabilities registradas
    const allCaps = Array.from(capabilitiesById.values()).map((c) => ({
      id: c.capabilityRevisionId as string,
      identityKey: c.capabilityKey as string,
      supersedesRevisionIds: c.supersedesRevisionIds as readonly string[],
    }));

    validateSupersessionChain([
      ...allCaps,
      {
        id: rev.capabilityRevisionId as string,
        identityKey: rev.capabilityKey as string,
        supersedesRevisionIds: rev.supersedesRevisionIds as readonly string[],
      },
    ]);

    capabilitiesById.set(rev.capabilityRevisionId, rev);
  }

  function registerRoute(rev: RouteRevision): void {
    if (routesById.has(rev.routeRevisionId)) {
      throw new DuplicateRevisionIdError(rev.routeRevisionId as string, 'RouteRevision');
    }

    const allRoutes = Array.from(routesById.values()).map((r) => ({
      id: r.routeRevisionId as string,
      identityKey: r.routeKey as string,
      supersedesRevisionIds: r.supersedesRevisionIds as readonly string[],
    }));

    validateSupersessionChain([
      ...allRoutes,
      {
        id: rev.routeRevisionId as string,
        identityKey: rev.routeKey as string,
        supersedesRevisionIds: rev.supersedesRevisionIds as readonly string[],
      },
    ]);

    routesById.set(rev.routeRevisionId, rev);
  }

  function registerBinding(rev: CapabilityRouteBindingRevision): void {
    if (bindingsById.has(rev.bindingRevisionId)) {
      throw new DuplicateRevisionIdError(rev.bindingRevisionId as string, 'CapabilityRouteBindingRevision');
    }

    // Validar existência das revisões vinculadas
    if (!capabilitiesById.has(rev.capabilityRevisionId)) {
      throw new InvalidBindingReferenceError(rev.bindingRevisionId as string, rev.capabilityRevisionId as string);
    }
    if (!routesById.has(rev.routeRevisionId)) {
      throw new InvalidBindingReferenceError(rev.bindingRevisionId as string, rev.routeRevisionId as string);
    }

    const allBindings = Array.from(bindingsById.values()).map((b) => ({
      id: b.bindingRevisionId as string,
      identityKey: b.bindingKey as string,
      supersedesRevisionIds: b.supersedesRevisionIds as readonly string[],
    }));

    validateSupersessionChain([
      ...allBindings,
      {
        id: rev.bindingRevisionId as string,
        identityKey: rev.bindingKey as string,
        supersedesRevisionIds: rev.supersedesRevisionIds as readonly string[],
      },
    ]);

    bindingsById.set(rev.bindingRevisionId, rev);
  }

  function registerTerms(rev: RouteTermsRevision): void {
    if (termsById.has(rev.termsRevisionId)) {
      throw new DuplicateRevisionIdError(rev.termsRevisionId as string, 'RouteTermsRevision');
    }

    // Validar existência da RouteRevision vinculada
    if (!routesById.has(rev.routeRevisionId)) {
      throw new InvalidTermsReferenceError(rev.termsRevisionId as string, rev.routeRevisionId as string);
    }

    // Validar coerência de FreeEntitlementStatus
    if (rev.freeEntitlementStatus === 'known_none' && rev.freeEntitlements.length > 0) {
      throw new IncoherentEntitlementStateError(
        rev.termsRevisionId as string,
        "freeEntitlementStatus is 'known_none' but freeEntitlements array contains items",
      );
    }
    if (rev.freeEntitlementStatus === 'known_entitlements' && rev.freeEntitlements.length === 0) {
      throw new IncoherentEntitlementStateError(
        rev.termsRevisionId as string,
        "freeEntitlementStatus is 'known_entitlements' but freeEntitlements array is empty",
      );
    }

    const allTerms = Array.from(termsById.values()).map((t) => ({
      id: t.termsRevisionId as string,
      identityKey: t.termsKey as string,
      supersedesRevisionIds: t.supersedesRevisionIds as readonly string[],
    }));

    validateSupersessionChain([
      ...allTerms,
      {
        id: rev.termsRevisionId as string,
        identityKey: rev.termsKey as string,
        supersedesRevisionIds: rev.supersedesRevisionIds as readonly string[],
      },
    ]);

    termsById.set(rev.termsRevisionId, rev);
  }

  // Popular dados iniciais se fornecidos
  if (initialData) {
    if (initialData.capabilities) {
      for (const cap of initialData.capabilities) registerCapability(cap);
    }
    if (initialData.routes) {
      for (const route of initialData.routes) registerRoute(route);
    }
    if (initialData.bindings) {
      for (const binding of initialData.bindings) registerBinding(binding);
    }
    if (initialData.terms) {
      for (const terms of initialData.terms) registerTerms(terms);
    }
  }

  return {
    registerCapabilityRevision: registerCapability,
    getCapability(key: CapabilityKey) {
      const all = Array.from(capabilitiesById.values()).filter((c) => c.capabilityKey === key);
      if (all.length === 0) return undefined;
      const heads = getHeads(
        all.map((c) => ({
          ...c,
          id: c.capabilityRevisionId as string,
          supersedesRevisionIds: c.supersedesRevisionIds as readonly string[],
        })),
      ).map((h) => all.find((c) => c.capabilityRevisionId === h.id)!);
      return { heads, all };
    },
    getCapabilityRevision(id: CapabilityRevisionId) {
      return capabilitiesById.get(id);
    },
    listCapabilityRevisions(key?: CapabilityKey) {
      const all = Array.from(capabilitiesById.values());
      return key ? all.filter((c) => c.capabilityKey === key) : all;
    },
    getCapabilityHeads(key: CapabilityKey) {
      const cap = this.getCapability(key);
      return cap ? cap.heads : [];
    },

    registerRouteRevision: registerRoute,
    getRoute(key: RouteKey) {
      const all = Array.from(routesById.values()).filter((r) => r.routeKey === key);
      if (all.length === 0) return undefined;
      const heads = getHeads(
        all.map((r) => ({
          ...r,
          id: r.routeRevisionId as string,
          supersedesRevisionIds: r.supersedesRevisionIds as readonly string[],
        })),
      ).map((h) => all.find((r) => r.routeRevisionId === h.id)!);
      return { heads, all };
    },
    getRouteRevision(id: RouteRevisionId) {
      return routesById.get(id);
    },
    listRouteRevisions(key?: RouteKey) {
      const all = Array.from(routesById.values());
      return key ? all.filter((r) => r.routeKey === key) : all;
    },
    getRouteHeads(key: RouteKey) {
      const route = this.getRoute(key);
      return route ? route.heads : [];
    },

    registerBindingRevision: registerBinding,
    getBindingRevision(id: BindingRevisionId) {
      return bindingsById.get(id);
    },
    getBindingsForCapability(capabilityRevisionId: CapabilityRevisionId) {
      return Array.from(bindingsById.values()).filter(
        (b) => b.capabilityRevisionId === capabilityRevisionId,
      );
    },
    getBindingsForRoute(routeRevisionId: RouteRevisionId) {
      return Array.from(bindingsById.values()).filter(
        (b) => b.routeRevisionId === routeRevisionId,
      );
    },
    getRoutesForCapability(capabilityRevisionId: CapabilityRevisionId) {
      const bindings = this.getBindingsForCapability(capabilityRevisionId);
      const routes: RouteRevision[] = [];
      for (const b of bindings) {
        const route = routesById.get(b.routeRevisionId);
        if (route && !routes.some((r) => r.routeRevisionId === route.routeRevisionId)) {
          routes.push(route);
        }
      }
      return routes;
    },

    registerTermsRevision: registerTerms,
    getTermsForRoute(routeRevisionId: RouteRevisionId) {
      return resolveTermsForRoute(routeRevisionId, Array.from(termsById.values()));
    },
    listTermsRevisions(routeRevisionId?: RouteRevisionId) {
      const all = Array.from(termsById.values());
      return routeRevisionId ? all.filter((t) => t.routeRevisionId === routeRevisionId) : all;
    },

    exportSnapshot(): CapabilityRegistryData {
      return {
        capabilities: Array.from(capabilitiesById.values()),
        routes: Array.from(routesById.values()),
        bindings: Array.from(bindingsById.values()),
        terms: Array.from(termsById.values()),
      };
    },
  };
}
