/**
 * NEX+ · Auth Layer
 * Testes Unitários de SessionRef (HMAC, Domain Separation & Invariantes) — Escopo 0.86B-1
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';

import {
  deriveSessionRef,
  isValidSessionRef,
  SESSION_REF_DOMAIN_NAMESPACE,
  SessionSecretMissingError,
  InvalidSessionRefInputError,
} from '../session-ref';

describe('NEX+ Auth · SessionRef Derivation & Invariants (0.86B-1)', () => {
  const TEST_SECRET = 'test_secret_for_session_ref_derivation_12345';

  it('SR-1: Derivação legítima produz SessionRef em formato hexadecimal SHA-256 (64 chars)', () => {
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

  it('SR-5: Domain separation garante que payload prefixado com namespace oficial é utilizado', () => {
    const sessionRef = deriveSessionRef({
      collection: 'users',
      userId: 'usr_001',
      sid: 'sid_001',
      secret: TEST_SECRET,
    });

    // Calcula HMAC manual com namespace oficial
    const expectedPayload = `${SESSION_REF_DOMAIN_NAMESPACE}:users:usr_001:sid_001`;
    const expectedHmac = crypto.createHmac('sha256', TEST_SECRET).update(expectedPayload, 'utf8').digest('hex');

    assert.equal(sessionRef, expectedHmac);

    // Sem namespace ou com namespace diferente não coincide
    const unnamespacedHmac = crypto.createHmac('sha256', TEST_SECRET).update('users:usr_001:sid_001', 'utf8').digest('hex');
    assert.notEqual(sessionRef, unnamespacedHmac);
  });

  it('SR-6: Segredo ausente ou vazio falha fechado com SessionSecretMissingError', () => {
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

  it('SR-7: Inputs vazios ou não-string são rejeitados com InvalidSessionRefInputError', () => {
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

  it('SR-8: isValidSessionRef valida estritamente digests hexadecimais de 64 caracteres', () => {
    assert.equal(isValidSessionRef('a'.repeat(64)), true);
    assert.equal(isValidSessionRef('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'), true);

    // Inválidos
    assert.equal(isValidSessionRef(''), false);
    assert.equal(isValidSessionRef('a'.repeat(63)), false); // 63 chars
    assert.equal(isValidSessionRef('a'.repeat(65)), false); // 65 chars
    assert.equal(isValidSessionRef('g'.repeat(64)), false); // 'g' não é hex
    assert.equal(isValidSessionRef('A'.repeat(64)), false); // maiúsculo não é lowercase hex
    assert.equal(isValidSessionRef(null), false);
    assert.equal(isValidSessionRef(123), false);
  });
});
