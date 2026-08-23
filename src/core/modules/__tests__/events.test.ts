/**
 * NEX+ · Módulos, Referências & Eventos
 * Testes Unitários de InMemoryModuleEventHub — Escopo 0.86 (Bloco 0.86A · Micro-Hardening)
 *
 * Cenários EV-1 a EV-11 + SUB-1 a SUB-5 + Hardening H-1..H-6, L-1..L-3, R-1:
 * 1. Validação estrutural e semântica de Domain e System events.
 * 2. Validação contra ModuleRegistry (exigência para domain events, revisão existente, módulo correto, tipo declarado).
 * 3. Unicidade de EventId, proibição de self-causation e append-only journal inalterável.
 * 4. Validação rigorosa de temporalidade canônica UTC (terminada em Z, sem offsets, sem datas de calendário impossíveis).
 * 5. Validação rigorosa de JSON-Safe Payloads e imutabilidade pós-publicação.
 * 6. Determinismo de entrega e isolamento absoluto de falhas em subscribers.
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
  InvalidEventEnvelopeError,
  InvalidJsonPayloadError,
  ModuleKeyMismatchError,
  ModuleRegistryRequiredError,
  SelfCausationError,
  UndeclaredEventTypeError,
  UnregisteredModuleRevisionError,
  isValidCanonicalUtcTimestamp,
} from '../events';

describe('NEX+ Module Event Hub & Envelope (0.86A · Hardening)', () => {
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
  // 1. BLOCKER H: DOMAIN EVENT EXIGE MODULE REGISTRY (H-1 .. H-6)
  // ==========================================================================

  it('H-1, H-2, H-3: Hub sem ModuleRegistry + Domain event falha fechado com ModuleRegistryRequiredError sem gravar no journal e sem acionar subscriber', async () => {
    const hubWithoutRegistry = createModuleEventHub(); // Sem registry
    let subscriberCalls = 0;

    hubWithoutRegistry.subscribe({
      subscriberId: 'sub_test_h' as SubscriberId,
      handler: () => {
        subscriberCalls++;
      },
    });

    const domainEvent: NexEventEnvelope = {
      eventId: 'evt_domain_no_reg' as EventId,
      eventClass: 'domain',
      type: 'orders.order_created' as EventType,
      origin: {
        kind: 'module',
        module: { moduleKey: 'module.orders' as ModuleKey },
        moduleRevisionId: 'mod_rev_orders_v1' as ModuleRevisionId,
      },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.100Z',
      payload: { test: true },
    };

    // H-1: Falha fechado com ModuleRegistryRequiredError
    await assert.rejects(
      async () => {
        await hubWithoutRegistry.publish(domainEvent);
      },
      (err: any) => {
        assert.ok(err instanceof ModuleRegistryRequiredError);
        return true;
      },
    );

    // H-2: Journal size continua 0
    assert.equal(hubWithoutRegistry.getJournalSize(), 0);
    assert.equal(hubWithoutRegistry.getEvent('evt_domain_no_reg' as EventId), undefined);

    // H-3: Subscriber não foi chamado
    assert.equal(subscriberCalls, 0);
  });

  it('H-4: Hub sem ModuleRegistry + System event legítimo publica normalmente', async () => {
    const hubWithoutRegistry = createModuleEventHub();
    let subscriberReceived = false;

    hubWithoutRegistry.subscribe({
      subscriberId: 'sub_sys' as SubscriberId,
      handler: () => {
        subscriberReceived = true;
      },
    });

    const systemEvent: NexEventEnvelope = {
      eventId: 'evt_sys_no_reg' as EventId,
      eventClass: 'system',
      type: 'system.node_ping' as EventType,
      origin: { kind: 'system', component: 'healthcheck' },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.050Z',
      payload: { healthy: true },
    };

    const res = await hubWithoutRegistry.publish(systemEvent);
    assert.equal(res.event.eventId, 'evt_sys_no_reg');
    assert.equal(hubWithoutRegistry.getJournalSize(), 1);
    assert.equal(subscriberReceived, true);
  });

  it('H-5: Hub com ModuleRegistry + Domain event legítimo publica com sucesso', async () => {
    const domainEvent: NexEventEnvelope = {
      eventId: 'evt_domain_with_reg' as EventId,
      eventClass: 'domain',
      type: 'orders.order_created' as EventType,
      origin: {
        kind: 'module',
        module: { moduleKey: 'module.orders' as ModuleKey },
        moduleRevisionId: 'mod_rev_orders_v1' as ModuleRevisionId,
      },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.100Z',
      payload: { orderId: 'ord-1' },
    };

    const res = await hub.publish(domainEvent);
    assert.equal(res.event.eventId, 'evt_domain_with_reg');
    assert.equal(hub.getJournalSize(), 1);
  });

  it('H-6: As três validações semânticas de ModuleRegistry (unregistered revision, module key mismatch, undeclared event type) são preservadas', async () => {
    // 1. Unregistered revision
    await assert.rejects(
      async () => {
        await hub.publish({
          eventId: 'evt_unreg' as EventId,
          eventClass: 'domain',
          type: 'orders.order_created' as EventType,
          origin: {
            kind: 'module',
            module: { moduleKey: 'module.orders' as ModuleKey },
            moduleRevisionId: 'mod_rev_ghost' as ModuleRevisionId,
          },
          occurredAt: '2026-08-22T10:00:00.000Z',
          recordedAt: '2026-08-22T10:00:00.100Z',
          payload: {},
        });
      },
      (err: any) => err instanceof UnregisteredModuleRevisionError,
    );

    // 2. Module key mismatch
    registry.registerModuleRevision({
      moduleKey: 'module.other' as ModuleKey,
      moduleRevisionId: 'mod_rev_other_1' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Other',
      description: 'Other module',
      ownedResourceTypes: [],
      emittedEventTypes: ['orders.order_created' as EventType],
    });

    await assert.rejects(
      async () => {
        await hub.publish({
          eventId: 'evt_mismatch' as EventId,
          eventClass: 'domain',
          type: 'orders.order_created' as EventType,
          origin: {
            kind: 'module',
            module: { moduleKey: 'module.orders' as ModuleKey },
            moduleRevisionId: 'mod_rev_other_1' as ModuleRevisionId,
          },
          occurredAt: '2026-08-22T10:00:00.000Z',
          recordedAt: '2026-08-22T10:00:00.100Z',
          payload: {},
        });
      },
      (err: any) => err instanceof ModuleKeyMismatchError,
    );

    // 3. Undeclared event type
    await assert.rejects(
      async () => {
        await hub.publish({
          eventId: 'evt_undeclared' as EventId,
          eventClass: 'domain',
          type: 'orders.unregistered_secret_event' as EventType,
          origin: {
            kind: 'module',
            module: { moduleKey: 'module.orders' as ModuleKey },
            moduleRevisionId: 'mod_rev_orders_v1' as ModuleRevisionId,
          },
          occurredAt: '2026-08-22T10:00:00.000Z',
          recordedAt: '2026-08-22T10:00:00.100Z',
          payload: {},
        });
      },
      (err: any) => err instanceof UndeclaredEventTypeError,
    );
  });

  // ==========================================================================
  // 2. BLOCKER L: TEMPORALIDADE CANÔNICA UTC (L-1 .. L-3)
  // ==========================================================================

  it('L-1: Validador isValidCanonicalUtcTimestamp aceita estritamente instantes UTC terminados em Z', () => {
    // Válidos
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T10:00:00Z'), true);
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T10:00:00.0Z'), true);
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T10:00:00.00Z'), true);
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T10:00:00.000Z'), true);
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T10:00:00.123Z'), true);
    assert.equal(isValidCanonicalUtcTimestamp('2026-12-31T23:59:59.999Z'), true);

    // Rejeitados: sem Z
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T10:00:00'), false);
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T10:00:00.000'), false);

    // Rejeitados: offsets numéricos
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T10:00:00+03:00'), false);
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T10:00:00-03:00'), false);
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T10:00:00+00:00'), false);

    // Rejeitados: formatos não ISO / datas sem tempo
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22'), false);
    assert.equal(isValidCanonicalUtcTimestamp('08/22/2026'), false);
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22 10:00:00Z'), false);

    // Rejeitados: whitespace periférico
    assert.equal(isValidCanonicalUtcTimestamp(' 2026-08-22T10:00:00Z'), false);
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T10:00:00Z '), false);

    // Rejeitados: fração excessiva (> 3 dígitos)
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T10:00:00.1234Z'), false);

    // Rejeitados: datas impossíveis no calendário
    assert.equal(isValidCanonicalUtcTimestamp('2026-02-30T10:00:00Z'), false); // 30 de fevereiro
    assert.equal(isValidCanonicalUtcTimestamp('2026-04-31T10:00:00Z'), false); // 31 de abril
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T25:00:00Z'), false); // hora 25
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T10:60:00Z'), false); // minuto 60
    assert.equal(isValidCanonicalUtcTimestamp('2026-08-22T10:00:60Z'), false); // segundo 60
  });

  it('L-2: Evento com occurredAt ou recordedAt fora do padrão canônico UTC é rejeitado no publish', async () => {
    const makeEvent = (occurredAt: string, recordedAt: string): NexEventEnvelope => ({
      eventId: 'evt_time_test' as EventId,
      eventClass: 'system',
      type: 'system.ping' as EventType,
      origin: { kind: 'system', component: 'timekeeper' },
      occurredAt,
      recordedAt,
      payload: {},
    });

    // Offset +03:00 em occurredAt -> rejeita
    await assert.rejects(
      async () => hub.publish(makeEvent('2026-08-22T10:00:00+03:00', '2026-08-22T10:00:00.000Z')),
      (err: any) => err instanceof InvalidEventEnvelopeError && err.fieldName === 'occurredAt',
    );

    // Data sem hora em recordedAt -> rejeita
    await assert.rejects(
      async () => hub.publish(makeEvent('2026-08-22T10:00:00.000Z', '2026-08-22')),
      (err: any) => err instanceof InvalidEventEnvelopeError && err.fieldName === 'recordedAt',
    );

    // 30 de fevereiro em occurredAt -> rejeita
    await assert.rejects(
      async () => hub.publish(makeEvent('2026-02-30T10:00:00Z', '2026-08-22T10:00:00.000Z')),
      (err: any) => err instanceof InvalidEventEnvelopeError && err.fieldName === 'occurredAt',
    );
  });

  // ==========================================================================
  // 3. BLOCKER R: JOURNAL APPEND-ONLY SEM CLEAR (R-1)
  // ==========================================================================

  it('R-1: ModuleEventHub não expõe clearForTests() e o Journal é estritamente append-only', async () => {
    const testHub = createModuleEventHub();
    let subscriberCalls = 0;

    testHub.subscribe({
      subscriberId: 'sub_r1' as SubscriberId,
      handler: () => {
        subscriberCalls++;
      },
    });

    const event: NexEventEnvelope = {
      eventId: 'evt_r1_unique' as EventId,
      eventClass: 'system',
      type: 'system.boot' as EventType,
      origin: { kind: 'system', component: 'kernel' },
      occurredAt: '2026-08-22T10:00:00.000Z',
      recordedAt: '2026-08-22T10:00:00.010Z',
      payload: { boot: 1 },
    };

    // 1. Publica evento X
    await testHub.publish(event);
    assert.equal(testHub.getJournalSize(), 1);
    assert.equal(subscriberCalls, 1);

    // 2. Prova: API pública não expõe clearForTests
    assert.equal((testHub as any).clearForTests, undefined);

    // 3. Tentar publicar EventId X novamente é rejeitado como DuplicateEventId
    await assert.rejects(
      async () => {
        await testHub.publish(event);
      },
      (err: any) => {
        assert.ok(err instanceof DuplicateEventIdError);
        assert.equal(err.eventId, 'evt_r1_unique');
        return true;
      },
    );

    // 4. Journal permanece com exatamente 1 entrada e subscriber não recebeu 2ª entrega
    assert.equal(testHub.getJournalSize(), 1);
    assert.equal(subscriberCalls, 1);
  });

  // ==========================================================================
  // 4. EVENT VALIDATION & ENVELOPE (EV-1 .. EV-11)
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
        module: { moduleKey: 'module.orders' as ModuleKey },
        moduleRevisionId: 'mod_rev_inv_v1' as ModuleRevisionId,
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
      type: 'orders.order_secret_mutated' as EventType,
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
      causationId: 'evt_loop_01' as EventId,
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
  // 5. SUBSCRIPTIONS & DELIVERY (SUB-1 .. SUB-5)
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
    assert.equal(count, 1);
  });
});
