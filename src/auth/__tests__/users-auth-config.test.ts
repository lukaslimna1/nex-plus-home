/**
 * NEX+ · Auth Layer
 * Testes Unitários de Conformidade e Configuração da Coleção Users
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Users } from '../../collections/Users';

describe('NEX+ Auth · Users Collection Configuration (Server Authority & Expiration)', () => {
  it('1. Users.auth possui tokenExpiration configurado para 620 segundos (10m20s)', () => {
    assert.ok(typeof Users.auth === 'object' && Users.auth !== null);
    // tokenExpiration deve ser exatamente 620s (10m20s)
    assert.equal(Users.auth.tokenExpiration, 620);
  });

  it('2. Users.auth possui useSessions: true ativo para persistência em PostgreSQL', () => {
    assert.ok(typeof Users.auth === 'object' && Users.auth !== null);
    assert.equal(Users.auth.useSessions, true);
  });

  it('3. Users.auth.forgotPassword possui expiração de 1 hora configurada', () => {
    assert.ok(typeof Users.auth === 'object' && Users.auth !== null);
    assert.ok(typeof Users.auth.forgotPassword === 'object' && Users.auth.forgotPassword !== null);
    assert.equal(Users.auth.forgotPassword.expiration, 3600000);
  });
});
