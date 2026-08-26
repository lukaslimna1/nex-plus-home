/**
 * NEX+ · 0.86B-5 Acceptance Gate · Cross-Boundary Lifecycle & History
 * Contrato Canônico de Acceptance (0.86B-5 · 26/08/2026)
 *
 * Provas:
 * 1. B1 (Auth) -> B2 (Context) -> B3 (Input) -> B4 (Material Pin) Composição Canônica.
 * 2. Multi-sessão simultânea com isolamento estrito de sujeito contextual (Brand A vs Brand B).
 * 3. Contexto pessoal (ausência de contextSubjectRef sem string sintética 'personal').
 * 4. Separação estrita de eixos: Actor (quem agiu) != ContextSubjectRef (em nome de quem).
 * 5. Hints contextuais (location, focus, observedInteraction, flowRef) não são autoridade.
 * 6. Cadeia Context -> Input: derivação estrita de eixos de autoridade e não-cópia de UI/flow.
 * 7. História do Input e do Material Pin: mutações futuras de sessão não alteram fatos históricos.
 * 8. SourceEventIdentity replay: deduplicação segura com preservação do sujeito original.
 * 9. resource_ref (identidade) vs aspect_snapshot (valor material histórico congelado).
 * 10. Material Context Pin não carrega estado de UI / frontend.
 * 11. Deep Immutability transversal em toda a cadeia.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AuthenticatedSessionContext, SessionRef } from '../../auth/session-ref.types';
import type { HumanActor } from '../observations/contracts';
import type {
  ContextSubjectRef,
  ContextSubjectType,
  ContextSubjectId,
  FlowRef,
  FlowType,
  FlowId,
  OperationalLocation,
  OperationalFocus,
  ObservedInteractionContext,
  OperationalContext,
  OperationalChannel,
  SessionOperationalState,
} from '../context/contracts';
import type {
  ModuleKey,
  ResourceType,
  ResourceId,
  CorrelationId,
  JsonValue,
} from '../modules/contracts';
import type {
  InputRecordId,
  IngressContentId,
  SourceEventIdentity,
  InputPart,
  InputRecord,
  IngressContentRecord,
  RecordInputDraft,
  IngressAccessAuthorizer,
  InputRecordAccessAuthorizer,
} from '../input/contracts';
import type {
  MaterialContextPinId,
  MaterialContextPin,
  PinMaterialContextDraft,
  MaterialContextAccessAuthorizer,
} from '../material-context/contracts';
import type {
  EnsureSessionOperationalStateParams,
  SessionOperationalStateStore,
  SetContextSubjectParams,
} from '../context/persistence/contracts';
import type {
  InputRecordStore,
  IngressContentStore,
} from '../input/persistence/contracts';
import type { MaterialContextStore } from '../material-context/persistence/contracts';

import {
  ensureSessionOperationalState,
  getSessionOperationalState,
  setSessionContextSubject,
  clearSessionContextSubject,
} from '../context/session-state';
import { composeOperationalContext } from '../context/compose';
import { InputRecordService } from '../input/service';
import { MaterialContextPinService } from '../material-context/service';

// ============================================================================
// IN-MEMORY STORES & FAKES PARA TESTES UNITÁRIOS DE ACCEPTANCE
// ============================================================================

class InMemorySessionStateStore implements SessionOperationalStateStore {
  readonly store = new Map<string, SessionOperationalState>();

  async getState(sessionRef: SessionRef, expectedUserId: string): Promise<SessionOperationalState | null> {
    const existing = this.store.get(sessionRef);
    if (!existing) return null;
    return existing;
  }

  async ensureState(params: EnsureSessionOperationalStateParams): Promise<SessionOperationalState> {
    const existing = this.store.get(params.sessionRef);
    if (existing) return existing;

    const now = new Date().toISOString();
    const created: SessionOperationalState = {
      sessionRef: params.sessionRef,
      userId: params.userId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(params.sessionRef, created);
    return created;
  }

  async setContextSubject(params: SetContextSubjectParams): Promise<SessionOperationalState> {
    const existing = this.store.get(params.sessionRef);
    if (!existing) {
      throw new Error(`Session ${params.sessionRef} not found.`);
    }
    if (existing.revision !== params.expectedRevision) {
      const err: any = new Error('revision conflict');
      err.code = 'REVISION_CONFLICT';
      throw err;
    }

    const now = new Date().toISOString();
    const updated: SessionOperationalState = {
      ...existing,
      ...(params.contextSubjectRef !== null
        ? { contextSubjectRef: params.contextSubjectRef }
        : {}),
      revision: existing.revision + 1,
      updatedAt: now,
    };
    if (params.contextSubjectRef === null) {
      delete (updated as any).contextSubjectRef;
    }
    this.store.set(params.sessionRef, updated);
    return updated;
  }
}

class InMemoryInputRecordStore implements InputRecordStore {
  readonly records = new Map<string, InputRecord>();
  readonly bySourceEvent = new Map<string, InputRecord>();

  async saveInputRecord(record: InputRecord): Promise<InputRecord> {
    if (record.sourceEventIdentity) {
      const key = `${record.sourceEventIdentity.source}:::${record.sourceEventIdentity.id}`;
      if (this.bySourceEvent.has(key)) {
        const err: any = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      this.bySourceEvent.set(key, record);
    }
    this.records.set(record.inputId, record);
    return record;
  }

  async getInputRecord(inputId: InputRecordId): Promise<InputRecord | null> {
    return this.records.get(inputId) ?? null;
  }

  async findBySourceEventIdentity(identity: SourceEventIdentity): Promise<InputRecord | null> {
    const key = `${identity.source}:::${identity.id}`;
    return this.bySourceEvent.get(key) ?? null;
  }
}

class InMemoryIngressContentStore implements IngressContentStore {
  readonly records = new Map<string, IngressContentRecord>();

  async saveContent(record: IngressContentRecord): Promise<IngressContentRecord> {
    this.records.set(record.contentId, record);
    return record;
  }

  async getContent(contentId: IngressContentId): Promise<IngressContentRecord | null> {
    return this.records.get(contentId) ?? null;
  }

  async hasContent(contentId: IngressContentId): Promise<boolean> {
    return this.records.has(contentId);
  }
}

class InMemoryMaterialContextStore implements MaterialContextStore {
  readonly pins = new Map<string, MaterialContextPin>();

  async savePin(pin: MaterialContextPin): Promise<MaterialContextPin> {
    if (this.pins.has(pin.pinId)) {
      throw new Error(`Pin '${pin.pinId}' already exists.`);
    }
    this.pins.set(pin.pinId, pin);
    return pin;
  }

  async getPin(pinId: MaterialContextPinId): Promise<MaterialContextPin | null> {
    return this.pins.get(pinId) ?? null;
  }

  async hasPin(pinId: MaterialContextPinId): Promise<boolean> {
    return this.pins.has(pinId);
  }
}

class PermissiveAuthorizers implements IngressAccessAuthorizer, InputRecordAccessAuthorizer, MaterialContextAccessAuthorizer {
  async authorize(): Promise<boolean> {
    return true;
  }
}

// ============================================================================
// SUÍTE DE ACCEPTANCE: CROSS-BOUNDARY LIFECYCLE & HISTORY
// ============================================================================

describe('0.86B-5 Acceptance Gate · Cross-Boundary Composition & History', () => {
  const userLucas = 'usr_lucas_123';
  const humanActorLucas: HumanActor = { kind: 'human', humanId: userLucas, role: 'director' };

  const sessionRefA = '1111111111111111111111111111111111111111111111111111111111111111' as SessionRef;
  const sessionRefB = '2222222222222222222222222222222222222222222222222222222222222222' as SessionRef;

  const sessionContextA: AuthenticatedSessionContext = {
    sessionRef: sessionRefA,
    actor: humanActorLucas,
  };

  const sessionContextB: AuthenticatedSessionContext = {
    sessionRef: sessionRefB,
    actor: humanActorLucas,
  };

  const brandAlterstate: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'alterstate' as ContextSubjectId,
  };

  const brandArkana: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'arkana' as ContextSubjectId,
  };

  describe('1. Multi-Sessão Canônica & Isolamento de Sujeito (Seções 8, 9, 15, 28)', () => {
    it('Session A (Brand A) e Session B (Brand B) do mesmo usuário são simultâneas e não vazam estado cruzado', async () => {
      const sessionStore = new InMemorySessionStateStore();

      // Garantir estado para ambas as sessões
      await ensureSessionOperationalState(sessionContextA, sessionStore);
      await ensureSessionOperationalState(sessionContextB, sessionStore);

      // Definir Session A = Alterstate, Session B = Arkana
      await setSessionContextSubject(sessionContextA, { contextSubjectRef: brandAlterstate, expectedRevision: 1 }, sessionStore);
      await setSessionContextSubject(sessionContextB, { contextSubjectRef: brandArkana, expectedRevision: 1 }, sessionStore);

      // Obter estados
      const stateA = await getSessionOperationalState(sessionContextA, sessionStore);
      const stateB = await getSessionOperationalState(sessionContextB, sessionStore);

      assert.ok(stateA);
      assert.ok(stateB);
      assert.strictEqual(stateA.userId, userLucas);
      assert.strictEqual(stateB.userId, userLucas);
      assert.strictEqual(stateA.contextSubjectRef?.subjectId, 'alterstate');
      assert.strictEqual(stateB.contextSubjectRef?.subjectId, 'arkana');

      // Compor OperationalContexts independentes
      const ctxA = composeOperationalContext({
        actor: sessionContextA.actor,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: stateA.contextSubjectRef,
      });

      const ctxB = composeOperationalContext({
        actor: sessionContextB.actor,
        userId: userLucas,
        sessionRef: sessionRefB,
        contextSubjectRef: stateB.contextSubjectRef,
      });

      assert.strictEqual(ctxA.sessionRef, sessionRefA);
      assert.strictEqual(ctxA.contextSubjectRef?.subjectId, 'alterstate');
      assert.strictEqual(ctxB.sessionRef, sessionRefB);
      assert.strictEqual(ctxB.contextSubjectRef?.subjectId, 'arkana');

      // Alterar Session A para pessoal (clear) não afeta Session B
      await clearSessionContextSubject(sessionContextA, 2, sessionStore);
      const stateAAfter = await getSessionOperationalState(sessionContextA, sessionStore);
      const stateBAfter = await getSessionOperationalState(sessionContextB, sessionStore);

      assert.strictEqual(stateAAfter?.contextSubjectRef, undefined);
      assert.strictEqual(stateBAfter?.contextSubjectRef?.subjectId, 'arkana');
    });

    it('Contexto Pessoal: ausência de contextSubjectRef sem string sintética "personal"', async () => {
      const sessionStore = new InMemorySessionStateStore();
      await ensureSessionOperationalState(sessionContextA, sessionStore);

      const stateA = await getSessionOperationalState(sessionContextA, sessionStore);
      assert.ok(stateA);
      assert.strictEqual(stateA.contextSubjectRef, undefined);

      const ctxPersonal = composeOperationalContext({
        actor: sessionContextA.actor,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: stateA.contextSubjectRef,
      });

      assert.strictEqual((ctxPersonal.actor as HumanActor).humanId, userLucas);
      assert.strictEqual(ctxPersonal.userId, userLucas);
      assert.strictEqual(ctxPersonal.sessionRef, sessionRefA);
      assert.strictEqual(ctxPersonal.contextSubjectRef, undefined);
      assert.strictEqual((ctxPersonal as any).subject, undefined);
      assert.strictEqual(JSON.stringify(ctxPersonal).includes('personal'), false);
    });

    it('Separação estrita de eixos: Actor (quem agiu = User U) != ContextSubject (em nome de quem = Brand A)', () => {
      const ctx = composeOperationalContext({
        actor: humanActorLucas,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: brandAlterstate,
      });

      assert.strictEqual(ctx.actor.kind, 'human');
      assert.strictEqual((ctx.actor as HumanActor).humanId, userLucas);
      assert.strictEqual(ctx.contextSubjectRef?.subjectType, 'brand');
      assert.strictEqual(ctx.contextSubjectRef?.subjectId, 'alterstate');
      // Actor nunca pode ser a Marca
      assert.notStrictEqual((ctx.actor as any).subjectId, 'alterstate');
      assert.notStrictEqual((ctx.actor as any).brand, 'alterstate');
    });
  });

  describe('2. Hints contextuais vs Composição Canônica (Seções 12, 13, 28)', () => {
    it('OperationalContext aceita hints ricos (location, focus, observedInteraction, flowRef, correlationId, channel) sem sobrescrever eixos de autoridade', () => {
      const richLocation: OperationalLocation = {
        module: { moduleKey: 'catalog' as ModuleKey },
        trail: [
          {
            kind: 'resource',
            resource: {
              ownerModule: { moduleKey: 'catalog' as ModuleKey },
              resourceType: 'product' as ResourceType,
              resourceId: 'prod_100' as ResourceId,
            },
          },
        ],
      };

      const richFocus: OperationalFocus = {
        primaryTarget: richLocation.trail[0],
        action: 'edit' as any,
      };

      const observedInteraction: ObservedInteractionContext = {
        origin: 'client_observed',
        observedAt: '2026-08-26T12:00:00.000Z',
        location: richLocation,
        focus: richFocus,
      };

      const flowRef: FlowRef = {
        flowType: 'product_launch' as FlowType,
        flowId: 'flw_launch_01' as FlowId,
      };

      const correlationId: CorrelationId = 'corr_e2e_999' as CorrelationId;
      const channel: OperationalChannel = 'web_admin' as OperationalChannel;

      const ctx = composeOperationalContext({
        actor: humanActorLucas,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: brandAlterstate,
        location: richLocation,
        focus: richFocus,
        observedInteraction,
        flowRef,
        correlationId,
        channel,
      });

      assert.strictEqual((ctx.actor as HumanActor).humanId, userLucas);
      assert.strictEqual(ctx.userId, userLucas);
      assert.strictEqual(ctx.sessionRef, sessionRefA);
      assert.strictEqual(ctx.contextSubjectRef?.subjectId, 'alterstate');
      assert.strictEqual(ctx.location?.module.moduleKey, 'catalog');
      assert.strictEqual(ctx.focus?.action, 'edit');
      assert.strictEqual(ctx.observedInteraction?.origin, 'client_observed');
      assert.strictEqual(ctx.flowRef?.flowId, 'flw_launch_01');
      assert.strictEqual(ctx.correlationId, 'corr_e2e_999');
      assert.strictEqual(ctx.channel, 'web_admin');
    });
  });

  describe('3. Cadeia Context -> Input & Imutabilidade Histórica (Seções 13, 14, 15, 16)', () => {
    it('recordInput deriva eixos de autoridade do OperationalContext e NÃO copia location, focus, observedInteraction nem flowRef', async () => {
      const inputStore = new InMemoryInputRecordStore();
      const contentStore = new InMemoryIngressContentStore();
      const authorizers = new PermissiveAuthorizers();
      const inputService = new InputRecordService({
        inputStore,
        contentStore,
        authorizer: authorizers,
        inputAuthorizer: authorizers,
        nowProvider: () => '2026-08-26T12:00:00.000Z',
      });

      const richCtx = composeOperationalContext({
        actor: humanActorLucas,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: brandAlterstate,
        flowRef: { flowType: 'checkout' as any, flowId: 'flw_01' as any },
        correlationId: 'corr_input_1' as CorrelationId,
        channel: 'mobile_app' as OperationalChannel,
        location: { module: { moduleKey: 'catalog' as any }, trail: [] },
        focus: { action: 'view' as any },
        observedInteraction: { origin: 'client_observed', observedAt: '2026-08-26T11:59:00.000Z' },
      });

      const draft: RecordInputDraft = {
        parts: [{ kind: 'text', text: 'Quero atualizar o estoque do produto 100' }],
        occurredAt: '2026-08-26T11:59:30.000Z',
      };

      const result = await inputService.recordInput(draft, richCtx);

      assert.strictEqual(result.deduplicated, false);
      const record = result.record;

      // Eixos de autoridade herdados estritamente do OperationalContext
      assert.strictEqual((record.actor as HumanActor).humanId, userLucas);
      assert.strictEqual(record.userId, userLucas);
      assert.strictEqual(record.sessionRef, sessionRefA);
      assert.strictEqual(record.contextSubjectRef?.subjectId, 'alterstate');
      assert.strictEqual(record.channel, 'mobile_app');
      assert.strictEqual(record.correlationId, 'corr_input_1');
      assert.strictEqual(record.receivedAt, '2026-08-26T12:00:00.000Z');
      assert.strictEqual(record.occurredAt, '2026-08-26T11:59:30.000Z');

      // NÃO copiados (contrato B3)
      assert.strictEqual((record as any).location, undefined);
      assert.strictEqual((record as any).focus, undefined);
      assert.strictEqual((record as any).observedInteraction, undefined);
      assert.strictEqual((record as any).flowRef, undefined);
    });

    it('História do Input: Input A (Brand A) permanece inalterado quando a sessão muda para Brand B; Input B nasce Brand B', async () => {
      const sessionStore = new InMemorySessionStateStore();
      const inputStore = new InMemoryInputRecordStore();
      const contentStore = new InMemoryIngressContentStore();
      const authorizers = new PermissiveAuthorizers();
      const inputService = new InputRecordService({
        inputStore,
        contentStore,
        authorizer: authorizers,
        inputAuthorizer: authorizers,
      });

      // 1. Sessão A inicia em Alterstate
      await ensureSessionOperationalState(sessionContextA, sessionStore);
      await setSessionContextSubject(sessionContextA, { contextSubjectRef: brandAlterstate, expectedRevision: 1 }, sessionStore);

      const ctxA = composeOperationalContext({
        actor: sessionContextA.actor,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: brandAlterstate,
      });

      // Criar Input A
      const resA = await inputService.recordInput(
        { parts: [{ kind: 'text', text: 'Input gravado no contexto Alterstate' }] },
        ctxA
      );
      assert.strictEqual(resA.record.contextSubjectRef?.subjectId, 'alterstate');

      // 2. Sessão A transiciona para Arkana
      await setSessionContextSubject(sessionContextA, { contextSubjectRef: brandArkana, expectedRevision: 2 }, sessionStore);
      const stateArkana = await getSessionOperationalState(sessionContextA, sessionStore);
      assert.strictEqual(stateArkana?.contextSubjectRef?.subjectId, 'arkana');

      const ctxB = composeOperationalContext({
        actor: sessionContextA.actor,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: stateArkana?.contextSubjectRef,
      });

      // Criar Input B
      const resB = await inputService.recordInput(
        { parts: [{ kind: 'text', text: 'Input gravado no novo contexto Arkana' }] },
        ctxB
      );
      assert.strictEqual(resB.record.contextSubjectRef?.subjectId, 'arkana');

      // 3. Provar que Input A não sofreu mutação retroativa no store
      const persistedA = await inputStore.getInputRecord(resA.record.inputId);
      assert.ok(persistedA);
      assert.strictEqual(persistedA.contextSubjectRef?.subjectId, 'alterstate');
      assert.strictEqual(persistedA.inputId, resA.record.inputId);
    });

    it('Source Event Replay: reentrega retorna ocorrência original sem reescrever para o contexto de sessão atual', async () => {
      const inputStore = new InMemoryInputRecordStore();
      const contentStore = new InMemoryIngressContentStore();
      const authorizers = new PermissiveAuthorizers();
      const inputService = new InputRecordService({
        inputStore,
        contentStore,
        authorizer: authorizers,
        inputAuthorizer: authorizers,
      });

      const sourceEvent: SourceEventIdentity = {
        source: 'shopify_webhook',
        id: 'order_ev_12345',
      };

      // 1. Primeira entrega sob Alterstate
      const ctxAlterstate = composeOperationalContext({
        actor: humanActorLucas,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: brandAlterstate,
      });

      const res1 = await inputService.recordInput(
        {
          sourceEventIdentity: sourceEvent,
          parts: [{ kind: 'text', text: 'Order created #12345' }],
        },
        ctxAlterstate
      );

      assert.strictEqual(res1.deduplicated, false);
      assert.strictEqual(res1.record.contextSubjectRef?.subjectId, 'alterstate');

      // 2. Segunda entrega com a sessão agora sob Arkana
      const ctxArkana = composeOperationalContext({
        actor: humanActorLucas,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: brandArkana,
      });

      const res2 = await inputService.recordInput(
        {
          sourceEventIdentity: sourceEvent,
          parts: [{ kind: 'text', text: 'Order created #12345 duplicate delivery' }],
        },
        ctxArkana
      );

      assert.strictEqual(res2.deduplicated, true);
      assert.strictEqual(res2.record.inputId, res1.record.inputId);
      // Sujeito do registro retornado continua sendo Alterstate (ocorrência original histórica)
      assert.strictEqual(res2.record.contextSubjectRef?.subjectId, 'alterstate');
      assert.notStrictEqual(res2.record.contextSubjectRef?.subjectId, 'arkana');
    });
  });

  describe('4. Cadeia Input -> Material Context Pin & Imutabilidade Histórica (Seções 20, 21, 22, 23)', () => {
    it('MaterialContextPin utiliza input_ref de InputRecord recém-criado e deriva eixos do OperationalContext', async () => {
      const inputStore = new InMemoryInputRecordStore();
      const contentStore = new InMemoryIngressContentStore();
      const materialStore = new InMemoryMaterialContextStore();
      const authorizers = new PermissiveAuthorizers();

      const inputService = new InputRecordService({
        inputStore,
        contentStore,
        authorizer: authorizers,
        inputAuthorizer: authorizers,
      });

      const pinService = new MaterialContextPinService({
        store: materialStore,
        authorizer: authorizers,
        nowProvider: () => '2026-08-26T12:05:00.000Z',
      });

      const ctx = composeOperationalContext({
        actor: humanActorLucas,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: brandAlterstate,
        flowRef: { flowType: 'checkout' as FlowType, flowId: 'flw_chk_1' as FlowId },
        correlationId: 'corr_pin_01' as CorrelationId,
        channel: 'web_portal' as OperationalChannel,
      });

      // 1. Criar InputRecord
      const inputResult = await inputService.recordInput(
        { parts: [{ kind: 'text', text: 'Aprovar pedido #900' }] },
        ctx
      );

      // 2. Criar MaterialContextPin com input_ref + aspect_snapshot
      const pinDraft: PinMaterialContextDraft = {
        items: [
          {
            kind: 'input_ref',
            inputId: inputResult.record.inputId,
          },
          {
            kind: 'aspect_snapshot',
            aspect: {
              target: {
                kind: 'resource',
                resource: {
                  ownerModule: { moduleKey: 'orders' as ModuleKey },
                  resourceType: 'order' as ResourceType,
                  resourceId: 'ord_900' as ResourceId,
                },
              },
              aspectKey: 'total_amount' as any,
            },
            value: { amount: 159.9, currency: 'BRL' },
          },
        ],
      };

      const pin = await pinService.pin(pinDraft, ctx);

      assert.ok(pin.pinId.startsWith('pin_'));
      assert.strictEqual((pin.actor as HumanActor).humanId, userLucas);
      assert.strictEqual(pin.userId, userLucas);
      assert.strictEqual(pin.sessionRef, sessionRefA);
      assert.strictEqual(pin.contextSubjectRef?.subjectId, 'alterstate');
      assert.strictEqual(pin.flowRef?.flowId, 'flw_chk_1');
      assert.strictEqual(pin.correlationId, 'corr_pin_01');
      assert.strictEqual(pin.channel, 'web_portal');
      assert.strictEqual(pin.pinnedAt, '2026-08-26T12:05:00.000Z');
      assert.strictEqual(pin.items.length, 2);
      assert.strictEqual(pin.items[0].kind, 'input_ref');
      assert.strictEqual((pin.items[0] as any).inputId, inputResult.record.inputId);
    });

    it('História do Material Pin: Pin A (Brand A) permanece inalterado quando a sessão muda para Brand B; Pin B nasce Brand B', async () => {
      const materialStore = new InMemoryMaterialContextStore();
      const authorizers = new PermissiveAuthorizers();
      const pinService = new MaterialContextPinService({
        store: materialStore,
        authorizer: authorizers,
      });

      const ctxA = composeOperationalContext({
        actor: humanActorLucas,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: brandAlterstate,
      });

      const ctxB = composeOperationalContext({
        actor: humanActorLucas,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: brandArkana,
      });

      // Pin A
      const pinA = await pinService.pin(
        {
          items: [
            {
              kind: 'aspect_snapshot',
              aspect: {
                target: {
                  kind: 'resource',
                  resource: { ownerModule: { moduleKey: 'catalog' as any }, resourceType: 'product' as any, resourceId: 'p1' as any },
                },
                aspectKey: 'price' as any,
              },
              value: 79.9,
            },
          ],
        },
        ctxA
      );
      assert.strictEqual(pinA.contextSubjectRef?.subjectId, 'alterstate');

      // Pin B
      const pinB = await pinService.pin(
        {
          items: [
            {
              kind: 'aspect_snapshot',
              aspect: {
                target: {
                  kind: 'resource',
                  resource: { ownerModule: { moduleKey: 'catalog' as any }, resourceType: 'product' as any, resourceId: 'p2' as any },
                },
                aspectKey: 'price' as any,
              },
              value: 120.0,
            },
          ],
        },
        ctxB
      );
      assert.strictEqual(pinB.contextSubjectRef?.subjectId, 'arkana');

      // Provar que Pin A no store permanece Alterstate
      const persistedPinA = await materialStore.getPin(pinA.pinId);
      assert.ok(persistedPinA);
      assert.strictEqual(persistedPinA.contextSubjectRef?.subjectId, 'alterstate');
    });

    it('resource_ref (identidade) vs aspect_snapshot (valor congelado): mutação de variável externa não afeta snapshot histórico', async () => {
      const materialStore = new InMemoryMaterialContextStore();
      const authorizers = new PermissiveAuthorizers();
      const pinService = new MaterialContextPinService({
        store: materialStore,
        authorizer: authorizers,
      });

      const ctx = composeOperationalContext({
        actor: humanActorLucas,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: brandAlterstate,
      });

      let currentExternalCatalogPrice = 79.9;

      const pin = await pinService.pin(
        {
          items: [
            {
              kind: 'resource_ref',
              resource: {
                ownerModule: { moduleKey: 'catalog' as any },
                resourceType: 'product' as any,
                resourceId: 'prod_shoes_42' as any,
              },
            },
            {
              kind: 'aspect_snapshot',
              aspect: {
                target: {
                  kind: 'resource',
                  resource: {
                    ownerModule: { moduleKey: 'catalog' as any },
                    resourceType: 'product' as any,
                    resourceId: 'prod_shoes_42' as any,
                  },
                },
                aspectKey: 'price' as any,
              },
              value: currentExternalCatalogPrice,
            },
          ],
        },
        ctx
      );

      // Preço externo muda de 79.9 para 99.9
      currentExternalCatalogPrice = 99.9;

      const persistedPin = await pinService.getPin(pin.pinId, ctx);
      const snapshotItem = persistedPin.items.find((i) => i.kind === 'aspect_snapshot');
      assert.ok(snapshotItem);
      assert.strictEqual((snapshotItem as any).value, 79.9);
      assert.notStrictEqual((snapshotItem as any).value, currentExternalCatalogPrice);
    });

    it('Pin não carrega UI state: hints de location, focus, observedInteraction presentes no context não são inseridos no Pin', async () => {
      const materialStore = new InMemoryMaterialContextStore();
      const authorizers = new PermissiveAuthorizers();
      const pinService = new MaterialContextPinService({
        store: materialStore,
        authorizer: authorizers,
      });

      const richCtx = composeOperationalContext({
        actor: humanActorLucas,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: brandAlterstate,
        location: { module: { moduleKey: 'catalog' as any }, trail: [] },
        focus: { action: 'scroll_view' as any },
        observedInteraction: { origin: 'client_observed', observedAt: '2026-08-26T12:00:00.000Z' },
      });

      const pin = await pinService.pin(
        {
          items: [
            {
              kind: 'resource_ref',
              resource: { ownerModule: { moduleKey: 'catalog' as any }, resourceType: 'product' as any, resourceId: 'p1' as any },
            },
          ],
        },
        richCtx
      );

      assert.strictEqual((pin as any).location, undefined);
      assert.strictEqual((pin as any).focus, undefined);
      assert.strictEqual((pin as any).observedInteraction, undefined);
      assert.strictEqual(pin.items.length, 1);
    });
  });

  describe('5. Deep Immutability Transversal (Seção 26)', () => {
    it('Toda a cadeia (OperationalContext, InputRecord, MaterialContextPin) é imune a mutações posteriores do caller', async () => {
      const inputStore = new InMemoryInputRecordStore();
      const contentStore = new InMemoryIngressContentStore();
      const materialStore = new InMemoryMaterialContextStore();
      const authorizers = new PermissiveAuthorizers();

      const inputService = new InputRecordService({
        inputStore,
        contentStore,
        authorizer: authorizers,
        inputAuthorizer: authorizers,
      });

      const pinService = new MaterialContextPinService({
        store: materialStore,
        authorizer: authorizers,
      });

      // 1. Caller prepara objetos mutáveis
      const callerActor: any = { kind: 'human', humanId: userLucas, role: 'director' };
      const callerSubject: any = { subjectType: 'brand', subjectId: 'alterstate' };
      const callerFlow: any = { flowType: 'checkout', flowId: 'flw_chk_1' };

      const ctx = composeOperationalContext({
        actor: callerActor,
        userId: userLucas,
        sessionRef: sessionRefA,
        contextSubjectRef: callerSubject,
        flowRef: callerFlow,
      });

      assert.strictEqual(Object.isFrozen(ctx), true);
      assert.strictEqual(Object.isFrozen(ctx.actor), true);
      assert.strictEqual(Object.isFrozen(ctx.contextSubjectRef), true);

      // Caller muta seus objetos
      callerActor.humanId = 'HACKED';
      callerSubject.subjectId = 'HACKED';
      callerFlow.flowId = 'HACKED';

      assert.strictEqual((ctx.actor as HumanActor).humanId, userLucas);
      assert.strictEqual(ctx.contextSubjectRef?.subjectId, 'alterstate');
      assert.strictEqual(ctx.flowRef?.flowId, 'flw_chk_1');

      // 2. Caller prepara draft de InputRecord mutável
      const callerPart: any = { kind: 'text', text: 'Mensagem original' };
      const callerParts = [callerPart];

      const inputResult = await inputService.recordInput(
        { parts: callerParts },
        ctx
      );

      assert.strictEqual(Object.isFrozen(inputResult.record), true);
      assert.strictEqual(Object.isFrozen(inputResult.record.parts), true);

      callerPart.text = 'MENSAGEM HACKEADA';
      callerParts.push({ kind: 'text', text: 'PARTE EXTRA INJETADA' });

      assert.strictEqual(inputResult.record.parts.length, 1);
      assert.strictEqual((inputResult.record.parts[0] as any).text, 'Mensagem original');

      // 3. Caller prepara draft de Pin mutável com snapshot JSON aninhado
      const nestedValue: any = { price: 99.9, tags: ['promo', 'summer'] };
      const callerPinItem: any = {
        kind: 'aspect_snapshot',
        aspect: {
          target: {
            kind: 'resource',
            resource: { ownerModule: { moduleKey: 'catalog' as any }, resourceType: 'prod' as any, resourceId: 'p1' as any },
          },
          aspectKey: 'pricing' as any,
        },
        value: nestedValue,
      };
      const callerPinItems = [callerPinItem];

      const pin = await pinService.pin({ items: callerPinItems }, ctx);

      assert.strictEqual(Object.isFrozen(pin), true);
      assert.strictEqual(Object.isFrozen(pin.items), true);

      nestedValue.price = 0.01;
      nestedValue.tags.push('hacked');
      callerPinItems.push({ kind: 'resource_ref', resource: {} as any });

      assert.strictEqual(pin.items.length, 1);
      const snapshot = pin.items[0] as any;
      assert.strictEqual(snapshot.value.price, 99.9);
      assert.strictEqual(snapshot.value.tags.length, 2);
    });
  });
});
