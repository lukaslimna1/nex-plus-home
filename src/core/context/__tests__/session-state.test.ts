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
  SessionOperationalStateOwnershipMismatchError,
  SessionOperationalStateRevisionConflictError,
} from '../errors';

class InMemorySessionOperationalStateStore implements SessionOperationalStateStore {
  private readonly store = new Map<string, SessionOperationalState>();

  async getState(sessionRef: SessionRef): Promise<SessionOperationalState | null> {
    return this.store.get(sessionRef) ?? null;
  }

  async ensureState(params: EnsureSessionOperationalStateParams): Promise<SessionOperationalState> {
    const existing = this.store.get(params.sessionRef);
    if (existing) {
      if (existing.userId !== params.userId) {
        throw new SessionOperationalStateOwnershipMismatchError({
          sessionRef: params.sessionRef,
          expectedUserId: existing.userId,
          actualUserId: params.userId,
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
        expectedUserId: existing.userId,
        actualUserId: params.userId,
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

describe('0.86B-2 · Camada de Domínio SessionOperationalState', () => {
  const sessionRefA = 'a'.repeat(64) as SessionRef;
  const authContextLucas: AuthenticatedSessionContext = {
    actor: { kind: 'human', humanId: 'usr_lucas_1' },
    sessionRef: sessionRefA,
  };

  const subjectAlterstate: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'alterstate' as ContextSubjectId,
  };

  it('assegura estado inicial limpo (revision 1, contextSubjectRef undefined)', async () => {
    const store = new InMemorySessionOperationalStateStore();
    const state = await ensureSessionOperationalState(authContextLucas, store);

    assert.equal(state.sessionRef, sessionRefA);
    assert.equal(state.userId, 'usr_lucas_1');
    assert.equal(state.revision, 1);
    assert.equal(state.contextSubjectRef, undefined);
  });

  it('atualiza sujeito ativo e incrementa revisão', async () => {
    const store = new InMemorySessionOperationalStateStore();
    await ensureSessionOperationalState(authContextLucas, store);

    const updated = await setSessionContextSubject(
      authContextLucas,
      {
        contextSubjectRef: subjectAlterstate,
        expectedRevision: 1,
      },
      store
    );

    assert.equal(updated.revision, 2);
    assert.deepEqual(updated.contextSubjectRef, subjectAlterstate);

    const current = await getSessionOperationalState(authContextLucas, store);
    assert.deepEqual(current, updated);
  });

  it('limpa sujeito ativo retornando ao contexto pessoal', async () => {
    const store = new InMemorySessionOperationalStateStore();
    await ensureSessionOperationalState(authContextLucas, store);
    await setSessionContextSubject(
      authContextLucas,
      { contextSubjectRef: subjectAlterstate, expectedRevision: 1 },
      store
    );

    const cleared = await clearSessionContextSubject(authContextLucas, 2, store);
    assert.equal(cleared.revision, 3);
    assert.equal(cleared.contextSubjectRef, undefined);
  });

  it('rejeita atualização se a revisão esperada divergir (conflito de concorrência)', async () => {
    const store = new InMemorySessionOperationalStateStore();
    await ensureSessionOperationalState(authContextLucas, store);

    await assert.rejects(
      () =>
        setSessionContextSubject(
          authContextLucas,
          { contextSubjectRef: subjectAlterstate, expectedRevision: 99 },
          store
        ),
      SessionOperationalStateRevisionConflictError
    );
  });
});
