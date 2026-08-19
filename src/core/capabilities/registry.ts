/**
 * NEX+ · Capability Registry & Route/Terms Ledger
 * Implementação Factual do Registry em Memória — Escopo 0.5 (Bloco 0.5B)
 *
 * Plano de Autoridade (L0).
 * Funções puras, validação de invariantes, vigência temporal e resolução determinística de termos.
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
  TermsResolutionContext,
  TermsResolutionResult,
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

export class IncoherentBillingStateError extends Error {
  readonly termsRevisionId: string;
  readonly detail: string;
  constructor(termsRevisionId: string, detail: string) {
    super(`[L0 Registry Error] Incoherent BillingStatus state in Terms '${termsRevisionId}': ${detail}.`);
    this.name = 'IncoherentBillingStateError';
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

/**
 * Resolve deterministicamente os termos para uma RouteRevision sob um contexto factual e temporal:
 * 1. Avalia a vigência temporal (effectiveFrom <= at <= validUntil).
 * 2. Determina os heads ativos naquele instante temporal.
 * 3. Valida a aplicabilidade das condições declaradas em TermsApplicability.
 * 4. Detecta contradições materiais entre termos simultaneamente aplicáveis (BillingStatus, Entitlements, Privacy, Tarifas).
 * NUNCA escolhe vencedor por timestamp, SemVer ou ordem de inserção.
 */
export function resolveTermsForRoute(
  routeRevisionId: RouteRevisionId,
  allTerms: readonly RouteTermsRevision[],
  context: TermsResolutionContext,
): TermsResolutionResult {
  const termsForRoute = allTerms.filter((t) => t.routeRevisionId === routeRevisionId);
  if (termsForRoute.length === 0) {
    return { status: 'no_terms' };
  }

  // 1. Filtrar termos temporalmente ativos no timestamp context.at
  const activeTerms = termsForRoute.filter(
    (t) => t.effectiveFrom <= context.at && (!t.validUntil || context.at <= t.validUntil),
  );

  if (activeTerms.length === 0) {
    return { status: 'no_applicable_terms' };
  }

  // 2. Determinar os heads vigentes entre os termos temporalmente ativos
  const headTerms = getHeads(
    activeTerms.map((t) => ({
      ...t,
      id: t.termsRevisionId as string,
      supersedesRevisionIds: t.supersedesRevisionIds as readonly string[],
    })),
  ).map((h) => activeTerms.find((t) => t.termsRevisionId === h.id)!);

  if (headTerms.length === 0) {
    return { status: 'no_applicable_terms' };
  }

  // 3. Avaliar TermsApplicability para cada head
  const applicableTerms: RouteTermsRevision[] = [];
  const insufficientTerms: { term: RouteTermsRevision; missing: string[] }[] = [];

  for (const term of headTerms) {
    if (!term.applicability) {
      applicableTerms.push(term);
      continue;
    }

    const app = term.applicability;
    const missing: string[] = [];
    let mismatch = false;

    const dimensions: (keyof typeof app)[] = [
      'endpoint',
      'region',
      'accountTier',
      'credentialProfileRef',
      'requestMode',
      'routeMode',
    ];

    for (const dim of dimensions) {
      const expectedVal = app[dim];
      if (expectedVal !== undefined) {
        const actualVal = context[dim as keyof TermsResolutionContext];
        if (actualVal === undefined) {
          missing.push(dim);
        } else if (actualVal !== expectedVal) {
          mismatch = true;
          break;
        }
      }
    }

    if (mismatch) {
      // Condição não satisfeita pelo contexto factual
      continue;
    }

    if (missing.length > 0) {
      insufficientTerms.push({ term, missing });
    } else {
      applicableTerms.push(term);
    }
  }

  // Se houver qualquer termo com contexto insuficiente (mesmo que haja outros termos já aplicáveis),
  // a resolução factual completa não pode ser declarada como resolvida
  if (insufficientTerms.length > 0) {
    const missingDimensions = Array.from(new Set(insufficientTerms.flatMap((i) => i.missing)));
    return {
      status: 'insufficient_context',
      missingDimensions,
      candidateTerms: insufficientTerms.map((i) => i.term),
      reason: `Context is missing required dimensions [${missingDimensions.join(', ')}] to evaluate TermsApplicability.`,
    };
  }

  if (applicableTerms.length === 0) {
    return { status: 'no_applicable_terms' };
  }

  if (applicableTerms.length === 1) {
    return {
      status: 'single_applicable',
      terms: applicableTerms[0],
    };
  }

  // 4. Múltiplos heads aplicáveis: verificar contradições materiais
  for (let i = 0; i < applicableTerms.length; i++) {
    for (let j = i + 1; j < applicableTerms.length; j++) {
      const t1 = applicableTerms[i];
      const t2 = applicableTerms[j];

      // A) BillingStatus
      if (t1.billingStatus !== t2.billingStatus) {
        return {
          status: 'unresolved_conflict',
          conflictingTerms: applicableTerms,
          reason: `Contradictory BillingStatus between terms '${t1.termsRevisionId}' (${t1.billingStatus}) and '${t2.termsRevisionId}' (${t2.billingStatus}).`,
        };
      }

      // B) FreeEntitlementStatus
      if (t1.freeEntitlementStatus !== t2.freeEntitlementStatus) {
        return {
          status: 'unresolved_conflict',
          conflictingTerms: applicableTerms,
          reason: `Contradictory FreeEntitlementStatus between terms '${t1.termsRevisionId}' (${t1.freeEntitlementStatus}) and '${t2.termsRevisionId}' (${t2.freeEntitlementStatus}).`,
        };
      }

      // C) PrivacyDataTerms
      if (t1.privacyDataTerms && t2.privacyDataTerms) {
        const p1 = t1.privacyDataTerms;
        const p2 = t2.privacyDataTerms;

        if (p1.retentionDays !== undefined && p2.retentionDays !== undefined && p1.retentionDays !== p2.retentionDays) {
          return {
            status: 'unresolved_conflict',
            conflictingTerms: applicableTerms,
            reason: `Contradictory retentionDays between terms '${t1.termsRevisionId}' (${p1.retentionDays}) and '${t2.termsRevisionId}' (${p2.retentionDays}).`,
          };
        }

        if (p1.trainingUsage !== undefined && p2.trainingUsage !== undefined && p1.trainingUsage !== p2.trainingUsage) {
          return {
            status: 'unresolved_conflict',
            conflictingTerms: applicableTerms,
            reason: `Contradictory trainingUsage between terms '${t1.termsRevisionId}' (${p1.trainingUsage}) and '${t2.termsRevisionId}' (${p2.trainingUsage}).`,
          };
        }

        if (
          p1.trainingOptOutGuaranteed !== undefined &&
          p2.trainingOptOutGuaranteed !== undefined &&
          p1.trainingOptOutGuaranteed !== p2.trainingOptOutGuaranteed
        ) {
          return {
            status: 'unresolved_conflict',
            conflictingTerms: applicableTerms,
            reason: `Contradictory trainingOptOutGuaranteed between terms '${t1.termsRevisionId}' (${p1.trainingOptOutGuaranteed}) and '${t2.termsRevisionId}' (${p2.trainingOptOutGuaranteed}).`,
          };
        }

        if (
          p1.zeroDataRetentionGuaranteed !== undefined &&
          p2.zeroDataRetentionGuaranteed !== undefined &&
          p1.zeroDataRetentionGuaranteed !== p2.zeroDataRetentionGuaranteed
        ) {
          return {
            status: 'unresolved_conflict',
            conflictingTerms: applicableTerms,
            reason: `Contradictory zeroDataRetentionGuaranteed between terms '${t1.termsRevisionId}' (${p1.zeroDataRetentionGuaranteed}) and '${t2.termsRevisionId}' (${p2.zeroDataRetentionGuaranteed}).`,
          };
        }

        if (
          p1.residencyRegion !== undefined &&
          p2.residencyRegion !== undefined &&
          p1.residencyRegion !== p2.residencyRegion
        ) {
          return {
            status: 'unresolved_conflict',
            conflictingTerms: applicableTerms,
            reason: `Contradictory residencyRegion between terms '${t1.termsRevisionId}' (${p1.residencyRegion}) and '${t2.termsRevisionId}' (${p2.residencyRegion}).`,
          };
        }
      }

      // D) Incompatible BillingComponents with identical dimension but different rates
      for (const c1 of t1.billingComponents) {
        for (const c2 of t2.billingComponents) {
          if (
            c1.type === c2.type &&
            c1.unit === c2.unit &&
            c1.currency === c2.currency &&
            c1.period === c2.period &&
            c1.applicability === c2.applicability
          ) {
            if (c1.amount !== undefined && c2.amount !== undefined && c1.amount !== c2.amount) {
              return {
                status: 'unresolved_conflict',
                conflictingTerms: applicableTerms,
                reason: `Contradictory rate/amount for billing component '${c1.type}' between '${t1.termsRevisionId}' (${c1.amount}) and '${t2.termsRevisionId}' (${c2.amount}).`,
              };
            }
          }
        }
      }
    }
  }

  // Fatos aditivos compatíveis
  return {
    status: 'composable_terms',
    terms: applicableTerms,
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
  getBindingHeadsForCapability(capabilityRevisionId: CapabilityRevisionId): readonly CapabilityRouteBindingRevision[];
  getBindingsForRoute(routeRevisionId: RouteRevisionId): readonly CapabilityRouteBindingRevision[];
  getBindingHeadsForRoute(routeRevisionId: RouteRevisionId): readonly CapabilityRouteBindingRevision[];
  getRoutesForCapability(capabilityRevisionId: CapabilityRevisionId): readonly RouteRevision[];

  // Terms
  registerTermsRevision(rev: RouteTermsRevision): void;
  getTermsForRoute(routeRevisionId: RouteRevisionId, context: TermsResolutionContext): TermsResolutionResult;
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

    // Validar coerência de BillingStatus
    if (rev.billingStatus === 'known_none' && rev.billingComponents.length > 0) {
      throw new IncoherentBillingStateError(
        rev.termsRevisionId as string,
        "billingStatus is 'known_none' but billingComponents array contains items",
      );
    }
    if (rev.billingStatus === 'known_components' && rev.billingComponents.length === 0) {
      throw new IncoherentBillingStateError(
        rev.termsRevisionId as string,
        "billingStatus is 'known_components' but billingComponents array is empty",
      );
    }
    if (rev.billingStatus === 'unknown' && rev.billingComponents.length > 0) {
      throw new IncoherentBillingStateError(
        rev.termsRevisionId as string,
        "billingStatus is 'unknown' but billingComponents array contains items",
      );
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
    if (rev.freeEntitlementStatus === 'unknown' && rev.freeEntitlements.length > 0) {
      throw new IncoherentEntitlementStateError(
        rev.termsRevisionId as string,
        "freeEntitlementStatus is 'unknown' but freeEntitlements array contains items",
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
    getBindingHeadsForCapability(capabilityRevisionId: CapabilityRevisionId) {
      const all = this.getBindingsForCapability(capabilityRevisionId);
      const heads = getHeads(
        all.map((b) => ({
          ...b,
          id: b.bindingRevisionId as string,
          supersedesRevisionIds: b.supersedesRevisionIds as readonly string[],
        })),
      );
      return heads.map((h) => all.find((b) => b.bindingRevisionId === h.id)!);
    },
    getBindingsForRoute(routeRevisionId: RouteRevisionId) {
      return Array.from(bindingsById.values()).filter(
        (b) => b.routeRevisionId === routeRevisionId,
      );
    },
    getBindingHeadsForRoute(routeRevisionId: RouteRevisionId) {
      const all = this.getBindingsForRoute(routeRevisionId);
      const heads = getHeads(
        all.map((b) => ({
          ...b,
          id: b.bindingRevisionId as string,
          supersedesRevisionIds: b.supersedesRevisionIds as readonly string[],
        })),
      );
      return heads.map((h) => all.find((b) => b.bindingRevisionId === h.id)!);
    },
    getRoutesForCapability(capabilityRevisionId: CapabilityRevisionId) {
      // Utiliza exclusivamente binding heads vigentes
      const bindingHeads = this.getBindingHeadsForCapability(capabilityRevisionId);
      const routes: RouteRevision[] = [];
      for (const b of bindingHeads) {
        const route = routesById.get(b.routeRevisionId);
        if (route && !routes.some((r) => r.routeRevisionId === route.routeRevisionId)) {
          routes.push(route);
        }
      }
      return routes;
    },

    registerTermsRevision: registerTerms,
    getTermsForRoute(routeRevisionId: RouteRevisionId, context: TermsResolutionContext) {
      return resolveTermsForRoute(routeRevisionId, Array.from(termsById.values()), context);
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
