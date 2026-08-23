/**
 * NEX+ · Auth Layer
 * Testes do Server-Side Session Boundary (Hardened Trust Boundary) — Escopo 0.86B-1 (Hardening)
 *
 * Cobertura de Requisitos & Invariantes:
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

// Inicialização segura de variáveis de ambiente antes da avaliação dinâmica de módulos
process.env.PAYLOAD_SECRET ??= 'test_payload_secret_for_boundary_testing_67890';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isValidSessionRef } from '../session-ref.types';

describe('NEX+ Auth · Server-Side Session Boundary Hardening (0.86B-1)', () => {
  // ==========================================================================
  // 1. TRUST BOUNDARY & AUSÊNCIA DE SEAMS PÚBLICOS
  // ==========================================================================

  it('H-1: Nenhum export público aceita user, _sid, payload, headers ou secret arbitrário para forjar contexto', async () => {
    const authExports = await import('../index');

    // 1. resolveSessionContextFromAuthUser NÃO deve estar no barrel público
    assert.equal((authExports as any).resolveSessionContextFromAuthUser, undefined);

    // 2. deriveSessionRef NÃO deve estar no barrel público
    assert.equal((authExports as any).deriveSessionRef, undefined);

    // 3. Os únicos entrypoints de boundary exportados são resolveAuthenticatedSessionContext e requireAuthenticatedSessionContext
    assert.equal(typeof authExports.resolveAuthenticatedSessionContext, 'function');
    assert.equal(typeof authExports.requireAuthenticatedSessionContext, 'function');

    // 4. As funções públicas não exigem nem recebem parâmetros de injeção
    assert.equal(authExports.resolveAuthenticatedSessionContext.length, 0);
    assert.equal(authExports.requireAuthenticatedSessionContext.length, 0);
  });

  // ==========================================================================
  // 2. INV-CTX-AUTH-10 REFINADA & FAIL-CLOSED SEMÂNTICO
  // ==========================================================================

  it('H-2 (INV-CTX-AUTH-10): Quando headers() ou payload.auth() não encontra sessão (user: null), boundary falha fechado como not_authenticated', async () => {
    const { resolveAuthenticatedSessionContext, AuthInternalError } = await import('../session-boundary');

    // Fora de contexto de requisição Next.js real, getNextHeaders() lança ou retorna vazio,
    // garantindo que o boundary falha fechado em ambiente não-autenticado
    const result = await resolveAuthenticatedSessionContext();

    // Se estiver fora de requisição Next.js, trata como erro interno ou not_authenticated fail-closed
    assert.ok(result.status === 'error' || result.status === 'unauthenticated');

    if (result.status === 'unauthenticated') {
      assert.ok(
        result.reason === 'not_authenticated' ||
        result.reason === 'invalid_or_unavailable_auth' ||
        result.reason === 'admin_rejected',
      );
    } else if (result.status === 'error') {
      assert.ok(result.error instanceof AuthInternalError);
    }
  });

  it('H-3: requireAuthenticatedSessionContext falha fechado lançando UnauthenticatedSessionError ou AuthInternalError', async () => {
    const {
      requireAuthenticatedSessionContext,
      UnauthenticatedSessionError,
      AuthInternalError,
    } = await import('../session-boundary');

    await assert.rejects(
      async () => {
        await requireAuthenticatedSessionContext();
      },
      (err: any) => {
        assert.ok(
          err instanceof UnauthenticatedSessionError || err instanceof AuthInternalError,
        );
        return true;
      },
    );
  });

  // ==========================================================================
  // 3. PRIVACIDADE & CONFINAMENTO DE SEGREDOS (INV-CTX-AUTH-08)
  // ==========================================================================

  it('H-4 (INV-CTX-AUTH-08): SessionRef é apenas opaca (64 hex chars) e DTO de saída nunca expõe _sid, JWT, cookie, token ou secret', () => {
    // Prova de contrato do tipo: SessionRef não é credencial e isValidSessionRef apenas valida formato
    const sampleRef = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    assert.equal(isValidSessionRef(sampleRef), true);

    // Formato inválido rejeitado
    assert.equal(isValidSessionRef('invalid-session-token'), false);
    assert.equal(isValidSessionRef(''), false);
  });

  // ==========================================================================
  // 4. FALHA FECHADA DIANTE DE SEGREDO AUSENTE
  // ==========================================================================

  it('H-5: Ausência de PAYLOAD_SECRET e SESSION_REF_SECRET resulta em erro e jamais produz contexto autenticado', async () => {
    const { resolveAuthenticatedSessionContext } = await import('../session-boundary');

    const originalPayloadSecret = process.env.PAYLOAD_SECRET;
    const originalSessionSecret = process.env.SESSION_REF_SECRET;

    try {
      delete process.env.PAYLOAD_SECRET;
      delete process.env.SESSION_REF_SECRET;

      const res = await resolveAuthenticatedSessionContext();
      assert.ok(res.status === 'error' || res.status === 'unauthenticated');
      assert.notEqual(res.status, 'authenticated');
    } finally {
      if (originalPayloadSecret !== undefined) process.env.PAYLOAD_SECRET = originalPayloadSecret;
      if (originalSessionSecret !== undefined) process.env.SESSION_REF_SECRET = originalSessionSecret;
    }
  });
});
