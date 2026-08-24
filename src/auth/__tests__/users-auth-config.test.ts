/**
 * NEX+ · Auth Layer
 * Testes Unitários de Conformidade e Configuração da Coleção Users
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Users } from '../../collections/Users';

describe('NEX+ Auth · Users Collection Configuration (Server Authority & Expiration)', () => {
  it('1. Users.auth possui tokenExpiration configurado para 720 segundos (12 minutos)', () => {
    assert.ok(typeof Users.auth === 'object' && Users.auth !== null);
    // tokenExpiration deve ser exatamente 720s (12 minutos)
    assert.equal(Users.auth.tokenExpiration, 720);
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
