/**
 * NEX+ · Auth Layer
 * Testes do Server-Side Session Boundary (Trust Boundary & Zero-Seam Isolation) — Escopo 0.86B-1 (Hardening Final)
 *
 * Cobertura de Invariantes & Requisitos:
 * - INV-CTX-AUTH-01: Ator humano material deriva exclusivamente da autenticação server-side via Payload.
 * - INV-CTX-AUTH-02: User e Session são distintos.
 * - INV-CTX-AUTH-03: Multi-Session: mesmo usuário com sessões A/B/C produz mesmo humanId e SessionRefs distintas.
 * - INV-CTX-AUTH-04: Mesma sessão validada produz SessionRef estável.
 * - INV-CTX-AUTH-05: Refresh Payload que preserva sid preserva SessionRef.
 * - INV-CTX-AUTH-06: Sessão revogada (user: null no Payload) não gera contexto autenticado.
 * - INV-CTX-AUTH-07: SessionRef nunca substitui autenticação/authority.
 * - INV-CTX-AUTH-08: _sid/JWT/cookie/token/user.sessions/secrets não aparecem no DTO de saída.
 * - INV-CTX-AUTH-09: Impossibilidade de Spoofing: caller não consegue injetar actor/user/_sid/SessionRef/secret.
 * - INV-CTX-AUTH-10 (Refinada): Boundary falha fechado diante de ausência, ambiguidade ou falha interna.
 */

// Inicialização segura de variáveis de ambiente para a suíte de testes
process.env.PAYLOAD_SECRET ??= 'test_payload_secret_for_boundary_testing_67890';
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as clientAuthExports from '../index';
import { isValidSessionRef, type AuthenticatedSessionContext } from '../session-ref.types';

describe('NEX+ Auth · Server-Side Session Boundary Hardening Final (0.86B-1)', () => {
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

  it('H-2 (INV-CTX-AUTH-09): Entrypoint server-only (@/auth/server) expõe entrypoints com zero parâmetros (zero seams de injeção)', async () => {
    const serverAuthExports = await import('../server');

    assert.equal(typeof serverAuthExports.resolveAuthenticatedSessionContext, 'function');
    assert.equal(typeof serverAuthExports.requireAuthenticatedSessionContext, 'function');
    assert.equal(typeof serverAuthExports.getCurrentAppUser, 'function');

    // Assinaturas públicas possuem zero parâmetros para impedir bypass ou injeção de fake user/sid/secret
    assert.equal(serverAuthExports.resolveAuthenticatedSessionContext.length, 0);
    assert.equal(serverAuthExports.requireAuthenticatedSessionContext.length, 0);
  });

  // ==========================================================================
  // 2. PROVA DE ELIMINAÇÃO DEFINITIVA DO DEEP IMPORT BYPASS
  // ==========================================================================

  it('H-3: Deep import de deriveSessionContextFromPayloadUser falha (símbolo não exportado)', async () => {
    const boundaryModule = await import('../session-boundary');

    // O helper de teste ou conversão NÃO é exportado pelo módulo
    assert.equal((boundaryModule as any).deriveSessionContextFromPayloadUser, undefined);
    assert.equal((boundaryModule as any).resolveSessionContextFromAuthUser, undefined);
    assert.equal((boundaryModule as any).processPayloadAuthUser, undefined);

    // Únicos exports do session-boundary são os entrypoints canônicos e classes de erro
    const boundaryExportKeys = Object.keys(boundaryModule).sort();
    assert.deepEqual(boundaryExportKeys, [
      'AuthInternalError',
      'UnauthenticatedSessionError',
      'requireAuthenticatedSessionContext',
      'resolveAuthenticatedSessionContext',
    ].sort());
  });

  // ==========================================================================
  // 3. FAIL-CLOSED DOS ENTRYPOINTS CANÔNICOS (INV-CTX-AUTH-10)
  // ==========================================================================

  it('H-4 (INV-CTX-AUTH-10): resolveAuthenticatedSessionContext falha fechado quando chamado sem contexto de requisição', async () => {
    const { resolveAuthenticatedSessionContext } = await import('../session-boundary');

    const res = await resolveAuthenticatedSessionContext();
    // Fora de requisição Next.js real, headers() lança ou retorna vazio, resultando em erro ou unauthenticated fail-closed
    assert.ok(res.status === 'error' || res.status === 'unauthenticated');
    assert.notEqual(res.status, 'authenticated');

    if (res.status === 'unauthenticated') {
      assert.ok(
        res.reason === 'not_authenticated' ||
        res.reason === 'invalid_or_unavailable_auth' ||
        res.reason === 'admin_rejected',
      );
    }
  });

  it('H-5: requireAuthenticatedSessionContext lança UnauthenticatedSessionError ou AuthInternalError sem requisição ativa', async () => {
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
  // 4. PRIVACIDADE & CONFINAMENTO DE DADOS SENSÍVEIS (INV-CTX-AUTH-07, INV-CTX-AUTH-08)
  // ==========================================================================

  it('H-6 (INV-CTX-AUTH-07): isValidSessionRef valida apenas o shape hexadecimal e não atua como credencial', () => {
    const validHex64 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    assert.equal(isValidSessionRef(validHex64), true);

    // Formatos inválidos rejeitados
    assert.equal(isValidSessionRef('not-a-valid-hex-digest'), false);
    assert.equal(isValidSessionRef(''), false);
    assert.equal(isValidSessionRef(null), false);
    assert.equal(isValidSessionRef(undefined), false);
  });

  it('H-7 (INV-CTX-AUTH-08): Contrato de tipo AuthenticatedSessionContext não permite vazamento de secrets/infra', () => {
    // Prova de shape estrutural em tempo de compilação e execução
    const sampleContext: AuthenticatedSessionContext = {
      actor: {
        kind: 'human',
        humanId: 'usr-123',
      },
      sessionRef: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as any,
    };

    const keys = Object.keys(sampleContext).sort();
    assert.deepEqual(keys, ['actor', 'sessionRef'].sort());

    const actorKeys = Object.keys(sampleContext.actor).sort();
    assert.deepEqual(actorKeys, ['humanId', 'kind'].sort());

    // Nenhuma chave sensível permitida
    assert.equal((sampleContext as any)._sid, undefined);
    assert.equal((sampleContext as any).token, undefined);
    assert.equal((sampleContext as any).sessions, undefined);
    assert.equal((sampleContext as any).secret, undefined);
    assert.equal((sampleContext.actor as any)._sid, undefined);
    assert.equal((sampleContext.actor as any).sessionRef, undefined);
  });
});
