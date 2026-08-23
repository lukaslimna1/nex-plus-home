/**
 * NEX+ · Auth Layer
 * Testes do Server-Side Session Boundary (Hardened Trust Boundary) — Escopo 0.86B-1 (Hardening)
 *
 * Cobertura Completa de Invariantes & Requisitos:
 * - INV-CTX-AUTH-01: Ator humano material deriva exclusivamente da autenticação server-side.
 * - INV-CTX-AUTH-02: User e Session são distintos.
 * - INV-CTX-AUTH-03: Mesmo user com sessões A/B/C produz mesmo humanId e SessionRefs distintas.
 * - INV-CTX-AUTH-04: Mesma sessão validada produz SessionRef estável.
 * - INV-CTX-AUTH-05: Refresh Payload que preserva sid preserva SessionRef.
 * - INV-CTX-AUTH-06: Sessão revogada (user: null no Payload) não gera contexto autenticado.
 * - INV-CTX-AUTH-07: SessionRef nunca substitui autenticação/authority.
 * - INV-CTX-AUTH-08: _sid/JWT/cookie/token/user.sessions/secrets não aparecem no DTO de saída.
 * - INV-CTX-AUTH-09: Cliente não consegue escolher HumanActor ou SessionRef.
 * - INV-CTX-AUTH-10 (Refinada): Boundary falha fechado diante de ausência, ambiguidade ou falha interna.
 */

// Inicialização de variáveis de ambiente para a suíte de testes
process.env.PAYLOAD_SECRET ??= 'test_payload_secret_for_boundary_testing_67890';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as clientAuthExports from '../index';
import { isValidSessionRef } from '../session-ref.types';

describe('NEX+ Auth · Server-Side Session Boundary Hardening (0.86B-1)', () => {
  const TEST_SECRET = 'test_secret_for_boundary_unit_tests_12345';

  // ==========================================================================
  // 1. ISOLAMENTO DO BARREL CLIENT-SAFE VS SERVER-ONLY
  // ==========================================================================

  it('H-1: Barrel público client-safe (@/auth) não exporta módulos server-only', () => {
    // Funções server-only NÃO devem estar no barrel client-safe
    assert.equal((clientAuthExports as any).resolveAuthenticatedSessionContext, undefined);
    assert.equal((clientAuthExports as any).requireAuthenticatedSessionContext, undefined);
    assert.equal((clientAuthExports as any).getCurrentAppUser, undefined);
    assert.equal((clientAuthExports as any).deriveSessionRef, undefined);
    assert.equal((clientAuthExports as any).getEdgeServerConfig, undefined);
    assert.equal((clientAuthExports as any).deriveSessionContextFromPayloadUser, undefined);

    // Tipos, DTOs e helpers client-safe continuam disponíveis
    assert.equal(typeof clientAuthExports.isValidSessionRef, 'function');
    assert.equal(typeof clientAuthExports.classifyIdentity, 'function');
    assert.equal(typeof clientAuthExports.toAppUserView, 'function');
    assert.equal(typeof clientAuthExports.normalizeEmail, 'function');
    assert.equal(typeof clientAuthExports.getInitials, 'function');
    assert.equal(typeof clientAuthExports.handleLogoutResult, 'function');
  });

  it('H-2: Entrypoint server-only (@/auth/server) expõe boundary seguro sem seams de injeção', async () => {
    const serverAuthExports = await import('../server');

    assert.equal(typeof serverAuthExports.resolveAuthenticatedSessionContext, 'function');
    assert.equal(typeof serverAuthExports.requireAuthenticatedSessionContext, 'function');
    assert.equal(typeof serverAuthExports.getCurrentAppUser, 'function');

    // Assinaturas públicas possuem zero parâmetros para impedir bypass/injeção de parâmetros
    assert.equal(serverAuthExports.resolveAuthenticatedSessionContext.length, 0);
    assert.equal(serverAuthExports.requireAuthenticatedSessionContext.length, 0);
  });

  // ==========================================================================
  // 2. DERIVAÇÃO DE CONTEXTO A PARTIR DE RESULTADO PAYLOAD
  // ==========================================================================

  it('H-3 (INV-CTX-AUTH-01): Usuário users com sessão ativa produz HumanActor correto e SessionRef opaca congelada', async () => {
    const { deriveSessionContextFromPayloadUser } = await import('../session-boundary');

    const rawUser = {
      id: 'usr-101',
      collection: 'users',
      email: 'lucas@nex.local',
      displayName: 'Lucas Lima',
      _sid: 'sid_valid_session_001',
      sessions: [{ id: 'sid_valid_session_001', createdAt: '2026-08-23T00:00:00.000Z' }],
    };

    const res = deriveSessionContextFromPayloadUser(rawUser, TEST_SECRET);

    assert.equal(res.status, 'authenticated');
    if (res.status === 'authenticated') {
      assert.equal(res.context.actor.kind, 'human');
      assert.equal(res.context.actor.humanId, 'usr-101');
      assert.equal((res.context.actor as any).sessionRef, undefined); // Actor NÃO contém sessionRef

      assert.equal(isValidSessionRef(res.context.sessionRef), true);
      assert.ok(Object.isFrozen(res.context));
      assert.ok(Object.isFrozen(res.context.actor));
    }
  });

  it('H-4 (INV-CTX-AUTH-02, INV-CTX-AUTH-03): Multi-Session: mesmo usuário com 3 sids distintos produz mesmo humanId e 3 SessionRefs distintas', async () => {
    const { deriveSessionContextFromPayloadUser } = await import('../session-boundary');

    const userSession1 = { id: 'usr-lucas', collection: 'users', email: 'lucas@nex.local', _sid: 'sid_pc_casa' };
    const userSession2 = { id: 'usr-lucas', collection: 'users', email: 'lucas@nex.local', _sid: 'sid_celular' };
    const userSession3 = { id: 'usr-lucas', collection: 'users', email: 'lucas@nex.local', _sid: 'sid_outro_pc' };

    const res1 = deriveSessionContextFromPayloadUser(userSession1, TEST_SECRET);
    const res2 = deriveSessionContextFromPayloadUser(userSession2, TEST_SECRET);
    const res3 = deriveSessionContextFromPayloadUser(userSession3, TEST_SECRET);

    assert.equal(res1.status, 'authenticated');
    assert.equal(res2.status, 'authenticated');
    assert.equal(res3.status, 'authenticated');

    if (res1.status === 'authenticated' && res2.status === 'authenticated' && res3.status === 'authenticated') {
      assert.equal(res1.context.actor.humanId, 'usr-lucas');
      assert.equal(res2.context.actor.humanId, 'usr-lucas');
      assert.equal(res3.context.actor.humanId, 'usr-lucas');

      assert.notEqual(res1.context.sessionRef, res2.context.sessionRef);
      assert.notEqual(res2.context.sessionRef, res3.context.sessionRef);
      assert.notEqual(res1.context.sessionRef, res3.context.sessionRef);
    }
  });

  it('H-5 (INV-CTX-AUTH-04): Mesma sessão validada produz SessionRef deterministicamente estável', async () => {
    const { deriveSessionContextFromPayloadUser } = await import('../session-boundary');

    const userDoc = { id: 'usr-42', collection: 'users', email: 'user42@nex.local', _sid: 'sid_stable_99' };

    const resA = deriveSessionContextFromPayloadUser(userDoc, TEST_SECRET);
    const resB = deriveSessionContextFromPayloadUser(userDoc, TEST_SECRET);

    assert.equal(resA.status, 'authenticated');
    assert.equal(resB.status, 'authenticated');

    if (resA.status === 'authenticated' && resB.status === 'authenticated') {
      assert.equal(resA.context.sessionRef, resB.context.sessionRef);
    }
  });

  it('H-6 (INV-CTX-AUTH-05): Refresh Payload que preserva sid preserva a SessionRef idêntica', async () => {
    const { deriveSessionContextFromPayloadUser } = await import('../session-boundary');

    const beforeRefresh = { id: 'usr-999', collection: 'users', email: 'dev@nex.local', _sid: 'sid_persistent', exp: 1700000000 };
    const afterRefresh = { id: 'usr-999', collection: 'users', email: 'dev@nex.local', _sid: 'sid_persistent', exp: 1700007200 };

    const resBefore = deriveSessionContextFromPayloadUser(beforeRefresh, TEST_SECRET);
    const resAfter = deriveSessionContextFromPayloadUser(afterRefresh, TEST_SECRET);

    assert.equal(resBefore.status, 'authenticated');
    assert.equal(resAfter.status, 'authenticated');

    if (resBefore.status === 'authenticated' && resAfter.status === 'authenticated') {
      assert.equal(resBefore.context.sessionRef, resAfter.context.sessionRef);
    }
  });

  it('H-7: Usuários distintos produzem humanIds distintos e SessionRefs distintas', async () => {
    const { deriveSessionContextFromPayloadUser } = await import('../session-boundary');

    const userA = { id: 'usr-aaa', collection: 'users', email: 'a@nex.local', _sid: 'sid-1' };
    const userB = { id: 'usr-bbb', collection: 'users', email: 'b@nex.local', _sid: 'sid-2' };

    const resA = deriveSessionContextFromPayloadUser(userA, TEST_SECRET);
    const resB = deriveSessionContextFromPayloadUser(userB, TEST_SECRET);

    assert.equal(resA.status, 'authenticated');
    assert.equal(resB.status, 'authenticated');

    if (resA.status === 'authenticated' && resB.status === 'authenticated') {
      assert.notEqual(resA.context.actor.humanId, resB.context.actor.humanId);
      assert.notEqual(resA.context.sessionRef, resB.context.sessionRef);
    }
  });

  it('H-8: Identidade da coleção admins é rejeitada com admin_rejected para App User material actions', async () => {
    const { deriveSessionContextFromPayloadUser } = await import('../session-boundary');

    const adminUser = { id: 'adm-007', collection: 'admins', email: 'admin@nex.local', _sid: 'sid_admin_session' };

    const res = deriveSessionContextFromPayloadUser(adminUser, TEST_SECRET);
    assert.equal(res.status, 'unauthenticated');
    if (res.status === 'unauthenticated') {
      assert.equal(res.reason, 'admin_rejected');
    }
  });

  it('H-9: Coleção desconhecida ou inválida retorna not_authenticated', async () => {
    const { deriveSessionContextFromPayloadUser } = await import('../session-boundary');

    const foreignDoc = { id: 'unk-1', collection: 'guests', email: 'guest@nex.local', _sid: 'sid-1' };
    const res = deriveSessionContextFromPayloadUser(foreignDoc, TEST_SECRET);
    assert.equal(res.status, 'unauthenticated');
    if (res.status === 'unauthenticated') {
      assert.equal(res.reason, 'not_authenticated');
    }
  });

  it('H-10: Usuário users sem _sid (sessão revogada ou inexistente) falha fechado como invalid_or_unavailable_auth', async () => {
    const { deriveSessionContextFromPayloadUser } = await import('../session-boundary');

    const userWithoutSid = { id: 'usr-revoked', collection: 'users', email: 'revoked@nex.local' };
    const res = deriveSessionContextFromPayloadUser(userWithoutSid, TEST_SECRET);
    assert.equal(res.status, 'unauthenticated');
    if (res.status === 'unauthenticated') {
      assert.equal(res.reason, 'invalid_or_unavailable_auth');
    }
  });

  it('H-11: Usuário users sem id falha fechado como invalid_or_unavailable_auth', async () => {
    const { deriveSessionContextFromPayloadUser } = await import('../session-boundary');

    const userWithoutId = { collection: 'users', email: 'noid@nex.local', _sid: 'sid-1' };
    const res = deriveSessionContextFromPayloadUser(userWithoutId, TEST_SECRET);
    assert.equal(res.status, 'unauthenticated');
    if (res.status === 'unauthenticated') {
      assert.equal(res.reason, 'invalid_or_unavailable_auth');
    }
  });

  it('H-12 (INV-CTX-AUTH-10 Refinada): user: null do Payload retorna unauthenticated not_authenticated', async () => {
    const { deriveSessionContextFromPayloadUser } = await import('../session-boundary');

    const resNull = deriveSessionContextFromPayloadUser(null, TEST_SECRET);
    assert.equal(resNull.status, 'unauthenticated');
    if (resNull.status === 'unauthenticated') {
      assert.equal(resNull.reason, 'not_authenticated');
    }

    const resUndef = deriveSessionContextFromPayloadUser(undefined, TEST_SECRET);
    assert.equal(resUndef.status, 'unauthenticated');
    if (resUndef.status === 'unauthenticated') {
      assert.equal(resUndef.reason, 'not_authenticated');
    }
  });

  it('H-13 (INV-CTX-AUTH-08): DTO de saída não contém _sid, JWT, cookie, token, hash, salt, sessions ou secret', async () => {
    const { deriveSessionContextFromPayloadUser } = await import('../session-boundary');

    const rawUserWithSecrets = {
      id: 'usr-privacy-test',
      collection: 'users',
      email: 'test@nex.local',
      _sid: 'secret_sid_never_leak_me',
      token: 'jwt.token.secret.signature',
      hash: '$2b$10$hashedpassword',
      salt: 'somesalt',
      sessions: [{ id: 'secret_sid_never_leak_me', token: 'inner_token' }],
    };

    const res = deriveSessionContextFromPayloadUser(rawUserWithSecrets, TEST_SECRET);
    assert.equal(res.status, 'authenticated');

    if (res.status === 'authenticated') {
      const { context } = res;
      assert.deepEqual(Object.keys(context).sort(), ['actor', 'sessionRef'].sort());
      assert.deepEqual(Object.keys(context.actor).sort(), ['humanId', 'kind'].sort());

      assert.equal((context as any)._sid, undefined);
      assert.equal((context as any).token, undefined);
      assert.equal((context as any).hash, undefined);
      assert.equal((context as any).salt, undefined);
      assert.equal((context as any).sessions, undefined);
      assert.equal((context.actor as any)._sid, undefined);
      assert.equal((context.actor as any).sessionRef, undefined);
    }
  });

  it('H-14: Falha na resolução de segredo server-side propaga status error', async () => {
    const { deriveSessionContextFromPayloadUser } = await import('../session-boundary');

    const rawUser = { id: 'usr-1', collection: 'users', email: 'a@nex.local', _sid: 'sid-1' };
    const originalPayloadSecret = process.env.PAYLOAD_SECRET;
    const originalSessionSecret = process.env.SESSION_REF_SECRET;

    try {
      delete process.env.PAYLOAD_SECRET;
      delete process.env.SESSION_REF_SECRET;

      const res = deriveSessionContextFromPayloadUser(rawUser);
      assert.equal(res.status, 'error');
      if (res.status === 'error') {
        assert.equal(res.error.message.includes('Server secret is missing'), true);
      }
    } finally {
      if (originalPayloadSecret !== undefined) process.env.PAYLOAD_SECRET = originalPayloadSecret;
      if (originalSessionSecret !== undefined) process.env.SESSION_REF_SECRET = originalSessionSecret;
    }
  });

  it('H-15: Entrypoints reais resolveAuthenticatedSessionContext e requireAuthenticatedSessionContext falham fechado sem requisição ativa', async () => {
    const {
      resolveAuthenticatedSessionContext,
      requireAuthenticatedSessionContext,
      UnauthenticatedSessionError,
      AuthInternalError,
    } = await import('../session-boundary');

    const res = await resolveAuthenticatedSessionContext();
    assert.ok(res.status === 'error' || res.status === 'unauthenticated');

    await assert.rejects(
      async () => {
        await requireAuthenticatedSessionContext();
      },
      (err: any) => {
        assert.ok(err instanceof UnauthenticatedSessionError || err instanceof AuthInternalError);
        return true;
      },
    );
  });
});
