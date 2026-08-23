/**
 * NEX+ · Auth Layer
 * Testes Unitários de SessionRef (HMAC, Canonical JSON & Anti-Delimiter-Injection) — Escopo 0.86B-1 (Hardening)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';

import {
  deriveSessionRef,
  SessionSecretMissingError,
  InvalidSessionRefInputError,
} from '../session-ref';
import {
  isValidSessionRef,
  SESSION_REF_DOMAIN_NAMESPACE,
} from '../session-ref.types';

describe('NEX+ Auth · SessionRef Derivation & Hardening (0.86B-1)', () => {
  const TEST_SECRET = 'test_secret_for_session_ref_derivation_12345';

  it('SR-1: Derivação legítima produz SessionRef em formato hexadecimal SHA-256 (64 chars minúsculos)', () => {
    const sessionRef = deriveSessionRef({
      collection: 'users',
      userId: 'usr_001',
      sid: 'sid_session_alpha',
      secret: TEST_SECRET,
    });

    assert.equal(typeof sessionRef, 'string');
    assert.equal(sessionRef.length, 64);
    assert.equal(isValidSessionRef(sessionRef), true);
    assert.match(sessionRef, /^[a-f0-9]{64}$/);
  });

  it('SR-2: Mesma entrada e mesmo segredo produzem SessionRef deterministicamente estável', () => {
    const ref1 = deriveSessionRef({
      collection: 'users',
      userId: 'usr_001',
      sid: 'sid_session_alpha',
      secret: TEST_SECRET,
    });

    const ref2 = deriveSessionRef({
      collection: 'users',
      userId: 'usr_001',
      sid: 'sid_session_alpha',
      secret: TEST_SECRET,
    });

    assert.equal(ref1, ref2);
  });

  it('SR-3: User != Session: Mesmo usuário com 3 sids distintos produz 3 SessionRefs distintas', () => {
    const refA = deriveSessionRef({
      collection: 'users',
      userId: 'usr_lucas',
      sid: 'sid_desktop_casa',
      secret: TEST_SECRET,
    });

    const refB = deriveSessionRef({
      collection: 'users',
      userId: 'usr_lucas',
      sid: 'sid_celular',
      secret: TEST_SECRET,
    });

    const refC = deriveSessionRef({
      collection: 'users',
      userId: 'usr_lucas',
      sid: 'sid_laptop_trabalho',
      secret: TEST_SECRET,
    });

    assert.notEqual(refA, refB);
    assert.notEqual(refB, refC);
    assert.notEqual(refA, refC);
  });

  it('SR-4: Usuários diferentes com mesmo sid produzem SessionRefs distintas', () => {
    const refUser1 = deriveSessionRef({
      collection: 'users',
      userId: 'usr_lucas',
      sid: 'sid_common_123',
      secret: TEST_SECRET,
    });

    const refUser2 = deriveSessionRef({
      collection: 'users',
      userId: 'usr_daniel',
      sid: 'sid_common_123',
      secret: TEST_SECRET,
    });

    assert.notEqual(refUser1, refUser2);
  });

  it('SR-5: Domain separation com serialização canônica JSON é utilizada', () => {
    const sessionRef = deriveSessionRef({
      collection: 'users',
      userId: 'usr_001',
      sid: 'sid_001',
      secret: TEST_SECRET,
    });

    const canonicalMessage = JSON.stringify([
      SESSION_REF_DOMAIN_NAMESPACE,
      'users',
      'usr_001',
      'sid_001',
    ]);
    const expectedHmac = crypto.createHmac('sha256', TEST_SECRET).update(canonicalMessage, 'utf8').digest('hex');

    assert.equal(sessionRef, expectedHmac);
  });

  it('SR-6 (Anti-Delimiter-Injection): Valores contendo dois-pontos ":" não geram a mesma mensagem HMAC', () => {
    // Par 1: userId tem "u:1", sid tem "s2"
    const ref1 = deriveSessionRef({
      collection: 'users',
      userId: 'u:1',
      sid: 's2',
      secret: TEST_SECRET,
    });

    // Par 2: userId tem "u", sid tem "1:s2" (se fosse concatenação 'users:u:1:s2', colidiriam)
    const ref2 = deriveSessionRef({
      collection: 'users',
      userId: 'u',
      sid: '1:s2',
      secret: TEST_SECRET,
    });

    // A serialização canônica JSON garante que as mensagens são estritamente distintas
    assert.notEqual(ref1, ref2);
  });

  it('SR-7: Segredo ausente ou vazio falha fechado com SessionSecretMissingError', () => {
    const originalEnvSecret = process.env.SESSION_REF_SECRET;
    const originalPayloadSecret = process.env.PAYLOAD_SECRET;

    try {
      delete process.env.SESSION_REF_SECRET;
      delete process.env.PAYLOAD_SECRET;

      assert.throws(
        () => {
          deriveSessionRef({
            collection: 'users',
            userId: 'usr_001',
            sid: 'sid_001',
          });
        },
        (err: any) => {
          assert.ok(err instanceof SessionSecretMissingError);
          assert.equal(err.code, 'SESSION_SECRET_MISSING');
          return true;
        },
      );
    } finally {
      if (originalEnvSecret !== undefined) process.env.SESSION_REF_SECRET = originalEnvSecret;
      if (originalPayloadSecret !== undefined) process.env.PAYLOAD_SECRET = originalPayloadSecret;
    }
  });

  it('SR-8: Inputs vazios ou não-string são rejeitados com InvalidSessionRefInputError', () => {
    assert.throws(
      () => deriveSessionRef({ collection: '', userId: 'u1', sid: 's1', secret: TEST_SECRET }),
      (err: any) => err instanceof InvalidSessionRefInputError && err.fieldName === 'collection',
    );

    assert.throws(
      () => deriveSessionRef({ collection: 'users', userId: '', sid: 's1', secret: TEST_SECRET }),
      (err: any) => err instanceof InvalidSessionRefInputError && err.fieldName === 'userId',
    );

    assert.throws(
      () => deriveSessionRef({ collection: 'users', userId: 'u1', sid: '   ', secret: TEST_SECRET }),
      (err: any) => err instanceof InvalidSessionRefInputError && err.fieldName === 'sid',
    );
  });

  it('SR-9: isValidSessionRef valida estritamente digests hexadecimais de 64 caracteres', () => {
    assert.equal(isValidSessionRef('a'.repeat(64)), true);
    assert.equal(isValidSessionRef('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), true);

    // Inválidos
    assert.equal(isValidSessionRef(''), false);
    assert.equal(isValidSessionRef('a'.repeat(63)), false);
    assert.equal(isValidSessionRef('a'.repeat(65)), false);
    assert.equal(isValidSessionRef('g'.repeat(64)), false);
    assert.equal(isValidSessionRef('A'.repeat(64)), false);
    assert.equal(isValidSessionRef(null), false);
    assert.equal(isValidSessionRef(123), false);
  });
});
