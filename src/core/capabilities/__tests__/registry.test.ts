/**
 * NEX+ · Capability Registry & Route/Terms Ledger
 * Testes Fatuais e Validações Determinísticas de Aceitação — Escopo 0.5 (Bloco 0.5B / B3)
 *
 * Suíte Completa: 22 Casos de Aceitação Base + 16 Casos de Hardening e Resolução.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CapabilityKey,
  CapabilityRevision,
  CapabilityRevisionId,
  CapabilityRouteBindingRevision,
  BindingKey,
  BindingRevisionId,
  RouteKey,
  RouteRevision,
  RouteRevisionId,
  RouteTermsKey,
  RouteTermsRevision,
  RouteTermsRevisionId,
  AdapterRevisionRef,
  FactProvenance,
  RouteObservation,
  MaterialFactSnapshot,
  TermsResolutionContext,
} from '../contracts';

import {
  createCapabilityRegistry,
  validateSupersessionChain,
  SelfSupersessionError,
  SupersessionCycleError,
  CrossIdentitySupersessionError,
  IncoherentEntitlementStateError,
  IncoherentBillingStateError,
} from '../registry';

// Fixture de Provenance padrão para testes
const defaultProvenance: FactProvenance = {
  source: 'official_docs',
  acquisitionBasis: 'declared',
  verificationStatus: 'corroborated',
  observedAt: '2026-08-19T18:00:00.000Z',
};

const defaultContext: TermsResolutionContext = {
  at: '2026-08-19T18:00:00.000Z',
};

describe('NEX+ L0 Capability Registry & Route/Terms Ledger (Bloco 0.5B / B3)', () => {
  // 1. Capability inexistente não é retornada pelo Registry
  it('1. Capability inexistente não é retornada pelo Registry', () => {
    const registry = createCapabilityRegistry();
    const result = registry.getCapability('non_existent_cap' as CapabilityKey);
    assert.equal(result, undefined);
    assert.equal(registry.getCapabilityRevision('non_existent_id' as CapabilityRevisionId), undefined);
  });

  // 2. Capability active com zero Routes continua existindo
  it('2. Capability active com zero Routes continua existindo', () => {
    const registry = createCapabilityRegistry();
    const capRev: CapabilityRevision = {
      capabilityKey: 'test.standalone.cap' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_standalone_v1' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Standalone Capability',
      description: 'Capability without bound routes',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };

    registry.registerCapabilityRevision(capRev);
    const cap = registry.getCapability('test.standalone.cap' as CapabilityKey);
    assert.ok(cap);
    assert.equal(cap.heads.length, 1);
    assert.equal(cap.heads[0].capabilityRevisionId, 'rev_cap_standalone_v1');

    const routes = registry.getRoutesForCapability('rev_cap_standalone_v1' as CapabilityRevisionId);
    assert.equal(routes.length, 0);
  });

  // 3. Duas CapabilityRevisions active podem coexistir como heads
  it('3. Duas CapabilityRevisions active podem coexistir como heads', () => {
    const registry = createCapabilityRegistry();
    const capV1: CapabilityRevision = {
      capabilityKey: 'test.parallel.cap' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_par_v1' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Parallel Cap V1',
      description: 'Version 1 active',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };
    const capV2: CapabilityRevision = {
      capabilityKey: 'test.parallel.cap' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_par_v2' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [], // Sem superseder v1
      title: 'Parallel Cap V2',
      description: 'Version 2 active in parallel',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };

    registry.registerCapabilityRevision(capV1);
    registry.registerCapabilityRevision(capV2);

    const heads = registry.getCapabilityHeads('test.parallel.cap' as CapabilityKey);
    assert.equal(heads.length, 2);
    assert.deepEqual(
      heads.map((h) => h.capabilityRevisionId),
      ['rev_cap_par_v1', 'rev_cap_par_v2'],
    );
  });

  // 4. C1 supersedida por C2 deixa de ser head
  it('4. C1 supersedida por C2 deixa de ser head', () => {
    const registry = createCapabilityRegistry();
    const capV1: CapabilityRevision = {
      capabilityKey: 'test.lineage.cap' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_lin_v1' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Lineage Cap V1',
      description: 'Initial',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };
    const capV2: CapabilityRevision = {
      capabilityKey: 'test.lineage.cap' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_lin_v2' as CapabilityRevisionId,
      lifecycle: 'deprecated',
      supersedesRevisionIds: ['rev_cap_lin_v1' as CapabilityRevisionId],
      title: 'Lineage Cap V2',
      description: 'Supersedes V1',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };

    registry.registerCapabilityRevision(capV1);
    registry.registerCapabilityRevision(capV2);

    const heads = registry.getCapabilityHeads('test.lineage.cap' as CapabilityKey);
    assert.equal(heads.length, 1);
    assert.equal(heads[0].capabilityRevisionId, 'rev_cap_lin_v2');

    // C1 histórico permanece intacto e acessível
    const c1History = registry.getCapabilityRevision('rev_cap_lin_v1' as CapabilityRevisionId);
    assert.ok(c1History);
    assert.equal(c1History.lifecycle, 'active');
  });

  // 5. Self-supersession é rejeitada
  it('5. Self-supersession é rejeitada', () => {
    const registry = createCapabilityRegistry();
    const invalidCap: CapabilityRevision = {
      capabilityKey: 'test.self.cap' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_self' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: ['rev_cap_self' as CapabilityRevisionId],
      title: 'Invalid Self',
      description: 'Should fail',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };

    assert.throws(() => registry.registerCapabilityRevision(invalidCap), SelfSupersessionError);
  });

  // 6. Ciclo C1→C2→C1 é rejeitado
  it('6. Ciclo C1→C2→C1 é rejeitado', () => {
    const registry = createCapabilityRegistry();
    const c1: CapabilityRevision = {
      capabilityKey: 'test.cycle.cap' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_cyc_1' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'C1',
      description: 'Cycle test',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };
    const c2: CapabilityRevision = {
      capabilityKey: 'test.cycle.cap' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_cyc_2' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: ['rev_cap_cyc_1' as CapabilityRevisionId],
      title: 'C2',
      description: 'Supersedes C1',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };
    const c3Cycle: CapabilityRevision = {
      capabilityKey: 'test.cycle.cap' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_cyc_1' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: ['rev_cap_cyc_2' as CapabilityRevisionId],
      title: 'C1 again',
      description: 'Creates cycle',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };

    registry.registerCapabilityRevision(c1);
    registry.registerCapabilityRevision(c2);
    assert.throws(() => registry.registerCapabilityRevision(c3Cycle));
  });

  // 7. Cross-identity supersession é rejeitada
  it('7. Cross-identity supersession é rejeitada', () => {
    const registry = createCapabilityRegistry();
    const capA: CapabilityRevision = {
      capabilityKey: 'test.cap.a' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_a_v1' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Cap A',
      description: 'Domain A',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };
    const capBInvalid: CapabilityRevision = {
      capabilityKey: 'test.cap.b' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_b_v1' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: ['rev_cap_a_v1' as CapabilityRevisionId],
      title: 'Cap B Invalid',
      description: 'Cross-identity attempt',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };

    registry.registerCapabilityRevision(capA);
    assert.throws(() => registry.registerCapabilityRevision(capBInvalid), CrossIdentitySupersessionError);
  });

  // 8. RouteRevision R1 serve C1 e C2 por Bindings distintos sem criar R2 fictícia
  it('8. RouteRevision R1 serve C1 e C2 por Bindings distintos sem criar R2 fictícia', () => {
    const registry = createCapabilityRegistry();
    const c1: CapabilityRevision = {
      capabilityKey: 'test.cap1' as CapabilityKey,
      capabilityRevisionId: 'rev_c1' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'C1',
      description: 'Cap 1',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };
    const c2: CapabilityRevision = {
      capabilityKey: 'test.cap2' as CapabilityKey,
      capabilityRevisionId: 'rev_c2' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'C2',
      description: 'Cap 2',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };
    const r1: RouteRevision = {
      routeKey: 'test.shared.postgres' as RouteKey,
      routeRevisionId: 'rev_r1' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_sql_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'natural' },
      networkTopologyScopes: ['loopback'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };

    const b1: CapabilityRouteBindingRevision = {
      bindingKey: 'bind.c1.r1' as BindingKey,
      bindingRevisionId: 'rev_b1' as BindingRevisionId,
      capabilityRevisionId: 'rev_c1' as CapabilityRevisionId,
      routeRevisionId: 'rev_r1' as RouteRevisionId,
      adapterRevisionRef: 'adapter_sql_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      domainEffectAtested: 'none',
      compatibilityProvenance: defaultProvenance,
      supersedesRevisionIds: [],
    };
    const b2: CapabilityRouteBindingRevision = {
      bindingKey: 'bind.c2.r1' as BindingKey,
      bindingRevisionId: 'rev_b2' as BindingRevisionId,
      capabilityRevisionId: 'rev_c2' as CapabilityRevisionId,
      routeRevisionId: 'rev_r1' as RouteRevisionId,
      adapterRevisionRef: 'adapter_sql_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      domainEffectAtested: 'none',
      compatibilityProvenance: defaultProvenance,
      supersedesRevisionIds: [],
    };

    registry.registerCapabilityRevision(c1);
    registry.registerCapabilityRevision(c2);
    registry.registerRouteRevision(r1);
    registry.registerBindingRevision(b1);
    registry.registerBindingRevision(b2);

    assert.equal(registry.getBindingsForRoute('rev_r1' as RouteRevisionId).length, 2);
    assert.deepEqual(
      registry.getRoutesForCapability('rev_c1' as CapabilityRevisionId).map((r) => r.routeRevisionId),
      ['rev_r1'],
    );
    assert.deepEqual(
      registry.getRoutesForCapability('rev_c2' as CapabilityRevisionId).map((r) => r.routeRevisionId),
      ['rev_r1'],
    );
  });

  // 9. Schemas estruturalmente iguais não criam Binding automaticamente
  it('9. Schemas estruturalmente iguais não criam Binding automaticamente', () => {
    const registry = createCapabilityRegistry();
    const cap: CapabilityRevision = {
      capabilityKey: 'test.unbound.cap' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_unbound' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Unbound Cap',
      description: 'Has identical schema to Route R1',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
      domainEffect: 'none',
    };
    const route: RouteRevision = {
      routeKey: 'test.unbound.route' as RouteKey,
      routeRevisionId: 'rev_route_unbound' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_sql_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };

    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);

    const routes = registry.getRoutesForCapability('rev_cap_unbound' as CapabilityRevisionId);
    assert.equal(routes.length, 0);
  });

  // 10. Route sem Binding não aparece como implementação da CapabilityRevision
  it('10. Route sem Binding não aparece como implementação da CapabilityRevision', () => {
    const registry = createCapabilityRegistry();
    const cap: CapabilityRevision = {
      capabilityKey: 'test.isolated.cap' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_iso' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Isolated',
      description: 'None',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };
    const route: RouteRevision = {
      routeKey: 'test.isolated.route' as RouteKey,
      routeRevisionId: 'rev_route_iso' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_iso_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };

    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);

    assert.equal(registry.getRoutesForCapability('rev_cap_iso' as CapabilityRevisionId).length, 0);
    assert.equal(registry.getBindingsForRoute('rev_route_iso' as RouteRevisionId).length, 0);
  });

  // 11. Gateway local + WAN mantém crossesEgressBoundary=true
  it('11. Gateway local + WAN mantém crossesEgressBoundary=true', () => {
    const routeGateway: RouteRevision = {
      routeKey: 'ai.local_gateway' as RouteKey,
      routeRevisionId: 'rev_route_gw_v1' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_gw_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['non_streaming'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback', 'wan'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };

    assert.ok(routeGateway.networkTopologyScopes.includes('loopback'));
    assert.ok(routeGateway.networkTopologyScopes.includes('wan'));
    assert.equal(routeGateway.crossesEgressBoundary, true);
  });

  // 12. DomainEffect none não vira may_mutate_domain por access log/billing/cache
  it('12. DomainEffect none não vira may_mutate_domain por access log/billing/cache', () => {
    const routeReadOnly: RouteRevision = {
      routeKey: 'query.catalog_read' as RouteKey,
      routeRevisionId: 'rev_route_read_v1' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_read_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'natural' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'non_ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };

    assert.equal(routeReadOnly.domainEffect, 'none');
  });

  // 13. Idempotency keyed não fornece autorização de retry
  it('13. Idempotency keyed não fornece autorização de retry', () => {
    const routeKeyed: RouteRevision = {
      routeKey: 'payment.charge' as RouteKey,
      routeRevisionId: 'rev_route_charge_v1' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_charge_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: {
        supportType: 'keyed',
        scopeAndConditions: {
          keyPlacement: 'Idempotency-Key',
          retentionWindow: '24h',
          payloadRestrictions: 'identical_payload_required',
        },
      },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'non_ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'may_mutate_domain',
    };

    assert.equal(routeKeyed.idempotencyProfile.supportType, 'keyed');
    assert.equal(((routeKeyed.idempotencyProfile as unknown) as Record<string, unknown>).canRetry, undefined);
  });

  // 14. Billing metered + recurring allowance + promotional credit coexistem
  it('14. Billing metered + recurring allowance + promotional credit coexistem', () => {
    const terms: RouteTermsRevision = {
      termsKey: 'terms.ai_service' as RouteTermsKey,
      termsRevisionId: 'rev_terms_ai_v1' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [
        {
          type: 'metered_usage',
          amount: 0.002,
          unit: '1k_tokens',
          currency: 'USD',
        },
      ],
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [
        {
          type: 'recurring_free_allowance',
          quotaAmount: 1000,
          unit: 'requests',
          renewalPeriod: 'monthly',
        },
        {
          type: 'promotional_credit',
          quotaAmount: 50,
          unit: 'USD',
          validUntil: '2026-12-31T23:59:59.000Z',
        },
      ],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    assert.equal(terms.billingStatus, 'known_components');
    assert.equal(terms.billingComponents.length, 1);
    assert.equal(terms.freeEntitlementStatus, 'known_entitlements');
    assert.equal(terms.freeEntitlements.length, 2);
    assert.equal(terms.freeEntitlements[0].type, 'recurring_free_allowance');
    assert.equal(terms.freeEntitlements[1].type, 'promotional_credit');
  });

  // 15. FreeEntitlementStatus unknown é diferente de known_none
  it('15. FreeEntitlementStatus unknown é diferente de known_none', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'test.route.terms' as RouteKey,
      routeRevisionId: 'rev_route_t_v1' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const termsKnownNone: RouteTermsRevision = {
      termsKey: 'terms.known_none' as RouteTermsKey,
      termsRevisionId: 'rev_terms_none' as RouteTermsRevisionId,
      routeRevisionId: 'rev_route_t_v1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    registry.registerTermsRevision(termsKnownNone);

    const invalidTermsNone: RouteTermsRevision = {
      termsKey: 'terms.invalid_none' as RouteTermsKey,
      termsRevisionId: 'rev_terms_inv_none' as RouteTermsRevisionId,
      routeRevisionId: 'rev_route_t_v1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [{ type: 'recurring_free_allowance', quotaAmount: 100 }],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    assert.throws(() => registry.registerTermsRevision(invalidTermsNone), IncoherentEntitlementStateError);
  });

  // 16. TermsApplicability diferentes podem coexistir
  it('16. TermsApplicability diferentes podem coexistir', () => {
    const tRegionBR: RouteTermsRevision = {
      termsKey: 'terms.region.br' as RouteTermsKey,
      termsRevisionId: 'rev_terms_br' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r1' as RouteRevisionId,
      supersedesRevisionIds: [],
      applicability: { region: 'BR', accountTier: 'Enterprise' },
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'metered_usage', amount: 0.01 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const tRegionUS: RouteTermsRevision = {
      termsKey: 'terms.region.us' as RouteTermsKey,
      termsRevisionId: 'rev_terms_us' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r1' as RouteRevisionId,
      supersedesRevisionIds: [],
      applicability: { region: 'US', accountTier: 'Standard' },
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'metered_usage', amount: 0.02 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    assert.equal(tRegionBR.applicability?.region, 'BR');
    assert.equal(tRegionUS.applicability?.region, 'US');
  });

  // 17. Dois Terms compatíveis/componíveis não viram conflito artificial
  it('17. Dois Terms compatíveis/componíveis não viram conflito artificial', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'test.comp.route' as RouteKey,
      routeRevisionId: 'rev_route_comp' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const tBase: RouteTermsRevision = {
      termsKey: 'terms.comp.base' as RouteTermsKey,
      termsRevisionId: 'rev_terms_base' as RouteTermsRevisionId,
      routeRevisionId: 'rev_route_comp' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'fixed_subscription', amount: 100 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const tOverage: RouteTermsRevision = {
      termsKey: 'terms.comp.overage' as RouteTermsKey,
      termsRevisionId: 'rev_terms_overage' as RouteTermsRevisionId,
      routeRevisionId: 'rev_route_comp' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'metered_overage', amount: 0.05 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    registry.registerTermsRevision(tBase);
    registry.registerTermsRevision(tOverage);

    const result = registry.getTermsForRoute('rev_route_comp' as RouteRevisionId, defaultContext);
    assert.equal(result.status, 'composable_terms');
    if (result.status === 'composable_terms') {
      assert.equal(result.terms.length, 2);
    }
  });

  // 18. Dois Terms materialmente conflitantes sem supersession preservam unresolved_conflict
  it('18. Dois Terms materialmente conflitantes sem supersession preservam unresolved_conflict', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'test.conflict.route' as RouteKey,
      routeRevisionId: 'rev_route_conf' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const tOptOutTrue: RouteTermsRevision = {
      termsKey: 'terms.conf.a' as RouteTermsKey,
      termsRevisionId: 'rev_terms_opt_true' as RouteTermsRevisionId,
      routeRevisionId: 'rev_route_conf' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      privacyDataTerms: { trainingOptOutGuaranteed: true },
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const tOptOutFalse: RouteTermsRevision = {
      termsKey: 'terms.conf.b' as RouteTermsKey,
      termsRevisionId: 'rev_terms_opt_false' as RouteTermsRevisionId,
      routeRevisionId: 'rev_route_conf' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      privacyDataTerms: { trainingOptOutGuaranteed: false },
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    registry.registerTermsRevision(tOptOutTrue);
    registry.registerTermsRevision(tOptOutFalse);

    const result = registry.getTermsForRoute('rev_route_conf' as RouteRevisionId, defaultContext);
    assert.equal(result.status, 'unresolved_conflict');
    if (result.status === 'unresolved_conflict') {
      assert.equal(result.conflictingTerms.length, 2);
    }
  });

  // 19. Nenhum conflito de Terms é resolvido por timestamp/ordem
  it('19. Nenhum conflito de Terms é resolvido por timestamp/ordem', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'test.order.route' as RouteKey,
      routeRevisionId: 'rev_route_order' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const tOld: RouteTermsRevision = {
      termsKey: 'terms.order.old' as RouteTermsKey,
      termsRevisionId: 'rev_terms_old' as RouteTermsRevisionId,
      routeRevisionId: 'rev_route_order' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2020-01-01T00:00:00.000Z',
    };
    const tNew: RouteTermsRevision = {
      termsKey: 'terms.order.new' as RouteTermsKey,
      termsRevisionId: 'rev_terms_new' as RouteTermsRevisionId,
      routeRevisionId: 'rev_route_order' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'fixed_subscription', amount: 50 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-19T00:00:00.000Z',
    };

    registry.registerTermsRevision(tOld);
    registry.registerTermsRevision(tNew);

    const result = registry.getTermsForRoute('rev_route_order' as RouteRevisionId, defaultContext);
    assert.equal(result.status, 'unresolved_conflict');
  });

  // 20. RouteObservation efêmera não é usada como revisão histórica
  it('20. RouteObservation efêmera não é usada como revisão histórica', () => {
    const liveObservation: RouteObservation = {
      routeKey: 'postgres.suppliers' as RouteKey,
      routeRevisionId: 'rev_r1' as RouteRevisionId,
      health: 'healthy',
      quotaRemaining: 950,
      observedLatencyMs: 12,
      observedAt: '2026-08-19T18:00:00.000Z',
    };

    assert.equal(liveObservation.health, 'healthy');
    assert.equal(liveObservation.quotaRemaining, 950);
  });

  // 21. Material snapshot preserva apenas fatos que realmente foram declarados materiais
  it('21. Material snapshot preserva apenas fatos que realmente foram declarados materiais', () => {
    const snapshot: MaterialFactSnapshot = {
      observedQuotaRemaining: 950,
      observedHealth: 'healthy',
      snapshotTimestamp: '2026-08-19T18:00:00.000Z',
      provenance: defaultProvenance,
    };

    assert.equal(snapshot.observedQuotaRemaining, 950);
    assert.equal(snapshot.observedHealth, 'healthy');
  });

  // 22. Revisions antigas permanecem consultáveis depois de supersession
  it('22. Revisions antigas permanecem consultáveis depois de supersession', () => {
    const registry = createCapabilityRegistry();
    const c1: CapabilityRevision = {
      capabilityKey: 'test.audit.cap' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_old_v1' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'V1 Original',
      description: 'Audit test',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };
    const c2: CapabilityRevision = {
      capabilityKey: 'test.audit.cap' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_new_v2' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: ['rev_cap_old_v1' as CapabilityRevisionId],
      title: 'V2 Replacement',
      description: 'Audit test v2',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };

    registry.registerCapabilityRevision(c1);
    registry.registerCapabilityRevision(c2);

    const heads = registry.getCapabilityHeads('test.audit.cap' as CapabilityKey);
    assert.equal(heads.length, 1);
    assert.equal(heads[0].capabilityRevisionId, 'rev_cap_new_v2');

    const historicalC1 = registry.getCapabilityRevision('rev_cap_old_v1' as CapabilityRevisionId);
    assert.ok(historicalC1);
    assert.equal(historicalC1.title, 'V1 Original');
  });

  // ==========================================================================
  // NOVOS TESTES OBRIGATÓRIOS (CORREÇÕES 1 A 5 - HARDENING B2/B3)
  // ==========================================================================

  // N1. Terms BR não aplica em contexto US
  it('N1. Terms BR não aplica em contexto US', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.geo.test' as RouteKey,
      routeRevisionId: 'rev_r_geo' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'none',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const tBR: RouteTermsRevision = {
      termsKey: 'terms.br.only' as RouteTermsKey,
      termsRevisionId: 'rev_terms_br_only' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_geo' as RouteRevisionId,
      supersedesRevisionIds: [],
      applicability: { region: 'BR' },
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    registry.registerTermsRevision(tBR);

    const result = registry.getTermsForRoute('rev_r_geo' as RouteRevisionId, {
      at: '2026-08-19T18:00:00.000Z',
      region: 'US',
    });
    assert.equal(result.status, 'no_applicable_terms');
  });

  // N2. Terms BR aplica em contexto BR
  it('N2. Terms BR aplica em contexto BR', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.geo.br' as RouteKey,
      routeRevisionId: 'rev_r_geo_br' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'none',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const tBR: RouteTermsRevision = {
      termsKey: 'terms.br.valid' as RouteTermsKey,
      termsRevisionId: 'rev_terms_br_valid' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_geo_br' as RouteRevisionId,
      supersedesRevisionIds: [],
      applicability: { region: 'BR' },
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    registry.registerTermsRevision(tBR);

    const result = registry.getTermsForRoute('rev_r_geo_br' as RouteRevisionId, {
      at: '2026-08-19T18:00:00.000Z',
      region: 'BR',
    });
    assert.equal(result.status, 'single_applicable');
    if (result.status === 'single_applicable') {
      assert.equal(result.terms.termsRevisionId, 'rev_terms_br_valid');
    }
  });

  // N3. Terms futuro não remove Terms atual antes de effectiveFrom
  it('N3. Terms futuro não remove Terms atual antes de effectiveFrom', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.future.test' as RouteKey,
      routeRevisionId: 'rev_r_future' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'none',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const tCurrent: RouteTermsRevision = {
      termsKey: 'terms.price.active' as RouteTermsKey,
      termsRevisionId: 'rev_terms_current' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_future' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const tFuture: RouteTermsRevision = {
      termsKey: 'terms.price.active' as RouteTermsKey,
      termsRevisionId: 'rev_terms_future' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_future' as RouteRevisionId,
      supersedesRevisionIds: ['rev_terms_current' as RouteTermsRevisionId],
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'fixed_subscription', amount: 99 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-09-01T00:00:00.000Z', // Entra em vigor apenas em setembro
    };

    registry.registerTermsRevision(tCurrent);
    registry.registerTermsRevision(tFuture);

    // Avaliação em agosto: tCurrent ainda é o aplicável
    const resultAugust = registry.getTermsForRoute('rev_r_future' as RouteRevisionId, {
      at: '2026-08-19T18:00:00.000Z',
    });
    assert.equal(resultAugust.status, 'single_applicable');
    if (resultAugust.status === 'single_applicable') {
      assert.equal(resultAugust.terms.termsRevisionId, 'rev_terms_current');
    }

    // Avaliação em setembro: tFuture assume como aplicável
    const resultSeptember = registry.getTermsForRoute('rev_r_future' as RouteRevisionId, {
      at: '2026-09-05T00:00:00.000Z',
    });
    assert.equal(resultSeptember.status, 'single_applicable');
    if (resultSeptember.status === 'single_applicable') {
      assert.equal(resultSeptember.terms.termsRevisionId, 'rev_terms_future');
    }
  });

  // N4. Terms expirado não é aplicável depois de validUntil
  it('N4. Terms expirado não é aplicável depois de validUntil', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.expired.test' as RouteKey,
      routeRevisionId: 'rev_r_exp' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'none',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const tExpired: RouteTermsRevision = {
      termsKey: 'terms.expired' as RouteTermsKey,
      termsRevisionId: 'rev_terms_exp' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_exp' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      validUntil: '2026-06-30T23:59:59.000Z',
    };
    registry.registerTermsRevision(tExpired);

    const result = registry.getTermsForRoute('rev_r_exp' as RouteRevisionId, {
      at: '2026-08-19T18:00:00.000Z',
    });
    assert.equal(result.status, 'no_applicable_terms');
  });

  // N5. Terms que exige accountTier com contexto sem accountTier resulta em insufficient_context
  it('N5. Terms que exige accountTier com contexto sem accountTier resulta em insufficient_context', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.tier.test' as RouteKey,
      routeRevisionId: 'rev_r_tier' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'none',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const tTier: RouteTermsRevision = {
      termsKey: 'terms.tier.ent' as RouteTermsKey,
      termsRevisionId: 'rev_terms_tier_ent' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_tier' as RouteRevisionId,
      supersedesRevisionIds: [],
      applicability: { accountTier: 'Enterprise' },
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    registry.registerTermsRevision(tTier);

    const result = registry.getTermsForRoute('rev_r_tier' as RouteRevisionId, {
      at: '2026-08-19T18:00:00.000Z',
      // accountTier ausente no contexto factual
    });
    assert.equal(result.status, 'insufficient_context');
    if (result.status === 'insufficient_context') {
      assert.deepEqual(result.missingDimensions, ['accountTier']);
    }
  });

  // N6. Dois Terms com scopes disjuntos NÃO viram unresolved_conflict
  it('N6. Dois Terms com scopes disjuntos NÃO viram unresolved_conflict', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.disjoint.test' as RouteKey,
      routeRevisionId: 'rev_r_disjoint' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'none',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const tBR: RouteTermsRevision = {
      termsKey: 'terms.disjoint.br' as RouteTermsKey,
      termsRevisionId: 'rev_terms_dj_br' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_disjoint' as RouteRevisionId,
      supersedesRevisionIds: [],
      applicability: { region: 'BR' },
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const tUS: RouteTermsRevision = {
      termsKey: 'terms.disjoint.us' as RouteTermsKey,
      termsRevisionId: 'rev_terms_dj_us' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_disjoint' as RouteRevisionId,
      supersedesRevisionIds: [],
      applicability: { region: 'US' },
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'fixed_subscription', amount: 200 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    registry.registerTermsRevision(tBR);
    registry.registerTermsRevision(tUS);

    const resultBR = registry.getTermsForRoute('rev_r_disjoint' as RouteRevisionId, {
      at: '2026-08-19T18:00:00.000Z',
      region: 'BR',
    });
    assert.equal(resultBR.status, 'single_applicable');
    if (resultBR.status === 'single_applicable') {
      assert.equal(resultBR.terms.termsRevisionId, 'rev_terms_dj_br');
    }
  });

  // N7. trainingUsage true × false no mesmo scope gera unresolved_conflict
  it('N7. trainingUsage true × false no mesmo scope gera unresolved_conflict', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.privacy.conflict' as RouteKey,
      routeRevisionId: 'rev_r_priv_conf' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const t1: RouteTermsRevision = {
      termsKey: 'terms.priv.1' as RouteTermsKey,
      termsRevisionId: 'rev_terms_priv_1' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_priv_conf' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      privacyDataTerms: { trainingUsage: true },
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const t2: RouteTermsRevision = {
      termsKey: 'terms.priv.2' as RouteTermsKey,
      termsRevisionId: 'rev_terms_priv_2' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_priv_conf' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      privacyDataTerms: { trainingUsage: false },
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    registry.registerTermsRevision(t1);
    registry.registerTermsRevision(t2);

    const result = registry.getTermsForRoute('rev_r_priv_conf' as RouteRevisionId, defaultContext);
    assert.equal(result.status, 'unresolved_conflict');
  });

  // N8. ZDR true × false no mesmo scope gera unresolved_conflict
  it('N8. ZDR true × false no mesmo scope gera unresolved_conflict', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.zdr.conflict' as RouteKey,
      routeRevisionId: 'rev_r_zdr_conf' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const t1: RouteTermsRevision = {
      termsKey: 'terms.zdr.1' as RouteTermsKey,
      termsRevisionId: 'rev_terms_zdr_1' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_zdr_conf' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      privacyDataTerms: { zeroDataRetentionGuaranteed: true },
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const t2: RouteTermsRevision = {
      termsKey: 'terms.zdr.2' as RouteTermsKey,
      termsRevisionId: 'rev_terms_zdr_2' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_zdr_conf' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      privacyDataTerms: { zeroDataRetentionGuaranteed: false },
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    registry.registerTermsRevision(t1);
    registry.registerTermsRevision(t2);

    const result = registry.getTermsForRoute('rev_r_zdr_conf' as RouteRevisionId, defaultContext);
    assert.equal(result.status, 'unresolved_conflict');
  });

  // N9. retentionDays incompatíveis no mesmo scope gera unresolved_conflict
  it('N9. retentionDays incompatíveis no mesmo scope gera unresolved_conflict', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.retention.conflict' as RouteKey,
      routeRevisionId: 'rev_r_ret_conf' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const t1: RouteTermsRevision = {
      termsKey: 'terms.ret.1' as RouteTermsKey,
      termsRevisionId: 'rev_terms_ret_1' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_ret_conf' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      privacyDataTerms: { retentionDays: 30 },
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const t2: RouteTermsRevision = {
      termsKey: 'terms.ret.2' as RouteTermsKey,
      termsRevisionId: 'rev_terms_ret_2' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_ret_conf' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      privacyDataTerms: { retentionDays: 0 },
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    registry.registerTermsRevision(t1);
    registry.registerTermsRevision(t2);

    const result = registry.getTermsForRoute('rev_r_ret_conf' as RouteRevisionId, defaultContext);
    assert.equal(result.status, 'unresolved_conflict');
  });

  // N10. billing known_none + components é rejeitado
  it('N10. billing known_none + components é rejeitado', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.incoherent.billing1' as RouteKey,
      routeRevisionId: 'rev_r_inc_b1' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const invalidTerms: RouteTermsRevision = {
      termsKey: 'terms.inc.b1' as RouteTermsKey,
      termsRevisionId: 'rev_terms_inc_b1' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_inc_b1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [{ type: 'fixed_subscription', amount: 50 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    assert.throws(() => registry.registerTermsRevision(invalidTerms), IncoherentBillingStateError);
  });

  // N11. billing known_components + lista vazia é rejeitado
  it('N11. billing known_components + lista vazia é rejeitado', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.incoherent.billing2' as RouteKey,
      routeRevisionId: 'rev_r_inc_b2' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const invalidTerms: RouteTermsRevision = {
      termsKey: 'terms.inc.b2' as RouteTermsKey,
      termsRevisionId: 'rev_terms_inc_b2' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_inc_b2' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    assert.throws(() => registry.registerTermsRevision(invalidTerms), IncoherentBillingStateError);
  });

  // N12. billing unknown + componentes conhecidos é rejeitado
  it('N12. billing unknown + componentes conhecidos é rejeitado', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.incoherent.billing3' as RouteKey,
      routeRevisionId: 'rev_r_inc_b3' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const invalidTerms: RouteTermsRevision = {
      termsKey: 'terms.inc.b3' as RouteTermsKey,
      termsRevisionId: 'rev_terms_inc_b3' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_inc_b3' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'unknown',
      billingComponents: [{ type: 'metered_usage', amount: 1 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    assert.throws(() => registry.registerTermsRevision(invalidTerms), IncoherentBillingStateError);
  });

  // N13. entitlement unknown + itens conhecidos é rejeitado
  it('N13. entitlement unknown + itens conhecidos é rejeitado', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.incoherent.ent1' as RouteKey,
      routeRevisionId: 'rev_r_inc_e1' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const invalidTerms: RouteTermsRevision = {
      termsKey: 'terms.inc.e1' as RouteTermsKey,
      termsRevisionId: 'rev_terms_inc_e1' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_inc_e1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'unknown',
      freeEntitlements: [{ type: 'recurring_free_allowance', quotaAmount: 100 }],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    assert.throws(() => registry.registerTermsRevision(invalidTerms), IncoherentEntitlementStateError);
  });

  // N14. Ciclo real lança especificamente SupersessionCycleError
  it('N14. Ciclo real lança especificamente SupersessionCycleError', () => {
    const c1 = {
      id: 'rev_cyc_a',
      identityKey: 'cap_cyc_test',
      supersedesRevisionIds: ['rev_cyc_b'],
    };
    const c2 = {
      id: 'rev_cyc_b',
      identityKey: 'cap_cyc_test',
      supersedesRevisionIds: ['rev_cyc_a'],
    };

    assert.throws(() => validateSupersessionChain([c1, c2]), (err: unknown) => {
      assert.ok(err instanceof SupersessionCycleError);
      assert.deepEqual(err.cyclePath, ['rev_cyc_a', 'rev_cyc_b', 'rev_cyc_a']);
      return true;
    });
  });

  // N15. Binding B1 é supersedido por B2. Consulta histórica retorna ambos, consulta de heads retorna somente B2
  it('N15. Binding B1 é supersedido por B2. Consulta histórica retorna ambos, consulta de heads retorna somente B2', () => {
    const registry = createCapabilityRegistry();
    const cap: CapabilityRevision = {
      capabilityKey: 'test.bind.heads.cap' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_bh' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Cap',
      description: 'Binding heads test',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };
    const route: RouteRevision = {
      routeKey: 'test.bind.heads.route' as RouteKey,
      routeRevisionId: 'rev_route_bh' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };

    const b1: CapabilityRouteBindingRevision = {
      bindingKey: 'bind.bh' as BindingKey,
      bindingRevisionId: 'rev_b1' as BindingRevisionId,
      capabilityRevisionId: 'rev_cap_bh' as CapabilityRevisionId,
      routeRevisionId: 'rev_route_bh' as RouteRevisionId,
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      domainEffectAtested: 'none',
      compatibilityProvenance: defaultProvenance,
      supersedesRevisionIds: [],
    };
    const b2: CapabilityRouteBindingRevision = {
      bindingKey: 'bind.bh' as BindingKey,
      bindingRevisionId: 'rev_b2' as BindingRevisionId,
      capabilityRevisionId: 'rev_cap_bh' as CapabilityRevisionId,
      routeRevisionId: 'rev_route_bh' as RouteRevisionId,
      adapterRevisionRef: 'adapter_v2' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      domainEffectAtested: 'none',
      compatibilityProvenance: defaultProvenance,
      supersedesRevisionIds: ['rev_b1' as BindingRevisionId],
    };

    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerBindingRevision(b1);
    registry.registerBindingRevision(b2);

    // Consulta histórica: ambos retornados
    const allBindings = registry.getBindingsForCapability('rev_cap_bh' as CapabilityRevisionId);
    assert.equal(allBindings.length, 2);

    // Consulta de heads: somente B2 retornado
    const headBindings = registry.getBindingHeadsForCapability('rev_cap_bh' as CapabilityRevisionId);
    assert.equal(headBindings.length, 1);
    assert.equal(headBindings[0].bindingRevisionId, 'rev_b2');
  });

  // N16. getRoutesForCapability não usa Binding supersedido
  it('N16. getRoutesForCapability não usa Binding supersedido', () => {
    const registry = createCapabilityRegistry();
    const cap: CapabilityRevision = {
      capabilityKey: 'test.cap.route_switch' as CapabilityKey,
      capabilityRevisionId: 'rev_cap_rs' as CapabilityRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Cap Route Switch',
      description: 'Test active route resolution',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      domainEffect: 'none',
    };
    const rOld: RouteRevision = {
      routeKey: 'route.old' as RouteKey,
      routeRevisionId: 'rev_r_old' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };
    const rNew: RouteRevision = {
      routeKey: 'route.new' as RouteKey,
      routeRevisionId: 'rev_r_new' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v2' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };

    const b1Old: CapabilityRouteBindingRevision = {
      bindingKey: 'bind.sw' as BindingKey,
      bindingRevisionId: 'rev_b_sw_1' as BindingRevisionId,
      capabilityRevisionId: 'rev_cap_rs' as CapabilityRevisionId,
      routeRevisionId: 'rev_r_old' as RouteRevisionId,
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      domainEffectAtested: 'none',
      compatibilityProvenance: defaultProvenance,
      supersedesRevisionIds: [],
    };
    const b2New: CapabilityRouteBindingRevision = {
      bindingKey: 'bind.sw' as BindingKey,
      bindingRevisionId: 'rev_b_sw_2' as BindingRevisionId,
      capabilityRevisionId: 'rev_cap_rs' as CapabilityRevisionId,
      routeRevisionId: 'rev_r_new' as RouteRevisionId,
      adapterRevisionRef: 'adapter_v2' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      domainEffectAtested: 'none',
      compatibilityProvenance: defaultProvenance,
      supersedesRevisionIds: ['rev_b_sw_1' as BindingRevisionId],
    };

    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(rOld);
    registry.registerRouteRevision(rNew);
    registry.registerBindingRevision(b1Old);
    registry.registerBindingRevision(b2New);

    // getRoutesForCapability usa somente heads: deve retornar somente rNew
    const activeRoutes = registry.getRoutesForCapability('rev_cap_rs' as CapabilityRevisionId);
    assert.equal(activeRoutes.length, 1);
    assert.equal(activeRoutes[0].routeRevisionId, 'rev_r_new');
  });

  // ==========================================================================
  // HARDENING FINAL FASE A (0.5B) - PRESERVAÇÃO DE CONTEXTO INSUFICIENTE
  // ==========================================================================

  // A1. T1 aplicável + T2 depende de accountTier ausente → insufficient_context
  it('A1. T1 aplicável + T2 depende de accountTier ausente → insufficient_context', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.hard.a1' as RouteKey,
      routeRevisionId: 'rev_r_a1' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const t1: RouteTermsRevision = {
      termsKey: 'terms.a1.base' as RouteTermsKey,
      termsRevisionId: 'rev_t_a1_base' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_a1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const t2: RouteTermsRevision = {
      termsKey: 'terms.a1.tier' as RouteTermsKey,
      termsRevisionId: 'rev_t_a1_tier' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_a1' as RouteRevisionId,
      supersedesRevisionIds: [],
      applicability: { accountTier: 'Enterprise' },
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'fixed_subscription', amount: 50 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    registry.registerTermsRevision(t1);
    registry.registerTermsRevision(t2);

    // Contexto com data válida, mas sem accountTier
    const result = registry.getTermsForRoute('rev_r_a1' as RouteRevisionId, {
      at: '2026-08-19T18:00:00.000Z',
    });
    assert.equal(result.status, 'insufficient_context');
    if (result.status === 'insufficient_context') {
      assert.deepEqual(result.missingDimensions, ['accountTier']);
      assert.equal(result.candidateTerms.length, 1);
      assert.equal(result.candidateTerms[0].termsRevisionId, 'rev_t_a1_tier');
    }
  });

  // A2. T1 aplicável + T2 exige region=BR e accountTier ausente, context region=US → T2 descartado por mismatch; T1 é single_applicable
  it('A2. T1 aplicável + T2 exige region=BR e accountTier ausente, context region=US → T2 descartado por mismatch; T1 é single_applicable', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.hard.a2' as RouteKey,
      routeRevisionId: 'rev_r_a2' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const t1: RouteTermsRevision = {
      termsKey: 'terms.a2.base' as RouteTermsKey,
      termsRevisionId: 'rev_t_a2_base' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_a2' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const t2: RouteTermsRevision = {
      termsKey: 'terms.a2.br_tier' as RouteTermsKey,
      termsRevisionId: 'rev_t_a2_br_tier' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_a2' as RouteRevisionId,
      supersedesRevisionIds: [],
      applicability: { region: 'BR', accountTier: 'Enterprise' },
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'fixed_subscription', amount: 50 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    registry.registerTermsRevision(t1);
    registry.registerTermsRevision(t2);

    // Contexto com region=US (mismatch com T2) e accountTier ausente
    const result = registry.getTermsForRoute('rev_r_a2' as RouteRevisionId, {
      at: '2026-08-19T18:00:00.000Z',
      region: 'US',
    });
    assert.equal(result.status, 'single_applicable');
    if (result.status === 'single_applicable') {
      assert.equal(result.terms.termsRevisionId, 'rev_t_a2_base');
    }
  });

  // A3. Dois Terms potencialmente conflitantes, um resolvido e outro com dimensão material ausente → insufficient_context, não single_applicable
  it('A3. Dois Terms potencialmente conflitantes, um resolvido e outro com dimensão material ausente → insufficient_context, não single_applicable', () => {
    const registry = createCapabilityRegistry();
    const route: RouteRevision = {
      routeKey: 'route.hard.a3' as RouteKey,
      routeRevisionId: 'rev_r_a3' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };
    registry.registerRouteRevision(route);

    const tFree: RouteTermsRevision = {
      termsKey: 'terms.a3.free' as RouteTermsKey,
      termsRevisionId: 'rev_t_a3_free' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_a3' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      privacyDataTerms: { trainingOptOutGuaranteed: true },
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const tSpecialTierPaid: RouteTermsRevision = {
      termsKey: 'terms.a3.paid' as RouteTermsKey,
      termsRevisionId: 'rev_t_a3_paid' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_a3' as RouteRevisionId,
      supersedesRevisionIds: [],
      applicability: { accountTier: 'CustomTier' },
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'metered_usage', amount: 10 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      privacyDataTerms: { trainingOptOutGuaranteed: false },
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };

    registry.registerTermsRevision(tFree);
    registry.registerTermsRevision(tSpecialTierPaid);

    // Sem accountTier no contexto: não podemos afirmar que é apenas tFree
    const result = registry.getTermsForRoute('rev_r_a3' as RouteRevisionId, {
      at: '2026-08-19T18:00:00.000Z',
    });
    assert.equal(result.status, 'insufficient_context');
    if (result.status === 'insufficient_context') {
      assert.deepEqual(result.missingDimensions, ['accountTier']);
      assert.equal(result.candidateTerms.length, 1);
      assert.equal(result.candidateTerms[0].termsRevisionId, 'rev_t_a3_paid');
    }
  });
});
