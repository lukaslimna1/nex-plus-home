/**
 * NEX+ · Testes Unitários de Contratos, Invariantes e Composição do Contexto Operacional
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { HumanActor, MaxActor, SystemActor, IntegrationActor, Actor } from '../../observations/contracts';
import type { SessionRef } from '../../../auth/session-ref.types';
import type { ModuleRef, ResourceRef, CorrelationId } from '../../modules/contracts';
import type {
  ContextSubjectRef,
  ContextSubjectType,
  ContextSubjectId,
  FlowRef,
  FlowType,
  FlowId,
  ContextScopeRef,
  ContextScopeType,
  ContextScopeId,
  ContextAnchorRef,
  OperationalLocation,
  ContextAspectRef,
  ContextAspectKey,
  OperationalFocus,
  ObservedInteractionContext,
  OperationalChannel,
  OperationVerb,
} from '../contracts';
import {
  validateActor,
  validateContextSubjectRef,
  validateFlowRef,
  validateContextScopeRef,
  validateContextAnchorRef,
  validateOperationalLocation,
  validateContextAspectRef,
  validateOperationalFocus,
  validateObservedInteractionContext,
  validateOperationalContext,
  validateSessionOperationalState,
} from '../invariants';
import { composeOperationalContext } from '../compose';
import {
  OperationalContextInvariantError,
  SessionOperationalStateInvariantError,
} from '../errors';

const VALID_SESSION_REF_A = 'a'.repeat(64) as SessionRef;
const VALID_SESSION_REF_B = 'b'.repeat(64) as SessionRef;

describe('0.86B-2 · Actor Allowlist & Runtime Strictness (Blocker 2)', () => {
  it('valida HumanActor canônico e aceita campos opcionais canônicos (role, authorityRef)', () => {
    const minimalHuman: HumanActor = { kind: 'human', humanId: 'u1' };
    assert.doesNotThrow(() => validateActor(minimalHuman));

    const fullHuman: HumanActor = {
      kind: 'human',
      humanId: 'u1',
      role: 'managing_partner',
      authorityRef: 'auth_ref_123',
    };
    assert.doesNotThrow(() => validateActor(fullHuman));
  });

  it('rejeita HumanActor com token, jwt, secret, password ou campos arbitrários extras', () => {
    const humanWithToken = {
      kind: 'human',
      humanId: 'u1',
      token: 'SUPER_SECRET_TOKEN',
    };
    assert.throws(
      () => validateActor(humanWithToken),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );

    const humanWithJwt = {
      kind: 'human',
      humanId: 'u1',
      jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    };
    assert.throws(
      () => validateActor(humanWithJwt),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );

    const humanWithArbitrary = {
      kind: 'human',
      humanId: 'u1',
      metadata: { leaked: true },
    };
    assert.throws(
      () => validateActor(humanWithArbitrary),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
  });

  it('valida MaxActor canônico com sessionRef opcional e rejeita campos extras', () => {
    const minimalMax: MaxActor = { kind: 'max', maxVersion: '1.0.0' };
    assert.doesNotThrow(() => validateActor(minimalMax));

    const maxWithSession: MaxActor = {
      kind: 'max',
      maxVersion: '1.0.0',
      sessionRef: 'internal_max_session_123',
    };
    assert.doesNotThrow(() => validateActor(maxWithSession));

    const maxWithSecret = {
      kind: 'max',
      maxVersion: '1.0.0',
      secret: 'API_KEY_SECRET',
    };
    assert.throws(
      () => validateActor(maxWithSecret),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
  });

  it('valida SystemActor canônico com version opcional e rejeita jwt extra', () => {
    const sysActor: SystemActor = {
      kind: 'system',
      component: 'reconciliation_engine',
      version: '2.1.0',
    };
    assert.doesNotThrow(() => validateActor(sysActor));

    const sysWithJwt = {
      kind: 'system',
      component: 'reconciliation_engine',
      jwt: 'secret_jwt_data',
    };
    assert.throws(
      () => validateActor(sysWithJwt),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
  });

  it('valida IntegrationActor canônico com integrationId opcional e rejeita password extra', () => {
    const intActor: IntegrationActor = {
      kind: 'integration',
      provider: 'bling',
      integrationId: 'bling_conn_456',
    };
    assert.doesNotThrow(() => validateActor(intActor));

    const intWithPassword = {
      kind: 'integration',
      provider: 'bling',
      password: 'mypassword',
    };
    assert.throws(
      () => validateActor(intWithPassword),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
  });

  it('reconstrução defensiva na composição não propaga campos arbitrários nem segredos', () => {
    const cleanHuman: HumanActor = {
      kind: 'human',
      humanId: 'usr_lucas',
      role: 'admin',
    };

    const ctx = composeOperationalContext({
      actor: cleanHuman,
      userId: 'usr_lucas',
      sessionRef: VALID_SESSION_REF_A,
    });

    assert.deepEqual(Object.keys(ctx.actor).sort(), ['authorityRef', 'humanId', 'kind', 'role'].filter(k => (ctx.actor as any)[k] !== undefined).sort());
    assert.equal(ctx.actor.kind, 'human');
    assert.equal(ctx.actor.humanId, 'usr_lucas');
  });
});

describe('0.86B-2 · ContextSubjectRef & FlowRef Invariants', () => {
  it('valida ContextSubjectRef válido com subjectType extensível', () => {
    const subject: ContextSubjectRef = {
      subjectType: 'brand' as ContextSubjectType,
      subjectId: 'alterstate' as ContextSubjectId,
    };
    assert.doesNotThrow(() => validateContextSubjectRef(subject));

    // Sujeito futuro não-brand
    const orgSubject: ContextSubjectRef = {
      subjectType: 'organization' as ContextSubjectType,
      subjectId: 'org_999' as ContextSubjectId,
    };
    assert.doesNotThrow(() => validateContextSubjectRef(orgSubject));
  });

  it('rejeita ContextSubjectRef com campos extras ou inválidos', () => {
    assert.throws(
      () => validateContextSubjectRef(null),
      OperationalContextInvariantError
    );
    assert.throws(
      () => validateContextSubjectRef({ subjectType: '', subjectId: '123' }),
      (err: any) => err.violationType === 'INVALID_SUBJECT_TYPE'
    );
    assert.throws(
      () => validateContextSubjectRef({ subjectType: 'brand', subjectId: '   ' }),
      (err: any) => err.violationType === 'INVALID_SUBJECT_ID'
    );
    assert.throws(
      () => validateContextSubjectRef({ subjectType: 'brand', subjectId: 'alterstate', extra: 'data' } as any),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
  });

  it('valida FlowRef válido e rejeita inválido ou com campos extras', () => {
    const validFlow: FlowRef = {
      flowType: 'supplier_onboarding' as FlowType,
      flowId: 'flow_123' as FlowId,
    };
    assert.doesNotThrow(() => validateFlowRef(validFlow));

    assert.throws(
      () => validateFlowRef({ flowType: '', flowId: '123' }),
      (err: any) => err.violationType === 'INVALID_FLOW_TYPE'
    );
    assert.throws(
      () => validateFlowRef({ flowType: 'flow', flowId: '' }),
      (err: any) => err.violationType === 'INVALID_FLOW_ID'
    );
    assert.throws(
      () => validateFlowRef({ flowType: 'flow', flowId: '123', extraField: true } as any),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
  });
});

describe('0.86B-2 · ContextScopeRef, ContextAnchorRef & OperationalLocation', () => {
  const moduleRef: ModuleRef = { moduleKey: 'fornecedores' as any };

  it('valida ContextScopeRef válido e rejeita inválido', () => {
    const scope: ContextScopeRef = {
      module: moduleRef,
      scopeType: 'supplier-category' as ContextScopeType,
      scopeId: 'packaging' as ContextScopeId,
    };
    assert.doesNotThrow(() => validateContextScopeRef(scope));

    assert.throws(
      () => validateContextScopeRef({ module: { moduleKey: '' }, scopeType: 'cat', scopeId: '1' }),
      (err: any) => err.violationType === 'INVALID_SCOPE_MODULE'
    );
    assert.throws(
      () => validateContextScopeRef({ module: moduleRef, scopeType: '', scopeId: '1' }),
      (err: any) => err.violationType === 'INVALID_SCOPE_TYPE'
    );
    assert.throws(
      () => validateContextScopeRef({ module: moduleRef, scopeType: 'cat', scopeId: '  ' }),
      (err: any) => err.violationType === 'INVALID_SCOPE_ID'
    );
  });

  it('valida ContextAnchorRef união discriminada estrita (resource e scope)', () => {
    const resourceAnchor: ContextAnchorRef = {
      kind: 'resource',
      resource: {
        ownerModule: moduleRef,
        resourceType: 'supplier' as any,
        resourceId: 'sup_x' as any,
      },
    };
    assert.doesNotThrow(() => validateContextAnchorRef(resourceAnchor));

    const scopeAnchor: ContextAnchorRef = {
      kind: 'scope',
      scope: {
        module: moduleRef,
        scopeType: 'category' as any,
        scopeId: 'boxes' as any,
      },
    };
    assert.doesNotThrow(() => validateContextAnchorRef(scopeAnchor));
  });

  it('rejeita ContextAnchorRef híbrido (kind=resource com scopeRef ou kind=scope com resourceRef) (Gap 1)', () => {
    // 1. kind=resource contendo scope
    const hybridResource = {
      kind: 'resource',
      resource: {
        ownerModule: moduleRef,
        resourceType: 'supplier' as any,
        resourceId: 'sup_x' as any,
      },
      scope: {
        module: moduleRef,
        scopeType: 'category' as any,
        scopeId: 'boxes' as any,
      },
    };
    assert.throws(
      () => validateContextAnchorRef(hybridResource as any),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );

    // 2. kind=scope contendo resource
    const hybridScope = {
      kind: 'scope',
      scope: {
        module: moduleRef,
        scopeType: 'category' as any,
        scopeId: 'boxes' as any,
      },
      resource: {
        ownerModule: moduleRef,
        resourceType: 'supplier' as any,
        resourceId: 'sup_x' as any,
      },
    };
    assert.throws(
      () => validateContextAnchorRef(hybridScope as any),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
  });

  it('valida OperationalLocation com trilha ordenada e rejeita formato incorreto', () => {
    const loc: OperationalLocation = {
      module: moduleRef,
      trail: [
        {
          kind: 'scope',
          scope: { module: moduleRef, scopeType: 'cat' as any, scopeId: 'pack' as any },
        },
        {
          kind: 'resource',
          resource: { ownerModule: moduleRef, resourceType: 'supplier' as any, resourceId: 'sup_1' as any },
        },
      ],
    };
    assert.doesNotThrow(() => validateOperationalLocation(loc));

    // Trilha vazia é permitida quando o módulo for suficiente
    const locEmptyTrail: OperationalLocation = {
      module: moduleRef,
      trail: [],
    };
    assert.doesNotThrow(() => validateOperationalLocation(locEmptyTrail));

    assert.throws(
      () => validateOperationalLocation({ module: { moduleKey: '' }, trail: [] }),
      (err: any) => err.violationType === 'INVALID_LOCATION_MODULE'
    );
    assert.throws(
      () => validateOperationalLocation({ module: moduleRef, trail: 'not-an-array' as any }),
      (err: any) => err.violationType === 'INVALID_LOCATION_TRAIL'
    );
  });
});

describe('0.86B-2 · ContextAspectRef, OperationalFocus & ObservedInteractionContext', () => {
  const moduleRef: ModuleRef = { moduleKey: 'fornecedores' as any };
  const targetAnchor: ContextAnchorRef = {
    kind: 'resource',
    resource: {
      ownerModule: moduleRef,
      resourceType: 'supplier-product' as any,
      resourceId: 'box-30x30x6' as any,
    },
  };

  it('valida ContextAspectRef sem carregar valor material (apenas aspectKey)', () => {
    const aspectPrice: ContextAspectRef = {
      target: targetAnchor,
      aspectKey: 'price' as ContextAspectKey,
    };
    assert.doesNotThrow(() => validateContextAspectRef(aspectPrice));

    assert.throws(
      () => validateContextAspectRef({ target: targetAnchor, aspectKey: '' }),
      (err: any) => err.violationType === 'INVALID_ASPECT_KEY'
    );
  });

  it('valida OperationalFocus com alvos primários, relacionados e aspectos', () => {
    const focus: OperationalFocus = {
      primaryTarget: targetAnchor,
      relatedTargets: [
        {
          kind: 'resource',
          resource: { ownerModule: { moduleKey: 'radar' as any }, resourceType: 'item' as any, resourceId: 'radar_1' as any },
        },
      ],
      activeAspects: [{ target: targetAnchor, aspectKey: 'price' as any }],
      visibleAspects: [
        { target: targetAnchor, aspectKey: 'price' as any },
        { target: targetAnchor, aspectKey: 'dimensions' as any },
      ],
      action: 'compare' as OperationVerb,
    };
    assert.doesNotThrow(() => validateOperationalFocus(focus));

    // Focus vazio é válido (opcional)
    assert.doesNotThrow(() => validateOperationalFocus({}));
  });

  it('valida ObservedInteractionContext estrito (client_observed + UTC Z)', () => {
    const observed: ObservedInteractionContext = {
      origin: 'client_observed',
      observedAt: '2026-08-24T19:00:00.000Z',
      location: { module: moduleRef, trail: [targetAnchor] },
      focus: { primaryTarget: targetAnchor, action: 'view' as any },
    };
    assert.doesNotThrow(() => validateObservedInteractionContext(observed));

    // Rejeita origin diferente de 'client_observed'
    assert.throws(
      () =>
        validateObservedInteractionContext({
          origin: 'server_observed' as any,
          observedAt: '2026-08-24T19:00:00.000Z',
        }),
      (err: any) => err.violationType === 'INVALID_OBSERVED_ORIGIN'
    );

    // Rejeita timestamp não-UTC ou com offset
    assert.throws(
      () =>
        validateObservedInteractionContext({
          origin: 'client_observed',
          observedAt: '2026-08-24T19:00:00+03:00',
        }),
      (err: any) => err.violationType === 'INVALID_OBSERVED_AT'
    );
  });
});

describe('0.86B-2 · Max Contextual (Gap 2)', () => {
  it('comprova MaxActor + userId contextual humano + SessionRef contextual', () => {
    const maxActor: MaxActor = {
      kind: 'max',
      maxVersion: '1.2.0',
      sessionRef: 'internal_max_task_987',
    };

    const ctx = composeOperationalContext({
      actor: maxActor,
      userId: 'usr_lucas_contextual',
      sessionRef: VALID_SESSION_REF_A,
      contextSubjectRef: {
        subjectType: 'brand' as ContextSubjectType,
        subjectId: 'alterstate' as ContextSubjectId,
      },
    });

    // 1. Ator permanece estritamente MAX
    assert.equal(ctx.actor.kind, 'max');
    assert.equal((ctx.actor as MaxActor).maxVersion, '1.2.0');
    assert.equal((ctx.actor as MaxActor).sessionRef, 'internal_max_task_987');

    // 2. Não vira HumanActor
    assert.notEqual(ctx.actor.kind, 'human');

    // 3. userId representa o contexto humano em que o MAX atua
    assert.equal(ctx.userId, 'usr_lucas_contextual');

    // 4. sessionRef representa a correlação/sessão contextual
    assert.equal(ctx.sessionRef, VALID_SESSION_REF_A);
  });
});

describe('0.86B-2 · Conflito Canonical Context × Client Observed (Gap 4)', () => {
  const moduleA: ModuleRef = { moduleKey: 'fornecedores' as any };
  const moduleB: ModuleRef = { moduleKey: 'radar' as any };

  const anchorA: ContextAnchorRef = {
    kind: 'resource',
    resource: { ownerModule: moduleA, resourceType: 'supplier' as any, resourceId: 'sup_a' as any },
  };
  const anchorB: ContextAnchorRef = {
    kind: 'resource',
    resource: { ownerModule: moduleB, resourceType: 'item' as any, resourceId: 'item_b' as any },
  };

  const locA: OperationalLocation = { module: moduleA, trail: [anchorA] };
  const locB: OperationalLocation = { module: moduleB, trail: [anchorB] };

  const focusA: OperationalFocus = { primaryTarget: anchorA, action: 'view' as any };
  const focusB: OperationalFocus = { primaryTarget: anchorB, action: 'edit' as any };

  it('preserva contexto canônico A mesmo com observedInteraction B e mantém origin client_observed', () => {
    const humanLucas: HumanActor = { kind: 'human', humanId: 'usr_lucas_123' };

    const ctx = composeOperationalContext({
      actor: humanLucas,
      userId: 'usr_lucas_123',
      sessionRef: VALID_SESSION_REF_A,
      contextSubjectRef: { subjectType: 'brand' as ContextSubjectType, subjectId: 'alterstate' as ContextSubjectId },
      location: locA,
      focus: focusA,
      observedInteraction: {
        origin: 'client_observed',
        observedAt: '2026-08-24T19:00:00.000Z',
        location: locB,
        focus: focusB,
      },
    });

    // 1. Contexto canônico permanece A
    assert.equal(ctx.location?.module.moduleKey, 'fornecedores');
    assert.equal((ctx.location?.trail[0] as any).resource.resourceId, 'sup_a');
    assert.equal((ctx.focus?.primaryTarget as any).resource.resourceId, 'sup_a');
    assert.equal(ctx.focus?.action, 'view');

    // 2. Contexto observado pelo cliente permanece B
    assert.equal(ctx.observedInteraction?.origin, 'client_observed');
    assert.equal(ctx.observedInteraction?.location?.module.moduleKey, 'radar');
    assert.equal((ctx.observedInteraction?.location?.trail[0] as any).resource.resourceId, 'item_b');
    assert.equal((ctx.observedInteraction?.focus?.primaryTarget as any).resource.resourceId, 'item_b');
    assert.equal(ctx.observedInteraction?.focus?.action, 'edit');

    // 3. Observed interaction NÃO sobrescreve identidade canônica
    assert.equal((ctx.actor as HumanActor).humanId, 'usr_lucas_123');
    assert.equal(ctx.userId, 'usr_lucas_123');
    assert.equal(ctx.sessionRef, VALID_SESSION_REF_A);
    assert.equal(ctx.contextSubjectRef?.subjectId, 'alterstate');
  });
});

describe('0.86B-2 · OperationalContext Invariants & Composition', () => {
  const humanLucas: HumanActor = {
    kind: 'human',
    humanId: 'usr_lucas_123',
    role: 'partner',
  };

  const subjectAlterstate: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'alterstate' as ContextSubjectId,
  };

  it('compõe OperationalContext válido para ator humano com sessão e sujeito de Marca', () => {
    const ctx = composeOperationalContext({
      actor: humanLucas,
      userId: 'usr_lucas_123',
      sessionRef: VALID_SESSION_REF_A,
      contextSubjectRef: subjectAlterstate,
      correlationId: 'corr_123' as CorrelationId,
      channel: 'web_dashboard' as OperationalChannel,
    });

    assert.equal(ctx.actor.kind, 'human');
    assert.equal(ctx.userId, 'usr_lucas_123');
    assert.equal(ctx.sessionRef, VALID_SESSION_REF_A);
    assert.deepEqual(ctx.contextSubjectRef, subjectAlterstate);
    assert.equal(ctx.correlationId, 'corr_123');
    assert.equal(ctx.channel, 'web_dashboard');
    assert.ok(Object.isFrozen(ctx));
  });

  it('compõe OperationalContext em contexto pessoal quando contextSubjectRef for ausente', () => {
    const ctx = composeOperationalContext({
      actor: humanLucas,
      userId: 'usr_lucas_123',
      sessionRef: VALID_SESSION_REF_A,
    });

    assert.equal(ctx.contextSubjectRef, undefined);
    assert.equal(ctx.userId, 'usr_lucas_123');
  });

  it('lança erro se sessionRef for fornecida sem userId', () => {
    assert.throws(
      () =>
        composeOperationalContext({
          actor: humanLucas,
          sessionRef: VALID_SESSION_REF_A,
        }),
      (err: any) => err.violationType === 'MISSING_USER_ID_FOR_SESSION'
    );
  });

  it('lança erro se actor for humano e actor.humanId divergir de userId com sessão', () => {
    assert.throws(
      () =>
        composeOperationalContext({
          actor: humanLucas, // humanId: 'usr_lucas_123'
          userId: 'usr_joao_456',
          sessionRef: VALID_SESSION_REF_A,
        }),
      (err: any) => err.violationType === 'HUMAN_ACTOR_USER_MISMATCH'
    );
  });

  it('compõe OperationalContext para MaxActor, SystemActor e IntegrationActor sem sessão', () => {
    const maxActor: MaxActor = { kind: 'max', maxVersion: '1.0.0' };
    const ctxMax = composeOperationalContext({
      actor: maxActor,
      contextSubjectRef: subjectAlterstate,
    });
    assert.equal(ctxMax.actor.kind, 'max');
    assert.equal(ctxMax.sessionRef, undefined);
    assert.equal(ctxMax.userId, undefined);

    const sysActor: SystemActor = { kind: 'system', component: 'background_indexer' };
    const ctxSys = composeOperationalContext({ actor: sysActor });
    assert.equal(ctxSys.actor.kind, 'system');

    const intActor: IntegrationActor = { kind: 'integration', provider: 'bling' };
    const ctxInt = composeOperationalContext({ actor: intActor });
    assert.equal(ctxInt.actor.kind, 'integration');
  });

  it('garante imutabilidade e não mutação dos inputs após a composição', () => {
    const rawLocation: OperationalLocation = {
      module: { moduleKey: 'fornecedores' as any },
      trail: [
        {
          kind: 'scope',
          scope: {
            module: { moduleKey: 'fornecedores' as any },
            scopeType: 'cat' as any,
            scopeId: 'pack' as any,
          },
        },
      ],
    };

    const ctx = composeOperationalContext({
      actor: humanLucas,
      userId: 'usr_lucas_123',
      sessionRef: VALID_SESSION_REF_A,
      location: rawLocation,
    });

    assert.ok(Object.isFrozen(ctx));
    assert.ok(Object.isFrozen(ctx.location));
    assert.ok(Object.isFrozen(ctx.location?.trail));
    assert.ok(Object.isFrozen(ctx.location?.trail[0]));

    // Modificação em rawLocation não afeta ctx.location
    const originalLength = ctx.location!.trail.length;
    (rawLocation.trail as any).push({
      kind: 'scope',
      scope: { module: { moduleKey: 'fornecedores' as any }, scopeType: 'cat2' as any, scopeId: 'sub' as any },
    });
    assert.equal(ctx.location!.trail.length, originalLength);
  });
});

describe('0.86B-2 · Prova do Exemplo-Guia (Lucas → Alterstate → Fornecedores → Embalagens → Fornecedor X → Caixa 30×30×6)', () => {
  it('representa a estrutura contextual rica do exemplo-guia sem copiar valores concretos nem inferir autoridade', () => {
    const actorLucas: HumanActor = {
      kind: 'human',
      humanId: 'usr_lucas_bauru',
      role: 'managing_partner',
    };

    const subjectAlterstate: ContextSubjectRef = {
      subjectType: 'brand' as ContextSubjectType,
      subjectId: 'alterstate' as ContextSubjectId,
    };

    const moduleFornecedores: ModuleRef = {
      moduleKey: 'fornecedores' as any,
    };

    // 1. Escopo Embalagens (sem entidade canônica própria)
    const scopeEmbalagens: ContextAnchorRef = {
      kind: 'scope',
      scope: {
        module: moduleFornecedores,
        scopeType: 'supplier-category' as ContextScopeType,
        scopeId: 'packaging' as ContextScopeId,
      },
    };

    // 2. Recurso canônico Fornecedor X (Boxen Embalagens)
    const resourceFornecedorX: ContextAnchorRef = {
      kind: 'resource',
      resource: {
        ownerModule: moduleFornecedores,
        resourceType: 'supplier' as any,
        resourceId: 'supplier-boxen' as any,
      },
    };

    // 3. Sub-recurso canônico Produto Caixa 30×30×6 Onda B
    const resourceProdutoCaixa: ContextAnchorRef = {
      kind: 'resource',
      resource: {
        ownerModule: moduleFornecedores,
        resourceType: 'supplier-product' as any,
        resourceId: 'box-30x30x6-onda-b' as any,
      },
    };

    const location: OperationalLocation = {
      module: moduleFornecedores,
      trail: [scopeEmbalagens, resourceFornecedorX, resourceProdutoCaixa],
    };

    const focus: OperationalFocus = {
      primaryTarget: resourceProdutoCaixa,
      activeAspects: [
        { target: resourceProdutoCaixa, aspectKey: 'price' as ContextAspectKey },
        { target: resourceProdutoCaixa, aspectKey: 'dimensions' as ContextAspectKey },
      ],
      visibleAspects: [
        { target: resourceProdutoCaixa, aspectKey: 'price' as ContextAspectKey },
        { target: resourceProdutoCaixa, aspectKey: 'dimensions' as ContextAspectKey },
        { target: resourceProdutoCaixa, aspectKey: 'material' as ContextAspectKey },
        { target: resourceProdutoCaixa, aspectKey: 'moq' as ContextAspectKey },
        { target: resourceProdutoCaixa, aspectKey: 'freight' as ContextAspectKey },
      ],
      action: 'compare' as OperationVerb,
    };

    const observed: ObservedInteractionContext = {
      origin: 'client_observed',
      observedAt: '2026-08-24T19:00:00.000Z',
      location,
      focus,
    };

    const opContext = composeOperationalContext({
      actor: actorLucas,
      userId: 'usr_lucas_bauru',
      sessionRef: VALID_SESSION_REF_A,
      contextSubjectRef: subjectAlterstate,
      location,
      focus,
      observedInteraction: observed,
      channel: 'web_desktop' as OperationalChannel,
    });

    // Provas estruturais:
    // 1. Identidade e Sujeito
    assert.equal(opContext.actor.kind, 'human');
    assert.equal(opContext.userId, 'usr_lucas_bauru');
    assert.equal(opContext.sessionRef, VALID_SESSION_REF_A);
    assert.equal(opContext.contextSubjectRef?.subjectType, 'brand');
    assert.equal(opContext.contextSubjectRef?.subjectId, 'alterstate');

    // 2. Ordem da Trilha Preservada (mais amplo para mais específico)
    assert.equal(opContext.location?.trail.length, 3);
    assert.equal(opContext.location?.trail[0].kind, 'scope');
    assert.equal((opContext.location?.trail[0] as any).scope.scopeId, 'packaging');
    assert.equal(opContext.location?.trail[1].kind, 'resource');
    assert.equal((opContext.location?.trail[1] as any).resource.resourceId, 'supplier-boxen');
    assert.equal(opContext.location?.trail[2].kind, 'resource');
    assert.equal((opContext.location?.trail[2] as any).resource.resourceId, 'box-30x30x6-onda-b');

    // 3. Foco e Ação
    assert.equal(opContext.focus?.primaryTarget?.kind, 'resource');
    assert.equal(opContext.focus?.action, 'compare');
    assert.equal(opContext.focus?.activeAspects?.length, 2);
    assert.equal(opContext.focus?.visibleAspects?.length, 5);

    // 4. Sem Valores Materiais (sem R$ ou valores de dimensão no ref)
    const contextJson = JSON.stringify(opContext);
    assert.ok(!contextJson.includes('R$'));
    assert.ok(!contextJson.includes('22,89'));
    assert.ok(!contextJson.includes('Onda B Kraft'));

    // 5. Imutabilidade
    assert.ok(Object.isFrozen(opContext));
    assert.ok(Object.isFrozen(opContext.location));
    assert.ok(Object.isFrozen(opContext.focus));
  });
});

describe('0.86B-2 · SessionOperationalState Minimal Shape (Section 6)', () => {
  it('valida SessionOperationalState válido', () => {
    const state = {
      sessionRef: VALID_SESSION_REF_A,
      userId: 'usr_lucas_123',
      contextSubjectRef: {
        subjectType: 'brand' as ContextSubjectType,
        subjectId: 'alterstate' as ContextSubjectId,
      },
      revision: 1,
      createdAt: '2026-08-24T19:00:00.000Z',
      updatedAt: '2026-08-24T19:00:00.000Z',
    };
    assert.doesNotThrow(() => validateSessionOperationalState(state));
  });

  it('valida SessionOperationalState em contexto pessoal (sem contextSubjectRef)', () => {
    const state = {
      sessionRef: VALID_SESSION_REF_A,
      userId: 'usr_lucas_123',
      revision: 1,
      createdAt: '2026-08-24T19:00:00.000Z',
      updatedAt: '2026-08-24T19:00:00.000Z',
    };
    assert.doesNotThrow(() => validateSessionOperationalState(state));
  });

  it('rejeita SessionOperationalState contendo jwt, cookie, token, secret, module ou propriedades extras', () => {
    const stateWithJwt = {
      sessionRef: VALID_SESSION_REF_A,
      userId: 'usr_lucas_123',
      revision: 1,
      createdAt: '2026-08-24T19:00:00.000Z',
      updatedAt: '2026-08-24T19:00:00.000Z',
      jwt: 'secret_jwt',
    };
    assert.throws(
      () => validateSessionOperationalState(stateWithJwt),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );

    const stateWithModule = {
      sessionRef: VALID_SESSION_REF_A,
      userId: 'usr_lucas_123',
      revision: 1,
      createdAt: '2026-08-24T19:00:00.000Z',
      updatedAt: '2026-08-24T19:00:00.000Z',
      module: 'fornecedores',
    };
    assert.throws(
      () => validateSessionOperationalState(stateWithModule),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );

    const stateWithArbitrary = {
      sessionRef: VALID_SESSION_REF_A,
      userId: 'usr_lucas_123',
      revision: 1,
      createdAt: '2026-08-24T19:00:00.000Z',
      updatedAt: '2026-08-24T19:00:00.000Z',
      arbitraryField: 123,
    };
    assert.throws(
      () => validateSessionOperationalState(stateWithArbitrary),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
  });

  it('rejeita SessionOperationalState contendo contextSubjectRef: null (deve ser ausente/undefined para pessoal)', () => {
    const stateWithNullSubject = {
      sessionRef: VALID_SESSION_REF_A,
      userId: 'usr_lucas_123',
      contextSubjectRef: null,
      revision: 1,
      createdAt: '2026-08-24T19:00:00.000Z',
      updatedAt: '2026-08-24T19:00:00.000Z',
    };
    assert.throws(
      () => validateSessionOperationalState(stateWithNullSubject),
      (err: any) => err.violationType === 'INVALID_CONTEXT_SUBJECT_REF'
    );
  });

  it('rejeita OperationalContext contendo contextSubjectRef: null', () => {
    assert.throws(
      () =>
        validateOperationalContext({
          actor: { kind: 'human', humanId: 'usr_lucas_123' },
          userId: 'usr_lucas_123',
          sessionRef: VALID_SESSION_REF_A,
          contextSubjectRef: null as any,
        }),
      (err: any) => err.violationType === 'INVALID_CONTEXT_SUBJECT_REF'
    );
  });

  it('rejeita SessionOperationalState com revision < 1 ou timestamps inválidos', () => {
    assert.throws(
      () =>
        validateSessionOperationalState({
          sessionRef: VALID_SESSION_REF_A,
          userId: 'usr_lucas_123',
          revision: 0,
          createdAt: '2026-08-24T19:00:00.000Z',
          updatedAt: '2026-08-24T19:00:00.000Z',
        }),
      (err: any) => err.violationType === 'INVALID_REVISION'
    );

    assert.throws(
      () =>
        validateSessionOperationalState({
          sessionRef: VALID_SESSION_REF_A,
          userId: 'usr_lucas_123',
          revision: 1,
          createdAt: '2026-08-24T19:00:00+03:00',
          updatedAt: '2026-08-24T19:00:00.000Z',
        }),
      (err: any) => err.violationType === 'INVALID_CREATED_AT'
    );
  });
});
