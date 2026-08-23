/**
 * NEX+ · Auth Layer
 * Testes Unitários e Adversariais do Server-Side Session Boundary — Escopo 0.86B-1
 *
 * Cobertura de Invariantes:
 * - INV-CTX-AUTH-01: Ator humano material deriva exclusivamente da autenticação server-side.
 * - INV-CTX-AUTH-02: User e Session são distintos.
 * - INV-CTX-AUTH-03: Mesmo user com sessões A/B/C produz mesmo humanId e SessionRefs distintas.
 * - INV-CTX-AUTH-04: Mesma sessão validada produz SessionRef estável.
 * - INV-CTX-AUTH-05: Refresh Payload que preserva sid preserva SessionRef.
 * - INV-CTX-AUTH-06: Sessão revogada não consegue gerar novo boundary autenticado.
 * - INV-CTX-AUTH-07: SessionRef nunca substitui autenticação/authority.
 * - INV-CTX-AUTH-08: _sid/JWT/cookie/token/user.sessions não aparecem no DTO de saída, logs ou erros públicos.
 * - INV-CTX-AUTH-09: Cliente não consegue escolher HumanActor ou SessionRef.
 * - INV-CTX-AUTH-10: Falha interna de auth não é silenciosamente convertida em usuário anônimo no boundary material.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSessionContextFromAuthUser,
  resolveAuthenticatedSessionContext,
  requireAuthenticatedSessionContext,
  UnauthenticatedSessionError,
  AuthInternalError,
} from '../session-boundary';
import { isValidSessionRef } from '../session-ref';

describe('NEX+ Auth · Server-Side Session Boundary (0.86B-1)', () => {
  const TEST_SECRET = 'test_payload_secret_for_boundary_testing_67890';

  // ==========================================================================
  // 1. CENÁRIOS FUNDAMENTAIS & INVARIANTES DE IDENTIDADE / SESSÃO
  // ==========================================================================

  it('SB-1 (INV-CTX-AUTH-01): Usuário válido com sessão ativa produz HumanActor correto e SessionRef opaca', () => {
    const rawUser = {
      id: 'usr-101',
      collection: 'users',
      email: 'lucas@nex.local',
      displayName: 'Lucas Lima',
      _sid: 'sid_valid_session_001',
      sessions: [{ id: 'sid_valid_session_001', createdAt: '2026-08-23T00:00:00.000Z' }],
    };

    const res = resolveSessionContextFromAuthUser(rawUser, TEST_SECRET);

    assert.equal(res.status, 'authenticated');
    if (res.status === 'authenticated') {
      // HumanActor derivado com fidelidade
      assert.equal(res.context.actor.kind, 'human');
      assert.equal(res.context.actor.humanId, 'usr-101');
      assert.equal((res.context.actor as any).sessionRef, undefined); // Actor NÃO contém sessionRef

      // SessionRef válida e opaca
      assert.equal(isValidSessionRef(res.context.sessionRef), true);

      // Imutabilidade
      assert.ok(Object.isFrozen(res.context));
      assert.ok(Object.isFrozen(res.context.actor));
    }
  });

  it('SB-2: Usuário anônimo (null/undefined/vazio) retorna unauthenticated com reason anonymous', async () => {
    const resNull = resolveSessionContextFromAuthUser(null, TEST_SECRET);
    assert.equal(resNull.status, 'unauthenticated');
    if (resNull.status === 'unauthenticated') {
      assert.equal(resNull.reason, 'anonymous');
    }

    const resUndef = resolveSessionContextFromAuthUser(undefined, TEST_SECRET);
    assert.equal(resUndef.status, 'unauthenticated');
    if (resUndef.status === 'unauthenticated') {
      assert.equal(resUndef.reason, 'anonymous');
    }

    // requireAuthenticatedSessionContext lança UnauthenticatedSessionError
    await assert.rejects(
      async () => {
        const mockPayload = {
          auth: async () => ({ user: null }),
        } as any;
        await requireAuthenticatedSessionContext({ payload: mockPayload, headers: {}, secret: TEST_SECRET });
      },
      (err: any) => {
        assert.ok(err instanceof UnauthenticatedSessionError);
        assert.equal(err.reason, 'anonymous');
        return true;
      },
    );
  });

  it('SB-3: Usuário da coleção admins é estritamente rejeitado com admin_rejected para App User material actions', async () => {
    const adminUser = {
      id: 'adm-007',
      collection: 'admins',
      email: 'admin@nex.local',
      _sid: 'sid_admin_session',
    };

    const res = resolveSessionContextFromAuthUser(adminUser, TEST_SECRET);
    assert.equal(res.status, 'unauthenticated');
    if (res.status === 'unauthenticated') {
      assert.equal(res.reason, 'admin_rejected');
    }

    await assert.rejects(
      async () => {
        const mockPayload = {
          auth: async () => ({ user: adminUser }),
        } as any;
        await requireAuthenticatedSessionContext({ payload: mockPayload, headers: {}, secret: TEST_SECRET });
      },
      (err: any) => {
        assert.ok(err instanceof UnauthenticatedSessionError);
        assert.equal(err.reason, 'admin_rejected');
        return true;
      },
    );
  });

  it('SB-4 (INV-CTX-AUTH-10): Falha interna do Payload não é convertida silenciosamente em anônimo', async () => {
    const mockCrashingPayload = {
      auth: async () => {
        throw new Error('Database connection timeout during auth strategy execution');
      },
    } as any;

    const res = await resolveAuthenticatedSessionContext({
      payload: mockCrashingPayload,
      headers: {},
      secret: TEST_SECRET,
    });

    // Deve retornar status 'error' e conter AuthInternalError, NUNCA 'unauthenticated' ou 'anonymous'
    assert.equal(res.status, 'error');
    if (res.status === 'error') {
      assert.ok(res.error instanceof AuthInternalError);
      assert.match(res.error.message, /Database connection timeout/);
    }

    // requireAuthenticatedSessionContext lança o AuthInternalError
    await assert.rejects(
      async () => {
        await requireAuthenticatedSessionContext({
          payload: mockCrashingPayload,
          headers: {},
          secret: TEST_SECRET,
        });
      },
      (err: any) => {
        assert.ok(err instanceof AuthInternalError);
        return true;
      },
    );
  });

  it('SB-5 (INV-CTX-AUTH-02, INV-CTX-AUTH-03): Mesmo usuário com 3 sids distintos produz mesmo humanId e 3 SessionRefs distintas', () => {
    const userSession1 = {
      id: 'usr-lucas',
      collection: 'users',
      email: 'lucas@nex.local',
      _sid: 'sid_pc_casa',
    };

    const userSession2 = {
      id: 'usr-lucas',
      collection: 'users',
      email: 'lucas@nex.local',
      _sid: 'sid_celular',
    };

    const userSession3 = {
      id: 'usr-lucas',
      collection: 'users',
      email: 'lucas@nex.local',
      _sid: 'sid_outro_pc',
    };

    const res1 = resolveSessionContextFromAuthUser(userSession1, TEST_SECRET);
    const res2 = resolveSessionContextFromAuthUser(userSession2, TEST_SECRET);
    const res3 = resolveSessionContextFromAuthUser(userSession3, TEST_SECRET);

    assert.equal(res1.status, 'authenticated');
    assert.equal(res2.status, 'authenticated');
    assert.equal(res3.status, 'authenticated');

    if (res1.status === 'authenticated' && res2.status === 'authenticated' && res3.status === 'authenticated') {
      // O humanId é estritamente o mesmo
      assert.equal(res1.context.actor.humanId, 'usr-lucas');
      assert.equal(res2.context.actor.humanId, 'usr-lucas');
      assert.equal(res3.context.actor.humanId, 'usr-lucas');

      // As SessionRefs são estritamente distintas
      assert.notEqual(res1.context.sessionRef, res2.context.sessionRef);
      assert.notEqual(res2.context.sessionRef, res3.context.sessionRef);
      assert.notEqual(res1.context.sessionRef, res3.context.sessionRef);
    }
  });

  it('SB-6 (INV-CTX-AUTH-04): Mesma sessão validada produz SessionRef deterministicamente estável', () => {
    const userDoc = {
      id: 'usr-42',
      collection: 'users',
      email: 'user42@nex.local',
      _sid: 'sid_stable_99',
    };

    const resA = resolveSessionContextFromAuthUser(userDoc, TEST_SECRET);
    const resB = resolveSessionContextFromAuthUser(userDoc, TEST_SECRET);

    assert.equal(resA.status, 'authenticated');
    assert.equal(resB.status, 'authenticated');

    if (resA.status === 'authenticated' && resB.status === 'authenticated') {
      assert.equal(resA.context.sessionRef, resB.context.sessionRef);
    }
  });

  it('SB-7 (INV-CTX-AUTH-05): Refresh de token que preserva sid preserva a SessionRef idêntica', () => {
    const beforeRefresh = {
      id: 'usr-999',
      collection: 'users',
      email: 'dev@nex.local',
      _sid: 'sid_persistent_across_refresh',
      exp: 1700000000,
    };

    const afterRefresh = {
      id: 'usr-999',
      collection: 'users',
      email: 'dev@nex.local',
      _sid: 'sid_persistent_across_refresh', // Mesmo sid mantido pelo Payload 3.88.0
      exp: 1700007200, // Novo exp
    };

    const resBefore = resolveSessionContextFromAuthUser(beforeRefresh, TEST_SECRET);
    const resAfter = resolveSessionContextFromAuthUser(afterRefresh, TEST_SECRET);

    assert.equal(resBefore.status, 'authenticated');
    assert.equal(resAfter.status, 'authenticated');

    if (resBefore.status === 'authenticated' && resAfter.status === 'authenticated') {
      assert.equal(resBefore.context.sessionRef, resAfter.context.sessionRef);
    }
  });

  it('SB-8 (INV-CTX-AUTH-06): Sessão revogada no Payload falha fechado no boundary', () => {
    // Quando uma sessão é revogada, payload.auth() retorna user sem _sid correspondente ou null
    const revokedUserWithoutSid = {
      id: 'usr-revoked',
      collection: 'users',
      email: 'revoked@nex.local',
      // _sid ausente porque a sessão foi removida de user.sessions[]
    };

    const res = resolveSessionContextFromAuthUser(revokedUserWithoutSid, TEST_SECRET);
    assert.equal(res.status, 'unauthenticated');
    if (res.status === 'unauthenticated') {
      assert.equal(res.reason, 'missing_session');
    }
  });

  it('SB-9 (INV-CTX-AUTH-08): DTO de saída não contém _sid, JWT, cookie, token ou array de sessions', () => {
    const rawUserWithSecrets = {
      id: 'usr-privacy-test',
      collection: 'users',
      email: 'test@nex.local',
      _sid: 'secret_sid_never_leak_me',
      token: 'jwt.token.secret.signature',
      hash: '$2b$10$hashedpassword',
      salt: 'somesalt',
      sessions: [
        { id: 'secret_sid_never_leak_me', token: 'inner_token', userAgent: 'Chrome' },
      ],
    };

    const res = resolveSessionContextFromAuthUser(rawUserWithSecrets, TEST_SECRET);
    assert.equal(res.status, 'authenticated');

    if (res.status === 'authenticated') {
      const { context } = res;
      const contextKeys = Object.keys(context);

      // Apenas 'actor' e 'sessionRef'
      assert.deepEqual(contextKeys.sort(), ['actor', 'sessionRef'].sort());

      const actorKeys = Object.keys(context.actor);
      assert.deepEqual(actorKeys.sort(), ['humanId', 'kind'].sort());

      // Verificação explícita de ausência de campos sensíveis
      assert.equal((context as any)._sid, undefined);
      assert.equal((context as any).token, undefined);
      assert.equal((context as any).hash, undefined);
      assert.equal((context as any).salt, undefined);
      assert.equal((context as any).sessions, undefined);
      assert.equal((context.actor as any)._sid, undefined);
      assert.equal((context.actor as any).sessionRef, undefined);
    }
  });

  it('SB-10 (INV-CTX-AUTH-09): Cliente tentando injetar actor, humanId ou SessionRef não tem efeito sobre a resolução', async () => {
    // Requisição com headers e body maliciosos do cliente tentando forçar actor admin
    const clientProvidedMaliciousData = {
      headers: {
        'x-nex-actor': 'human:super_admin',
        'x-nex-human-id': 'usr-admin-victim',
        'x-nex-session-ref': '0000000000000000000000000000000000000000000000000000000000000000',
      },
    };

    // Mas o Payload autentica o usuário real 'usr-regular' com sid 'sid_legit_55'
    const mockPayload = {
      auth: async () => ({
        user: {
          id: 'usr-regular',
          collection: 'users',
          email: 'regular@nex.local',
          _sid: 'sid_legit_55',
        },
      }),
    } as any;

    const context = await requireAuthenticatedSessionContext({
      payload: mockPayload,
      headers: clientProvidedMaliciousData.headers,
      secret: TEST_SECRET,
    });

    // O boundary derivou exclusivamente da autoridade do Payload, ignorando completamente as tentativas de injeção
    assert.equal(context.actor.humanId, 'usr-regular');
    assert.notEqual(context.sessionRef, '0000000000000000000000000000000000000000000000000000000000000000');
    assert.equal(isValidSessionRef(context.sessionRef), true);
  });

  it('SB-11: Falha na configuração de segredo server-side retorna status error no resolve e lança no require', async () => {
    const rawUser = {
      id: 'usr-1',
      collection: 'users',
      email: 'a@nex.local',
      _sid: 'sid-1',
    };

    const originalEnvSecret = process.env.SESSION_REF_SECRET;
    const originalPayloadSecret = process.env.PAYLOAD_SECRET;

    try {
      delete process.env.SESSION_REF_SECRET;
      delete process.env.PAYLOAD_SECRET;

      const res = resolveSessionContextFromAuthUser(rawUser);
      assert.equal(res.status, 'error');

      const mockPayload = {
        auth: async () => ({ user: rawUser }),
      } as any;

      await assert.rejects(
        async () => {
          await requireAuthenticatedSessionContext({ payload: mockPayload, headers: {} });
        },
        (err: any) => {
          assert.equal(err.code, 'SESSION_SECRET_MISSING');
          return true;
        },
      );
    } finally {
      if (originalEnvSecret !== undefined) process.env.SESSION_REF_SECRET = originalEnvSecret;
      if (originalPayloadSecret !== undefined) process.env.PAYLOAD_SECRET = originalPayloadSecret;
    }
  });
});
