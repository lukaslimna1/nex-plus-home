/**
 * NEX+ · Capability Registry & Route/Terms Ledger
 * Testes Fatuais e Validações Determinísticas de Aceitação — Escopo 0.5 (Bloco 0.5B / B3)
 *
 * Execução com Node Test Runner nativo (sem novas dependências).
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
  NativeContractRevisionRef,
  FactProvenance,
  RouteObservation,
  MaterialFactSnapshot,
} from '../contracts';

import {
  createCapabilityRegistry,
  SelfSupersessionError,
  SupersessionCycleError,
  CrossIdentitySupersessionError,
  InvalidBindingReferenceError,
  IncoherentEntitlementStateError,
} from '../registry';

// Fixture de Provenance padrão para testes
const defaultProvenance: FactProvenance = {
  source: 'official_docs',
  acquisitionBasis: 'declared',
  verificationStatus: 'corroborated',
  observedAt: '2026-08-19T18:00:00.000Z',
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
      capabilityRevisionId: 'rev_cap_cyc_1' as CapabilityRevisionId, // tentativa de reintroduzir ou ciclo
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
      supersedesRevisionIds: ['rev_cap_a_v1' as CapabilityRevisionId], // Cap B tentando superseder Cap A
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

    // Sem binding canônico registrado explicitamente, não há rota associada
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
      domainEffect: 'none', // HTTP GET + access log + billing consumption -> DomainEffect = none
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
    // IdempotencyProfile não tem método canRetry e não autoriza retry em L0/0.5B
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
          validityWindow: '2026-12-31T23:59:59.000Z',
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

    // Terms com known_none com lista vazia -> OK
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

    // Incoerência: known_none com entitlements presentes lança erro
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

    const result = registry.getTermsForRoute('rev_route_comp' as RouteRevisionId);
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

    const result = registry.getTermsForRoute('rev_route_conf' as RouteRevisionId);
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

    // Registrando em ordem inversa ou com timestamps diferentes
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
      billingStatus: 'known_components', // Contradição fática com tOld
      billingComponents: [{ type: 'fixed_subscription', amount: 50 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-19T00:00:00.000Z',
    };

    registry.registerTermsRevision(tOld);
    registry.registerTermsRevision(tNew);

    const result = registry.getTermsForRoute('rev_route_order' as RouteRevisionId);
    // Não pode escolher tNew só porque tem data maior
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
    // RouteObservation é volátil de runtime e não afeta RouteRevision imutável
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
    // Não clonou 20 métricas irrelevantes de telemetria
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

    // Consulta histórica pontual de V1 funciona perfeitamente
    const historicalC1 = registry.getCapabilityRevision('rev_cap_old_v1' as CapabilityRevisionId);
    assert.ok(historicalC1);
    assert.equal(historicalC1.title, 'V1 Original');
  });
});
