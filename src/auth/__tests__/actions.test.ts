/**
 * NEX+ · Auth Layer
 * Testes Unitários de Ações e Tratamento de Respostas de Auth — Escopo 0.8A Hardening
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handleLogoutResult } from '../identity';

process.env.PAYLOAD_SECRET ||= 'unit-test-payload-secret';
process.env.DATABASE_URL ||= 'postgresql://unit:unit@127.0.0.1:5433/unit_test';
const { removeCurrentSessionIfPersisted } = await import('../actions');

describe('NEX+ Auth · Actions & Logout Propagation (0.8A Hardening)', () => {
  it('1. handleLogoutResult retorna success: true quando logout tem êxito', () => {
    const res = handleLogoutResult({ success: true });
    assert.deepEqual(res, { success: true });
  });

  it('2. handleLogoutResult NÃO fabrica sucesso quando logout retorna success: false', () => {
    const res = handleLogoutResult({ success: false });
    assert.equal(res.success, false);
    assert.equal(res.error, 'Não foi possível encerrar a sessão.');
  });

  it('3. handleLogoutResult retorna falha segura quando resposta for null ou undefined', () => {
    const resNull = handleLogoutResult(null);
    assert.equal(resNull.success, false);
    assert.equal(resNull.error, 'Não foi possível encerrar a sessão.');

    const resUndef = handleLogoutResult(undefined);
    assert.equal(resUndef.success, false);
    assert.equal(resUndef.error, 'Não foi possível encerrar a sessão.');
  });

  it('4. fallback não atualiza quando o logout oficial já removeu o sid corrente', async () => {
    const sessions = [{ id: 'session-b', expiresAt: '2026-08-24T01:00:00Z' }];
    assert.equal(await removeCurrentSessionIfPersisted(sessions, 'session-a'), null);
  });

  it('5. fallback remove somente o sid corrente e preserva as demais sessões', async () => {
    const sessions = [
      { id: 'session-a', expiresAt: '2026-08-24T01:00:00Z' },
      { id: 'session-b', expiresAt: '2026-08-24T01:00:00Z' },
    ];
    assert.deepEqual(await removeCurrentSessionIfPersisted(sessions, 'session-a'), [sessions[1]]);
  });
});
