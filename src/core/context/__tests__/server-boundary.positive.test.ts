/**
 * NEX+ · Teste Comportamental Positivo do Server Boundary de Contexto Operacional
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 *
 * Provas Positivas Reais:
 * A. AuthenticatedSessionContext (actor humano user-A + sessionRef-A) -> OperationalContext preserva exatamente actor, userId e sessionRef.
 * B. Store com ContextSubjectRef (Alterstate) -> resolveCurrentOperationalContext projeta o subject persistido sem o caller fornecer.
 * C. Store com wrong owner (userId user-B para a mesma sessionRef-A) -> rejeita por SessionOperationalStateOwnershipMismatchError com expectedUserId=user-A e actualUserId=user-B.
 * D. Hints válidos (location A, focus A, observed B) -> location/focus canônicos permanecem A; observedInteraction permanece B/client_observed.
 * E. Objeto runtime de hints com propriedades extras de identidade (actor, userId, sessionRef, contextSubjectRef) -> ignorados, autoridade não é sobreposta.
 *
 * Execução Exclusiva:
 * node --conditions=react-server --import tsx --experimental-test-module-mocks --test src/core/context/__tests__/server-boundary.positive.test.ts
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import type { HumanActor } from '../../observations/contracts';
import type { AuthenticatedSessionContext, SessionRef } from '../../../auth/session-ref.types';
import type {
  ContextSubjectRef,
  ContextSubjectType,
  ContextSubjectId,
  OperationalLocation,
  OperationalFocus,
  ObservedInteractionContext,
  SessionOperationalState,
} from '../contracts';
import type {
  EnsureSessionOperationalStateParams,
  SessionOperationalStateStore,
  SetContextSubjectParams,
} from '../persistence/contracts';
import {
  SessionOperationalStateOwnershipMismatchError,
} from '../errors';

// Detecção dinâmica da flag experimental de module mocking
let hasExperimentalModuleMocks = false;
try {
  if (typeof (mock as any).module === 'function') {
    (mock as any).module('node:path', { namedExports: {} });
    (mock as any).restoreAll?.();
    hasExperimentalModuleMocks = true;
  }
} catch {
  hasExperimentalModuleMocks = false;
}

describe('0.86B-2 · Prova Positiva do Server Boundary de Contexto Operacional', { skip: !hasExperimentalModuleMocks }, () => {
  const sessionRefA = '1111111111111111111111111111111111111111111111111111111111111111' as SessionRef;
  const userA = 'usr_lucas_a';
  const userB = 'usr_joao_b';

  const brandAlterstate: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'alterstate' as ContextSubjectId,
  };

  class ControlledTestStore implements SessionOperationalStateStore {
    readonly states = new Map<string, SessionOperationalState>();

    async getState(sessionRef: SessionRef, expectedUserId: string): Promise<SessionOperationalState | null> {
      const state = this.states.get(sessionRef);
      if (!state) return null;
      if (state.userId !== expectedUserId) {
        throw new SessionOperationalStateOwnershipMismatchError({
          sessionRef,
          expectedUserId,
          actualUserId: state.userId,
        });
      }
      return state;
    }

    async ensureState(params: EnsureSessionOperationalStateParams): Promise<SessionOperationalState> {
      const existing = this.states.get(params.sessionRef);
      if (existing) {
        if (existing.userId !== params.userId) {
          throw new SessionOperationalStateOwnershipMismatchError({
            sessionRef: params.sessionRef,
            expectedUserId: params.userId,
            actualUserId: existing.userId,
          });
        }
        return existing;
      }

      const now = '2026-08-24T19:00:00.000Z';
      const newState: SessionOperationalState = Object.freeze({
        sessionRef: params.sessionRef,
        userId: params.userId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });

      this.states.set(params.sessionRef, newState);
      return newState;
    }

    async setContextSubject(params: SetContextSubjectParams): Promise<SessionOperationalState> {
      const existing = this.states.get(params.sessionRef);
      if (!existing) throw new Error('Not found');

      if (existing.userId !== params.userId) {
        throw new SessionOperationalStateOwnershipMismatchError({
          sessionRef: params.sessionRef,
          expectedUserId: params.userId,
          actualUserId: existing.userId,
        });
      }

      const now = '2026-08-24T19:05:00.000Z';
      const updated: SessionOperationalState = Object.freeze({
        sessionRef: existing.sessionRef,
        userId: existing.userId,
        ...(params.contextSubjectRef ? { contextSubjectRef: params.contextSubjectRef } : {}),
        revision: existing.revision + 1,
        createdAt: existing.createdAt,
        updatedAt: now,
      });

      this.states.set(params.sessionRef, updated);
      return updated;
    }
  }

  it('A. AuthenticatedSessionContext válido preserva exatamente actor, userId e sessionRef no OperationalContext final', async () => {
    const controlledAuthContext: AuthenticatedSessionContext = {
      actor: { kind: 'human', humanId: userA },
      sessionRef: sessionRefA,
    };

    (mock as any).module('../../../auth/session-boundary', {
      namedExports: {
        requireAuthenticatedSessionContext: async () => controlledAuthContext,
      },
    });

    try {
      const { resolveCurrentOperationalContext } = await import('../server');
      const testStore = new ControlledTestStore();

      const opContext = await resolveCurrentOperationalContext(undefined, testStore);

      // Prova A
      assert.equal(opContext.actor.kind, 'human');
      assert.equal((opContext.actor as HumanActor).humanId, userA);
      assert.equal(opContext.userId, userA);
      assert.equal(opContext.sessionRef, sessionRefA);
      assert.equal(opContext.contextSubjectRef, undefined);
    } finally {
      (mock as any).restoreAll?.();
    }
  });

  it('B. resolveCurrentOperationalContext projeta contextSubjectRef persistido no store sem o caller fornecer', async () => {
    const controlledAuthContext: AuthenticatedSessionContext = {
      actor: { kind: 'human', humanId: userA },
      sessionRef: sessionRefA,
    };

    (mock as any).module('../../../auth/session-boundary', {
      namedExports: {
        requireAuthenticatedSessionContext: async () => controlledAuthContext,
      },
    });

    try {
      const { resolveCurrentOperationalContext, setCurrentContextSubject } = await import('../server');
      const testStore = new ControlledTestStore();

      // 1. Inicializa o estado operacional da sessão A
      await testStore.ensureState({ sessionRef: sessionRefA, userId: userA });

      // 2. Configura Marca Alterstate no store da sessão A
      await setCurrentContextSubject(
        { contextSubjectRef: brandAlterstate, expectedRevision: 1 },
        testStore
      );

      // 3. Caller resolve o contexto operacional SEM passar subject
      const opContext = await resolveCurrentOperationalContext(undefined, testStore);

      // Prova B: Sujeito derivado do store
      assert.deepEqual(opContext.contextSubjectRef, brandAlterstate);
      assert.equal(opContext.userId, userA);
      assert.equal(opContext.sessionRef, sessionRefA);
    } finally {
      (mock as any).restoreAll?.();
    }
  });

  it('C. Store com wrong owner para a mesma sessionRef rejeita no entrypoint por SessionOperationalStateOwnershipMismatchError', async () => {
    const controlledAuthContext: AuthenticatedSessionContext = {
      actor: { kind: 'human', humanId: userA },
      sessionRef: sessionRefA,
    };

    (mock as any).module('../../../auth/session-boundary', {
      namedExports: {
        requireAuthenticatedSessionContext: async () => controlledAuthContext,
      },
    });

    try {
      const { resolveCurrentOperationalContext } = await import('../server');
      const storeWithWrongOwner = new ControlledTestStore();

      // Sessão A pré-existente no store, porém vinculada ao userB
      storeWithWrongOwner.states.set(
        sessionRefA,
        Object.freeze({
          sessionRef: sessionRefA,
          userId: userB,
          revision: 1,
          createdAt: '2026-08-24T19:00:00.000Z',
          updatedAt: '2026-08-24T19:00:00.000Z',
        })
      );

      // Prova C: rejeita e confere propriedades semânticas do erro
      await assert.rejects(
        () => resolveCurrentOperationalContext(undefined, storeWithWrongOwner),
        (err: any) => {
          assert.ok(err instanceof SessionOperationalStateOwnershipMismatchError);
          assert.equal(err.sessionRef, sessionRefA);
          assert.equal(err.expectedUserId, userA); // Caller autenticado
          assert.equal(err.actualUserId, userB);   // Usuário no estado do store
          return true;
        }
      );
    } finally {
      (mock as any).restoreAll?.();
    }
  });

  it('D. Hints válidos de location/focus e observedInteraction preservam o canônico e isolam o observado', async () => {
    const controlledAuthContext: AuthenticatedSessionContext = {
      actor: { kind: 'human', humanId: userA },
      sessionRef: sessionRefA,
    };

    (mock as any).module('../../../auth/session-boundary', {
      namedExports: {
        requireAuthenticatedSessionContext: async () => controlledAuthContext,
      },
    });

    try {
      const { resolveCurrentOperationalContext } = await import('../server');
      const testStore = new ControlledTestStore();

      const locA: OperationalLocation = {
        module: { moduleKey: 'fornecedores' as any },
        trail: [],
      };
      const focusA: OperationalFocus = {
        action: 'compare' as any,
      };

      const locB: OperationalLocation = {
        module: { moduleKey: 'radar' as any },
        trail: [],
      };
      const focusB: OperationalFocus = {
        action: 'view' as any,
      };

      const observedB: ObservedInteractionContext = {
        origin: 'client_observed',
        observedAt: '2026-08-24T19:00:00.000Z',
        location: locB,
        focus: focusB,
      };

      const opContext = await resolveCurrentOperationalContext(
        {
          location: locA,
          focus: focusA,
          observedInteraction: observedB,
        },
        testStore
      );

      // Prova D: Canônico permanece A, observado permanece B/client_observed
      assert.equal(opContext.location?.module.moduleKey, 'fornecedores');
      assert.equal(opContext.focus?.action, 'compare');
      assert.equal(opContext.observedInteraction?.origin, 'client_observed');
      assert.equal(opContext.observedInteraction?.location?.module.moduleKey, 'radar');
      assert.equal(opContext.observedInteraction?.focus?.action, 'view');
    } finally {
      (mock as any).restoreAll?.();
    }
  });

  it('E. Propriedades extras de identidade injetadas em hints não substituem identidade, sessão ou subject', async () => {
    const controlledAuthContext: AuthenticatedSessionContext = {
      actor: { kind: 'human', humanId: userA },
      sessionRef: sessionRefA,
    };

    (mock as any).module('../../../auth/session-boundary', {
      namedExports: {
        requireAuthenticatedSessionContext: async () => controlledAuthContext,
      },
    });

    try {
      const { resolveCurrentOperationalContext, setCurrentContextSubject } = await import('../server');
      const testStore = new ControlledTestStore();

      // 1. Inicializa o estado operacional da sessão A
      await testStore.ensureState({ sessionRef: sessionRefA, userId: userA });

      // 2. Configura Marca Alterstate
      await setCurrentContextSubject(
        { contextSubjectRef: brandAlterstate, expectedRevision: 1 },
        testStore
      );

      // 3. Caller malicioso tenta injetar campos de identidade dentro de hints
      const maliciousHints: any = {
        actor: { kind: 'human', humanId: 'usr_hacker' },
        userId: 'usr_hacker',
        sessionRef: '9'.repeat(64),
        contextSubjectRef: { subjectType: 'brand', subjectId: 'fake_brand' },
        location: { module: { moduleKey: 'fornecedores' }, trail: [] },
      };

      const opContext = await resolveCurrentOperationalContext(maliciousHints, testStore);

      // Prova E: Autoridade derivada da sessão real e do store NÃO é sobreposta
      assert.equal((opContext.actor as HumanActor).humanId, userA);
      assert.equal(opContext.userId, userA);
      assert.equal(opContext.sessionRef, sessionRefA);
      assert.deepEqual(opContext.contextSubjectRef, brandAlterstate);
      assert.equal(opContext.location?.module.moduleKey, 'fornecedores');
    } finally {
      (mock as any).restoreAll?.();
    }
  });
});
