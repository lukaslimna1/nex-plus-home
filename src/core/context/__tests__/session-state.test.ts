/**
 * NEX+ · Testes da Camada de Domínio de Estado Operacional de Sessão
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AuthenticatedSessionContext, SessionRef } from '../../../auth/session-ref.types';
import type {
  ContextSubjectRef,
  ContextSubjectType,
  ContextSubjectId,
  SessionOperationalState,
} from '../contracts';
import type {
  EnsureSessionOperationalStateParams,
  SessionOperationalStateStore,
  SetContextSubjectParams,
} from '../persistence/contracts';
import {
  ensureSessionOperationalState,
  getSessionOperationalState,
  setSessionContextSubject,
  clearSessionContextSubject,
} from '../session-state';
import {
  SessionOperationalStateInvariantError,
  SessionOperationalStateOwnershipMismatchError,
  SessionOperationalStateRevisionConflictError,
} from '../errors';

class InMemorySessionOperationalStateStore implements SessionOperationalStateStore {
  readonly store = new Map<string, SessionOperationalState>();

  async getState(sessionRef: SessionRef, expectedUserId: string): Promise<SessionOperationalState | null> {
    const existing = this.store.get(sessionRef);
    if (!existing) return null;
    if (existing.userId !== expectedUserId) {
      throw new SessionOperationalStateOwnershipMismatchError({
        sessionRef,
        expectedUserId,
        actualUserId: existing.userId,
      });
    }
    return existing;
  }

  async ensureState(params: EnsureSessionOperationalStateParams): Promise<SessionOperationalState> {
    const existing = this.store.get(params.sessionRef);
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

    const now = new Date().toISOString();
    const newState: SessionOperationalState = Object.freeze({
      sessionRef: params.sessionRef,
      userId: params.userId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });

    this.store.set(params.sessionRef, newState);
    return newState;
  }

  async setContextSubject(params: SetContextSubjectParams): Promise<SessionOperationalState> {
    const existing = this.store.get(params.sessionRef);
    if (!existing) {
      throw new Error('Not found');
    }

    if (existing.userId !== params.userId) {
      throw new SessionOperationalStateOwnershipMismatchError({
        sessionRef: params.sessionRef,
        expectedUserId: params.userId,
        actualUserId: existing.userId,
      });
    }

    if (existing.revision !== params.expectedRevision) {
      throw new SessionOperationalStateRevisionConflictError({
        sessionRef: params.sessionRef,
        expectedRevision: params.expectedRevision,
        actualRevision: existing.revision,
      });
    }

    const now = new Date().toISOString();
    const updatedState: SessionOperationalState = Object.freeze({
      sessionRef: existing.sessionRef,
      userId: existing.userId,
      ...(params.contextSubjectRef ? { contextSubjectRef: params.contextSubjectRef } : {}),
      revision: existing.revision + 1,
      createdAt: existing.createdAt,
      updatedAt: now,
    });

    this.store.set(params.sessionRef, updatedState);
    return updatedState;
  }
}

describe('0.86B-2 · Session Operational State Domain Layer & Ownership Invariants', () => {
  const sessionRefA = 'a'.repeat(64) as SessionRef;
  const sessionRefB = 'b'.repeat(64) as SessionRef;

  const mockSessionContextUser1: AuthenticatedSessionContext = {
    actor: { kind: 'human', humanId: 'usr_lucas' },
    sessionRef: sessionRefA,
  };

  const mockSessionContextUser2: AuthenticatedSessionContext = {
    actor: { kind: 'human', humanId: 'usr_joao' },
    sessionRef: sessionRefB,
  };

  it('ensureSessionOperationalState cria novo estado quando não existir', async () => {
    const store = new InMemorySessionOperationalStateStore();
    const state = await ensureSessionOperationalState(mockSessionContextUser1, store);

    assert.equal(state.sessionRef, sessionRefA);
    assert.equal(state.userId, 'usr_lucas');
    assert.equal(state.revision, 1);
    assert.equal(state.contextSubjectRef, undefined);
  });

  it('ensureSessionOperationalState retorna estado existente de forma idempotente', async () => {
    const store = new InMemorySessionOperationalStateStore();
    const state1 = await ensureSessionOperationalState(mockSessionContextUser1, store);
    const state2 = await ensureSessionOperationalState(mockSessionContextUser1, store);

    assert.equal(state1, state2);
  });

  it('getSessionOperationalState consulta estado existente com verificação de ownership', async () => {
    const store = new InMemorySessionOperationalStateStore();
    await ensureSessionOperationalState(mockSessionContextUser1, store);

    const state = await getSessionOperationalState(mockSessionContextUser1, store);
    assert.ok(state !== null);
    assert.equal(state.sessionRef, sessionRefA);
    assert.equal(state.userId, 'usr_lucas');
  });

  it('getSessionOperationalState retorna null se estado não existir', async () => {
    const store = new InMemorySessionOperationalStateStore();
    const state = await getSessionOperationalState(mockSessionContextUser1, store);
    assert.equal(state, null);
  });

  it('getSessionOperationalState lança erro se fake store retornar estado de outro usuário (Blocker 1 Prova A)', async () => {
    // Fake store que simula responder estado com userId de user2 quando user1 consulta
    const fakeStore: SessionOperationalStateStore = {
      async getState(sessionRef, expectedUserId) {
        return Object.freeze({
          sessionRef,
          userId: 'usr_outra_pessoa', // Mismatch intencional
          revision: 1,
          createdAt: '2026-08-24T19:00:00.000Z',
          updatedAt: '2026-08-24T19:00:00.000Z',
        });
      },
      async ensureState() { throw new Error('not used'); },
      async setContextSubject() { throw new Error('not used'); },
    };

    await assert.rejects(
      () => getSessionOperationalState(mockSessionContextUser1, fakeStore),
      (err: any) => {
        assert.ok(err instanceof SessionOperationalStateOwnershipMismatchError);
        assert.equal(err.sessionRef, sessionRefA);
        assert.equal(err.expectedUserId, 'usr_lucas');         // Caller autenticado
        assert.equal(err.actualUserId, 'usr_outra_pessoa');   // Usuário no estado
        return true;
      }
    );
  });

  it('getSessionOperationalState rejeita estado contendo campos extras (ex: jwt) retornado por store corrompido', async () => {
    const corruptStore: SessionOperationalStateStore = {
      async getState(sessionRef, expectedUserId) {
        return Object.freeze({
          sessionRef,
          userId: expectedUserId,
          revision: 1,
          createdAt: '2026-08-24T19:00:00.000Z',
          updatedAt: '2026-08-24T19:00:00.000Z',
          jwt: 'leaked_jwt_token',
        }) as any;
      },
      async ensureState() { throw new Error('not used'); },
      async setContextSubject() { throw new Error('not used'); },
    };

    await assert.rejects(
      () => getSessionOperationalState(mockSessionContextUser1, corruptStore),
      (err: any) => err.violationType === 'UNEXPECTED_PROPERTY'
    );
  });

  it('setSessionContextSubject atualiza sujeito de Marca e incrementa revision', async () => {
    const store = new InMemorySessionOperationalStateStore();
    await ensureSessionOperationalState(mockSessionContextUser1, store);

    const subject: ContextSubjectRef = {
      subjectType: 'brand' as ContextSubjectType,
      subjectId: 'alterstate' as ContextSubjectId,
    };

    const updated = await setSessionContextSubject(
      mockSessionContextUser1,
      { contextSubjectRef: subject, expectedRevision: 1 },
      store
    );

    assert.equal(updated.revision, 2);
    assert.deepEqual(updated.contextSubjectRef, subject);

    // clear retorna ao contexto pessoal e incrementa revision
    const cleared = await clearSessionContextSubject(mockSessionContextUser1, 2, store);
    assert.equal(cleared.revision, 3);
    assert.equal(cleared.contextSubjectRef, undefined);
  });

  it('rejeita mutação com expectedRevision desatualizado (concorrência otimista)', async () => {
    const store = new InMemorySessionOperationalStateStore();
    await ensureSessionOperationalState(mockSessionContextUser1, store);

    const subject: ContextSubjectRef = {
      subjectType: 'brand' as ContextSubjectType,
      subjectId: 'alterstate' as ContextSubjectId,
    };

    await assert.rejects(
      () =>
        setSessionContextSubject(
          mockSessionContextUser1,
          { contextSubjectRef: subject, expectedRevision: 99 },
          store
        ),
      SessionOperationalStateRevisionConflictError
    );
  });

  it('rejeita mutação de sessão alheia (divergência de userId)', async () => {
    const store = new InMemorySessionOperationalStateStore();
    await ensureSessionOperationalState(mockSessionContextUser1, store);

    // Tentativa de user2 mutar sessionRef de user1
    const evilContext: AuthenticatedSessionContext = {
      actor: { kind: 'human', humanId: 'usr_joao' },
      sessionRef: sessionRefA, // sessionRef do Lucas
    };

    await assert.rejects(
      () =>
        setSessionContextSubject(
          evilContext,
          { contextSubjectRef: null, expectedRevision: 1 },
          store
        ),
      (err: any) => {
        assert.ok(err instanceof SessionOperationalStateOwnershipMismatchError);
        assert.equal(err.sessionRef, sessionRefA);
        assert.equal(err.expectedUserId, 'usr_joao');   // Caller
        assert.equal(err.actualUserId, 'usr_lucas');    // Owner da sessão no store
        return true;
      }
    );
  });
});
