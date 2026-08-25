import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MaterialContextPinService } from '../service';
import type {
  MaterialContextPin,
  MaterialContextPinId,
  PinMaterialContextDraft,
  MaterialContextAccessAuthorizer,
  MaterialContextAccessAuthorizationParams,
} from '../contracts';
import {
  MaterialContextAuthorizationError,
  MaterialContextPinNotFoundError,
} from '../errors';
import type { MaterialContextStore } from '../persistence/contracts';
import type { OperationalContext } from '../../context/contracts';

class InMemoryMaterialContextStore implements MaterialContextStore {
  private readonly pins = new Map<string, MaterialContextPin>();

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

class FakeAuthorizer implements MaterialContextAccessAuthorizer {
  allowCreate = true;
  allowRead = true;

  authorize(params: MaterialContextAccessAuthorizationParams): boolean {
    if (params.operation === 'create') return this.allowCreate;
    if (params.operation === 'read') return this.allowRead;
    return false;
  }
}

describe('0.86B-4 · MaterialContextPinService & Behavior Invariants', () => {
  const baseContext: OperationalContext = {
    actor: { kind: 'human', humanId: 'usr_lucas' },
    userId: 'usr_lucas',
    sessionRef: 'a'.repeat(64) as any,
    contextSubjectRef: {
      subjectType: 'brand' as any,
      subjectId: 'brd_tea' as any,
    },
    flowRef: {
      flowType: 'approval_flow' as any,
      flowId: 'flw_001' as any,
    },
    correlationId: 'corr_test_123' as any,
    channel: 'app_admin' as any,
    location: {
      module: { moduleKey: 'inventory' as any },
      trail: [],
    },
    focus: {
      primaryTarget: {
        kind: 'resource',
        resource: {
          ownerModule: { moduleKey: 'inventory' as any },
          resourceType: 'item' as any,
          resourceId: 'itm_1' as any,
        },
      },
      action: 'view_details' as any,
    },
    observedInteraction: {
      origin: 'client_observed',
      observedAt: '2026-08-25T02:00:00.000Z',
    },
  };

  const sampleDraft: PinMaterialContextDraft = {
    items: [
      {
        kind: 'resource_ref',
        resource: {
          ownerModule: { moduleKey: 'catalog' as any },
          resourceType: 'product' as any,
          resourceId: 'prod_99' as any,
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
              resourceId: 'prod_99' as any,
            },
          },
          aspectKey: 'price' as any,
        },
        value: {
          current: 79.9,
          currency: 'BRL',
          discounts: [5.0, 2.5],
        },
      },
    ],
  };

  it('1. Deriva eixos de autoridade e proveniência do OperationalContext sem copiar location/focus/observedInteraction', async () => {
    const store = new InMemoryMaterialContextStore();
    const authorizer = new FakeAuthorizer();
    const service = new MaterialContextPinService({
      store,
      authorizer,
      nowProvider: () => '2026-08-25T02:30:00.000Z',
    });

    const pin = await service.pin(sampleDraft, baseContext);

    // Eixos esperados derivados
    assert.equal(pin.actor.kind, 'human');
    assert.equal((pin.actor as any).humanId, 'usr_lucas');
    assert.equal(pin.userId, 'usr_lucas');
    assert.equal(pin.sessionRef, 'a'.repeat(64));
    assert.deepEqual(pin.contextSubjectRef, {
      subjectType: 'brand',
      subjectId: 'brd_tea',
    });
    assert.deepEqual(pin.flowRef, {
      flowType: 'approval_flow',
      flowId: 'flw_001',
    });
    assert.equal(pin.correlationId, 'corr_test_123');
    assert.equal(pin.channel, 'app_admin');
    assert.equal(pin.pinnedAt, '2026-08-25T02:30:00.000Z');
    assert.equal(pin.items.length, 2);

    // Garante que location, focus e observedInteraction NÃO foram copiados
    assert.equal((pin as any).location, undefined);
    assert.equal((pin as any).focus, undefined);
    assert.equal((pin as any).observedInteraction, undefined);
  });

  it('2. Duas chamadas com items idênticos geram pinIds distintos (não deduplica por hash)', async () => {
    const store = new InMemoryMaterialContextStore();
    const authorizer = new FakeAuthorizer();
    const service = new MaterialContextPinService({ store, authorizer });

    const pin1 = await service.pin(sampleDraft, baseContext);
    const pin2 = await service.pin(sampleDraft, baseContext);

    assert.notEqual(pin1.pinId, pin2.pinId);
    assert.deepEqual(pin1.items, pin2.items);
  });

  it('3. Prova adversarial de Deep Immutability contra mutações posteriores do caller', async () => {
    const store = new InMemoryMaterialContextStore();
    const authorizer = new FakeAuthorizer();
    const service = new MaterialContextPinService({ store, authorizer });

    // Cria objetos mutáveis locais
    const mutableActor: any = { kind: 'human', humanId: 'lucas', role: 'admin' };
    const mutableSubject: any = { subjectType: 'brand', subjectId: 'brd_tea' };
    const mutableFlow: any = { flowType: 'order', flowId: 'flw_10' };
    const mutableItems: any = [
      {
        kind: 'aspect_snapshot',
        aspect: {
          target: {
            kind: 'resource',
            resource: {
              ownerModule: { moduleKey: 'billing' },
              resourceType: 'invoice',
              resourceId: 'inv_100',
            },
          },
          aspectKey: 'total',
        },
        value: {
          amount: 500,
          breakdown: [200, 300],
        },
      },
    ];

    const mutableContext: OperationalContext = {
      actor: mutableActor,
      userId: 'usr_lucas',
      contextSubjectRef: mutableSubject,
      flowRef: mutableFlow,
    };

    const pin = await service.pin({ items: mutableItems }, mutableContext);

    // Mutações posteriores pelo caller
    mutableActor.humanId = 'attacker';
    mutableSubject.subjectId = 'brd_hacked';
    mutableFlow.flowId = 'flw_corrupted';
    mutableItems[0].kind = 'input_ref';
    mutableItems[0].value.amount = 999999;
    mutableItems[0].value.breakdown.push(1000);
    mutableItems.push({ kind: 'observation_ref', observationId: 'obs_malicious' });

    // O pin retornado e persistido NÃO foram alterados
    assert.equal((pin.actor as any).humanId, 'lucas');
    assert.equal(pin.contextSubjectRef?.subjectId, 'brd_tea');
    assert.equal(pin.flowRef?.flowId, 'flw_10');
    assert.equal(pin.items.length, 1);
    assert.equal(pin.items[0].kind, 'aspect_snapshot');
    assert.equal(((pin.items[0] as any).value as any).amount, 500);
    assert.deepEqual(((pin.items[0] as any).value as any).breakdown, [200, 300]);

    // Verifica congelamento profundo
    assert.ok(Object.isFrozen(pin));
    assert.ok(Object.isFrozen(pin.actor));
    assert.ok(Object.isFrozen(pin.contextSubjectRef));
    assert.ok(Object.isFrozen(pin.flowRef));
    assert.ok(Object.isFrozen(pin.items));
    assert.ok(Object.isFrozen(pin.items[0]));
    assert.ok(Object.isFrozen((pin.items[0] as any).aspect));
    assert.ok(Object.isFrozen((pin.items[0] as any).aspect.target));
    assert.ok(Object.isFrozen((pin.items[0] as any).value));
    assert.ok(Object.isFrozen(((pin.items[0] as any).value as any).breakdown));
  });

  it('4. Prova semântica: resource_ref registra apenas identidade vs aspect_snapshot congela valor material', async () => {
    const store = new InMemoryMaterialContextStore();
    const authorizer = new FakeAuthorizer();
    const service = new MaterialContextPinService({ store, authorizer });

    // Estado da entidade no momento T0
    let externalProductPrice = 79.9;

    const pin = await service.pin(
      {
        items: [
          {
            kind: 'resource_ref',
            resource: {
              ownerModule: { moduleKey: 'catalog' as any },
              resourceType: 'product' as any,
              resourceId: 'prod_1' as any,
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
                  resourceId: 'prod_1' as any,
                },
              },
              aspectKey: 'price' as any,
            },
            value: externalProductPrice,
          },
        ],
      },
      baseContext
    );

    // Em T1, o preço externo é atualizado
    externalProductPrice = 99.9;

    // O pin do contexto material capturado em T0 continua sendo 79.9
    const retrieved = await service.getPin(pin.pinId, baseContext);
    assert.equal(retrieved.items[0].kind, 'resource_ref');
    assert.equal(retrieved.items[1].kind, 'aspect_snapshot');
    assert.equal((retrieved.items[1] as any).value, 79.9);
  });

  it('5. Authorization fail-closed: rejeita create quando autorizador nega', async () => {
    const store = new InMemoryMaterialContextStore();
    const authorizer = new FakeAuthorizer();
    authorizer.allowCreate = false;
    const service = new MaterialContextPinService({ store, authorizer });

    await assert.rejects(
      () => service.pin(sampleDraft, baseContext),
      (err: any) => {
        assert.ok(err instanceof MaterialContextAuthorizationError);
        assert.equal(err.operation, 'create');
        return true;
      }
    );
  });

  it('6. Authorization fail-closed: posse de pinId não concede acesso de leitura quando autorizador nega', async () => {
    const store = new InMemoryMaterialContextStore();
    const authorizer = new FakeAuthorizer();
    authorizer.allowCreate = true;
    const service = new MaterialContextPinService({ store, authorizer });

    const pin = await service.pin(sampleDraft, baseContext);

    // Tenta ler com autorização negada
    authorizer.allowRead = false;
    await assert.rejects(
      () => service.getPin(pin.pinId, baseContext),
      (err: any) => {
        assert.ok(err instanceof MaterialContextAuthorizationError);
        assert.equal(err.operation, 'read');
        assert.equal(err.pinId, pin.pinId);
        return true;
      }
    );
  });

  it('7. getPin para identificador inexistente lança MaterialContextPinNotFoundError', async () => {
    const store = new InMemoryMaterialContextStore();
    const authorizer = new FakeAuthorizer();
    const service = new MaterialContextPinService({ store, authorizer });

    await assert.rejects(
      () => service.getPin('pin_non_existent' as any, baseContext),
      (err: any) => {
        assert.ok(err instanceof MaterialContextPinNotFoundError);
        assert.equal(err.pinId, 'pin_non_existent');
        return true;
      }
    );
  });
});
