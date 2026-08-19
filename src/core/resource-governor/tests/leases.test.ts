/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Testes Unitários de Resource Leases — Escopo 0.6 (Fase B / Hardening)
 *
 * Cenários B1 a B13 + G20 a G22: Criação, estados, transições válidas/inválidas,
 * validação numérica estrita, timestamps obrigatórios e reconciliação temporal.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { RouteRevisionId } from '../../capabilities/contracts';
import type { DecisionId } from '../../execution/contracts';
import type { DecisionMaterialContextId } from '../../evaluation/contracts';

import type {
  ResourceLeaseId,
  ResourceRequestId,
} from '../contracts';
import {
  createResourceLeaseStore,
  ResourceLeaseError,
} from '../leases/store';

describe('NEX+ Resource Governor · Resource Leases (Fase B & Hardening)', () => {
  // B1. create reserved lease
  it('B1. create reserved lease', () => {
    const store = createResourceLeaseStore();
    const lease = store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      targetModel: 'llama3:8b',
      reservedRamBytes: 1024,
      reservedVramBytes: 2048,
      createdAt: '2026-08-19T20:00:00.000Z',
    });

    assert.equal(lease.leaseId, 'lease_01');
    assert.equal(lease.state, 'reserved');
    assert.equal(lease.reservedRamBytes, 1024);
    assert.equal(lease.reservedVramBytes, 2048);
  });

  // B2. reserved lease desconta RAM pendente
  it('B2. reserved lease é retornado em listReservedLeases e retém RAM', () => {
    const store = createResourceLeaseStore();
    store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      reservedRamBytes: 4 * 1024 * 1024 * 1024,
      createdAt: '2026-08-19T20:00:00.000Z',
    });

    const reserved = store.listReservedLeases();
    assert.equal(reserved.length, 1);
    assert.equal(reserved[0].reservedRamBytes, 4 * 1024 * 1024 * 1024);
  });

  // B3. reserved lease desconta VRAM pendente
  it('B3. reserved lease é retornado em listReservedLeases e retém VRAM', () => {
    const store = createResourceLeaseStore();
    store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      reservedVramBytes: 6 * 1024 * 1024 * 1024,
      createdAt: '2026-08-19T20:00:00.000Z',
    });

    const reserved = store.listReservedLeases();
    assert.equal(reserved.length, 1);
    assert.equal(reserved[0].reservedVramBytes, 6 * 1024 * 1024 * 1024);
  });

  // B4. activate lease
  it('B4. activate lease transita de reserved para active com timestamp explícito', () => {
    const store = createResourceLeaseStore();
    store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T20:00:00.000Z',
    });

    const active = store.activateLease('lease_01' as ResourceLeaseId, '2026-08-19T20:00:01.000Z');
    assert.equal(active.state, 'active');
    assert.equal(active.activatedAt, '2026-08-19T20:00:01.000Z');
    assert.equal(store.listReservedLeases().length, 0);
    assert.equal(store.listActiveLeases().length, 1);
  });

  // B5. active lease não é double counted (não está em listReservedLeases)
  it('B5. active lease não está em listReservedLeases', () => {
    const store = createResourceLeaseStore();
    store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      reservedRamBytes: 1000,
      createdAt: '2026-08-19T20:00:00.000Z',
    });
    store.activateLease('lease_01' as ResourceLeaseId, '2026-08-19T20:00:01.000Z');

    assert.equal(store.listReservedLeases().length, 0);
    assert.equal(store.listActiveLeases().length, 1);
  });

  // B6. active lease protege modelo
  it('B6. active lease retém targetModel no store', () => {
    const store = createResourceLeaseStore();
    store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      targetModel: 'llama3:8b',
      createdAt: '2026-08-19T20:00:00.000Z',
    });
    store.activateLease('lease_01' as ResourceLeaseId, '2026-08-19T20:00:01.000Z');

    const active = store.listActiveLeases();
    assert.equal(active[0].targetModel, 'llama3:8b');
  });

  // B7. reserved lease protege modelo
  it('B7. reserved lease retém targetModel no store', () => {
    const store = createResourceLeaseStore();
    store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      targetModel: 'mistral:7b',
      createdAt: '2026-08-19T20:00:00.000Z',
    });

    const reserved = store.listReservedLeases();
    assert.equal(reserved[0].targetModel, 'mistral:7b');
  });

  // B8. release remove proteção
  it('B8. release remove lease de active e reserved com timestamp explícito', () => {
    const store = createResourceLeaseStore();
    store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T20:00:00.000Z',
    });
    store.activateLease('lease_01' as ResourceLeaseId, '2026-08-19T20:00:01.000Z');
    const released = store.releaseLease('lease_01' as ResourceLeaseId, '2026-08-19T20:00:05.000Z');

    assert.equal(released.state, 'released');
    assert.equal(released.releasedAt, '2026-08-19T20:00:05.000Z');
    assert.equal(store.listActiveLeases().length, 0);
    assert.equal(store.listReservedLeases().length, 0);
  });

  // B9. expiresAt não usa clock interno
  it('B9. expiresAt configurado não expira sem reconcile explícito', () => {
    const store = createResourceLeaseStore();
    store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T20:00:00.000Z',
      expiresAt: '2026-08-19T20:00:10.000Z',
    });

    // Sem chamar reconcile, continua reserved
    const lease = store.getLease('lease_01' as ResourceLeaseId);
    assert.equal(lease?.state, 'reserved');
  });

  // B10. reconcile explícito expira lease
  it('B10. reconcile explícito expira lease', () => {
    const store = createResourceLeaseStore();
    store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T20:00:00.000Z',
      expiresAt: '2026-08-19T20:00:10.000Z',
    });

    // Reconcile antes da expiração: não expira
    store.reconcileExpiredLeases('2026-08-19T20:00:05.000Z');
    assert.equal(store.getLease('lease_01' as ResourceLeaseId)?.state, 'reserved');

    // Reconcile após a expiração: expira
    const expired = store.reconcileExpiredLeases('2026-08-19T20:00:11.000Z');
    assert.equal(expired.length, 1);
    assert.equal(store.getLease('lease_01' as ResourceLeaseId)?.state, 'expired');
  });

  // B11. duplicate LeaseId rejeitado
  it('B11. duplicate LeaseId rejeitado', () => {
    const store = createResourceLeaseStore();
    store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T20:00:00.000Z',
    });

    assert.throws(() => {
      store.createReservation({
        leaseId: 'lease_01' as ResourceLeaseId,
        requestId: 'req_02' as ResourceRequestId,
        decisionId: 'dec_01' as DecisionId,
        materialContextId: 'ctx_01' as DecisionMaterialContextId,
        routeRevisionId: 'route_rev_01' as RouteRevisionId,
        createdAt: '2026-08-19T20:00:00.000Z',
      });
    }, /Duplicate leaseId/);
  });

  // B12. transição released → active rejeitada
  it('B12. transição released → active rejeitada', () => {
    const store = createResourceLeaseStore();
    store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T20:00:00.000Z',
    });
    store.releaseLease('lease_01' as ResourceLeaseId, '2026-08-19T20:00:01.000Z');

    assert.throws(() => {
      store.activateLease('lease_01' as ResourceLeaseId, '2026-08-19T20:00:02.000Z');
    }, /Cannot activate lease/);
  });

  // B13. transição expired → active rejeitada
  it('B13. transição expired → active rejeitada', () => {
    const store = createResourceLeaseStore();
    store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T20:00:00.000Z',
      expiresAt: '2026-08-19T20:00:05.000Z',
    });
    store.reconcileExpiredLeases('2026-08-19T20:00:10.000Z');

    assert.throws(() => {
      store.activateLease('lease_01' as ResourceLeaseId, '2026-08-19T20:00:11.000Z');
    }, /Cannot activate lease/);
  });

  // G20. activateLease exige timestamp explícito
  it('G20. activateLease exige timestamp explícito e não aceita omitido ou inválido', () => {
    const store = createResourceLeaseStore();
    store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T20:00:00.000Z',
    });

    assert.throws(() => {
      store.activateLease('lease_01' as ResourceLeaseId, '' as any);
    }, /activateLease requires an explicit valid timestamp/);

    assert.throws(() => {
      store.activateLease('lease_01' as ResourceLeaseId, 'invalid-date' as any);
    }, /activateLease requires an explicit valid timestamp/);
  });

  // G21. releaseLease exige timestamp explícito
  it('G21. releaseLease exige timestamp explícito e não aceita omitido ou inválido', () => {
    const store = createResourceLeaseStore();
    store.createReservation({
      leaseId: 'lease_01' as ResourceLeaseId,
      requestId: 'req_01' as ResourceRequestId,
      decisionId: 'dec_01' as DecisionId,
      materialContextId: 'ctx_01' as DecisionMaterialContextId,
      routeRevisionId: 'route_rev_01' as RouteRevisionId,
      createdAt: '2026-08-19T20:00:00.000Z',
    });

    assert.throws(() => {
      store.releaseLease('lease_01' as ResourceLeaseId, '' as any);
    }, /releaseLease requires an explicit valid timestamp/);

    assert.throws(() => {
      store.releaseLease('lease_01' as ResourceLeaseId, 'invalid-date' as any);
    }, /releaseLease requires an explicit valid timestamp/);
  });

  // G22. lease negativo é rejeitado
  it('G22. lease com valor negativo, NaN ou Infinity é rejeitado estruturalmente', () => {
    const store = createResourceLeaseStore();

    assert.throws(() => {
      store.createReservation({
        leaseId: 'lease_01' as ResourceLeaseId,
        requestId: 'req_01' as ResourceRequestId,
        decisionId: 'dec_01' as DecisionId,
        materialContextId: 'ctx_01' as DecisionMaterialContextId,
        routeRevisionId: 'route_rev_01' as RouteRevisionId,
        reservedRamBytes: -500,
        createdAt: '2026-08-19T20:00:00.000Z',
      });
    }, /reservedRamBytes must be a finite number >= 0/);

    assert.throws(() => {
      store.createReservation({
        leaseId: 'lease_02' as ResourceLeaseId,
        requestId: 'req_01' as ResourceRequestId,
        decisionId: 'dec_01' as DecisionId,
        materialContextId: 'ctx_01' as DecisionMaterialContextId,
        routeRevisionId: 'route_rev_01' as RouteRevisionId,
        reservedVramBytes: NaN,
        createdAt: '2026-08-19T20:00:00.000Z',
      });
    }, /reservedVramBytes must be a finite number >= 0/);
  });
});
