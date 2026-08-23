/**
 * NEX+ · Módulos, Referências & Eventos
 * Testes Unitários de InMemoryModuleEventHub — Escopo 0.86 (Bloco 0.86A)
 *
 * Cenários EV-1 a EV-11 + SUB-1 a SUB-5:
 * 1. Validação estrutural e semântica de Domain e System events.
 * 2. Validação contra ModuleRegistry (revisão existente, módulo correto, tipo declarado).
 * 3. Unicidade de EventId e proibição de self-causation.
 * 4. Validação rigorosa de JSON-Safe Payloads e imutabilidade pós-publicação.
 * 5. Determinismo de entrega e isolamento absoluto de falhas em subscribers.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import type {
  CorrelationId,
  EventId,
  EventType,
  ModuleKey,
  ModuleManifestRevision,
  ModuleRevisionId,
  NexEventEnvelope,
  ResourceId,
  ResourceType,
  SubscriberId,
} from '../contracts';
import { createModuleRegistry } from '../registry';
import {
  createModuleEventHub,
  DuplicateEventIdError,
  InvalidJsonPayloadError,
  ModuleKeyMismatchError,
  SelfCausationError,
  UndeclaredEventTypeError,
  UnregisteredModuleRevisionError,
} from '../events';

describe('NEX+ Module Event Hub & Envelope (0.86A)', () => {
  let registry: ReturnType<typeof createCapabilityRegistryMock>;
  let hub: ReturnType<typeof createModuleEventHub>;

  function createCapabilityRegistryMock() {
    const reg = createModuleRegistry();

    const orderModule: ModuleManifestRevision = {
      moduleKey: 'module.orders' as ModuleKey,
      moduleRevisionId: 'mod_rev_orders_v1' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Orders Module',
      description: 'Manages sales orders and state transitions',
      ownedResourceTypes: ['order' as ResourceType, 'order_item' as ResourceType],
      emittedEventTypes: [
        'orders.order_created' as EventType,
        'orders.order_cancelled' as EventType,
      ],
    };

    reg.registerModuleRevision(orderModule);
    return reg;
  }

  beforeEach(() => {
    registry = createCapabilityRegistryMock();
    hub = createModuleEventHub({ moduleRegistry: registry });
  });

  // ==========================================================================
  // 1. EVENT VALIDATION & ENVELOPE (EV-1 .. EV-11)
  // ==========================================================================

  it('EV-1: Domain event legítimo com revisão e tipo declarados publica com sucesso', async () => {
    const event: NexEventEnvelope = {
      eventId: 'evt_01' as EventId,
      eventClass: 'domain',
      type: 'orders.order_created' as EventType,
      origin: {
        kind: 'module',
        module: { moduleKey: 'module.orders' as ModuleKey },
        moduleRevisionId: 'mod_rev_orders_v1' as ModuleRevisionId,
      },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.100Z',
      subject: {
        ownerModule: { moduleKey: 'module.orders' as ModuleKey },
        resourceType: 'order' as ResourceType,
        resourceId: 'ord-1001' as ResourceId,
      },
      correlationId: 'corr_req_123' as CorrelationId,
      payload: {
        orderId: 'ord-1001',
        totalCents: 5990,
        currency: 'BRL',
      },
    };

    const result = await hub.publish(event);

    assert.equal(result.event.eventId, 'evt_01');
    assert.equal(hub.getJournalSize(), 1);
    assert.equal(hub.getEvent('evt_01' as EventId)?.eventId, 'evt_01');
  });

  it('EV-2: System event legítimo com componente explícito publica com sucesso', async () => {
    const event: NexEventEnvelope = {
      eventId: 'evt_sys_01' as EventId,
      eventClass: 'system',
      type: 'system.node_startup' as EventType,
      origin: {
        kind: 'system',
        component: 'telemetry_daemon',
      },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.050Z',
      payload: {
        nodeId: 'node-alpha',
        environment: 'production',
      },
    };

    const result = await hub.publish(event);

    assert.equal(result.event.eventId, 'evt_sys_01');
    assert.equal(result.event.origin.kind, 'system');
    if (result.event.origin.kind === 'system') {
      assert.equal(result.event.origin.component, 'telemetry_daemon');
    }
  });

  it('EV-3: Domain event referenciando ModuleRevisionId inexistente é rejeitado com UnregisteredModuleRevisionError', async () => {
    const event: NexEventEnvelope = {
      eventId: 'evt_err_01' as EventId,
      eventClass: 'domain',
      type: 'orders.order_created' as EventType,
      origin: {
        kind: 'module',
        module: { moduleKey: 'module.orders' as ModuleKey },
        moduleRevisionId: 'mod_rev_phantom_99' as ModuleRevisionId,
      },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.100Z',
      payload: { test: true },
    };

    await assert.rejects(
      async () => {
        await hub.publish(event);
      },
      (err: any) => {
        assert.ok(err instanceof UnregisteredModuleRevisionError);
        assert.equal(err.moduleRevisionId, 'mod_rev_phantom_99');
        return true;
      },
    );
  });

  it('EV-4: Domain event cuja revisão pertence a outro ModuleKey é rejeitado com ModuleKeyMismatchError', async () => {
    // Registra módulo inventory
    registry.registerModuleRevision({
      moduleKey: 'module.inventory' as ModuleKey,
      moduleRevisionId: 'mod_rev_inv_v1' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Inventory',
      description: 'Stock management',
      ownedResourceTypes: [],
      emittedEventTypes: ['orders.order_created' as EventType],
    });

    const event: NexEventEnvelope = {
      eventId: 'evt_err_02' as EventId,
      eventClass: 'domain',
      type: 'orders.order_created' as EventType,
      origin: {
        kind: 'module',
        module: { moduleKey: 'module.orders' as ModuleKey }, // Alega orders
        moduleRevisionId: 'mod_rev_inv_v1' as ModuleRevisionId, // Mas usa rev de inventory
      },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.100Z',
      payload: { test: true },
    };

    await assert.rejects(
      async () => {
        await hub.publish(event);
      },
      (err: any) => {
        assert.ok(err instanceof ModuleKeyMismatchError);
        assert.equal(err.originModuleKey, 'module.orders');
        assert.equal(err.registeredModuleKey, 'module.inventory');
        return true;
      },
    );
  });

  it('EV-5: Domain event cujo EventType não foi declarado no emittedEventTypes da revisão é rejeitado com UndeclaredEventTypeError', async () => {
    const event: NexEventEnvelope = {
      eventId: 'evt_err_03' as EventId,
      eventClass: 'domain',
      type: 'orders.order_secret_mutated' as EventType, // Tipo não declarado
      origin: {
        kind: 'module',
        module: { moduleKey: 'module.orders' as ModuleKey },
        moduleRevisionId: 'mod_rev_orders_v1' as ModuleRevisionId,
      },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.100Z',
      payload: { test: true },
    };

    await assert.rejects(
      async () => {
        await hub.publish(event);
      },
      (err: any) => {
        assert.ok(err instanceof UndeclaredEventTypeError);
        assert.equal(err.eventType, 'orders.order_secret_mutated');
        assert.equal(err.moduleRevisionId, 'mod_rev_orders_v1');
        return true;
      },
    );
  });

  it('EV-6: Duplicate EventId é rejeitado fail-visible com DuplicateEventIdError e zero redelivery', async () => {
    let subscriberCalls = 0;
    hub.subscribe({
      subscriberId: 'sub_counter' as SubscriberId,
      handler: () => {
        subscriberCalls++;
      },
    });

    const event: NexEventEnvelope = {
      eventId: 'evt_dup_01' as EventId,
      eventClass: 'system',
      type: 'system.heartbeat' as EventType,
      origin: { kind: 'system', component: 'daemon' },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.010Z',
      payload: { status: 'alive' },
    };

    // Publicação 1 -> sucesso
    await hub.publish(event);
    assert.equal(subscriberCalls, 1);

    // Publicação 2 (mesmo EventId) -> falha
    await assert.rejects(
      async () => {
        await hub.publish(event);
      },
      (err: any) => {
        assert.ok(err instanceof DuplicateEventIdError);
        assert.equal(err.eventId, 'evt_dup_01');
        return true;
      },
    );

    // Subscriber NÃO foi chamado uma segunda vez
    assert.equal(subscriberCalls, 1);
    assert.equal(hub.getJournalSize(), 1);
  });

  it('EV-7: Self causation (causationId === eventId) é estritamente proibido com SelfCausationError', async () => {
    const event: NexEventEnvelope = {
      eventId: 'evt_loop_01' as EventId,
      eventClass: 'system',
      type: 'system.ping' as EventType,
      origin: { kind: 'system', component: 'ping_service' },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.010Z',
      causationId: 'evt_loop_01' as EventId, // Loop causal
      payload: { ping: 1 },
    };

    await assert.rejects(
      async () => {
        await hub.publish(event);
      },
      (err: any) => {
        assert.ok(err instanceof SelfCausationError);
        assert.equal(err.eventId, 'evt_loop_01');
        return true;
      },
    );
  });

  it('EV-8: CorrelationId e CausationId legítimos são preservados no journal', async () => {
    const event: NexEventEnvelope = {
      eventId: 'evt_child_02' as EventId,
      eventClass: 'system',
      type: 'system.task_finished' as EventType,
      origin: { kind: 'system', component: 'worker' },
      occurredAt: '2026-08-22T10:05:00.000Z',
      recordedAt: '2026-08-22T10:05:00.010Z',
      correlationId: 'flow_98765' as CorrelationId,
      causationId: 'evt_parent_01' as EventId,
      payload: { durationMs: 450 },
    };

    const result = await hub.publish(event);
    assert.equal(result.event.correlationId, 'flow_98765');
    assert.equal(result.event.causationId, 'evt_parent_01');

    const stored = hub.getEvent('evt_child_02' as EventId);
    assert.equal(stored?.correlationId, 'flow_98765');
    assert.equal(stored?.causationId, 'evt_parent_01');
  });

  it('EV-9: Payload de evento publicado é imutável (Object.freeze)', async () => {
    const event: NexEventEnvelope = {
      eventId: 'evt_freeze_01' as EventId,
      eventClass: 'system',
      type: 'system.metrics' as EventType,
      origin: { kind: 'system', component: 'monitor' },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.010Z',
      payload: {
        stats: {
          cpuPercent: 15,
          memoryMb: 512,
        },
      },
    };

    const result = await hub.publish(event);

    assert.ok(Object.isFrozen(result.event.payload));
    assert.ok(Object.isFrozen(result.event.payload.stats));

    assert.throws(() => {
      (result.event.payload as any).stats = {};
    });

    assert.throws(() => {
      (result.event.payload.stats as any).cpuPercent = 99;
    });
  });

  it('EV-10: Mutar o payload original antes ou depois do publish não afeta o journal', async () => {
    const rawPayload: any = {
      user: {
        name: 'Lucas',
        role: 'operator',
      },
      items: [1, 2, 3],
    };

    const event: NexEventEnvelope = {
      eventId: 'evt_isolation_01' as EventId,
      eventClass: 'system',
      type: 'system.audit' as EventType,
      origin: { kind: 'system', component: 'security' },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.010Z',
      payload: rawPayload,
    };

    await hub.publish(event);

    // Mutamos o objeto original do caller
    rawPayload.user.name = 'HACKED';
    rawPayload.items.push(999);
    rawPayload.newField = 'INJECTED';

    // O journal permanece 100% íntegro e intacto
    const stored = hub.getEvent('evt_isolation_01' as EventId)!;
    assert.equal((stored.payload as any).user.name, 'Lucas');
    assert.deepEqual((stored.payload as any).items, [1, 2, 3]);
    assert.equal((stored.payload as any).newField, undefined);
  });

  it('EV-11: Payload contendo types inválidos, NaN, Infinity, loops circulares ou chaves de prototype pollution é rejeitado', async () => {
    const baseEnvelope = (payload: any): NexEventEnvelope => ({
      eventId: `evt_inv_${Math.random()}` as EventId,
      eventClass: 'system',
      type: 'system.test' as EventType,
      origin: { kind: 'system', component: 'test' },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.010Z',
      payload,
    });

    // 1. Function
    await assert.rejects(
      async () => hub.publish(baseEnvelope({ bad: () => 123 })),
      (err: any) => err instanceof InvalidJsonPayloadError,
    );

    // 2. undefined
    await assert.rejects(
      async () => hub.publish(baseEnvelope({ bad: undefined })),
      (err: any) => err instanceof InvalidJsonPayloadError,
    );

    // 3. NaN
    await assert.rejects(
      async () => hub.publish(baseEnvelope({ bad: NaN })),
      (err: any) => err instanceof InvalidJsonPayloadError,
    );

    // 4. Infinity
    await assert.rejects(
      async () => hub.publish(baseEnvelope({ bad: Infinity })),
      (err: any) => err instanceof InvalidJsonPayloadError,
    );

    // 5. Circular reference
    const circular: any = { a: 1 };
    circular.self = circular;
    await assert.rejects(
      async () => hub.publish(baseEnvelope(circular)),
      (err: any) => err instanceof InvalidJsonPayloadError,
    );

    // 6. Prototype pollution key (__proto__)
    const protoObj = JSON.parse('{"__proto__": {"injected": true}}');
    await assert.rejects(
      async () => hub.publish(baseEnvelope(protoObj)),
      (err: any) => err instanceof InvalidJsonPayloadError,
    );
  });

  // ==========================================================================
  // 2. SUBSCRIPTIONS & DELIVERY (SUB-1 .. SUB-5)
  // ==========================================================================

  it('SUB-1: Múltiplos subscribers compatíveis recebem o evento publicado', async () => {
    const receivedA: NexEventEnvelope[] = [];
    const receivedB: NexEventEnvelope[] = [];

    hub.subscribe({
      subscriberId: 'sub_a' as SubscriberId,
      handler: (e) => {
        receivedA.push(e);
      },
    });

    hub.subscribe({
      subscriberId: 'sub_b' as SubscriberId,
      handler: (e) => {
        receivedB.push(e);
      },
    });

    const event: NexEventEnvelope = {
      eventId: 'evt_sub_01' as EventId,
      eventClass: 'system',
      type: 'system.broadcast' as EventType,
      origin: { kind: 'system', component: 'notifier' },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.010Z',
      payload: { msg: 'hello' },
    };

    const res = await hub.publish(event);

    assert.equal(receivedA.length, 1);
    assert.equal(receivedB.length, 1);
    assert.equal(res.deliveries.length, 2);
    assert.equal(res.deliveries[0].status, 'delivered');
    assert.equal(res.deliveries[1].status, 'delivered');
  });

  it('SUB-2: Ordem de entrega aos subscribers é estritamente determinística (ordem de registro)', async () => {
    const callOrder: string[] = [];

    hub.subscribe({
      subscriberId: 'sub_first' as SubscriberId,
      handler: () => {
        callOrder.push('first');
      },
    });

    hub.subscribe({
      subscriberId: 'sub_second' as SubscriberId,
      handler: () => {
        callOrder.push('second');
      },
    });

    hub.subscribe({
      subscriberId: 'sub_third' as SubscriberId,
      handler: () => {
        callOrder.push('third');
      },
    });

    const event: NexEventEnvelope = {
      eventId: 'evt_order_01' as EventId,
      eventClass: 'system',
      type: 'system.seq' as EventType,
      origin: { kind: 'system', component: 'order_test' },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.010Z',
      payload: {},
    };

    await hub.publish(event);

    assert.deepEqual(callOrder, ['first', 'second', 'third']);
  });

  it('SUB-3: Falha em Subscriber A não impede entrega a Subscriber B e preserva evento no journal', async () => {
    let subscriberBReceived = false;

    hub.subscribe({
      subscriberId: 'sub_failing_A' as SubscriberId,
      handler: () => {
        throw new Error('Subscriber A crashed intentionally');
      },
    });

    hub.subscribe({
      subscriberId: 'sub_healthy_B' as SubscriberId,
      handler: () => {
        subscriberBReceived = true;
      },
    });

    const event: NexEventEnvelope = {
      eventId: 'evt_isolation_fail_01' as EventId,
      eventClass: 'system',
      type: 'system.alert' as EventType,
      origin: { kind: 'system', component: 'alert_daemon' },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.010Z',
      payload: { alertLevel: 'high' },
    };

    const res = await hub.publish(event);

    // Subscriber B recebeu normalmente
    assert.equal(subscriberBReceived, true);

    // Journal gravou o evento perfeitamente
    assert.equal(hub.getJournalSize(), 1);
    assert.equal(hub.getEvent('evt_isolation_fail_01' as EventId)?.eventId, 'evt_isolation_fail_01');

    // Relatório de delivery reflete status de cada um
    assert.equal(res.deliveries.length, 2);
    assert.equal(res.deliveries[0].subscriberId, 'sub_failing_A');
    assert.equal(res.deliveries[0].status, 'failed');
    assert.ok(res.deliveries[0].error?.includes('Subscriber A crashed intentionally'));

    assert.equal(res.deliveries[1].subscriberId, 'sub_healthy_B');
    assert.equal(res.deliveries[1].status, 'delivered');
  });

  it('SUB-4: Subscriber com filtro de eventTypes não recebe eventos aos quais não está inscrito', async () => {
    let receivedCount = 0;

    hub.subscribe({
      subscriberId: 'sub_filtered' as SubscriberId,
      eventTypes: ['orders.order_cancelled' as EventType],
      handler: () => {
        receivedCount++;
      },
    });

    const eventCreated: NexEventEnvelope = {
      eventId: 'evt_filter_01' as EventId,
      eventClass: 'domain',
      type: 'orders.order_created' as EventType,
      origin: {
        kind: 'module',
        module: { moduleKey: 'module.orders' as ModuleKey },
        moduleRevisionId: 'mod_rev_orders_v1' as ModuleRevisionId,
      },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.010Z',
      payload: { id: 1 },
    };

    await hub.publish(eventCreated);
    assert.equal(receivedCount, 0);

    const eventCancelled: NexEventEnvelope = {
      eventId: 'evt_filter_02' as EventId,
      eventClass: 'domain',
      type: 'orders.order_cancelled' as EventType,
      origin: {
        kind: 'module',
        module: { moduleKey: 'module.orders' as ModuleKey },
        moduleRevisionId: 'mod_rev_orders_v1' as ModuleRevisionId,
      },
      occurredAt: '2026-08-22T10:01:00.000Z',
      recordedAt: '2026-08-22T10:01:00.010Z',
      payload: { id: 1 },
    };

    await hub.publish(eventCancelled);
    assert.equal(receivedCount, 1);
  });

  it('SUB-5: Unsubscribe remove o subscriber e impede entregas posteriores', async () => {
    let count = 0;

    const unsubscribe = hub.subscribe({
      subscriberId: 'sub_temp' as SubscriberId,
      handler: () => {
        count++;
      },
    });

    const event1: NexEventEnvelope = {
      eventId: 'evt_unsub_01' as EventId,
      eventClass: 'system',
      type: 'system.ping' as EventType,
      origin: { kind: 'system', component: 'daemon' },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.010Z',
      payload: {},
    };

    await hub.publish(event1);
    assert.equal(count, 1);

    // Cancelar subscrição
    unsubscribe();

    const event2: NexEventEnvelope = {
      eventId: 'evt_unsub_02' as EventId,
      eventClass: 'system',
      type: 'system.ping' as EventType,
      origin: { kind: 'system', component: 'daemon' },
      occurredAt: '2026-08-22T10:01:00.000Z',
      recordedAt: '2026-08-22T10:01:00.010Z',
      payload: {},
    };

    await hub.publish(event2);
    assert.equal(count, 1); // Permanece 1
  });
});
