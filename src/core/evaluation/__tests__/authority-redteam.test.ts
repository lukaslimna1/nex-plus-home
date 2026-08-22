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

import {
  evaluateDecision,
  buildAttemptCreatedEvent,
  __resetAdmissionRuntimeForTestsOnly,
} from '../selection';
import { assessContinuationAfterAttempt } from '../continuation';
import * as publicEvaluationExports from '../index';
import * as admissionAuthorityExports from '../admission-authority';
import * as selectionExports from '../selection';
import {
  DispatchAdmissionNotFoundError,
  DispatchAdmissionConflictError,
  DispatchAdmissionAlreadyConsumedError,
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
    __resetAdmissionRuntimeForTestsOnly();
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
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rt9');
    const route = createMockRoute('route.text', 'route_rt9');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.text', 'terms_rt9', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.text', 'bind_rt9', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_rt9' as DecisionId,
      materialContextId: 'ctx_original' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });

    assert.ok(result.admission);

    assert.throws(
      () => {
        buildAttemptCreatedEvent({
          admissionId: result.admission!.admissionId,
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
  // 5. BLOCKERS D/E & F: ISSUER PRIVADO, AUTORIDADE RUNTIME & SINGLE-USE CLAIM
  // ==========================================================================

  it('AUTH-STRUCT-FINAL: Nenhum módulo (barrel, admission-authority, selection) exporta mutable authority, issuer, claim ou internal store', () => {
    // 1. Barrel público (index.ts)
    assert.equal((publicEvaluationExports as any).createDispatchAdmissionAuthority, undefined);
    assert.equal((publicEvaluationExports as any).defaultDispatchAdmissionAuthority, undefined);
    assert.equal((publicEvaluationExports as any).registerAdmission, undefined);
    assert.equal((publicEvaluationExports as any).clear, undefined);
    assert.equal((publicEvaluationExports as any).DispatchAdmissionAuthority, undefined);
    assert.equal((publicEvaluationExports as any).InMemoryDispatchAdmissionAuthority, undefined);
    assert.equal((publicEvaluationExports as any).issueDispatchAdmissionInternal, undefined);
    assert.equal((publicEvaluationExports as any).issueDispatchAdmission, undefined);
    assert.equal((publicEvaluationExports as any).claimAdmissionForAttempt, undefined);
    assert.equal((publicEvaluationExports as any).internalStore, undefined);
    assert.equal((publicEvaluationExports as any).admissionStore, undefined);
    assert.equal((publicEvaluationExports as any).__resetAdmissionRuntimeForTestsOnly, undefined);
    assert.ok(publicEvaluationExports.DispatchAdmissionNotFoundError);
    assert.ok(publicEvaluationExports.DispatchAdmissionConflictError);
    assert.ok(publicEvaluationExports.DispatchAdmissionAlreadyConsumedError);
    assert.ok(publicEvaluationExports.evaluateDecision);
    assert.ok(publicEvaluationExports.buildAttemptCreatedEvent);
    assert.ok(publicEvaluationExports.assessContinuationAfterAttempt);

    // 2. Deep import em admission-authority.ts (deve conter APENAS as 3 classes de erro)
    assert.equal((admissionAuthorityExports as any).createDispatchAdmissionAuthority, undefined);
    assert.equal((admissionAuthorityExports as any).defaultDispatchAdmissionAuthority, undefined);
    assert.equal((admissionAuthorityExports as any).registerAdmission, undefined);
    assert.equal((admissionAuthorityExports as any).clear, undefined);
    assert.equal((admissionAuthorityExports as any).issueDispatchAdmissionInternal, undefined);
    assert.equal((admissionAuthorityExports as any).issueDispatchAdmission, undefined);
    assert.equal((admissionAuthorityExports as any).claimAdmissionForAttempt, undefined);
    assert.equal((admissionAuthorityExports as any).internalStore, undefined);
    assert.equal((admissionAuthorityExports as any).admissionStore, undefined);
    assert.equal((admissionAuthorityExports as any).__resetAdmissionRuntimeForTestsOnly, undefined);
    assert.ok(admissionAuthorityExports.DispatchAdmissionNotFoundError);
    assert.ok(admissionAuthorityExports.DispatchAdmissionConflictError);
    assert.ok(admissionAuthorityExports.DispatchAdmissionAlreadyConsumedError);

    // 3. Deep import em selection.ts (não exporta issuer, claim, store; exporta apenas evaluateDecision, buildAttemptCreatedEvent e test reset)
    assert.equal((selectionExports as any).createDispatchAdmissionAuthority, undefined);
    assert.equal((selectionExports as any).defaultDispatchAdmissionAuthority, undefined);
    assert.equal((selectionExports as any).registerAdmission, undefined);
    assert.equal((selectionExports as any).clear, undefined);
    assert.equal((selectionExports as any).issueDispatchAdmissionInternal, undefined);
    assert.equal((selectionExports as any).issueDispatchAdmission, undefined);
    assert.equal((selectionExports as any).claimAdmissionForAttempt, undefined);
    assert.equal((selectionExports as any).internalStore, undefined);
    assert.equal((selectionExports as any).admissionStore, undefined);
    assert.ok(selectionExports.evaluateDecision);
    assert.ok(selectionExports.buildAttemptCreatedEvent);
  });

  it('D/E-1: Tentativa de criar Attempt com admissionId arbitrário/forjado sem evaluateDecision é rejeitada com DispatchAdmissionNotFoundError', () => {
    assert.throws(
      () => {
        buildAttemptCreatedEvent({
          admissionId: 'adm_forged_without_evaluate' as any,
          attemptId: 'att_de_1' as AttemptId,
          createdAt: '2026-08-22T18:00:01.000Z',
          currentMaterialContextId: 'ctx_de_1' as DecisionMaterialContextId,
        });
      },
      (err: any) => {
        assert.ok(err instanceof DispatchAdmissionNotFoundError);
        assert.equal(err.code, 'DISPATCH_ADMISSION_NOT_FOUND');
        return true;
      },
    );
  });

  it('D/E-2: Happy path: admission emitida por evaluateDecision legítimo cria o primeiro AttemptCreatedEvent', () => {
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

  it('J3: Clone adulterado fornecido pelo caller não pode substituir refs; Attempt deriva estritamente da admission canônica', () => {
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

    // O caller tenta usar o admissionId genuíno mas não tem capacidade de passar overrides de rota/capability
    const attempt = buildAttemptCreatedEvent({
      admissionId: result.admission.admissionId,
      attemptId: 'att_j3' as AttemptId,
      createdAt: '2026-08-22T18:00:01.000Z',
      currentMaterialContextId: 'ctx_j3' as DecisionMaterialContextId,
      effectiveOperation: 'external.write',
    });

    assert.equal(attempt.capabilityRevisionId, cap.capabilityRevisionId);
    assert.equal(attempt.routeRevisionId, route.routeRevisionId);
    assert.equal(attempt.policyRevisionId, defaultPolicy.policyRevisionId);
  });

  it('F-1: Replay sequencial: a mesma admissionId NÃO pode ser reutilizada para um segundo Attempt (Single-Use)', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_f1_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_f1_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_f1_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_f1_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_f1' as DecisionId,
      materialContextId: 'ctx_f1' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: true, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: { operation: 'external.write' },
      authorization: {
        authorizationId: 'auth_f1' as AuthorizationDecisionId,
        materialContextId: 'ctx_f1' as DecisionMaterialContextId,
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

    // Primeiro Attempt -> PASS
    const attempt1 = buildAttemptCreatedEvent({
      admissionId: result.admission.admissionId,
      attemptId: 'att_f1_1' as AttemptId,
      createdAt: '2026-08-22T18:00:01.000Z',
      currentMaterialContextId: 'ctx_f1' as DecisionMaterialContextId,
      effectiveOperation: 'external.write',
    });
    assert.equal(attempt1.attemptId, 'att_f1_1');

    // Segundo Attempt com a mesma admissionId -> FAIL (AlreadyConsumed)
    assert.throws(
      () => {
        buildAttemptCreatedEvent({
          admissionId: result.admission!.admissionId,
          attemptId: 'att_f1_2' as AttemptId,
          createdAt: '2026-08-22T18:00:02.000Z',
          currentMaterialContextId: 'ctx_f1' as DecisionMaterialContextId,
          effectiveOperation: 'external.write',
        });
      },
      (err: any) => {
        assert.ok(err instanceof DispatchAdmissionAlreadyConsumedError);
        assert.equal(err.code, 'DISPATCH_ADMISSION_ALREADY_CONSUMED');
        assert.equal(err.admissionId, result.admission!.admissionId);
        assert.equal(err.consumedByAttemptId, 'att_f1_1');
        return true;
      },
    );
  });

  it('F-2: Replay concorrente: duas criações simultâneas com a mesma admissionId produzem exatamente 1 vencedor e 1 AlreadyConsumed', async () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_f2_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_f2_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_f2_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_f2_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_f2' as DecisionId,
      materialContextId: 'ctx_f2' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: true, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: { operation: 'external.write' },
      authorization: {
        authorizationId: 'auth_f2' as AuthorizationDecisionId,
        materialContextId: 'ctx_f2' as DecisionMaterialContextId,
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

    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() =>
        buildAttemptCreatedEvent({
          admissionId: result.admission!.admissionId,
          attemptId: 'att_f2_winner' as AttemptId,
          createdAt: '2026-08-22T18:00:01.000Z',
          currentMaterialContextId: 'ctx_f2' as DecisionMaterialContextId,
          effectiveOperation: 'external.write',
        }),
      ),
      Promise.resolve().then(() =>
        buildAttemptCreatedEvent({
          admissionId: result.admission!.admissionId,
          attemptId: 'att_f2_loser' as AttemptId,
          createdAt: '2026-08-22T18:00:01.000Z',
          currentMaterialContextId: 'ctx_f2' as DecisionMaterialContextId,
          effectiveOperation: 'external.write',
        }),
      ),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exatamente uma chamada concorrente deve ter sucesso');
    assert.equal(rejected.length, 1, 'Exatamente uma chamada concorrente deve ser rejeitada');
    assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof DispatchAdmissionAlreadyConsumedError);
  });

  it('F-3: Request inválido (mismatch de operation/target/context) NÃO queima a admission; próxima tentativa correta tem sucesso', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_f3_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_f3_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_f3_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_f3_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_f3' as DecisionId,
      materialContextId: 'ctx_f3' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: true, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: { operation: 'external.write', resourceTarget: 'provider:item:123' },
      authorization: {
        authorizationId: 'auth_f3' as AuthorizationDecisionId,
        materialContextId: 'ctx_f3' as DecisionMaterialContextId,
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

    // 1. Tentativa com operation incorreta -> lança erro de mismatch
    assert.throws(
      () => {
        buildAttemptCreatedEvent({
          admissionId: result.admission!.admissionId,
          attemptId: 'att_f3_bad' as AttemptId,
          createdAt: '2026-08-22T18:00:01.000Z',
          currentMaterialContextId: 'ctx_f3' as DecisionMaterialContextId,
          effectiveOperation: 'external.read', // Incorreta!
          effectiveResourceTarget: 'provider:item:123',
        });
      },
      /Operation mismatch/,
    );

    // 2. Tentativa com target incorreto -> lança erro de mismatch
    assert.throws(
      () => {
        buildAttemptCreatedEvent({
          admissionId: result.admission!.admissionId,
          attemptId: 'att_f3_bad2' as AttemptId,
          createdAt: '2026-08-22T18:00:01.000Z',
          currentMaterialContextId: 'ctx_f3' as DecisionMaterialContextId,
          effectiveOperation: 'external.write',
          effectiveResourceTarget: 'provider:item:999', // Incorreto!
        });
      },
      /ResourceTarget mismatch/,
    );

    // 3. Prova: O token NÃO foi queimado! Tentativa com parâmetros corretos passa normalmente
    const attempt = buildAttemptCreatedEvent({
      admissionId: result.admission!.admissionId,
      attemptId: 'att_f3_good' as AttemptId,
      createdAt: '2026-08-22T18:00:02.000Z',
      currentMaterialContextId: 'ctx_f3' as DecisionMaterialContextId,
      effectiveOperation: 'external.write',
      effectiveResourceTarget: 'provider:item:123',
    });
    assert.equal(attempt.attemptId, 'att_f3_good');

    // 4. Agora que foi legitimamente consumida, a próxima falha com AlreadyConsumed
    assert.throws(
      () => {
        buildAttemptCreatedEvent({
          admissionId: result.admission!.admissionId,
          attemptId: 'att_f3_after' as AttemptId,
          createdAt: '2026-08-22T18:00:03.000Z',
          currentMaterialContextId: 'ctx_f3' as DecisionMaterialContextId,
          effectiveOperation: 'external.write',
          effectiveResourceTarget: 'provider:item:123',
        });
      },
      (err: any) => {
        assert.ok(err instanceof DispatchAdmissionAlreadyConsumedError);
        return true;
      },
    );
  });

  it('F-4: Depois do consumo não há volta: qualquer tentativa subsequente falha com AlreadyConsumed', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('external.write', 'cap_f4_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.ext.write', 'route_f4_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.ext.write', 'terms_f4_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.ext.write', 'bind_f4_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_f4' as DecisionId,
      materialContextId: 'ctx_f4' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: true, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      requiredAuthorizationScope: { operation: 'external.write', resourceTarget: 'provider:item:123' },
      authorization: {
        authorizationId: 'auth_f4' as AuthorizationDecisionId,
        materialContextId: 'ctx_f4' as DecisionMaterialContextId,
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

    // Primeiro attempt consome
    buildAttemptCreatedEvent({
      admissionId: result.admission.admissionId,
      attemptId: 'att_f4_consumed' as AttemptId,
      createdAt: '2026-08-22T18:00:01.000Z',
      currentMaterialContextId: 'ctx_f4' as DecisionMaterialContextId,
      effectiveOperation: 'external.write',
      effectiveResourceTarget: 'provider:item:123',
    });

    // Todas as variações subsequentes falham por AlreadyConsumed antes de qualquer outro check
    assert.throws(
      () =>
        buildAttemptCreatedEvent({
          admissionId: result.admission!.admissionId,
          attemptId: 'att_f4_variant1' as AttemptId,
          createdAt: '2026-08-22T18:00:02.000Z',
          currentMaterialContextId: 'ctx_f4' as DecisionMaterialContextId,
          effectiveOperation: 'external.read', // op errada
        }),
      DispatchAdmissionAlreadyConsumedError,
    );

    assert.throws(
      () =>
        buildAttemptCreatedEvent({
          admissionId: result.admission!.admissionId,
          attemptId: 'att_f4_variant2' as AttemptId,
          createdAt: '2026-08-22T18:00:02.000Z',
          currentMaterialContextId: 'ctx_diff' as DecisionMaterialContextId, // ctx errado
        }),
      DispatchAdmissionAlreadyConsumedError,
    );
  });

  it('RETRY-LEGITIMO: Retry legítimo após confirmed_no_mutation exige nova evaluateDecision e gera nova admission', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.fetch', 'cap_fetch_rev1', 'active', 'may_mutate_domain');
    const route = createMockRoute('route.fetch', 'route_fetch_rev1');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.fetch', 'terms_fetch_rev1', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.fetch', 'bind_fetch_rev1', cap.capabilityRevisionId, route.routeRevisionId));

    // 1. Decisão A
    const resultA = evaluateDecision({
      decisionId: 'dec_retry_A' as DecisionId,
      materialContextId: 'ctx_retry_1' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });
    assert.ok(resultA.admission);

    const attemptA = buildAttemptCreatedEvent({
      admissionId: resultA.admission.admissionId,
      attemptId: 'att_retry_A' as AttemptId,
      createdAt: '2026-08-22T18:00:01.000Z',
      currentMaterialContextId: 'ctx_retry_1' as DecisionMaterialContextId,
    });

    // Outcome da tentativa A: confirmed_no_mutation
    const continuation = assessContinuationAfterAttempt({
      decisionId: 'dec_retry_A' as DecisionId,
      materialContextId: 'ctx_retry_1' as DecisionMaterialContextId,
      attempt: {
        attemptId: attemptA.attemptId,
        decisionId: attemptA.decisionId,
        routeEvaluationId: attemptA.routeEvaluationId,
        capabilityRevisionId: attemptA.capabilityRevisionId,
        bindingRevisionId: attemptA.bindingRevisionId,
        routeRevisionId: attemptA.routeRevisionId,
        policyRevisionId: attemptA.policyRevisionId,
        status: 'failed',
        createdAt: attemptA.createdAt,
        finishedAt: '2026-08-22T18:00:05.000Z',
      },
      assessment: {
        assessmentId: 'ass_retry_1' as any,
        attemptId: attemptA.attemptId,
        evidenceRefs: [],
        verdict: 'confirmed_no_mutation',
        reasonCode: 'TARGET_NOT_REACHABLE_NO_MUTATION',
        assessedAt: '2026-08-22T18:00:06.000Z',
      },
      isDomainMutating: false,
      assessedAt: '2026-08-22T18:00:06.000Z',
    });

    assert.equal(continuation.directive, 'new_route_evaluation_required');

    // 2. Nova Decisão B
    const resultB = evaluateDecision({
      decisionId: 'dec_retry_B' as DecisionId,
      materialContextId: 'ctx_retry_2' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:10.000Z',
    });
    assert.ok(resultB.admission);
    assert.notEqual(resultB.admission.admissionId, resultA.admission.admissionId);

    // Attempt B consome a nova admission B
    const attemptB = buildAttemptCreatedEvent({
      admissionId: resultB.admission.admissionId,
      attemptId: 'att_retry_B' as AttemptId,
      createdAt: '2026-08-22T18:00:11.000Z',
      currentMaterialContextId: 'ctx_retry_2' as DecisionMaterialContextId,
    });

    assert.equal(attemptB.attemptId, 'att_retry_B');
    assert.equal(attemptB.decisionId, 'dec_retry_B');
  });

  it('RESTART: Reinício de processo (runtime vazio) resulta em fail-closed com DispatchAdmissionNotFoundError', () => {
    // Simula reinício de processo limpando a memória do runtime interno
    __resetAdmissionRuntimeForTestsOnly();

    assert.throws(
      () => {
        buildAttemptCreatedEvent({
          admissionId: 'adm_persisted_from_prior_process' as any,
          attemptId: 'att_restart_1' as AttemptId,
          createdAt: '2026-08-22T18:00:01.000Z',
          currentMaterialContextId: 'ctx_restart' as DecisionMaterialContextId,
        });
      },
      (err: any) => {
        assert.ok(err instanceof DispatchAdmissionNotFoundError);
        return true;
      },
    );
  });

  it('DUPLICATE-ID: Avaliação determinística com mesma Decisão e Rota emite admissão idempotente', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_dup');
    const route = createMockRoute('route.text', 'route_dup');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.text', 'terms_dup', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.text', 'bind_dup', cap.capabilityRevisionId, route.routeRevisionId));

    const result1 = evaluateDecision({
      decisionId: 'dec_dup' as DecisionId,
      materialContextId: 'ctx_dup' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });
    assert.ok(result1.admission);

    // Mesma avaliação -> idempotente
    const result2 = evaluateDecision({
      decisionId: 'dec_dup' as DecisionId,
      materialContextId: 'ctx_dup' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-22T18:00:00.000Z',
    });
    assert.equal(result2.admission?.admissionId, result1.admission.admissionId);
  });
});
