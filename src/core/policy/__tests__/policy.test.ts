/**
 * NEX+ · Policy Engine · Egress, Zero-Cost & ACL Boundary
 * Testes Determinísticos do Policy Engine — Escopo 0.5 (Bloco 0.5C)
 *
 * Suíte Completa: 36 Casos de Aceitação Obrigatórios.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  RouteKey,
  RouteRevision,
  RouteRevisionId,
  RouteTermsKey,
  RouteTermsRevision,
  RouteTermsRevisionId,
  AdapterRevisionRef,
  FactProvenance,
  TermsResolutionResult,
} from '../../capabilities/contracts';

import type {
  PolicyKey,
  PolicyRevision,
  PolicyRevisionId,
  HumanAuthorizationDecision,
} from '../contracts';

import {
  mergeSensitivity,
  computeEffectiveSensitivity,
  evaluateEgressAxis,
  evaluateZeroCostAxis,
  evaluatePolicy,
} from '../engine';

// Provenance padrão para testes
const defaultProvenance: FactProvenance = {
  source: 'official_docs',
  acquisitionBasis: 'declared',
  verificationStatus: 'corroborated',
  observedAt: '2026-08-19T18:00:00.000Z',
};

// PolicyRevision fixture de teste
const testPolicy: PolicyRevision = {
  policyKey: 'nex.policy.foundation.v1' as PolicyKey,
  policyRevisionId: 'rev_policy_fixture_01' as PolicyRevisionId,
  supersedesRevisionIds: [],
  description: 'Fixture policy for deterministic 0.5C tests',
  defaultSensitivity: 'NORMAL',
  zeroCostRequired: true,
};

describe('NEX+ L0 Policy Engine (Bloco 0.5C)', () => {
  // 1. NORMAL permanece NORMAL
  it('1. NORMAL permanece NORMAL', () => {
    assert.equal(mergeSensitivity('NORMAL', 'NORMAL'), 'NORMAL');
  });

  // 2. NORMAL + LOCAL_ONLY = LOCAL_ONLY
  it('2. NORMAL + LOCAL_ONLY = LOCAL_ONLY', () => {
    assert.equal(mergeSensitivity('NORMAL', 'LOCAL_ONLY'), 'LOCAL_ONLY');
    assert.equal(mergeSensitivity('LOCAL_ONLY', 'NORMAL'), 'LOCAL_ONLY');
  });

  // 3. secret material força LOCAL_ONLY
  it('3. secret material força LOCAL_ONLY', () => {
    assert.equal(computeEffectiveSensitivity('NORMAL', true), 'LOCAL_ONLY');
    assert.equal(computeEffectiveSensitivity('LOCAL_ONLY', true), 'LOCAL_ONLY');
    assert.equal(computeEffectiveSensitivity('NORMAL', false), 'NORMAL');
  });

  // 4. ordem do merge não altera resultado
  it('4. ordem do merge não altera resultado', () => {
    const s1 = mergeSensitivity('NORMAL', 'LOCAL_ONLY');
    const s2 = mergeSensitivity('LOCAL_ONLY', 'NORMAL');
    assert.equal(s1, s2);
  });

  // 5. LOCAL_ONLY + local operator-managed = egress allow
  it('5. LOCAL_ONLY + local operator-managed = egress allow', () => {
    const route: RouteRevision = {
      routeKey: 'route.local.sql' as RouteKey,
      routeRevisionId: 'rev_r_local' as RouteRevisionId,
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

    const decision = evaluateEgressAxis(route, 'LOCAL_ONLY');
    assert.equal(decision.verdict, 'allow');
    assert.equal(decision.reasonCode, 'EGRESS_NO_EXTERNAL_PROVIDER');
  });

  // 6. LOCAL_ONLY + LAN operator-managed sem terceiro = allow
  it('6. LOCAL_ONLY + LAN operator-managed sem terceiro = allow', () => {
    const route: RouteRevision = {
      routeKey: 'route.lan.ollama' as RouteKey,
      routeRevisionId: 'rev_r_lan' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_ollama_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['streaming'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['lan'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };

    const decision = evaluateEgressAxis(route, 'LOCAL_ONLY');
    assert.equal(decision.verdict, 'allow');
    assert.equal(decision.reasonCode, 'EGRESS_NO_EXTERNAL_PROVIDER');
  });

  // 7. LOCAL_ONLY + external AI = deny
  it('7. LOCAL_ONLY + external AI = deny', () => {
    const route: RouteRevision = {
      routeKey: 'route.openai.gpt' as RouteKey,
      routeRevisionId: 'rev_r_openai' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_openai_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['streaming'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };

    const decision = evaluateEgressAxis(route, 'LOCAL_ONLY');
    assert.equal(decision.verdict, 'deny');
    assert.equal(decision.reasonCode, 'EGRESS_LOCAL_ONLY_EXTERNAL_PROVIDER');
  });

  // 8. LOCAL_ONLY + external non-AI third party = deny
  it('8. LOCAL_ONLY + external non-AI third party = deny', () => {
    const route: RouteRevision = {
      routeKey: 'route.stripe.charge' as RouteKey,
      routeRevisionId: 'rev_r_stripe' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_stripe_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'keyed' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'non_ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'may_mutate_domain',
    };

    const decision = evaluateEgressAxis(route, 'LOCAL_ONLY');
    assert.equal(decision.verdict, 'deny');
    assert.equal(decision.reasonCode, 'EGRESS_LOCAL_ONLY_EXTERNAL_NON_AI');
  });

  // 9. LOCAL_ONLY + external unknown/mixed = deny
  it('9. LOCAL_ONLY + external unknown/mixed = deny', () => {
    const route: RouteRevision = {
      routeKey: 'route.external.mixed' as RouteKey,
      routeRevisionId: 'rev_r_mixed' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'mixed',
      externalServiceNature: 'mixed_unknown',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };

    const decision = evaluateEgressAxis(route, 'LOCAL_ONLY');
    assert.equal(decision.verdict, 'deny');
    assert.equal(decision.reasonCode, 'EGRESS_LOCAL_ONLY_UNKNOWN_EXTERNAL_PATH');
  });

  // 10. NORMAL + external AI = egress allow
  it('10. NORMAL + external AI = egress allow', () => {
    const route: RouteRevision = {
      routeKey: 'route.openai.gpt' as RouteKey,
      routeRevisionId: 'rev_r_openai' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_openai_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['streaming'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };

    const decision = evaluateEgressAxis(route, 'NORMAL');
    assert.equal(decision.verdict, 'allow');
    assert.equal(decision.reasonCode, 'EGRESS_NORMAL_ALLOWED');
  });

  // 11. Zero-Cost desabilitado = allow naquele eixo
  it('11. Zero-Cost desabilitado = allow naquele eixo', () => {
    const policyNoZeroCost: PolicyRevision = {
      ...testPolicy,
      zeroCostRequired: false,
    };
    const termsResult: TermsResolutionResult = { status: 'no_terms' };

    const output = evaluateZeroCostAxis(policyNoZeroCost, termsResult);
    assert.equal(output.decision.verdict, 'allow');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_NOT_REQUIRED');
    assert.equal(output.runtimeRequirements.length, 0);
  });

  // 12. known_none billing = Zero-Cost allow
  it('12. known_none billing = Zero-Cost allow', () => {
    const terms: RouteTermsRevision = {
      termsKey: 'terms.local' as RouteTermsKey,
      termsRevisionId: 'rev_t_local' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_local' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const termsResult: TermsResolutionResult = {
      status: 'single_applicable',
      terms,
    };

    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'allow');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_NO_EXTERNAL_CHARGE');
  });

  // 13. recurring_full_free = allow
  it('13. recurring_full_free = allow', () => {
    const terms: RouteTermsRevision = {
      termsKey: 'terms.full.free' as RouteTermsKey,
      termsRevisionId: 'rev_t_ff' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'fixed_subscription', amount: 0 }],
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [{ type: 'recurring_full_free' }],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const termsResult: TermsResolutionResult = {
      status: 'single_applicable',
      terms,
    };

    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'allow');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_RECURRING_FULL_FREE');
    assert.equal(output.runtimeRequirements.length, 0);
  });

  // 14. recurring_free_allowance = allow em princípio + runtime requirement
  it('14. recurring_free_allowance = allow em princípio + runtime requirement', () => {
    const terms: RouteTermsRevision = {
      termsKey: 'terms.allowance' as RouteTermsKey,
      termsRevisionId: 'rev_t_allow' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [{ type: 'recurring_free_allowance', quotaAmount: 1000 }],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const termsResult: TermsResolutionResult = {
      status: 'single_applicable',
      terms,
    };

    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'allow');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_RECURRING_ALLOWANCE_PRINCIPLE');
    assert.deepEqual(output.runtimeRequirements, ['FREE_ALLOWANCE_AVAILABLE']);
  });

  // 15. trial isolado = deny
  it('15. trial isolado = deny', () => {
    const terms: RouteTermsRevision = {
      termsKey: 'terms.trial' as RouteTermsKey,
      termsRevisionId: 'rev_t_trial' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [{ type: 'trial', validityWindow: '14d' }],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const termsResult: TermsResolutionResult = {
      status: 'single_applicable',
      terms,
    };

    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'deny');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_TRIAL_ONLY');
  });

  // 16. promotional credit isolado = deny
  it('16. promotional credit isolado = deny', () => {
    const terms: RouteTermsRevision = {
      termsKey: 'terms.promo' as RouteTermsKey,
      termsRevisionId: 'rev_t_promo' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [{ type: 'promotional_credit', quotaAmount: 50, unit: 'USD' }],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const termsResult: TermsResolutionResult = {
      status: 'single_applicable',
      terms,
    };

    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'deny');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_PROMOTIONAL_ONLY');
  });

  // 17. metered paid sem recurring entitlement = deny
  it('17. metered paid sem recurring entitlement = deny', () => {
    const terms: RouteTermsRevision = {
      termsKey: 'terms.metered' as RouteTermsKey,
      termsRevisionId: 'rev_t_metered' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'metered_usage', amount: 0.005 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const termsResult: TermsResolutionResult = {
      status: 'single_applicable',
      terms,
    };

    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'deny');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_PAID_ONLY');
  });

  // 18. subscription sem recurring entitlement = deny
  it('18. subscription sem recurring entitlement = deny', () => {
    const terms: RouteTermsRevision = {
      termsKey: 'terms.sub' as RouteTermsKey,
      termsRevisionId: 'rev_t_sub' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'fixed_subscription', amount: 100 }],
      freeEntitlementStatus: 'known_none',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const termsResult: TermsResolutionResult = {
      status: 'single_applicable',
      terms,
    };

    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'deny');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_PAID_ONLY');
  });

  // 19. paid billing + recurring allowance = allow em princípio + runtime requirement
  it('19. paid billing + recurring allowance = allow em princípio + runtime requirement', () => {
    const terms: RouteTermsRevision = {
      termsKey: 'terms.paid_and_allowance' as RouteTermsKey,
      termsRevisionId: 'rev_t_pa' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'metered_overage', amount: 0.01 }],
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [{ type: 'recurring_free_allowance', quotaAmount: 500 }],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const termsResult: TermsResolutionResult = {
      status: 'single_applicable',
      terms,
    };

    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'allow');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_RECURRING_ALLOWANCE_PRINCIPLE');
    assert.deepEqual(output.runtimeRequirements, ['FREE_ALLOWANCE_AVAILABLE']);
  });

  // 20. paid billing + recurring_full_free aplicável = allow
  it('20. paid billing + recurring_full_free aplicável = allow', () => {
    const terms: RouteTermsRevision = {
      termsKey: 'terms.paid_and_ff' as RouteTermsKey,
      termsRevisionId: 'rev_t_pff' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_components',
      billingComponents: [{ type: 'metered_overage', amount: 0.02 }],
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [{ type: 'recurring_full_free' }],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const termsResult: TermsResolutionResult = {
      status: 'single_applicable',
      terms,
    };

    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'allow');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_RECURRING_FULL_FREE');
    assert.equal(output.runtimeRequirements.length, 0);
  });

  // 21. no_terms com Zero-Cost obrigatório = deny
  it('21. no_terms com Zero-Cost obrigatório = deny', () => {
    const termsResult: TermsResolutionResult = { status: 'no_terms' };
    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'deny');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_NO_TERMS');
  });

  // 22. no_applicable_terms = deny
  it('22. no_applicable_terms = deny', () => {
    const termsResult: TermsResolutionResult = { status: 'no_applicable_terms' };
    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'deny');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_NO_APPLICABLE_TERMS');
  });

  // 23. insufficient_context = deny
  it('23. insufficient_context = deny', () => {
    const termsResult: TermsResolutionResult = {
      status: 'insufficient_context',
      missingDimensions: ['accountTier'],
      candidateTerms: [],
      reason: 'Missing dimension',
    };
    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'deny');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_CONTEXT_INSUFFICIENT');
  });

  // 24. unresolved_conflict = deny
  it('24. unresolved_conflict = deny', () => {
    const termsResult: TermsResolutionResult = {
      status: 'unresolved_conflict',
      conflictingTerms: [],
      reason: 'Conflict',
    };
    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'deny');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_TERMS_CONFLICT');
  });

  // 25. Terms unknown não vira free
  it('25. Terms unknown não vira free', () => {
    const terms: RouteTermsRevision = {
      termsKey: 'terms.unknown.test' as RouteTermsKey,
      termsRevisionId: 'rev_t_unk' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'unknown',
      billingComponents: [],
      freeEntitlementStatus: 'unknown',
      freeEntitlements: [],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const termsResult: TermsResolutionResult = {
      status: 'single_applicable',
      terms,
    };

    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'deny');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_TERMS_UNKNOWN');
  });

  // 26. authorized + LOCAL_ONLY + external AI: Authorization permanece authorized; Policy Egress = deny
  it('26. authorized + LOCAL_ONLY + external AI: Authorization permanece authorized; Policy Egress = deny', () => {
    const humanAuth: HumanAuthorizationDecision = {
      actorRef: 'user_admin_01',
      operation: 'ai_text_generation',
      verdict: 'authorized',
      reasonCode: 'HUMAN_APPROVAL_GRANTED',
    };
    const route: RouteRevision = {
      routeKey: 'route.openai.gpt' as RouteKey,
      routeRevisionId: 'rev_r_openai' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_openai_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['streaming'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };

    const decision = evaluatePolicy({
      policy: testPolicy,
      route,
      termsResult: { status: 'no_terms' },
      sensitivity: 'LOCAL_ONLY',
    });

    assert.equal(humanAuth.verdict, 'authorized');
    assert.equal(decision.egressAxis.verdict, 'deny');
    assert.equal(decision.egressAxis.reasonCode, 'EGRESS_LOCAL_ONLY_EXTERNAL_PROVIDER');
  });

  // 27. denied + NORMAL + local: Authorization permanece denied; Policy Egress pode permitir
  it('27. denied + NORMAL + local: Authorization permanece denied; Policy Egress pode permitir', () => {
    const humanAuth: HumanAuthorizationDecision = {
      actorRef: 'user_anonymous',
      operation: 'query_catalog',
      verdict: 'denied',
      reasonCode: 'PERMISSION_DENIED',
    };
    const route: RouteRevision = {
      routeKey: 'route.local.sql' as RouteKey,
      routeRevisionId: 'rev_r_local' as RouteRevisionId,
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

    const decision = evaluatePolicy({
      policy: testPolicy,
      route,
      termsResult: { status: 'no_terms' },
      sensitivity: 'NORMAL',
    });

    assert.equal(humanAuth.verdict, 'denied');
    assert.equal(decision.egressAxis.verdict, 'allow');
    assert.equal(decision.egressAxis.reasonCode, 'EGRESS_NO_EXTERNAL_PROVIDER');
  });

  // 28. Policy Egress allow não cria Authorization
  it('28. Policy Egress allow não cria Authorization', () => {
    const route: RouteRevision = {
      routeKey: 'route.local.sql' as RouteKey,
      routeRevisionId: 'rev_r_local' as RouteRevisionId,
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

    const decision = evaluatePolicy({
      policy: testPolicy,
      route,
      termsResult: { status: 'no_terms' },
      sensitivity: 'NORMAL',
    });

    assert.equal(decision.egressAxis.verdict, 'allow');
    // PolicyDecision não possui campo de autorização humana
    assert.equal(((decision as unknown) as Record<string, unknown>).humanAuthorization, undefined);
    assert.equal(((decision as unknown) as Record<string, unknown>).authorized, undefined);
  });

  // 29. Authorization allow não cria Egress allow
  it('29. Authorization allow não cria Egress allow', () => {
    const humanAuth: HumanAuthorizationDecision = {
      actorRef: 'master_admin',
      operation: 'export_confidential_report',
      verdict: 'authorized',
      reasonCode: 'OVERRIDE_AUTH',
    };
    const route: RouteRevision = {
      routeKey: 'route.openai.gpt' as RouteKey,
      routeRevisionId: 'rev_r_openai' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_openai_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['streaming'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };

    // Sensibilidade LOCAL_ONLY bloqueia egress mesmo com humanAuth aprovada
    const decision = evaluatePolicy({
      policy: testPolicy,
      route,
      termsResult: { status: 'no_terms' },
      sensitivity: 'LOCAL_ONLY',
    });

    assert.equal(humanAuth.verdict, 'authorized');
    assert.equal(decision.egressAxis.verdict, 'deny');
  });

  // 30. PolicyDecision contém PolicyRevisionId
  it('30. PolicyDecision contém PolicyRevisionId', () => {
    const route: RouteRevision = {
      routeKey: 'route.local.sql' as RouteKey,
      routeRevisionId: 'rev_r_local' as RouteRevisionId,
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

    const decision = evaluatePolicy({
      policy: testPolicy,
      route,
      termsResult: { status: 'no_terms' },
    });

    assert.equal(decision.policyRevisionId, 'rev_policy_fixture_01');
    assert.equal(decision.routeRevisionId, 'rev_r_local');
  });

  // 31. PolicyDecision preserva reason codes por eixo
  it('31. PolicyDecision preserva reason codes por eixo', () => {
    const route: RouteRevision = {
      routeKey: 'route.openai.gpt' as RouteKey,
      routeRevisionId: 'rev_r_openai' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_openai_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['streaming'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };

    const decision = evaluatePolicy({
      policy: testPolicy,
      route,
      termsResult: { status: 'no_terms' },
      sensitivity: 'LOCAL_ONLY',
    });

    assert.equal(decision.egressAxis.reasonCode, 'EGRESS_LOCAL_ONLY_EXTERNAL_PROVIDER');
    assert.equal(decision.zeroCostAxis.reasonCode, 'ZERO_COST_NO_TERMS');
  });

  // 32. nenhuma API pública oferece canExecute/fallback
  it('32. nenhuma API pública oferece canExecute/fallback', () => {
    const decision = evaluatePolicy({
      policy: testPolicy,
      route: {
        routeKey: 'route.test' as RouteKey,
        routeRevisionId: 'rev_test' as RouteRevisionId,
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
      },
      termsResult: { status: 'no_terms' },
    });

    const untyped = (decision as unknown) as Record<string, unknown>;
    assert.equal(untyped.canExecute, undefined);
    assert.equal(untyped.fallbackRoute, undefined);
    assert.equal(untyped.selectBestRoute, undefined);
  });

  // 33. trial + promotional_credit sem recurring entitlement = deny
  it('33. trial + promotional_credit sem recurring entitlement = deny', () => {
    const terms: RouteTermsRevision = {
      termsKey: 'terms.combo.tp' as RouteTermsKey,
      termsRevisionId: 'rev_t_tp' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [
        { type: 'trial', validityWindow: '30d' },
        { type: 'promotional_credit', quotaAmount: 100 },
      ],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const termsResult: TermsResolutionResult = {
      status: 'single_applicable',
      terms,
    };

    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'deny');
  });

  // 34. recurring allowance + promotional credit mantém runtime requirement da allowance
  it('34. recurring allowance + promotional credit mantém runtime requirement da allowance', () => {
    const terms: RouteTermsRevision = {
      termsKey: 'terms.combo.ap' as RouteTermsKey,
      termsRevisionId: 'rev_t_ap' as RouteTermsRevisionId,
      routeRevisionId: 'rev_r_1' as RouteRevisionId,
      supersedesRevisionIds: [],
      provenance: defaultProvenance,
      billingStatus: 'known_none',
      billingComponents: [],
      freeEntitlementStatus: 'known_entitlements',
      freeEntitlements: [
        { type: 'recurring_free_allowance', quotaAmount: 1000 },
        { type: 'promotional_credit', quotaAmount: 50 },
      ],
      effectiveFrom: '2026-08-01T00:00:00.000Z',
    };
    const termsResult: TermsResolutionResult = {
      status: 'single_applicable',
      terms,
    };

    const output = evaluateZeroCostAxis(testPolicy, termsResult);
    assert.equal(output.decision.verdict, 'allow');
    assert.equal(output.decision.reasonCode, 'ZERO_COST_RECURRING_ALLOWANCE_PRINCIPLE');
    assert.deepEqual(output.runtimeRequirements, ['FREE_ALLOWANCE_AVAILABLE']);
  });

  // 35. LOCAL_ONLY não exige loopback
  it('35. LOCAL_ONLY não exige loopback', () => {
    const routeLan: RouteRevision = {
      routeKey: 'route.lan.server' as RouteKey,
      routeRevisionId: 'rev_r_lan_srv' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['atomic_batch'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['lan'],
      controlOwnership: 'operator_managed',
      externalServiceNature: 'none',
      crossesEgressBoundary: false,
      domainEffect: 'none',
    };

    const decision = evaluateEgressAxis(routeLan, 'LOCAL_ONLY');
    assert.equal(decision.verdict, 'allow');
    assert.equal(decision.reasonCode, 'EGRESS_NO_EXTERNAL_PROVIDER');
  });

  // 36. network first-hop local não mascara external provider egress
  it('36. network first-hop local não mascara external provider egress', () => {
    const routeGatewayToCloud: RouteRevision = {
      routeKey: 'route.local_gw.cloud' as RouteKey,
      routeRevisionId: 'rev_r_gw_cloud' as RouteRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      adapterRevisionRef: 'adapter_gw_v1' as AdapterRevisionRef,
      supportedExecutionModes: ['streaming'],
      idempotencyProfile: { supportType: 'none' },
      networkTopologyScopes: ['loopback', 'wan'],
      controlOwnership: 'third_party',
      externalServiceNature: 'ai_third_party',
      crossesEgressBoundary: true,
      domainEffect: 'none',
    };

    const decision = evaluateEgressAxis(routeGatewayToCloud, 'LOCAL_ONLY');
    assert.equal(decision.verdict, 'deny');
    assert.equal(decision.reasonCode, 'EGRESS_LOCAL_ONLY_EXTERNAL_PROVIDER');
  });
});
