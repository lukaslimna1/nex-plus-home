/**
 * NEX+ · Authority, Policy & Red-Team Acceptance Matrix
 * Testes Unitários de Autoridade e Red-Team — Escopo 0.85D (Checkpoint 2 · Passagem 2)
 *
 * Cobertura: AUTH-1..AUTH-9, RT-1..RT-3, RT-8..RT-10
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CapabilityKey,
  CapabilityRevision,
  CapabilityRevisionId,
  CapabilityRouteBindingRevision,
  BindingRevisionId,
  RouteKey,
  RouteRevision,
  RouteRevisionId,
  RouteTermsKey,
  RouteTermsRevision,
  RouteTermsRevisionId,
  TermsResolutionContext,
  FactProvenance,
  AdapterRevisionRef,
} from '../../capabilities/contracts';

import { createCapabilityRegistry } from '../../capabilities/registry';

import type {
  PolicyKey,
  PolicyRevision,
  PolicyRevisionId,
} from '../../policy/contracts';

import type {
  AttemptId,
  AttemptState,
  DecisionId,
  OutcomeAssessment,
} from '../../execution/contracts';

import type {
  AuthorizationDecisionId,
  DecisionMaterialContextId,
  RouteRuntimeFacts,
} from '../contracts';

import { evaluateDecision } from '../selection';
import {
  assessContinuationAfterAttempt,
  buildAttemptCreatedEvent,
} from '../continuation';
import {
  createDispatchAdmissionAuthority,
  defaultDispatchAdmissionAuthority,
  DispatchAdmissionNotFoundError,
  DispatchAdmissionConflictError,
} from '../admission-authority';

// ============================================================================
// HELPERS DE TESTE (CONTRATOS CANÔNICOS DE L0)
// ============================================================================

const defaultProvenance: FactProvenance = {
  source: 'direct_observation',
  acquisitionBasis: 'observed',
  verificationStatus: 'empirically_verified',
  observedAt: '2026-08-19T18:50:00.000Z',
};

const defaultTermsContext: TermsResolutionContext = {
  at: '2026-08-19T18:50:00.000Z',
};

const defaultPolicy: PolicyRevision = {
  policyKey: 'policy.standard' as PolicyKey,
  policyRevisionId: 'rev_pol_std' as PolicyRevisionId,
  supersedesRevisionIds: [],
  defaultSensitivity: 'NORMAL',
  zeroCostRequired: true,
};

function createMockCapability(
  key: string,
  id: string,
  lifecycle: 'active' | 'deprecated' | 'retired' = 'active',
  domainEffect: 'none' | 'may_mutate_domain' = 'none',
): CapabilityRevision {
  return {
    capabilityKey: key as CapabilityKey,
    capabilityRevisionId: id as CapabilityRevisionId,
    lifecycle,
    supersedesRevisionIds: [],
    title: key,
    description: `Description of ${key}`,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    domainEffect,
  };
}

function createMockRoute(
  key: string,
  id: string,
  lifecycle: 'active' | 'deprecated' | 'retired' = 'active',
  overrides?: Partial<RouteRevision>,
): RouteRevision {
  return {
    routeKey: key as RouteKey,
    routeRevisionId: id as RouteRevisionId,
    lifecycle,
    supersedesRevisionIds: [],
    adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
    supportedExecutionModes: ['atomic_batch'],
    idempotencyProfile: { supportType: 'none' },
    networkTopologyScopes: ['loopback'],
    controlOwnership: 'operator_managed',
    externalServiceNature: 'none',
    crossesEgressBoundary: false,
    domainEffect: 'none',
    ...overrides,
  };
}

function createMockBinding(
  bindingKey: string,
  bindingRevisionId: string,
  capabilityRevisionId: CapabilityRevisionId,
  routeRevisionId: RouteRevisionId,
  supersedesRevisionIds: readonly BindingRevisionId[] = [],
): CapabilityRouteBindingRevision {
  return {
    bindingKey: bindingKey as any,
    bindingRevisionId: bindingRevisionId as BindingRevisionId,
    capabilityRevisionId,
    routeRevisionId,
    adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
    supportedExecutionModes: ['atomic_batch'],
    domainEffectAtested: 'none',
    compatibilityProvenance: defaultProvenance,
    supersedesRevisionIds,
  };
}

function createMockTerms(
  termsKey: string,
  id: string,
  routeRevisionId: RouteRevisionId,
  overrides?: Partial<RouteTermsRevision>,
): RouteTermsRevision {
  return {
    termsKey: termsKey as RouteTermsKey,
    termsRevisionId: id as RouteTermsRevisionId,
    routeRevisionId,
    supersedesRevisionIds: [],
    provenance: defaultProvenance,
    billingStatus: 'known_none',
    billingComponents: [],
    freeEntitlementStatus: 'known_none',
    freeEntitlements: [],
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('NEX+ · Escopo 0.85D · Matriz de Aceitação de Autoridade & Red-Team (L0 Evaluation)', () => {
  beforeEach(() => {
    defaultDispatchAdmissionAuthority.clear();
  });

  // ==========================================================================
  // 1. GATES DE AUTORIDADE (AUTH-1 .. AUTH-9)
  // ==========================================================================

  it('AUTH-1: external.write sem capability registrada não gera Attempt nem admission', () => {
    const registry = createCapabilityRegistry();
    const result = evaluateDecision({
      decisionId: 'dec_auth_1' as DecisionId,
      materialContextId: 'ctx_auth_1' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: 'external.write' as CapabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'clarification_required');
    assert.equal(result.reasonCode, 'CAPABILITY_NOT_REGISTERED');
    assert.equal(result.evaluations.length, 0);
    assert.equal(result.admission, undefined);
  });

  it('AUTH-2: external.write com authorizationRequired=true e sem authorization resulta em awaiting_human e zero Attempt', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1', 'active', {
      crossesEgressBoundary: true,
      controlOwnership: 'third_party',
      externalServiceNature: 'non_ai_third_party',
      networkTopologyScopes: ['wan'],
    });
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_auth_2' as DecisionId,
      materialContextId: 'ctx_auth_2' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: 'external.write',
        resourceTarget: 'provider:resource:123',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'AUTHORIZATION_REQUIRED');
    assert.equal(result.admission, undefined);
  });

  it('AUTH-3: external.write com authorization.verdict=denied resulta em authorization_denied', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_auth_3' as DecisionId,
      materialContextId: 'ctx_auth_3' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: 'external.write',
      },
      authorization: {
        authorizationId: 'auth_dec_denied' as AuthorizationDecisionId,
        materialContextId: 'ctx_auth_3' as DecisionMaterialContextId,
        actorRef: 'operator_human_01',
        operation: 'external.write',
        verdict: 'denied',
        reasonCode: 'EXPLICIT_HUMAN_REJECTION',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'authorization_denied');
    assert.equal(result.reasonCode, 'EXPLICIT_HUMAN_REJECTION');
    assert.equal(result.admission, undefined);
  });

  it('AUTH-4: external.write com authorization.verdict=pending resulta em awaiting_human', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_auth_4' as DecisionId,
      materialContextId: 'ctx_auth_4' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: 'external.write',
      },
      authorization: {
        authorizationId: 'auth_dec_pend' as AuthorizationDecisionId,
        materialContextId: 'ctx_auth_4' as DecisionMaterialContextId,
        actorRef: 'operator_human_01',
        operation: 'external.write',
        verdict: 'pending',
        reasonCode: 'AWAITING_SUPERVISOR_APPROVAL',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'AUTHORIZATION_PENDING');
    assert.equal(result.admission, undefined);
  });

  it('AUTH-5: Context mismatch na autorização é rejeitado fail-closed', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_auth_5' as DecisionId,
      materialContextId: 'ctx_alpha' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: 'external.write',
      },
      authorization: {
        authorizationId: 'auth_dec_other' as AuthorizationDecisionId,
        materialContextId: 'ctx_beta' as DecisionMaterialContextId, // Diferente de ctx_alpha
        actorRef: 'operator_human_01',
        operation: 'external.write',
        verdict: 'authorized',
        reasonCode: 'AUTHORIZED_OK',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'AUTHORIZATION_CONTEXT_MISMATCH');
    assert.equal(result.admission, undefined);
  });

  it('AUTH-6: Operation mismatch na autorização é rejeitado fail-closed', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_auth_6' as DecisionId,
      materialContextId: 'ctx_auth_6' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: 'external.write', // Requer write
      },
      authorization: {
        authorizationId: 'auth_read_only' as AuthorizationDecisionId,
        materialContextId: 'ctx_auth_6' as DecisionMaterialContextId,
        actorRef: 'operator_human_01',
        operation: 'external.read', // Autorizou apenas read
        verdict: 'authorized',
        reasonCode: 'AUTHORIZED_READ',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'AUTHORIZATION_OPERATION_MISMATCH');
    assert.equal(result.admission, undefined);
  });

  it('AUTH-7: ResourceTarget mismatch na autorização é rejeitado fail-closed', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_auth_7' as DecisionId,
      materialContextId: 'ctx_auth_7' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: 'external.write',
        resourceTarget: 'provider:test-resource:123',
      },
      authorization: {
        authorizationId: 'auth_target_999' as AuthorizationDecisionId,
        materialContextId: 'ctx_auth_7' as DecisionMaterialContextId,
        actorRef: 'operator_human_01',
        operation: 'external.write',
        resourceTarget: 'provider:test-resource:999', // Divergente do alvo requerido 123
        verdict: 'authorized',
        reasonCode: 'AUTHORIZED_999',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'AUTHORIZATION_RESOURCE_MISMATCH');
    assert.equal(result.admission, undefined);
  });

  it('AUTH-8: Autorização válida com escopo e contexto exatos seleciona rota e gera DispatchAdmission', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_auth_8' as DecisionId,
      materialContextId: 'ctx_auth_8' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: 'external.write',
        resourceTarget: 'provider:test-resource:123',
      },
      authorization: {
        authorizationId: 'auth_valid_01' as AuthorizationDecisionId,
        materialContextId: 'ctx_auth_8' as DecisionMaterialContextId,
        actorRef: 'operator_human_01',
        operation: 'external.write',
        resourceTarget: 'provider:test-resource:123',
        verdict: 'authorized',
        reasonCode: 'AUTHORIZED_EXACT_SCOPE',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'route_selected');
    assert.equal(result.reasonCode, 'ROUTE_SELECTED');
    assert.ok(result.admission);
    assert.equal(result.admission.authorizationDecisionId, 'auth_valid_01' as AuthorizationDecisionId);

    // Constrói o AttemptCreatedEvent
    const attemptEvent = buildAttemptCreatedEvent({
      admissionId: result.admission.admissionId,
      attemptId: 'att_auth_8' as AttemptId,
      createdAt: '2026-08-22T18:00:01.000Z',
      currentMaterialContextId: 'ctx_auth_8' as DecisionMaterialContextId,
      effectiveOperation: 'external.write',
      effectiveResourceTarget: 'provider:test-resource:123',
    });

    assert.equal(attemptEvent.attemptId, 'att_auth_8');
    assert.equal(attemptEvent.decisionId, 'dec_auth_8');
    assert.equal(attemptEvent.capabilityRevisionId, cap.capabilityRevisionId);
  });

  it('AUTH-9: Autorização humana autorizada NÃO substitui negação de Egress por Policy', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const routeExternal = createMockRoute('route.ext.cloud', 'route_ext_cloud_rev1', 'active', {
      crossesEgressBoundary: true,
      controlOwnership: 'third_party',
      externalServiceNature: 'non_ai_third_party',
      networkTopologyScopes: ['wan'],
    });
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(routeExternal);
    registry.registerTermsRevision(createMockTerms('terms.ext.cloud', 'terms_ext_cloud_rev1', routeExternal.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.cloud', 'bind_ext_cloud_rev1', cap.capabilityRevisionId, routeExternal.routeRevisionId));

    // Policy restringe a LOCAL_ONLY
    const localPolicy: PolicyRevision = {
      ...defaultPolicy,
      defaultSensitivity: 'LOCAL_ONLY',
    };

    const result = evaluateDecision({
      decisionId: 'dec_auth_9' as DecisionId,
      materialContextId: 'ctx_auth_9' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: localPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: 'external.write',
      },
      authorization: {
        authorizationId: 'auth_valid_01' as AuthorizationDecisionId,
        materialContextId: 'ctx_auth_9' as DecisionMaterialContextId,
        actorRef: 'operator_human_01',
        operation: 'external.write',
        verdict: 'authorized',
        reasonCode: 'AUTHORIZED_OK',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'policy_denied');
    assert.equal(result.admission, undefined);
    assert.equal(result.evaluations[0].status, 'ineligible');
    assert.ok(result.evaluations[0].reasonCodes.some((r) => r.startsWith('EGRESS_')));
  });

  // ==========================================================================
  // 2. RED-TEAM: INTERPRETAÇÃO & RUNTIME FACTS (RT-1 .. RT-3)
  // ==========================================================================

  it('RT-1: Prompt com mutação ambígua resulta em clarification_required e zero Attempt', () => {
    const registry = createCapabilityRegistry();
    const result = evaluateDecision({
      decisionId: 'dec_rt_1' as DecisionId,
      materialContextId: 'ctx_rt_1' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'ambiguous',
        potentiallyMutating: true,
        capabilityKey: 'domain.action' as CapabilityKey,
        reason: 'User instruction does not clearly specify the target record to update.',
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'clarification_required');
    assert.equal(result.reasonCode, 'INTERPRETATION_AMBIGUOUS');
    assert.equal(result.evaluations.length, 0);
    assert.equal(result.admission, undefined);
  });

  it('RT-2: Instruções conflitantes modeladas como interpretação ambígua suspendem sem mutação', () => {
    const registry = createCapabilityRegistry();
    const result = evaluateDecision({
      decisionId: 'dec_rt_2' as DecisionId,
      materialContextId: 'ctx_rt_2' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'ambiguous',
        potentiallyMutating: true,
        capabilityKey: 'domain.action' as CapabilityKey,
        reason: 'Conflicting instructions: "update the resource, but do not change any fields".',
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'clarification_required');
    assert.equal(result.reasonCode, 'INTERPRETATION_AMBIGUOUS');
    assert.equal(result.admission, undefined);
  });

  it('RT-3: RouteRuntimeFacts com freshness=stale tornam a rota inelegível sem admissão', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_text_rev1');
    const route = createMockRoute('route.text.local', 'route_text_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.text', 'terms_text_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.text', 'bind_text_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const staleRuntimeFacts: RouteRuntimeFacts = {
      routeRevisionId: route.routeRevisionId,
      availability: 'available',
      health: 'healthy',
      cooldown: 'clear',
      freshness: 'stale', // Stale!
      observedAt: '2026-08-22T17:00:00.000Z',
      provenance: {
        source: 'telemetry_agent',
        acquisitionBasis: 'measured',
        verificationStatus: 'empirically_verified',
        observedAt: '2026-08-22T17:00:00.000Z',
      },
    };

    const runtimeFactsMap = new Map<RouteRevisionId, RouteRuntimeFacts>([
      [route.routeRevisionId, staleRuntimeFacts],
    ]);

    const result = evaluateDecision({
      decisionId: 'dec_rt_3' as DecisionId,
      materialContextId: 'ctx_rt_3' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: false,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      runtimeFactsMap,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'no_eligible_route');
    assert.equal(result.reasonCode, 'NO_ELIGIBLE_ROUTE');
    assert.equal(result.evaluations[0].status, 'ineligible');
    assert.ok(result.evaluations[0].reasonCodes.includes('RUNTIME_FACTS_STALE'));
    assert.equal(result.admission, undefined);
  });

  // ==========================================================================
  // 3. RED-TEAM: SUSPENSÃO, RETOMADA & DESFECHOS INDETERMINADOS (RT-8 .. RT-10)
  // ==========================================================================

  it('RT-8: Suspensão em T0 não cria tentativa; Retomada em T1 com autorização gera o primeiro Attempt', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const materialContextId = 'ctx_flow_01' as DecisionMaterialContextId;
    let attemptsCount = 0;

    // T0: Decisão avaliada sem autorização necessária
    const t0Result = evaluateDecision({
      decisionId: 'dec_flow_01' as DecisionId,
      materialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: { operation: 'external.write' },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(t0Result.disposition, 'awaiting_human');
    assert.equal(t0Result.admission, undefined);
    assert.equal(attemptsCount, 0); // Zero attempts em T0

    // T1: Chega autorização válida para o mesmo materialContextId
    const t1Result = evaluateDecision({
      decisionId: 'dec_flow_01' as DecisionId,
      materialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: { operation: 'external.write' },
      authorization: {
        authorizationId: 'auth_t1' as AuthorizationDecisionId,
        materialContextId,
        actorRef: 'operator_01',
        operation: 'external.write',
        verdict: 'authorized',
        reasonCode: 'OK',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:05:00.000Z',
    });

    assert.equal(t1Result.disposition, 'route_selected');
    assert.ok(t1Result.admission);

    // Agora gera exatamente o primeiro Attempt
    const attemptEvent = buildAttemptCreatedEvent({
      admissionId: t1Result.admission.admissionId,
      attemptId: 'att_01' as AttemptId,
      createdAt: '2026-08-22T18:05:01.000Z',
      currentMaterialContextId: materialContextId,
      effectiveOperation: 'external.write',
    });
    attemptsCount++;

    assert.equal(attemptsCount, 1);
    assert.equal(attemptEvent.attemptId, 'att_01');
  });

  it('RT-9: DispatchAdmission usado com contexto material alterado é rejeitado exigindo re-avaliação', () => {
    const admission = defaultDispatchAdmissionAuthority.registerAdmission({
      admissionId: 'adm_rt_9' as any,
      decisionId: 'dec_01' as any,
      materialContextId: 'ctx_original' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as any,
      capabilityRevisionId: 'cap_01' as any,
      bindingRevisionId: 'bind_01' as any,
      routeRevisionId: 'route_01' as any,
      policyRevisionId: 'pol_01' as any,
      admittedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.throws(
      () => {
        buildAttemptCreatedEvent({
          admissionId: admission.admissionId,
          attemptId: 'att_01' as AttemptId,
          createdAt: '2026-08-22T18:00:01.000Z',
          currentMaterialContextId: 'ctx_mutated_drift' as DecisionMaterialContextId, // Contexto alterado
        });
      },
      (err: any) => {
        assert.ok(err.message.includes('DispatchAdmission material context mismatch'));
        return true;
      },
    );
  });

  it('RT-10: Desfecho mutativo indeterminado proíbe retry automático e exige escalonamento humano', () => {
    const attempt: AttemptState = {
      attemptId: 'att_mut_1' as AttemptId,
      decisionId: 'dec_mut_1' as DecisionId,
      routeEvaluationId: 'eval_01' as any,
      capabilityRevisionId: 'cap_01' as any,
      bindingRevisionId: 'bind_01' as any,
      routeRevisionId: 'route_01' as any,
      policyRevisionId: 'pol_01' as any,
      status: 'failed',
      createdAt: '2026-08-22T18:00:00.000Z',
      finishedAt: '2026-08-22T18:00:05.000Z',
    };

    const assessment: OutcomeAssessment = {
      assessmentId: 'ass_01' as any,
      attemptId: attempt.attemptId,
      evidenceRefs: [],
      verdict: 'indeterminate',
      reasonCode: 'NETWORK_TIMEOUT_POST_DISPATCH',
      assessedAt: '2026-08-22T18:00:06.000Z',
    };

    const result = assessContinuationAfterAttempt({
      decisionId: attempt.decisionId,
      materialContextId: 'ctx_mut_1' as DecisionMaterialContextId,
      attempt,
      assessment,
      isDomainMutating: true, // Mutativa!
      assessedAt: '2026-08-22T18:00:06.000Z',
    });

    assert.equal(result.directive, 'human_escalation_required');
    assert.equal(result.reasonCode, 'INDETERMINATE_MUTATION_REQUIRES_HUMAN');
    assert.ok(result.escalation);
    assert.equal(result.escalation.kind, 'indeterminate_mutation');
  });

  // ==========================================================================
  // 4. BLOCKER I: VALIDAÇÃO DE WHITESPACE EM OPERATION (I1 .. I5)
  // ==========================================================================

  it('I1: operation vazia ("") é rejeitada fail-closed com AUTHORIZATION_SCOPE_REQUIRED', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_i1' as DecisionId,
      materialContextId: 'ctx_i1' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: '', // String vazia!
      },
      authorization: {
        authorizationId: 'auth_i1' as AuthorizationDecisionId,
        materialContextId: 'ctx_i1' as DecisionMaterialContextId,
        actorRef: 'operator_01',
        operation: '',
        verdict: 'authorized',
        reasonCode: 'OK',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'AUTHORIZATION_SCOPE_REQUIRED');
    assert.equal(result.admission, undefined);
  });

  it('I2: operation com somente espaços ("   ") é rejeitada fail-closed com AUTHORIZATION_SCOPE_REQUIRED', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_i2' as DecisionId,
      materialContextId: 'ctx_i2' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: '   ', // Apenas whitespace!
      },
      authorization: {
        authorizationId: 'auth_i2' as AuthorizationDecisionId,
        materialContextId: 'ctx_i2' as DecisionMaterialContextId,
        actorRef: 'operator_01',
        operation: '   ',
        verdict: 'authorized',
        reasonCode: 'OK',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'AUTHORIZATION_SCOPE_REQUIRED');
    assert.equal(result.admission, undefined);
  });

  it('I3: operation com whitespace no início (" external.write") é rejeitada fail-closed', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_i3' as DecisionId,
      materialContextId: 'ctx_i3' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: ' external.write', // Leading whitespace!
      },
      authorization: {
        authorizationId: 'auth_i3' as AuthorizationDecisionId,
        materialContextId: 'ctx_i3' as DecisionMaterialContextId,
        actorRef: 'operator_01',
        operation: ' external.write',
        verdict: 'authorized',
        reasonCode: 'OK',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'AUTHORIZATION_SCOPE_REQUIRED');
    assert.equal(result.admission, undefined);
  });

  it('I4: operation com whitespace no final ("external.write ") é rejeitada fail-closed', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_i4' as DecisionId,
      materialContextId: 'ctx_i4' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: 'external.write ', // Trailing whitespace!
      },
      authorization: {
        authorizationId: 'auth_i4' as AuthorizationDecisionId,
        materialContextId: 'ctx_i4' as DecisionMaterialContextId,
        actorRef: 'operator_01',
        operation: 'external.write ',
        verdict: 'authorized',
        reasonCode: 'OK',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'AUTHORIZATION_SCOPE_REQUIRED');
    assert.equal(result.admission, undefined);
  });

  it('I5: operation válida e sem whitespace ("external.write") é aceita gerando DispatchAdmission', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_i5' as DecisionId,
      materialContextId: 'ctx_i5' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: 'external.write', // Válida!
      },
      authorization: {
        authorizationId: 'auth_i5' as AuthorizationDecisionId,
        materialContextId: 'ctx_i5' as DecisionMaterialContextId,
        actorRef: 'operator_01',
        operation: 'external.write',
        verdict: 'authorized',
        reasonCode: 'OK',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'route_selected');
    assert.equal(result.reasonCode, 'ROUTE_SELECTED');
    assert.ok(result.admission);
    assert.equal(result.admission.authorizationScope?.operation, 'external.write');
  });

  // ==========================================================================
  // 5. BLOCKER J: AUTORIDADE RUNTIME E IMUTABILIDADE DE DISPATCH ADMISSION (J1 .. J8)
  // ==========================================================================

  it('J1: Happy path: admission autorizada registrada + context + operation + target corretos cria Attempt', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_j1' as DecisionId,
      materialContextId: 'ctx_j1' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: 'external.write',
        resourceTarget: 'provider:item:123',
      },
      authorization: {
        authorizationId: 'auth_j1' as AuthorizationDecisionId,
        materialContextId: 'ctx_j1' as DecisionMaterialContextId,
        actorRef: 'operator_01',
        operation: 'external.write',
        resourceTarget: 'provider:item:123',
        verdict: 'authorized',
        reasonCode: 'OK',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.equal(result.disposition, 'route_selected');
    assert.ok(result.admission);

    const attempt = buildAttemptCreatedEvent({
      admissionId: result.admission.admissionId,
      attemptId: 'att_j1' as AttemptId,
      createdAt: '2026-08-22T18:00:01.000Z',
      currentMaterialContextId: 'ctx_j1' as DecisionMaterialContextId,
      effectiveOperation: 'external.write',
      effectiveResourceTarget: 'provider:item:123',
    });

    assert.equal(attempt.attemptId, 'att_j1');
    assert.equal(attempt.decisionId, 'dec_j1');
    assert.equal(attempt.routeRevisionId, route.routeRevisionId);
  });

  it('J2: Admission desconhecida na autoridade runtime é rejeitada com DispatchAdmissionNotFoundError', () => {
    assert.throws(
      () => {
        buildAttemptCreatedEvent({
          admissionId: 'adm_unregistered_unknown' as any,
          attemptId: 'att_j2' as AttemptId,
          createdAt: '2026-08-22T18:00:01.000Z',
          currentMaterialContextId: 'ctx_j2' as DecisionMaterialContextId,
        });
      },
      (err: any) => {
        assert.ok(err instanceof DispatchAdmissionNotFoundError);
        assert.equal(err.code, 'DISPATCH_ADMISSION_NOT_FOUND');
        return true;
      },
    );
  });

  it('J3: Clone adulterado fornecido pelo caller é neutralizado; Attempt usa estritamente refs canônicas da autoridade', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_genuine_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_genuine_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_genuine_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_genuine_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_j3' as DecisionId,
      materialContextId: 'ctx_j3' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: { operation: 'external.write' },
      authorization: {
        authorizationId: 'auth_j3' as AuthorizationDecisionId,
        materialContextId: 'ctx_j3' as DecisionMaterialContextId,
        actorRef: 'operator_01',
        operation: 'external.write',
        verdict: 'authorized',
        reasonCode: 'OK',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.ok(result.admission);

    // Ataque do Codex: Caller clona o objeto admission e tenta trocar as revisões para executar outra rota/capability
    const maliciousClone = {
      ...result.admission,
      capabilityRevisionId: 'cap_malicious_injected' as any,
      bindingRevisionId: 'bind_malicious_injected' as any,
      routeRevisionId: 'route_malicious_injected' as any,
      policyRevisionId: 'policy_malicious_injected' as any,
    };

    // Caller passa o clone adulterado para buildAttemptCreatedEvent
    const attempt = buildAttemptCreatedEvent(
      maliciousClone,
      'att_j3' as AttemptId,
      '2026-08-22T18:00:01.000Z',
      'ctx_j3' as DecisionMaterialContextId,
      'external.write',
    );

    // Prova: O Attempt criado possui APENAS as refs genuínas emitidas por L0; as refs injetadas foram descartadas!
    assert.equal(attempt.capabilityRevisionId, cap.capabilityRevisionId);
    assert.equal(attempt.routeRevisionId, route.routeRevisionId);
    assert.equal(attempt.policyRevisionId, defaultPolicy.policyRevisionId);
    assert.notEqual(attempt.routeRevisionId, 'route_malicious_injected');
  });

  it('J4: Operation mismatch na execução pós-admissão é rejeitado sem criar Attempt', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_j4' as DecisionId,
      materialContextId: 'ctx_j4' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: { operation: 'external.write' },
      authorization: {
        authorizationId: 'auth_j4' as AuthorizationDecisionId,
        materialContextId: 'ctx_j4' as DecisionMaterialContextId,
        actorRef: 'operator_01',
        operation: 'external.write',
        verdict: 'authorized',
        reasonCode: 'OK',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.ok(result.admission);

    // Caller tenta disparar attempt pedindo 'external.read' quando admission foi concedida para 'external.write'
    assert.throws(
      () => {
        buildAttemptCreatedEvent({
          admissionId: result.admission!.admissionId,
          attemptId: 'att_j4' as AttemptId,
          createdAt: '2026-08-22T18:00:01.000Z',
          currentMaterialContextId: 'ctx_j4' as DecisionMaterialContextId,
          effectiveOperation: 'external.read', // Mismatch!
        });
      },
      (err: any) => {
        assert.ok(err.message.includes('Operation mismatch'));
        return true;
      },
    );
  });

  it('J5: ResourceTarget mismatch na execução pós-admissão é rejeitado sem criar Attempt', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_ext_write_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_ext_write_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_ext_write_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_ext_write_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_j5' as DecisionId,
      materialContextId: 'ctx_j5' as DecisionMaterialContextId,
      interpretation: {
        clarity: 'clear',
        potentiallyMutating: true,
        capabilityKey: cap.capabilityKey,
      },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: {
        operation: 'external.write',
        resourceTarget: 'provider:item:123',
      },
      authorization: {
        authorizationId: 'auth_j5' as AuthorizationDecisionId,
        materialContextId: 'ctx_j5' as DecisionMaterialContextId,
        actorRef: 'operator_01',
        operation: 'external.write',
        resourceTarget: 'provider:item:123',
        verdict: 'authorized',
        reasonCode: 'OK',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.ok(result.admission);

    // Caller tenta disparar attempt com resourceTarget divergente (item:999 ao invés de item:123)
    assert.throws(
      () => {
        buildAttemptCreatedEvent({
          admissionId: result.admission!.admissionId,
          attemptId: 'att_j5' as AttemptId,
          createdAt: '2026-08-22T18:00:01.000Z',
          currentMaterialContextId: 'ctx_j5' as DecisionMaterialContextId,
          effectiveOperation: 'external.write',
          effectiveResourceTarget: 'provider:item:999', // Mismatch!
        });
      },
      (err: any) => {
        assert.ok(err.message.includes('ResourceTarget mismatch'));
        return true;
      },
    );
  });

  it('J6: Material context mismatch na execução pós-admissão é rejeitado sem criar Attempt', () => {
    const authority = createDispatchAdmissionAuthority();
    const admission = authority.registerAdmission({
      admissionId: 'adm_j6' as any,
      decisionId: 'dec_j6' as any,
      materialContextId: 'ctx_alpha' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_j6' as any,
      capabilityRevisionId: 'cap_j6' as any,
      bindingRevisionId: 'bind_j6' as any,
      routeRevisionId: 'route_j6' as any,
      policyRevisionId: 'pol_j6' as any,
      admittedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.throws(
      () => {
        buildAttemptCreatedEvent({
          admissionId: admission.admissionId,
          admissionAuthority: authority,
          attemptId: 'att_j6' as AttemptId,
          createdAt: '2026-08-22T18:00:01.000Z',
          currentMaterialContextId: 'ctx_beta' as DecisionMaterialContextId, // Mismatch!
        });
      },
      (err: any) => {
        assert.ok(err.message.includes('DispatchAdmission material context mismatch'));
        return true;
      },
    );
  });

  it('J7: Reinício de processo (autoridade vazia) falha-closed; rehydration durável permanece escopo 0.86C', () => {
    // Simula novo runtime após reinício de processo
    const newProcessAuthority = createDispatchAdmissionAuthority();

    assert.throws(
      () => {
        buildAttemptCreatedEvent({
          admissionId: 'adm_persisted_from_old_process' as any,
          admissionAuthority: newProcessAuthority,
          attemptId: 'att_j7' as AttemptId,
          createdAt: '2026-08-22T18:00:01.000Z',
          currentMaterialContextId: 'ctx_j7' as DecisionMaterialContextId,
        });
      },
      (err: any) => {
        assert.ok(err instanceof DispatchAdmissionNotFoundError);
        return true;
      },
    );
  });

  it('J8: Tentativa de registrar duplicate admissionId com payload diferente lança DispatchAdmissionConflictError; payload idêntico é idempotente', () => {
    const authority = createDispatchAdmissionAuthority();
    const baseAdmission = {
      admissionId: 'adm_dup_test' as any,
      decisionId: 'dec_dup' as any,
      materialContextId: 'ctx_dup' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_dup' as any,
      capabilityRevisionId: 'cap_dup' as any,
      bindingRevisionId: 'bind_dup' as any,
      routeRevisionId: 'route_dup_v1' as any,
      policyRevisionId: 'pol_dup' as any,
      admittedAt: '2026-08-22T18:00:00.000Z',
    };

    const registered1 = authority.registerAdmission(baseAdmission);
    assert.ok(registered1);

    // Registro idêntico -> idempotente
    const registeredSame = authority.registerAdmission({ ...baseAdmission });
    assert.equal(registeredSame, registered1);

    // Registro conflitante com rota modificada -> conflito fail-closed
    assert.throws(
      () => {
        authority.registerAdmission({
          ...baseAdmission,
          routeRevisionId: 'route_dup_v2_tampered' as any,
        });
      },
      (err: any) => {
        assert.ok(err instanceof DispatchAdmissionConflictError);
        assert.equal(err.code, 'DISPATCH_ADMISSION_CONFLICT');
        return true;
      },
    );

    // O registro original permanece intacto com route_dup_v1
    const current = authority.getAdmission('adm_dup_test' as any);
    assert.equal(current?.routeRevisionId, 'route_dup_v1');
  });
});
