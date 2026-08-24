/**
 * NEX+ · Testes de Integração & Isolamento PostgreSQL para Estado Operacional de Sessão
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 *
 * Provas:
 * 1. Prova A/B/C de isolamento entre sessões do mesmo usuário e entre usuários distintos.
 * 2. Concorrência otimista e incremento atômico de revisões.
 * 3. Detecção e falha estrita diante de conflito de revisão (stale revision).
 * 4. Proteção contra divergência de ownership (owner mismatch).
 * 5. Criação concorrente atômica sem duplicação de linha (ON CONFLICT).
 * 6. Invariante SQL de par subject_type / subject_id.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import type { SessionRef } from '../../../../auth/session-ref.types';
import type {
  ContextSubjectRef,
  ContextSubjectType,
  ContextSubjectId,
} from '../../contracts';
import { PgSessionOperationalStateStore } from '../postgres';
import {
  SessionOperationalStateNotFoundError,
  SessionOperationalStateOwnershipMismatchError,
  SessionOperationalStateRevisionConflictError,
} from '../../errors';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

describe('0.86B-2 · Persistência PostgreSQL do Estado Operacional de Sessão', { skip: !databaseUrl }, () => {
  let pool: pg.Pool;
  let store: PgSessionOperationalStateStore;

  const sessionRefA = '1111111111111111111111111111111111111111111111111111111111111111' as SessionRef;
  const sessionRefB = '2222222222222222222222222222222222222222222222222222222222222222' as SessionRef;
  const sessionRefC = '3333333333333333333333333333333333333333333333333333333333333333' as SessionRef;
  const sessionRefD = '4444444444444444444444444444444444444444444444444444444444444444' as SessionRef;

  const userLucas = 'usr_lucas_123';
  const userJoao = 'usr_joao_456';

  const brandAlterstate: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'alterstate' as ContextSubjectId,
  };

  const brandArkana: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'arkana' as ContextSubjectId,
  };

  const brandNex: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'nex_group' as ContextSubjectId,
  };

  before(async () => {
    if (!databaseUrl) return;
    pool = new Pool({ connectionString: databaseUrl });
    store = new PgSessionOperationalStateStore(pool);

    // Limpar fixtures prévias para os sessionRefs de teste
    await pool.query(
      `DELETE FROM nex_session_operational_state WHERE session_ref IN ($1, $2, $3, $4);`,
      [sessionRefA, sessionRefB, sessionRefC, sessionRefD]
    );
  });

  after(async () => {
    if (pool) {
      await pool.query(
        `DELETE FROM nex_session_operational_state WHERE session_ref IN ($1, $2, $3, $4);`,
        [sessionRefA, sessionRefB, sessionRefC, sessionRefD]
      );
      await pool.end();
    }
  });

  it('Prova A/B/C: isolamento completo entre sessões simultâneas do mesmo usuário e outro usuário', async () => {
    // 1. Lucas abre Session A e seleciona Marca Alterstate
    const stateA1 = await store.ensureState({ sessionRef: sessionRefA, userId: userLucas });
    assert.equal(stateA1.revision, 1);
    assert.equal(stateA1.contextSubjectRef, undefined);

    const stateA2 = await store.setContextSubject({
      sessionRef: sessionRefA,
      userId: userLucas,
      contextSubjectRef: brandAlterstate,
      expectedRevision: 1,
    });
    assert.equal(stateA2.revision, 2);
    assert.deepEqual(stateA2.contextSubjectRef, brandAlterstate);

    // 2. Lucas abre Session B simultânea (ex: celular) e seleciona Marca Arkana
    const stateB1 = await store.ensureState({ sessionRef: sessionRefB, userId: userLucas });
    assert.equal(stateB1.revision, 1);

    const stateB2 = await store.setContextSubject({
      sessionRef: sessionRefB,
      userId: userLucas,
      contextSubjectRef: brandArkana,
      expectedRevision: 1,
    });
    assert.equal(stateB2.revision, 2);
    assert.deepEqual(stateB2.contextSubjectRef, brandArkana);

    // 3. João abre Session C em contexto pessoal (sem Marca)
    const stateC1 = await store.ensureState({ sessionRef: sessionRefC, userId: userJoao });
    assert.equal(stateC1.revision, 1);
    assert.equal(stateC1.contextSubjectRef, undefined);

    // 4. Prova de leitura isolada simultânea
    const readA = await store.getState(sessionRefA);
    const readB = await store.getState(sessionRefB);
    const readC = await store.getState(sessionRefC);

    assert.equal(readA?.contextSubjectRef?.subjectId, 'alterstate');
    assert.equal(readB?.contextSubjectRef?.subjectId, 'arkana');
    assert.equal(readC?.contextSubjectRef, undefined);

    // 5. Alterar Session A para Marca NEX
    const stateA3 = await store.setContextSubject({
      sessionRef: sessionRefA,
      userId: userLucas,
      contextSubjectRef: brandNex,
      expectedRevision: 2,
    });
    assert.equal(stateA3.revision, 3);
    assert.equal(stateA3.contextSubjectRef?.subjectId, 'nex_group');

    // Prova de que Session B e Session C permanecem INALTERADAS
    const checkBAfterA = await store.getState(sessionRefB);
    const checkCAfterA = await store.getState(sessionRefC);
    assert.equal(checkBAfterA?.contextSubjectRef?.subjectId, 'arkana');
    assert.equal(checkBAfterA?.revision, 2);
    assert.equal(checkCAfterA?.contextSubjectRef, undefined);
    assert.equal(checkCAfterA?.revision, 1);

    // 6. Limpar Session A (passa para contexto pessoal)
    const stateA4 = await store.setContextSubject({
      sessionRef: sessionRefA,
      userId: userLucas,
      contextSubjectRef: null,
      expectedRevision: 3,
    });
    assert.equal(stateA4.revision, 4);
    assert.equal(stateA4.contextSubjectRef, undefined);

    // Prova de que B continua Arkana e C continua pessoal
    const checkBFinal = await store.getState(sessionRefB);
    const checkCFinal = await store.getState(sessionRefC);
    assert.equal(checkBFinal?.contextSubjectRef?.subjectId, 'arkana');
    assert.equal(checkCFinal?.contextSubjectRef, undefined);
  });

  it('rejeita mutação com stale revision (conflito de concorrência)', async () => {
    // Session A está na revision 4
    await assert.rejects(
      () =>
        store.setContextSubject({
          sessionRef: sessionRefA,
          userId: userLucas,
          contextSubjectRef: brandAlterstate,
          expectedRevision: 2, // Stale! Revision atual é 4
        }),
      (err: any) => {
        assert.ok(err instanceof SessionOperationalStateRevisionConflictError);
        assert.equal(err.expectedRevision, 2);
        assert.equal(err.actualRevision, 4);
        return true;
      }
    );
  });

  it('rejeita mutação com owner mismatch (outro usuário tentando alterar sessionRef alheia)', async () => {
    // João tenta alterar a Session A de Lucas
    await assert.rejects(
      () =>
        store.setContextSubject({
          sessionRef: sessionRefA,
          userId: userJoao,
          contextSubjectRef: brandAlterstate,
          expectedRevision: 4,
        }),
      (err: any) => {
        assert.ok(err instanceof SessionOperationalStateOwnershipMismatchError);
        assert.equal(err.expectedUserId, userLucas);
        assert.equal(err.actualUserId, userJoao);
        return true;
      }
    );

    // João tenta dar ensureState na Session A que pertence a Lucas
    await assert.rejects(
      () => store.ensureState({ sessionRef: sessionRefA, userId: userJoao }),
      (err: any) => {
        assert.ok(err instanceof SessionOperationalStateOwnershipMismatchError);
        return true;
      }
    );
  });

  it('rejeita setContextSubject para sessionRef inexistente', async () => {
    await assert.rejects(
      () =>
        store.setContextSubject({
          sessionRef: sessionRefD,
          userId: userLucas,
          contextSubjectRef: brandAlterstate,
          expectedRevision: 1,
        }),
      SessionOperationalStateNotFoundError
    );
  });

  it('execuções concorrentes de ensureState não duplicam linhas e retornam estado coerente', async () => {
    const promises = Array.from({ length: 5 }, () =>
      store.ensureState({ sessionRef: sessionRefD, userId: userLucas })
    );

    const results = await Promise.all(promises);

    for (const r of results) {
      assert.equal(r.sessionRef, sessionRefD);
      assert.equal(r.userId, userLucas);
      assert.equal(r.revision, 1);
    }

    // Verificar no banco que existe apenas 1 linha
    const countRes = await pool.query(
      `SELECT count(*) as cnt FROM nex_session_operational_state WHERE session_ref = $1;`,
      [sessionRefD]
    );
    assert.equal(Number(countRes.rows[0].cnt), 1);
  });

  it('invariante de banco: CHECK constraint rejeita par de subject incompleto', async () => {
    // Inserção direta com subject_type preenchido e subject_id nulo deve violar constraint
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO nex_session_operational_state (
            session_ref, user_id, subject_type, subject_id, revision, created_at, updated_at
          ) VALUES (
            '5555555555555555555555555555555555555555555555555555555555555555',
            'usr_test',
            'brand',
            NULL,
            1,
            NOW(),
            NOW()
          );`
        )
    );
  });
});
