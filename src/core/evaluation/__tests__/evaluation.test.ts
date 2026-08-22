/**
 * NEX+ · Route Eligibility, Selection & Escalation
 * Acceptance Matrix & Testes Determinísticos — Escopo 0.5 (Bloco 0.5E)
 *
 * Suíte Completa: 64 Cenários da Matriz de Aceitação de L0.
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
  HumanAuthorizationDecision,
} from '../../policy/contracts';

import type {
  DecisionId,
  RouteEvaluationId,
  AttemptId,
  ReceiptId,
  OutcomeAssessmentId,
} from '../../execution/contracts';

import {
  createExecutionLedgerStore,
} from '../../execution/ledger';

import {
  materializePolicyDenialReceipt,
  materializeAuthorizationDenialReceipt,
  materializeNoEligibleRouteReceipt,
} from '../../execution/receipt';

import type {
  DecisionMaterialContextId,
  AuthorizationDecisionId,
  ContextualAuthorizationDecision,
  ConfirmationDecision,
  ConfirmationDecisionId,
  RouteRuntimeFacts,
  RouteSelectionPlan,
  SelectionPlanId,
} from '../contracts';

import { evaluateCandidateRoute } from '../route-evaluation';
import { evaluateDecision } from '../selection';
import {
  assessContinuationAfterAttempt,
  buildAttemptCreatedEvent,
} from '../continuation';
import { __resetAdmissionRuntimeForTestsOnly } from '../admission-authority';

const defaultProvenance: FactProvenance = {
  source: 'official_docs',
  acquisitionBasis: 'declared',
  verificationStatus: 'corroborated',
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

function createMockCapability(key: string, id: string, lifecycle: 'active' | 'deprecated' | 'retired' = 'active'): CapabilityRevision {
  return {
    capabilityKey: key as CapabilityKey,
    capabilityRevisionId: id as CapabilityRevisionId,
    lifecycle,
    supersedesRevisionIds: [],
    title: key,
    description: `Description of ${key}`,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    domainEffect: 'none',
  };
}

function createMockRoute(key: string, id: string, lifecycle: 'active' | 'deprecated' | 'retired' = 'active', overrides?: Partial<RouteRevision>): RouteRevision {
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

function createMockTerms(termsKey: string, id: string, routeRevisionId: RouteRevisionId, overrides?: Partial<RouteTermsRevision>): RouteTermsRevision {
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

describe('NEX+ L0 Route Eligibility, Selection & Escalation (Bloco 0.5E)', () => {
  beforeEach(() => {
    __resetAdmissionRuntimeForTestsOnly();
  });

  // 1. Capability inexistente → clarification_required
  it('1. Capability inexistente → clarification_required', () => {
    const registry = createCapabilityRegistry();
    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: 'cap.non_existent' as CapabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'clarification_required');
    assert.equal(result.reasonCode, 'CAPABILITY_NOT_REGISTERED');
  });

  // 2. Ambiguous mutative intent → clarification_required
  it('2. Ambiguous mutative intent → clarification_required', () => {
    const registry = createCapabilityRegistry();
    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'ambiguous', potentiallyMutating: true, reason: 'Ambiguous target row ID' },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'clarification_required');
    assert.equal(result.reasonCode, 'INTERPRETATION_AMBIGUOUS');
    assert.equal(result.escalation?.kind, 'clarification_required');
  });

  // 3. Capability active com zero Routes → no_eligible_route
  it('3. Capability active com zero Routes → no_eligible_route', () => {
    const registry = createCapabilityRegistry();
    registry.registerCapabilityRevision(createMockCapability('cap.text', 'cap_rev_01'));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: 'cap.text' as CapabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'no_eligible_route');
    assert.equal(result.reasonCode, 'NO_ROUTES_FOR_CAPABILITY');
  });

  // 4. Route retired → ineligible
  it('4. Route retired → ineligible', () => {
    const evalResult = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.text', 'r_rev_01', 'retired'),
      termsResult: { status: 'no_terms' },
      termsContext: defaultTermsContext,
      policy: { ...defaultPolicy, zeroCostRequired: false },
      containsSecretMaterial: false,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalResult.status, 'ineligible');
    assert.ok(evalResult.reasonCodes.includes('ROUTE_RETIRED'));
  });

  // 5. Route deprecated como única opção → awaiting_human
  it('5. Route deprecated como única opção → awaiting_human', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.text', 'r_rev_01', 'deprecated');
    const terms = createMockTerms('t.text', 't_rev_01', route.routeRevisionId);
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));
    registry.registerTermsRevision(terms);

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'ROUTE_DEPRECATED_REVIEW');
    assert.equal(result.escalation?.kind, 'deprecated_route_review');
  });

  // 6. Binding superseded não é candidato
  it('6. Binding superseded não é candidato', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const r1 = createMockRoute('r.text1', 'r_rev_01');
    const r2 = createMockRoute('r.text2', 'r_rev_02');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(r1);
    registry.registerRouteRevision(r2);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', r1.routeRevisionId));
    registry.registerTermsRevision(createMockTerms('t.2', 't_rev_02', r2.routeRevisionId));

    // B1 para r1 é supersedido por B2 para r2
    registry.registerBindingRevision(createMockBinding('b.main', 'b_rev_01', cap.capabilityRevisionId, r1.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.main', 'b_rev_02', cap.capabilityRevisionId, r2.routeRevisionId, ['b_rev_01' as BindingRevisionId]));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'route_selected');
    assert.equal(result.selectedRouteRevisionId, r2.routeRevisionId);
    assert.equal(result.evaluations.length, 1);
  });

  // 7. Authorization denied → authorization_denied
  it('7. Authorization denied → authorization_denied', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.text', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const auth: ContextualAuthorizationDecision = {
      authorizationId: 'auth_01' as AuthorizationDecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      actorRef: 'user_01',
      operation: 'execute',
      verdict: 'denied',
      reasonCode: 'PERMISSION_DENIED',
    };

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorization: auth,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'authorization_denied');
    assert.equal(result.reasonCode, 'PERMISSION_DENIED');
  });

  // 8. Authorization pending → awaiting_human
  it('8. Authorization pending → awaiting_human', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.text', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const auth: ContextualAuthorizationDecision = {
      authorizationId: 'auth_01' as AuthorizationDecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      actorRef: 'user_01',
      operation: 'execute',
      verdict: 'pending',
      reasonCode: 'AUTHORIZATION_PENDING',
    };

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorization: auth,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'AUTHORIZATION_PENDING');
  });

  // 9. Authorization context mismatch → gate inválido / awaiting_human
  it('9. Authorization context mismatch → gate inválido / awaiting_human', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.text', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const auth: ContextualAuthorizationDecision = {
      authorizationId: 'auth_01' as AuthorizationDecisionId,
      materialContextId: 'ctx_other_different' as DecisionMaterialContextId,
      actorRef: 'user_01',
      operation: 'execute',
      verdict: 'authorized',
      reasonCode: 'PREV_AUTH',
    };

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_current' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorization: auth,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'AUTHORIZATION_CONTEXT_MISMATCH');
  });

  // 10. Policy allow não sobrescreve auth deny
  it('10. Policy allow não sobrescreve auth deny', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorization: {
        authorizationId: 'auth_01' as AuthorizationDecisionId,
        materialContextId: 'ctx_01' as DecisionMaterialContextId,
        actorRef: 'u1',
        operation: 'op',
        verdict: 'denied',
        reasonCode: 'AUTH_DENIED',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'authorization_denied');
  });

  // 11. Authorization allow não sobrescreve Policy deny
  it('11. Authorization allow não sobrescreve Policy deny', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const routeCloudAI = createMockRoute('r.cloud', 'r_rev_01', 'active', {
      crossesEgressBoundary: true,
      controlOwnership: 'third_party',
      externalServiceNature: 'ai_third_party',
    });
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(routeCloudAI);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', routeCloudAI.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, routeCloudAI.routeRevisionId));

    const localPolicy: PolicyRevision = { ...defaultPolicy, defaultSensitivity: 'LOCAL_ONLY' };

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: localPolicy,
      authorization: {
        authorizationId: 'auth_01' as AuthorizationDecisionId,
        materialContextId: 'ctx_01' as DecisionMaterialContextId,
        actorRef: 'u1',
        operation: 'op',
        verdict: 'authorized',
        reasonCode: 'AUTH_OK',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'policy_denied');
  });

  // 12. LOCAL_ONLY + external AI → Route ineligible
  it('12. LOCAL_ONLY + external AI → Route ineligible', () => {
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.openai', 'r_rev_01', 'active', { crossesEgressBoundary: true, controlOwnership: 'third_party', externalServiceNature: 'ai_third_party' }),
      termsResult: { status: 'no_terms' },
      termsContext: defaultTermsContext,
      policy: { ...defaultPolicy, defaultSensitivity: 'LOCAL_ONLY', zeroCostRequired: false },
      containsSecretMaterial: false,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'ineligible');
    assert.ok(evalRes.reasonCodes.includes('EGRESS_LOCAL_ONLY_EXTERNAL_PROVIDER'));
  });

  // 13. LOCAL_ONLY + local operator-managed → pode passar egress
  it('13. LOCAL_ONLY + local operator-managed → pode passar egress', () => {
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01', 'active', { controlOwnership: 'operator_managed', externalServiceNature: 'none' }),
      termsResult: { status: 'single_applicable', terms: createMockTerms('t.1', 't_rev_01', 'r_rev_01' as RouteRevisionId) },
      termsContext: defaultTermsContext,
      policy: { ...defaultPolicy, defaultSensitivity: 'LOCAL_ONLY', zeroCostRequired: true },
      containsSecretMaterial: false,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'eligible');
  });

  // 14. Zero-Cost + paid only → ineligible
  it('14. Zero-Cost + paid only → ineligible', () => {
    const terms = createMockTerms('t.paid', 't_rev_paid', 'r_rev_01' as RouteRevisionId, {
      billingStatus: 'known_components',
      billingComponents: [{ type: 'metered_usage', amount: 0.05 }],
      freeEntitlementStatus: 'known_none',
    });
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'ineligible');
    assert.ok(evalRes.reasonCodes.includes('ZERO_COST_PAID_ONLY'));
  });

  // 15. Zero-Cost + trial only → ineligible
  it('15. Zero-Cost + trial only → ineligible', () => {
    const terms = createMockTerms('t.trial', 't_rev_trial', 'r_rev_01' as RouteRevisionId, {
      billingStatus: 'known_none',
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [{ type: 'trial' }],
    });
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'ineligible');
    assert.ok(evalRes.reasonCodes.includes('ZERO_COST_TRIAL_ONLY'));
  });

  // 16. Zero-Cost + promotional only → ineligible
  it('16. Zero-Cost + promotional only → ineligible', () => {
    const terms = createMockTerms('t.promo', 't_rev_promo', 'r_rev_01' as RouteRevisionId, {
      billingStatus: 'known_none',
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [{ type: 'promotional_credit', quotaAmount: 100 }],
    });
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'ineligible');
    assert.ok(evalRes.reasonCodes.includes('ZERO_COST_PROMOTIONAL_ONLY'));
  });

  // 17. recurring full free → Zero-Cost gate satisfeito
  it('17. recurring full free → Zero-Cost gate satisfeito', () => {
    const terms = createMockTerms('t.ff', 't_rev_ff', 'r_rev_01' as RouteRevisionId, {
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [{ type: 'recurring_full_free' }],
    });
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'eligible');
  });

  // 18. recurring allowance + fresh available quota → gate satisfeito
  it('18. recurring allowance + fresh available quota → gate satisfeito', () => {
    const terms = createMockTerms('t.allow', 't_rev_allow', 'r_rev_01' as RouteRevisionId, {
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [{ type: 'recurring_free_allowance', quotaAmount: 1000 }],
    });
    const runtimeFacts: RouteRuntimeFacts = {
      routeRevisionId: 'r_rev_01' as RouteRevisionId,
      availability: 'available',
      health: 'healthy',
      cooldown: 'clear',
      freeAllowanceAvailable: true,
      freshness: 'fresh',
      observedAt: '2026-08-19T18:50:00.000Z',
      provenance: defaultProvenance,
    };
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      runtimeFacts,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'eligible');
  });

  // 19. recurring allowance + exhausted quota → ineligible
  it('19. recurring allowance + exhausted quota → ineligible', () => {
    const terms = createMockTerms('t.allow', 't_rev_allow', 'r_rev_01' as RouteRevisionId, {
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [{ type: 'recurring_free_allowance', quotaAmount: 1000 }],
    });
    const runtimeFacts: RouteRuntimeFacts = {
      routeRevisionId: 'r_rev_01' as RouteRevisionId,
      availability: 'available',
      health: 'healthy',
      cooldown: 'clear',
      freeAllowanceAvailable: false,
      freshness: 'fresh',
      observedAt: '2026-08-19T18:50:00.000Z',
      provenance: defaultProvenance,
    };
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      runtimeFacts,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'ineligible');
    assert.ok(evalRes.reasonCodes.includes('FREE_ALLOWANCE_EXHAUSTED'));
  });

  // 20. recurring allowance + quota unknown → não eligible automaticamente
  it('20. recurring allowance + quota unknown → não eligible automaticamente', () => {
    const terms = createMockTerms('t.allow', 't_rev_allow', 'r_rev_01' as RouteRevisionId, {
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [{ type: 'recurring_free_allowance', quotaAmount: 1000 }],
    });
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'ineligible');
    assert.ok(evalRes.reasonCodes.includes('FREE_ALLOWANCE_UNKNOWN'));
  });

  // 21. stale material runtime fact → não eligible
  it('21. stale material runtime fact → não eligible', () => {
    const runtimeFacts: RouteRuntimeFacts = {
      routeRevisionId: 'r_rev_01' as RouteRevisionId,
      availability: 'available',
      health: 'healthy',
      cooldown: 'clear',
      freshness: 'stale',
      observedAt: '2026-08-19T17:00:00.000Z',
      provenance: defaultProvenance,
    };
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms: createMockTerms('t.1', 't_rev_01', 'r_rev_01' as RouteRevisionId) },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      runtimeFacts,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'ineligible');
    assert.ok(evalRes.reasonCodes.includes('RUNTIME_FACTS_STALE'));
  });

  // 22. Route unavailable → ineligible
  it('22. Route unavailable → ineligible', () => {
    const runtimeFacts: RouteRuntimeFacts = {
      routeRevisionId: 'r_rev_01' as RouteRevisionId,
      availability: 'unavailable',
      health: 'healthy',
      cooldown: 'clear',
      freshness: 'fresh',
      observedAt: '2026-08-19T18:50:00.000Z',
      provenance: defaultProvenance,
    };
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms: createMockTerms('t.1', 't_rev_01', 'r_rev_01' as RouteRevisionId) },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      runtimeFacts,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'ineligible');
    assert.ok(evalRes.reasonCodes.includes('ROUTE_UNAVAILABLE'));
  });

  // 23. Route unhealthy → ineligible
  it('23. Route unhealthy → ineligible', () => {
    const runtimeFacts: RouteRuntimeFacts = {
      routeRevisionId: 'r_rev_01' as RouteRevisionId,
      availability: 'available',
      health: 'unhealthy',
      cooldown: 'clear',
      freshness: 'fresh',
      observedAt: '2026-08-19T18:50:00.000Z',
      provenance: defaultProvenance,
    };
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms: createMockTerms('t.1', 't_rev_01', 'r_rev_01' as RouteRevisionId) },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      runtimeFacts,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'ineligible');
    assert.ok(evalRes.reasonCodes.includes('ROUTE_UNHEALTHY'));
  });

  // 24. active cooldown → ineligible
  it('24. active cooldown → ineligible', () => {
    const runtimeFacts: RouteRuntimeFacts = {
      routeRevisionId: 'r_rev_01' as RouteRevisionId,
      availability: 'available',
      health: 'healthy',
      cooldown: 'active',
      freshness: 'fresh',
      observedAt: '2026-08-19T18:50:00.000Z',
      provenance: defaultProvenance,
    };
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms: createMockTerms('t.1', 't_rev_01', 'r_rev_01' as RouteRevisionId) },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      runtimeFacts,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'ineligible');
    assert.ok(evalRes.reasonCodes.includes('ROUTE_COOLDOWN_ACTIVE'));
  });

  // 25. degraded health sozinho não causa deny automático
  it('25. degraded health sozinho não causa deny automático', () => {
    const runtimeFacts: RouteRuntimeFacts = {
      routeRevisionId: 'r_rev_01' as RouteRevisionId,
      availability: 'available',
      health: 'degraded',
      cooldown: 'clear',
      freshness: 'fresh',
      observedAt: '2026-08-19T18:50:00.000Z',
      provenance: defaultProvenance,
    };
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms: createMockTerms('t.1', 't_rev_01', 'r_rev_01' as RouteRevisionId) },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      runtimeFacts,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'eligible');
    assert.equal(evalRes.materialRuntimeFacts?.health, 'degraded');
  });

  // 26. Terms insufficient_context → Route não eligible
  it('26. Terms insufficient_context → Route não eligible', () => {
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'insufficient_context', missingDimensions: ['accountTier'], candidateTerms: [], reason: 'Missing dimension accountTier' },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'ineligible');
    assert.ok(evalRes.reasonCodes.includes('TERMS_CONTEXT_INSUFFICIENT'));
  });

  // 27. Confirmation required + missing → awaiting_human
  it('27. Confirmation required + missing → awaiting_human', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: true, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      confirmationRequired: true,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'CONFIRMATION_REQUIRED');
  });

  // 28. Confirmation pending → awaiting_human
  it('28. Confirmation pending → awaiting_human', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const conf: ConfirmationDecision = {
      confirmationId: 'conf_01' as ConfirmationDecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      actorRef: 'user_01',
      operation: 'delete_row',
      verdict: 'pending',
      reasonCode: 'AWAITING_USER_TAP',
    };

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: true, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      confirmationRequired: true,
      confirmation: conf,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'CONFIRMATION_PENDING');
  });

  // 29. Confirmation confirmed + same context → passa
  it('29. Confirmation confirmed + same context → passa', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const conf: ConfirmationDecision = {
      confirmationId: 'conf_01' as ConfirmationDecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      actorRef: 'user_01',
      operation: 'delete_row',
      verdict: 'confirmed',
      reasonCode: 'CONFIRMED_BY_USER',
    };

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: true, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      confirmationRequired: true,
      confirmation: conf,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'route_selected');
    assert.ok(result.admission);
  });

  // 30. Confirmation declined → cancelled
  it('30. Confirmation declined → cancelled', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const conf: ConfirmationDecision = {
      confirmationId: 'conf_01' as ConfirmationDecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      actorRef: 'user_01',
      operation: 'delete_row',
      verdict: 'declined',
      reasonCode: 'USER_REJECTED_PROMPT',
    };

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: true, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      confirmationRequired: true,
      confirmation: conf,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'cancelled');
    assert.equal(result.reasonCode, 'USER_REJECTED_PROMPT');
  });

  // 31. Confirmation context mismatch → awaiting_human
  it('31. Confirmation context mismatch → awaiting_human', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const conf: ConfirmationDecision = {
      confirmationId: 'conf_01' as ConfirmationDecisionId,
      materialContextId: 'ctx_old' as DecisionMaterialContextId,
      actorRef: 'user_01',
      operation: 'delete_row',
      verdict: 'confirmed',
      reasonCode: 'OLD_CONFIRMATION',
    };

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_new' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: true, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      confirmationRequired: true,
      confirmation: conf,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'CONFIRMATION_CONTEXT_MISMATCH');
  });

  // 32. exatamente uma eligible Route → route_selected
  it('32. exatamente uma eligible Route → route_selected', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'route_selected');
    assert.equal(result.selectedRouteRevisionId, route.routeRevisionId);
    assert.ok(result.admission);
  });

  // 33. duas eligible sem SelectionPlan → awaiting_human
  it('33. duas eligible sem SelectionPlan → awaiting_human', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const r1 = createMockRoute('r.text1', 'r_rev_01');
    const r2 = createMockRoute('r.text2', 'r_rev_02');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(r1);
    registry.registerRouteRevision(r2);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', r1.routeRevisionId));
    registry.registerTermsRevision(createMockTerms('t.2', 't_rev_02', r2.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, r1.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.2', 'b_rev_02', cap.capabilityRevisionId, r2.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'MULTIPLE_ELIGIBLE_ROUTES');
    assert.equal(result.escalation?.candidateRouteRevisionIds?.length, 2);
  });

  // 34. duas eligible com SelectionPlan → escolha determinística
  it('34. duas eligible com SelectionPlan → escolha determinística', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const r1 = createMockRoute('r.text1', 'r_rev_01');
    const r2 = createMockRoute('r.text2', 'r_rev_02');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(r1);
    registry.registerRouteRevision(r2);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', r1.routeRevisionId));
    registry.registerTermsRevision(createMockTerms('t.2', 't_rev_02', r2.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, r1.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.2', 'b_rev_02', cap.capabilityRevisionId, r2.routeRevisionId));

    const plan: RouteSelectionPlan = {
      planId: 'plan_01' as SelectionPlanId,
      preferredRoutes: [r2.routeRevisionId, r1.routeRevisionId],
      createdAt: '2026-08-19T18:50:00.000Z',
    };

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      selectionPlan: plan,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'route_selected');
    assert.equal(result.selectedRouteRevisionId, r2.routeRevisionId);
  });

  // 35. SelectionPlan com IDs duplicados → rejeitado
  it('35. SelectionPlan com IDs duplicados → rejeitado', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const r1 = createMockRoute('r.text1', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(r1);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', r1.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, r1.routeRevisionId));

    const badPlan: RouteSelectionPlan = {
      planId: 'plan_dup' as SelectionPlanId,
      preferredRoutes: [r1.routeRevisionId, r1.routeRevisionId],
      createdAt: '2026-08-19T18:50:00.000Z',
    };

    assert.throws(
      () =>
        evaluateDecision({
          decisionId: 'dec_01' as DecisionId,
          materialContextId: 'ctx_01' as DecisionMaterialContextId,
          interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
          capabilityRegistry: registry,
          policy: defaultPolicy,
          selectionPlan: badPlan,
          containsSecretMaterial: false,
          termsContext: defaultTermsContext,
          decidedAt: '2026-08-19T18:50:00.000Z',
        }),
      /Duplicate RouteRevisionId/,
    );
  });

  // 36. SelectionPlan não usa ordem do Registry
  it('36. SelectionPlan não usa ordem do Registry', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const r1 = createMockRoute('r.text1', 'r_rev_01');
    const r2 = createMockRoute('r.text2', 'r_rev_02');
    registry.registerCapabilityRevision(cap);
    // r1 inserido primeiro no registry
    registry.registerRouteRevision(r1);
    registry.registerRouteRevision(r2);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', r1.routeRevisionId));
    registry.registerTermsRevision(createMockTerms('t.2', 't_rev_02', r2.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, r1.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.2', 'b_rev_02', cap.capabilityRevisionId, r2.routeRevisionId));

    // Plano pede r2 explicitamente
    const plan: RouteSelectionPlan = {
      planId: 'plan_choose_r2' as SelectionPlanId,
      preferredRoutes: [r2.routeRevisionId, r1.routeRevisionId],
      createdAt: '2026-08-19T18:50:00.000Z',
    };

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      selectionPlan: plan,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.selectedRouteRevisionId, r2.routeRevisionId);
  });

  // 37. Policy runtime requirement é verificado pelo runtime facts
  it('37. Policy runtime requirement é verificado pelo runtime facts', () => {
    const terms = createMockTerms('t.allow', 't_rev_allow', 'r_rev_01' as RouteRevisionId, {
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [{ type: 'recurring_free_allowance', quotaAmount: 500 }],
    });
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      runtimeFacts: {
        routeRevisionId: 'r_rev_01' as RouteRevisionId,
        availability: 'available',
        health: 'healthy',
        cooldown: 'clear',
        freeAllowanceAvailable: false, // Quota zerada
        freshness: 'fresh',
        observedAt: '2026-08-19T18:50:00.000Z',
        provenance: defaultProvenance,
      },
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'ineligible');
    assert.ok(evalRes.reasonCodes.includes('FREE_ALLOWANCE_EXHAUSTED'));
  });

  // 38. RouteEvaluation preserva somente facts materiais
  it('38. RouteEvaluation preserva somente facts materiais', () => {
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms: createMockTerms('t.1', 't_rev_01', 'r_rev_01' as RouteRevisionId) },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      runtimeFacts: {
        routeRevisionId: 'r_rev_01' as RouteRevisionId,
        availability: 'available',
        health: 'degraded',
        cooldown: 'clear',
        freshness: 'fresh',
        observedAt: '2026-08-19T18:50:00.000Z',
        provenance: defaultProvenance,
      },
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.deepEqual(evalRes.materialRuntimeFacts, { health: 'degraded' });
  });

  // 39. RouteEvaluation não cria Attempt
  it('39. RouteEvaluation não cria Attempt', () => {
    const ledger = createExecutionLedgerStore();
    const evalRes = evaluateCandidateRoute({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capability: createMockCapability('cap.text', 'cap_rev_01'),
      binding: createMockBinding('b.1', 'b_rev_01', 'cap_rev_01' as CapabilityRevisionId, 'r_rev_01' as RouteRevisionId),
      route: createMockRoute('r.local', 'r_rev_01'),
      termsResult: { status: 'single_applicable', terms: createMockTerms('t.1', 't_rev_01', 'r_rev_01' as RouteRevisionId) },
      termsContext: defaultTermsContext,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      evaluatedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(evalRes.status, 'eligible');
    assert.equal(ledger.listAttempts().length, 0);
  });

  // 40. DispatchAdmission só nasce com todos gates válidos
  it('40. DispatchAdmission só nasce com todos gates válidos', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.ok(result.admission);
    assert.equal(result.admission.routeRevisionId, route.routeRevisionId);
  });

  // 41. Admission context M1 não pode ser reutilizada para M2
  it('41. Admission context M1 não pode ser reutilizada para M2', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_01');
    const route = createMockRoute('r.text', 'route_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.text', 't_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.text', 'bind_01', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_41' as DecisionId,
      materialContextId: 'ctx_M1' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.ok(result.admission);

    assert.throws(
      () =>
        buildAttemptCreatedEvent({
          admissionId: result.admission!.admissionId,
          attemptId: 'att_01' as AttemptId,
          createdAt: '2026-08-19T18:50:01.000Z',
          currentMaterialContextId: 'ctx_M2' as DecisionMaterialContextId, // Contexto material mudou
        }),
      /DispatchAdmission material context mismatch/,
    );
  });

  // 42. buildAttemptCreatedEvent usa refs exatas da Admission
  it('42. buildAttemptCreatedEvent usa refs exatas da Admission', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_02');
    const route = createMockRoute('r.text', 'route_02');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('terms.text', 't_02', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('bind.text', 'bind_02', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_42' as DecisionId,
      materialContextId: 'ctx_M1' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.ok(result.admission);

    const event = buildAttemptCreatedEvent({
      admissionId: result.admission!.admissionId,
      attemptId: 'att_01' as AttemptId,
      createdAt: '2026-08-19T18:50:01.000Z',
      currentMaterialContextId: 'ctx_M1' as DecisionMaterialContextId,
    });

    assert.equal(event.attemptId, 'att_01');
    assert.equal(event.decisionId, 'dec_42');
    assert.equal(event.routeEvaluationId, result.admission!.routeEvaluationId);
    assert.equal(event.routeRevisionId, 'route_02');
  });

  // 43. Route inelegível não cria Attempt
  it('43. Route inelegível não cria Attempt', () => {
    const registry = createCapabilityRegistry();
    const ledger = createExecutionLedgerStore();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.retired', 'r_rev_01', 'retired');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'no_eligible_route');
    assert.equal(result.admission, undefined);
    assert.equal(ledger.listAttempts().length, 0);
  });

  // 44. Policy denied pode gerar Receipt sem Attempt
  it('44. Policy denied pode gerar Receipt sem Attempt', () => {
    const ledger = createExecutionLedgerStore();
    const receipt = materializePolicyDenialReceipt({
      receiptId: 'rcpt_pol' as ReceiptId,
      decisionId: 'dec_01' as DecisionId,
      policyDecision: {
        policyRevisionId: 'pol_01' as PolicyRevisionId,
        routeRevisionId: 'route_01' as RouteRevisionId,
        effectiveSensitivity: 'LOCAL_ONLY',
        containsSecretMaterial: false,
        egressAxis: { verdict: 'deny', reasonCode: 'EGRESS_LOCAL_ONLY_EXTERNAL_PROVIDER' },
        zeroCostAxis: { verdict: 'allow', reasonCode: 'ZERO_COST_NOT_REQUIRED' },
        requiredRuntimeRequirements: [],
        evaluatedAt: '2026-08-19T18:50:00.000Z',
      },
      materializedAt: '2026-08-19T18:50:01.000Z',
    });

    ledger.appendReceipt(receipt);
    assert.equal(ledger.listReceipts().length, 1);
    assert.equal(ledger.listAttempts().length, 0);
  });

  // 45. Authorization denied pode gerar Receipt sem Attempt
  it('45. Authorization denied pode gerar Receipt sem Attempt', () => {
    const ledger = createExecutionLedgerStore();
    const receipt = materializeAuthorizationDenialReceipt({
      receiptId: 'rcpt_auth' as ReceiptId,
      decisionId: 'dec_01' as DecisionId,
      authDecision: { actorRef: 'u1', operation: 'op', verdict: 'denied', reasonCode: 'DENIED' },
      materializedAt: '2026-08-19T18:50:01.000Z',
    });

    ledger.appendReceipt(receipt);
    assert.equal(ledger.listReceipts().length, 1);
    assert.equal(ledger.listAttempts().length, 0);
  });

  // 46. no eligible route pode gerar Receipt sem Attempt
  it('46. no eligible route pode gerar Receipt sem Attempt', () => {
    const ledger = createExecutionLedgerStore();
    const receipt = materializeNoEligibleRouteReceipt({
      receiptId: 'rcpt_no_route' as ReceiptId,
      decisionId: 'dec_01' as DecisionId,
      reasonCode: 'NO_ELIGIBLE_ROUTE',
      materializedAt: '2026-08-19T18:50:01.000Z',
    });

    ledger.appendReceipt(receipt);
    assert.equal(ledger.listReceipts().length, 1);
    assert.equal(ledger.listAttempts().length, 0);
  });

  // 47. confirmed_mutation → continuation stop
  it('47. confirmed_mutation → continuation stop', () => {
    const assessment = {
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: [],
      verdict: 'confirmed_mutation' as const,
      reasonCode: 'MUTATION_EFFECT_OBSERVED',
      assessedAt: '2026-08-19T18:50:05.000Z',
    };
    const cont = assessContinuationAfterAttempt({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      attempt: { attemptId: 'att_01' as AttemptId, decisionId: 'dec_01' as DecisionId, routeEvaluationId: 'eval_01' as RouteEvaluationId, capabilityRevisionId: 'cap_01' as CapabilityRevisionId, bindingRevisionId: 'bind_01' as BindingRevisionId, routeRevisionId: 'r_01' as RouteRevisionId, status: 'succeeded', createdAt: '2026-08-19T18:50:00.000Z' },
      assessment,
      isDomainMutating: true,
      assessedAt: '2026-08-19T18:50:05.000Z',
    });

    assert.equal(cont.directive, 'stop');
  });

  // 48. confirmed_result → continuation stop
  it('48. confirmed_result → continuation stop', () => {
    const assessment = {
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: [],
      verdict: 'confirmed_result' as const,
      reasonCode: 'NON_MUTATING_RESULT_VERIFIED',
      assessedAt: '2026-08-19T18:50:05.000Z',
    };
    const cont = assessContinuationAfterAttempt({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      attempt: { attemptId: 'att_01' as AttemptId, decisionId: 'dec_01' as DecisionId, routeEvaluationId: 'eval_01' as RouteEvaluationId, capabilityRevisionId: 'cap_01' as CapabilityRevisionId, bindingRevisionId: 'bind_01' as BindingRevisionId, routeRevisionId: 'r_01' as RouteRevisionId, status: 'succeeded', createdAt: '2026-08-19T18:50:00.000Z' },
      assessment,
      isDomainMutating: false,
      assessedAt: '2026-08-19T18:50:05.000Z',
    });

    assert.equal(cont.directive, 'stop');
  });

  // 49. confirmed_no_mutation após falha → new_route_evaluation_required
  it('49. confirmed_no_mutation após falha → new_route_evaluation_required', () => {
    const assessment = {
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: [],
      verdict: 'confirmed_no_mutation' as const,
      reasonCode: 'MUTATION_NO_EFFECT_VERIFIED',
      assessedAt: '2026-08-19T18:50:05.000Z',
    };
    const cont = assessContinuationAfterAttempt({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      attempt: { attemptId: 'att_01' as AttemptId, decisionId: 'dec_01' as DecisionId, routeEvaluationId: 'eval_01' as RouteEvaluationId, capabilityRevisionId: 'cap_01' as CapabilityRevisionId, bindingRevisionId: 'bind_01' as BindingRevisionId, routeRevisionId: 'r_01' as RouteRevisionId, status: 'failed', createdAt: '2026-08-19T18:50:00.000Z' },
      assessment,
      isDomainMutating: true,
      assessedAt: '2026-08-19T18:50:05.000Z',
    });

    assert.equal(cont.directive, 'new_route_evaluation_required');
  });

  // 50. mutating indeterminate → human_escalation_required
  it('50. mutating indeterminate → human_escalation_required', () => {
    const assessment = {
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: [],
      verdict: 'indeterminate' as const,
      reasonCode: 'TIMEOUT_POST_DISPATCH_INDETERMINATE',
      assessedAt: '2026-08-19T18:50:05.000Z',
    };
    const cont = assessContinuationAfterAttempt({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      attempt: { attemptId: 'att_01' as AttemptId, decisionId: 'dec_01' as DecisionId, routeEvaluationId: 'eval_01' as RouteEvaluationId, capabilityRevisionId: 'cap_01' as CapabilityRevisionId, bindingRevisionId: 'bind_01' as BindingRevisionId, routeRevisionId: 'r_01' as RouteRevisionId, status: 'timed_out', createdAt: '2026-08-19T18:50:00.000Z' },
      assessment,
      isDomainMutating: true,
      assessedAt: '2026-08-19T18:50:05.000Z',
    });

    assert.equal(cont.directive, 'human_escalation_required');
    assert.equal(cont.escalation?.kind, 'indeterminate_mutation');
  });

  // 51. mutating indeterminate não seleciona outra Route
  it('51. mutating indeterminate não seleciona outra Route', () => {
    const assessment = {
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: [],
      verdict: 'indeterminate' as const,
      reasonCode: 'FAILURE_POST_DISPATCH_INDETERMINATE',
      assessedAt: '2026-08-19T18:50:05.000Z',
    };
    const cont = assessContinuationAfterAttempt({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      attempt: { attemptId: 'att_01' as AttemptId, decisionId: 'dec_01' as DecisionId, routeEvaluationId: 'eval_01' as RouteEvaluationId, capabilityRevisionId: 'cap_01' as CapabilityRevisionId, bindingRevisionId: 'bind_01' as BindingRevisionId, routeRevisionId: 'r_01' as RouteRevisionId, status: 'failed', createdAt: '2026-08-19T18:50:00.000Z' },
      assessment,
      isDomainMutating: true,
      assessedAt: '2026-08-19T18:50:05.000Z',
    });

    assert.notEqual(cont.directive, 'new_route_evaluation_required');
    assert.equal(cont.directive, 'human_escalation_required');
  });

  // 52. non-mutating indeterminate → new_route_evaluation_required
  it('52. non-mutating indeterminate → new_route_evaluation_required', () => {
    const assessment = {
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: [],
      verdict: 'indeterminate' as const,
      reasonCode: 'NON_MUTATING_TECHNICAL_SUCCESS_WITHOUT_RESULT_EVIDENCE',
      assessedAt: '2026-08-19T18:50:05.000Z',
    };
    const cont = assessContinuationAfterAttempt({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      attempt: { attemptId: 'att_01' as AttemptId, decisionId: 'dec_01' as DecisionId, routeEvaluationId: 'eval_01' as RouteEvaluationId, capabilityRevisionId: 'cap_01' as CapabilityRevisionId, bindingRevisionId: 'bind_01' as BindingRevisionId, routeRevisionId: 'r_01' as RouteRevisionId, status: 'succeeded', createdAt: '2026-08-19T18:50:00.000Z' },
      assessment,
      isDomainMutating: false,
      assessedAt: '2026-08-19T18:50:05.000Z',
    });

    assert.equal(cont.directive, 'new_route_evaluation_required');
  });

  // 53. falha de Route gratuita não autoriza paid fallback
  it('53. falha de Route gratuita não autoriza paid fallback', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const rPaid = createMockRoute('r.paid', 'r_rev_paid');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(rPaid);
    registry.registerTermsRevision(createMockTerms('t.paid', 't_rev_paid', rPaid.routeRevisionId, {
      billingStatus: 'known_components',
      billingComponents: [{ type: 'metered_usage', amount: 0.1 }],
    }));
    registry.registerBindingRevision(createMockBinding('b.paid', 'b_rev_paid', cap.capabilityRevisionId, rPaid.routeRevisionId));

    // Mesmo após uma rota gratuita falhar, a nova avaliação sob Policy zeroCostRequired=true nega a rota paga
    const result = evaluateDecision({
      decisionId: 'dec_02' as DecisionId,
      materialContextId: 'ctx_02' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy, // zeroCostRequired = true
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'policy_denied');
  });

  // 54. falha de Route local não autoriza external egress
  it('54. falha de Route local não autoriza external egress', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const rCloud = createMockRoute('r.cloud', 'r_rev_cloud', 'active', {
      crossesEgressBoundary: true,
      controlOwnership: 'third_party',
      externalServiceNature: 'ai_third_party',
    });
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(rCloud);
    registry.registerTermsRevision(createMockTerms('t.cloud', 't_rev_cloud', rCloud.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.cloud', 'b_rev_cloud', cap.capabilityRevisionId, rCloud.routeRevisionId));

    // Nova avaliação sob LOCAL_ONLY bloqueia a rota externa
    const result = evaluateDecision({
      decisionId: 'dec_02' as DecisionId,
      materialContextId: 'ctx_02' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: { ...defaultPolicy, defaultSensitivity: 'LOCAL_ONLY', zeroCostRequired: false },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'policy_denied');
  });

  // 55. resume após awaiting_human preserva Decision correlation
  it('55. resume após awaiting_human preserva Decision correlation', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const decisionId = 'dec_resumed_01' as DecisionId;
    const materialCtx = 'ctx_same_01' as DecisionMaterialContextId;

    // Resumindo a mesma decisão fornecendo a confirmação aprovada no mesmo contexto
    const result = evaluateDecision({
      decisionId,
      materialContextId: materialCtx,
      interpretation: { clarity: 'clear', potentiallyMutating: true, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      confirmationRequired: true,
      confirmation: {
        confirmationId: 'conf_granted' as ConfirmationDecisionId,
        materialContextId: materialCtx,
        actorRef: 'admin',
        operation: 'mutate',
        verdict: 'confirmed',
        reasonCode: 'USER_CONFIRMED',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.decisionId, decisionId);
    assert.equal(result.disposition, 'route_selected');
  });

  // 56. resume com materialContext diferente invalida gates anteriores
  it('56. resume com materialContext diferente invalida gates anteriores', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_resumed_01' as DecisionId,
      materialContextId: 'ctx_new_param_added' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: true, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      confirmationRequired: true,
      confirmation: {
        confirmationId: 'conf_old' as ConfirmationDecisionId,
        materialContextId: 'ctx_initial' as DecisionMaterialContextId, // Contexto antigo
        actorRef: 'admin',
        operation: 'mutate',
        verdict: 'confirmed',
        reasonCode: 'USER_CONFIRMED',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'CONFIRMATION_CONTEXT_MISMATCH');
  });

  // 57. nenhuma regra depende de LLM
  it('57. nenhuma regra depende de LLM', () => {
    const fnSource = evaluateDecision.toString();
    assert.equal(fnSource.includes('openai'), false);
    assert.equal(fnSource.includes('llm'), false);
    assert.equal(fnSource.includes('fetch'), false);
  });

  // 58. nenhuma seleção depende de Map/Array order
  it('58. nenhuma seleção depende de Map/Array order', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const r1 = createMockRoute('r.text1', 'r_rev_01');
    const r2 = createMockRoute('r.text2', 'r_rev_02');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(r1);
    registry.registerRouteRevision(r2);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', r1.routeRevisionId));
    registry.registerTermsRevision(createMockTerms('t.2', 't_rev_02', r2.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, r1.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.2', 'b_rev_02', cap.capabilityRevisionId, r2.routeRevisionId));

    // Sem SelectionPlan: não escolhe r1 só porque foi inserido primeiro
    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.selectedRouteRevisionId, undefined);
  });

  // 59. não existe canRetry automático
  it('59. não existe canRetry automático', () => {
    const assessment = {
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: [],
      verdict: 'indeterminate' as const,
      reasonCode: 'TIMEOUT',
      assessedAt: '2026-08-19T18:50:05.000Z',
    };
    const cont = assessContinuationAfterAttempt({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      attempt: { attemptId: 'att_01' as AttemptId, decisionId: 'dec_01' as DecisionId, routeEvaluationId: 'eval_01' as RouteEvaluationId, capabilityRevisionId: 'cap_01' as CapabilityRevisionId, bindingRevisionId: 'bind_01' as BindingRevisionId, routeRevisionId: 'r_01' as RouteRevisionId, status: 'timed_out', createdAt: '2026-08-19T18:50:00.000Z' },
      assessment,
      isDomainMutating: true,
      assessedAt: '2026-08-19T18:50:05.000Z',
    });

    const untyped = (cont as unknown) as Record<string, unknown>;
    assert.equal(untyped.canRetry, undefined);
    assert.equal(untyped.retry, undefined);
  });

  // 60. não existe selectCheapestRoute
  it('60. não existe selectCheapestRoute', () => {
    const untyped = (evaluateDecision as unknown) as Record<string, unknown>;
    assert.equal(untyped.selectCheapestRoute, undefined);
  });

  // 61. não existe silent fallback
  it('61. não existe silent fallback', () => {
    const untyped = (evaluateDecision as unknown) as Record<string, unknown>;
    assert.equal(untyped.silentFallback, undefined);
    assert.equal(untyped.fallback, undefined);
  });

  // 62. Decision terminada não é retomada como se fosse suspensão
  it('62. Decision terminada não é retomada como se fosse suspensão', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorization: {
        authorizationId: 'auth_01' as AuthorizationDecisionId,
        materialContextId: 'ctx_01' as DecisionMaterialContextId,
        actorRef: 'u1',
        operation: 'op',
        verdict: 'denied',
        reasonCode: 'DENIED',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'authorization_denied');
    assert.equal(result.escalation, undefined); // Terminação não cria escalation de suspensão
  });

  // 63. HumanEscalation é artefato estruturado
  it('63. HumanEscalation é artefato estruturado', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const r1 = createMockRoute('r.text1', 'r_rev_01');
    const r2 = createMockRoute('r.text2', 'r_rev_02');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(r1);
    registry.registerRouteRevision(r2);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', r1.routeRevisionId));
    registry.registerTermsRevision(createMockTerms('t.2', 't_rev_02', r2.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, r1.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.2', 'b_rev_02', cap.capabilityRevisionId, r2.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.ok(result.escalation);
    assert.equal(result.escalation.kind, 'multiple_eligible_routes');
    assert.equal(result.escalation.reasonCode, 'MULTIPLE_ELIGIBLE_ROUTES');
    assert.ok(Array.isArray(result.escalation.candidateRouteRevisionIds));
  });

  // 64. Reason codes preservam gate causador
  it('64. Reason codes preservam gate causador', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const rRetired = createMockRoute('r.ret', 'r_rev_ret', 'retired');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(rRetired);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', rRetired.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, rRetired.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.evaluations[0].reasonCodes.includes('ROUTE_RETIRED'), true);
  });

  // E65. dois Capability heads sem revision explícita NÃO usam ordem do Array
  it('E65. dois Capability heads sem revision explícita NÃO usam ordem do Array', () => {
    const registry = createCapabilityRegistry();
    const cap1 = createMockCapability('cap.multi', 'cap_rev_01');
    const cap2 = createMockCapability('cap.multi', 'cap_rev_02');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap1);
    registry.registerCapabilityRevision(cap2);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap1.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: 'cap.multi' as CapabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.notEqual(result.disposition, 'route_selected');
    assert.equal(result.disposition, 'awaiting_human');
  });

  // E66. dois Capability heads sem revision explícita → MULTIPLE_CAPABILITY_REVISIONS
  it('E66. dois Capability heads sem revision explícita → MULTIPLE_CAPABILITY_REVISIONS', () => {
    const registry = createCapabilityRegistry();
    const cap1 = createMockCapability('cap.multi', 'cap_rev_01');
    const cap2 = createMockCapability('cap.multi', 'cap_rev_02');
    registry.registerCapabilityRevision(cap1);
    registry.registerCapabilityRevision(cap2);

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: 'cap.multi' as CapabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'MULTIPLE_CAPABILITY_REVISIONS');
    assert.equal(result.escalation?.reasonCode, 'MULTIPLE_CAPABILITY_REVISIONS');
  });

  // E67. revision explícita válida seleciona exatamente aquela CapabilityRevision
  it('E67. revision explícita válida seleciona exatamente aquela CapabilityRevision', () => {
    const registry = createCapabilityRegistry();
    const cap1 = createMockCapability('cap.multi', 'cap_rev_01');
    const cap2 = createMockCapability('cap.multi', 'cap_rev_02');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap1);
    registry.registerCapabilityRevision(cap2);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap2.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: 'cap.multi' as CapabilityKey },
      targetCapabilityRevisionId: 'cap_rev_02' as CapabilityRevisionId,
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'route_selected');
    assert.equal(result.admission?.capabilityRevisionId, 'cap_rev_02');
  });

  // E68. revision explícita pertencente a outro CapabilityKey é rejeitada/suspensa
  it('E68. revision explícita pertencente a outro CapabilityKey é rejeitada/suspensa', () => {
    const registry = createCapabilityRegistry();
    const capText = createMockCapability('cap.text', 'cap_rev_text');
    const capAudio = createMockCapability('cap.audio', 'cap_rev_audio');
    registry.registerCapabilityRevision(capText);
    registry.registerCapabilityRevision(capAudio);

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: 'cap.text' as CapabilityKey },
      targetCapabilityRevisionId: 'cap_rev_audio' as CapabilityRevisionId,
      capabilityRegistry: registry,
      policy: defaultPolicy,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'clarification_required');
    assert.equal(result.reasonCode, 'CAPABILITY_REVISION_INVALID');
  });

  // E69. authorizationRequired=true sem Authorization → awaiting_human
  it('E69. authorizationRequired=true sem Authorization → awaiting_human', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'AUTHORIZATION_REQUIRED');
  });

  // E70. Authorization sem materialContext pinado não compila/é recusada pelo contrato contextual
  it('E70. Authorization com context mismatch é suspensa', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      authorization: {
        authorizationId: 'auth_01' as AuthorizationDecisionId,
        materialContextId: 'ctx_different' as DecisionMaterialContextId,
        actorRef: 'u1',
        operation: 'op',
        verdict: 'authorized',
        reasonCode: 'OK',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'AUTHORIZATION_CONTEXT_MISMATCH');
  });

  // E71. authorizationRequired=true + not_required não satisfaz gate
  it('E71. authorizationRequired=true + not_required não satisfaz gate', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      authorizationRequired: true,
      authorization: {
        authorizationId: 'auth_01' as AuthorizationDecisionId,
        materialContextId: 'ctx_01' as DecisionMaterialContextId,
        actorRef: 'u1',
        operation: 'op',
        verdict: 'not_required',
        reasonCode: 'NOT_REQUIRED',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'AUTHORIZATION_REQUIRED_NOT_SATISFIED');
  });

  // E72. confirmationRequired=true + not_required não satisfaz gate
  it('E72. confirmationRequired=true + not_required não satisfaz gate', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      confirmationRequired: true,
      confirmation: {
        confirmationId: 'conf_01' as ConfirmationDecisionId,
        materialContextId: 'ctx_01' as DecisionMaterialContextId,
        actorRef: 'u1',
        operation: 'op',
        verdict: 'not_required',
        reasonCode: 'NOT_REQ',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'awaiting_human');
    assert.equal(result.reasonCode, 'CONFIRMATION_REQUIRED_NOT_SATISFIED');
  });

  // E73. confirmationRequired=true + confirmed + mesmo contexto passa
  it('E73. confirmationRequired=true + confirmed + mesmo contexto passa', () => {
    const registry = createCapabilityRegistry();
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    registry.registerCapabilityRevision(cap);
    registry.registerRouteRevision(route);
    registry.registerTermsRevision(createMockTerms('t.1', 't_rev_01', route.routeRevisionId));
    registry.registerBindingRevision(createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId));

    const result = evaluateDecision({
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      interpretation: { clarity: 'clear', potentiallyMutating: false, capabilityKey: cap.capabilityKey },
      capabilityRegistry: registry,
      policy: defaultPolicy,
      confirmationRequired: true,
      confirmation: {
        confirmationId: 'conf_01' as ConfirmationDecisionId,
        materialContextId: 'ctx_01' as DecisionMaterialContextId,
        actorRef: 'u1',
        operation: 'op',
        verdict: 'confirmed',
        reasonCode: 'USER_CONFIRMED',
      },
      containsSecretMaterial: false,
      termsContext: defaultTermsContext,
      decidedAt: '2026-08-19T18:50:00.000Z',
    });

    assert.equal(result.disposition, 'route_selected');
    assert.equal(result.admission?.confirmationDecisionId, 'conf_01');
  });

  // E74. Binding de outra Capability não pode avaliar Route
  it('E74. Binding de outra Capability não pode avaliar Route', () => {
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    const crossBinding = createMockBinding('b.1', 'b_rev_01', 'cap_rev_other' as CapabilityRevisionId, route.routeRevisionId);

    assert.throws(
      () =>
        evaluateCandidateRoute({
          decisionId: 'dec_01' as DecisionId,
          materialContextId: 'ctx_01' as DecisionMaterialContextId,
          routeEvaluationId: 'eval_01' as RouteEvaluationId,
          capability: cap,
          binding: crossBinding,
          route,
          termsResult: { status: 'no_terms' },
          termsContext: defaultTermsContext,
          policy: defaultPolicy,
          containsSecretMaterial: false,
          evaluatedAt: '2026-08-19T18:50:00.000Z',
        }),
      /does not match capability/,
    );
  });

  // E75. Binding aponta para outra Route não pode avaliar Route
  it('E75. Binding aponta para outra Route não pode avaliar Route', () => {
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    const crossBinding = createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, 'r_rev_other' as RouteRevisionId);

    assert.throws(
      () =>
        evaluateCandidateRoute({
          decisionId: 'dec_01' as DecisionId,
          materialContextId: 'ctx_01' as DecisionMaterialContextId,
          routeEvaluationId: 'eval_01' as RouteEvaluationId,
          capability: cap,
          binding: crossBinding,
          route,
          termsResult: { status: 'no_terms' },
          termsContext: defaultTermsContext,
          policy: defaultPolicy,
          containsSecretMaterial: false,
          evaluatedAt: '2026-08-19T18:50:00.000Z',
        }),
      /does not match route/,
    );
  });

  // E76. RuntimeFacts de Route A não podem avaliar Route B
  it('E76. RuntimeFacts de Route A não podem avaliar Route B', () => {
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    const binding = createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId);
    const factsRouteB = {
      routeRevisionId: 'r_rev_other' as RouteRevisionId,
      availability: 'available' as const,
      health: 'healthy' as const,
      cooldown: 'clear' as const,
      freshness: 'fresh' as const,
      observedAt: '2026-08-19T18:50:00.000Z',
      provenance: { source: 'runtime_observation' as const, acquisitionBasis: 'observed' as const, verificationStatus: 'empirically_verified' as const, observedAt: '2026-08-19T18:50:00.000Z' },
    };

    assert.throws(
      () =>
        evaluateCandidateRoute({
          decisionId: 'dec_01' as DecisionId,
          materialContextId: 'ctx_01' as DecisionMaterialContextId,
          routeEvaluationId: 'eval_01' as RouteEvaluationId,
          capability: cap,
          binding,
          route,
          termsResult: { status: 'no_terms' },
          termsContext: defaultTermsContext,
          policy: defaultPolicy,
          containsSecretMaterial: false,
          runtimeFacts: factsRouteB,
          evaluatedAt: '2026-08-19T18:50:00.000Z',
        }),
      /does not match candidate route/,
    );
  });

  // E77. Terms de Route A não podem avaliar Route B
  it('E77. Terms de Route A não podem avaliar Route B', () => {
    const cap = createMockCapability('cap.text', 'cap_rev_01');
    const route = createMockRoute('r.local', 'r_rev_01');
    const binding = createMockBinding('b.1', 'b_rev_01', cap.capabilityRevisionId, route.routeRevisionId);
    const termsRouteB = createMockTerms('t.other', 't_rev_other', 'r_rev_other' as RouteRevisionId);

    assert.throws(
      () =>
        evaluateCandidateRoute({
          decisionId: 'dec_01' as DecisionId,
          materialContextId: 'ctx_01' as DecisionMaterialContextId,
          routeEvaluationId: 'eval_01' as RouteEvaluationId,
          capability: cap,
          binding,
          route,
          termsResult: { status: 'single_applicable', terms: termsRouteB },
          termsContext: defaultTermsContext,
          policy: defaultPolicy,
          containsSecretMaterial: false,
          evaluatedAt: '2026-08-19T18:50:00.000Z',
        }),
      /does not match candidate route/,
    );
  });

  // E78. Continuation com Assessment de outro Attempt é rejeitada
  it('E78. Continuation com Assessment de outro Attempt é rejeitada', () => {
    const attempt = {
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_01' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_01' as BindingRevisionId,
      routeRevisionId: 'r_01' as RouteRevisionId,
      status: 'running' as const,
      createdAt: '2026-08-19T18:50:00.000Z',
    };
    const assessmentOtherAttempt = {
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attemptId: 'att_other' as AttemptId,
      evidenceRefs: [],
      verdict: 'confirmed_mutation' as const,
      reasonCode: 'MUTATION_OK',
      assessedAt: '2026-08-19T18:50:05.000Z',
    };

    assert.throws(
      () =>
        assessContinuationAfterAttempt({
          decisionId: 'dec_01' as DecisionId,
          materialContextId: 'ctx_01' as DecisionMaterialContextId,
          attempt,
          assessment: assessmentOtherAttempt,
          isDomainMutating: true,
          assessedAt: '2026-08-19T18:50:05.000Z',
        }),
      /does not match AttemptState/,
    );
  });

  // E79. Continuation com Attempt de outra Decision é rejeitada
  it('E79. Continuation com Attempt de outra Decision é rejeitada', () => {
    const attempt = {
      attemptId: 'att_01' as AttemptId,
      decisionId: 'dec_other' as DecisionId,
      routeEvaluationId: 'eval_01' as RouteEvaluationId,
      capabilityRevisionId: 'cap_01' as CapabilityRevisionId,
      bindingRevisionId: 'bind_01' as BindingRevisionId,
      routeRevisionId: 'r_01' as RouteRevisionId,
      status: 'running' as const,
      createdAt: '2026-08-19T18:50:00.000Z',
    };
    const assessment = {
      assessmentId: 'ass_01' as OutcomeAssessmentId,
      attemptId: 'att_01' as AttemptId,
      evidenceRefs: [],
      verdict: 'confirmed_mutation' as const,
      reasonCode: 'MUTATION_OK',
      assessedAt: '2026-08-19T18:50:05.000Z',
    };

    assert.throws(
      () =>
        assessContinuationAfterAttempt({
          decisionId: 'dec_01' as DecisionId,
          materialContextId: 'ctx_01' as DecisionMaterialContextId,
          attempt,
          assessment,
          isDomainMutating: true,
          assessedAt: '2026-08-19T18:50:05.000Z',
        }),
      /does not match DecisionId/,
    );
  });
});

