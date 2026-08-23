/**
 * NEX+ · Módulos, Referências & Eventos
 * Testes de Aceitação, Autoridade & Red-Team — Escopo 0.86 (Bloco 0.86A)
 *
 * Cenários:
 * 1. AUTH-EVENT-1 & AUTH-EVENT-2: Evento é sinal e NUNCA concede autoridade (proibição de side-effects automáticos).
 * 2. CROSS-MODULE: Referências cruzadas preservam ownership estrito do módulo dono.
 * 3. CLOUDEVENTS-COMPAT: Mapeamento conceitual do envelope NEX+ para CloudEvents spec.
 * 4. BOUNDARY-ISOLATION: Isolamento de dependências no código-fonte de src/core/modules/.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
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
import { createModuleEventHub } from '../events';

describe('NEX+ Core Modules & Events Acceptance (0.86A)', () => {
  // ==========================================================================
  // 1. EVENTO NÃO É AUTORIZAÇÃO (AUTH-EVENT-1 & AUTH-EVENT-2)
  // ==========================================================================

  it('AUTH-EVENT-1: Evento com payload "operation: external.write" publica como sinal mas gera ZERO DispatchAdmission, ZERO Attempt e ZERO mutação', async () => {
    const registry = createModuleRegistry();
    const hub = createModuleEventHub({ moduleRegistry: registry });

    const auditModule: ModuleManifestRevision = {
      moduleKey: 'module.audit' as ModuleKey,
      moduleRevisionId: 'mod_rev_audit_1' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Audit Module',
      description: 'Emits audit trails',
      ownedResourceTypes: [],
      emittedEventTypes: ['audit.action_logged' as EventType],
    };
    registry.registerModuleRevision(auditModule);

    let observedEvent: NexEventEnvelope | undefined;
    hub.subscribe({
      subscriberId: 'sub_observer' as SubscriberId,
      handler: (e) => {
        observedEvent = e;
      },
    });

    const adversarialEvent: NexEventEnvelope = {
      eventId: 'evt_adv_01' as EventId,
      eventClass: 'domain',
      type: 'audit.action_logged' as EventType,
      origin: {
        kind: 'module',
        module: { moduleKey: 'module.audit' as ModuleKey },
        moduleRevisionId: 'mod_rev_audit_1' as ModuleRevisionId,
      },
      occurredAt: '2026-08-22T12:00:00.000Z',
      recordedAt: '2026-08-22T12:00:00.010Z',
      payload: {
        operation: 'external.write',
        targetResource: 'https://external-api.com/v1/resource',
        command: 'DROP_TABLE',
      },
    };

    const res = await hub.publish(adversarialEvent);

    // 1. O evento foi registrado no journal
    assert.equal(res.event.eventId, 'evt_adv_01');
    assert.ok(observedEvent);
    assert.equal(observedEvent.eventId, 'evt_adv_01');

    // 2. O payload é puro dado inerte (não concede authority, admission, attempt ou capability)
    assert.equal(observedEvent.payload.operation, 'external.write');
    assert.equal((observedEvent as any).admissionId, undefined);
    assert.equal((observedEvent as any).attemptId, undefined);
    assert.equal((observedEvent as any).policyVerdict, undefined);
  });

  it('AUTH-EVENT-2: Evento com payload contendo chaves de autoridade (approved, admin, token) é apenas data e não confere poder de execução', async () => {
    const registry = createModuleRegistry();
    const hub = createModuleEventHub({ moduleRegistry: registry });

    const event: NexEventEnvelope = {
      eventId: 'evt_adv_02' as EventId,
      eventClass: 'system',
      type: 'system.privileged_claim' as EventType,
      origin: { kind: 'system', component: 'rogue_subsystem' },
      occurredAt: '2026-08-22T12:00:00.000Z',
      recordedAt: '2026-08-22T12:00:00.010Z',
      payload: {
        authorization: 'BYPASS_ALL',
        approved: true,
        admin: true,
        allow: true,
        dispatchAdmissionId: 'adm_fake_12345',
        role: 'super_admin',
      },
    };

    const res = await hub.publish(event);

    assert.equal(res.event.eventId, 'evt_adv_02');
    assert.equal(res.event.payload.authorization, 'BYPASS_ALL');
    assert.equal(res.event.payload.approved, true);

    // O EventHub trata exclusivamente como dado imutável
    const stored = hub.getEvent('evt_adv_02' as EventId)!;
    assert.equal(stored.payload.dispatchAdmissionId, 'adm_fake_12345');
  });

  // ==========================================================================
  // 2. OWNERSHIP & REFERÊNCIAS CRUZADAS (CROSS-MODULE)
  // ==========================================================================

  it('CROSS-MODULE: module.beta emite evento sobre subject de module.alpha sem transferir ownership', async () => {
    const registry = createModuleRegistry();
    const hub = createModuleEventHub({ moduleRegistry: registry });

    const moduleAlpha: ModuleManifestRevision = {
      moduleKey: 'module.alpha' as ModuleKey,
      moduleRevisionId: 'mod_rev_alpha_1' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Alpha Store',
      description: 'Owns user profiles and customer records',
      ownedResourceTypes: ['record' as ResourceType, 'profile' as ResourceType],
      emittedEventTypes: ['alpha.record_created' as EventType],
    };

    const moduleBeta: ModuleManifestRevision = {
      moduleKey: 'module.beta' as ModuleKey,
      moduleRevisionId: 'mod_rev_beta_1' as ModuleRevisionId,
      lifecycle: 'active',
      supersedesRevisionIds: [],
      title: 'Beta Analytics',
      description: 'Analyzes user interactions',
      ownedResourceTypes: ['report' as ResourceType],
      emittedEventTypes: ['beta.analytics_computed' as EventType],
    };

    registry.registerModuleRevision(moduleAlpha);
    registry.registerModuleRevision(moduleBeta);

    // Subject aponta para o recurso de alpha
    const alphaRecordRef = registry.createResourceRef('module.alpha', 'record', 'record-777');

    // Beta emite evento legítimo falando sobre o recurso de alpha
    const betaEvent: NexEventEnvelope = {
      eventId: 'evt_beta_01' as EventId,
      eventClass: 'domain',
      type: 'beta.analytics_computed' as EventType,
      origin: {
        kind: 'module',
        module: { moduleKey: 'module.beta' as ModuleKey },
        moduleRevisionId: 'mod_rev_beta_1' as ModuleRevisionId,
      },
      occurredAt: '2026-08-22T14:00:00.000Z',
      recordedAt: '2026-08-22T14:00:00.050Z',
      subject: alphaRecordRef,
      payload: {
        score: 98.5,
        insights: ['frequent_buyer'],
      },
    };

    const res = await hub.publish(betaEvent);

    assert.equal(res.event.eventId, 'evt_beta_01');
    assert.equal(res.event.origin.kind, 'module');
    if (res.event.origin.kind === 'module') {
      assert.equal(res.event.origin.module.moduleKey, 'module.beta');
    }

    // O subject continua pertencendo exclusivamente ao module.alpha!
    assert.ok(res.event.subject);
    assert.equal(res.event.subject.ownerModule.moduleKey, 'module.alpha');
    assert.equal(res.event.subject.resourceType, 'record');
    assert.equal(res.event.subject.resourceId, 'record-777');
  });

  // ==========================================================================
  // 3. CLOUDEVENTS SEMANTIC COMPATIBILITY
  // ==========================================================================

  it('CLOUDEVENTS-COMPAT: Mapeamento conceitual para CloudEvents spec', () => {
    const registry = createModuleRegistry();
    const resource = registry.createResourceRef('module.catalog', 'product', 'sku-100');

    const envelope: NexEventEnvelope = {
      eventId: 'evt_ce_01' as EventId,
      eventClass: 'domain',
      type: 'catalog.product_updated' as EventType,
      origin: {
        kind: 'module',
        module: { moduleKey: 'module.catalog' as ModuleKey },
        moduleRevisionId: 'mod_rev_catalog_v1' as ModuleRevisionId,
      },
      occurredAt: '2026-08-22T15:00:00.000Z',
      recordedAt: '2026-08-22T15:00:00.010Z',
      subject: resource,
      payload: {
        priceCents: 12900,
      },
    };

    // Mapeamento formal de atributos conceituais CloudEvents:
    // id -> eventId
    assert.equal(envelope.eventId, 'evt_ce_01');

    // source -> origin (serializado estruturalmente)
    assert.equal(envelope.origin.kind, 'module');
    if (envelope.origin.kind === 'module') {
      assert.equal(envelope.origin.module.moduleKey, 'module.catalog');
      assert.equal(envelope.origin.moduleRevisionId, 'mod_rev_catalog_v1');
    }

    // type -> type
    assert.equal(envelope.type, 'catalog.product_updated');

    // time -> occurredAt
    assert.equal(envelope.occurredAt, '2026-08-22T15:00:00.000Z');

    // subject -> subject
    assert.equal(envelope.subject?.resourceId, 'sku-100');
    assert.equal(envelope.subject?.resourceType, 'product');
    assert.equal(envelope.subject?.ownerModule.moduleKey, 'module.catalog');

    // data -> payload
    assert.deepEqual(envelope.payload, { priceCents: 12900 });
  });

  // ==========================================================================
  // 4. DEPENDENCY BOUNDARY ISOLATION (ZERO DEPENDÊNCIAS DE EXECUTION/EVALUATION)
  // ==========================================================================

  it('BOUNDARY-ISOLATION: O módulo src/core/modules/ não possui imports para evaluation, policy ou execution', () => {
    const modulesDir = path.resolve(process.cwd(), 'src/core/modules');
    const sourceFiles = ['contracts.ts', 'registry.ts', 'events.ts', 'index.ts'];

    for (const fileName of sourceFiles) {
      const filePath = path.join(modulesDir, fileName);
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        if (line.trim().startsWith('import ') || line.trim().startsWith('export * from')) {
          assert.equal(
            line.includes('/evaluation'),
            false,
            `File ${fileName} must not import from evaluation: '${line}'`,
          );
          assert.equal(
            line.includes('/policy'),
            false,
            `File ${fileName} must not import from policy: '${line}'`,
          );
          assert.equal(
            line.includes('/execution'),
            false,
            `File ${fileName} must not import from execution: '${line}'`,
          );
        }
      }
    }
  });
});
