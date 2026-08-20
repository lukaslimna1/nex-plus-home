/**
 * NEX+ · Auth Layer
 * Testes Unitários de Identidade e Projeção de DTO — Escopo 0.8A
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeEmail,
  getInitials,
  classifyIdentity,
  toAppUserView,
} from '../identity';

describe('NEX+ Auth · Identity & DTO Projection (0.8A)', () => {
  it('T1. Identidade users é reconhecida como app_user', () => {
    const userDoc = {
      id: 'usr-123',
      collection: 'users',
      email: 'socio@nex.local',
      displayName: 'Daniel Silva',
    };

    assert.equal(classifyIdentity(userDoc), 'app_user');
    const view = toAppUserView(userDoc);
    assert.ok(view);
    assert.equal(view.id, 'usr-123');
    assert.equal(view.email, 'socio@nex.local');
    assert.equal(view.displayName, 'Daniel Silva');
  });

  it('T2. Identidade admins NÃO é reconhecida como app_user', () => {
    const adminDoc = {
      id: 'adm-001',
      collection: 'admins',
      email: 'admin@nex.local',
    };

    assert.equal(classifyIdentity(adminDoc), 'admin');
    assert.equal(toAppUserView(adminDoc), null);
  });

  it('T3. Identidades anônimas/inválidas retornam anonymous e null view', () => {
    assert.equal(classifyIdentity(undefined), 'anonymous');
    assert.equal(classifyIdentity(null), 'anonymous');
    assert.equal(classifyIdentity({}), 'anonymous');
    assert.equal(classifyIdentity({ collection: 'other' }), 'anonymous');

    assert.equal(toAppUserView(undefined), null);
    assert.equal(toAppUserView(null), null);
    assert.equal(toAppUserView({}), null);
  });

  it('T8. DTO de frontend não expõe campos internos, hashes, salts ou sessões', () => {
    const rawUserDoc = {
      id: 'usr-456',
      collection: 'users',
      email: 'lucas@nex.local',
      displayName: 'Lucas Lima',
      hash: '$2b$10$supersecretinternalhash',
      salt: 'randomsaltvalue',
      sessions: [{ id: 'sess-1', expiresAt: '2026-08-21T00:00:00Z' }],
      resetPasswordToken: 'tok-12345',
      resetPasswordExpiration: '2026-08-20T12:00:00Z',
      loginAttempts: 0,
      lockUntil: null,
      createdAt: '2026-08-20T00:00:00Z',
      updatedAt: '2026-08-20T00:00:00Z',
    };

    const view = toAppUserView(rawUserDoc);
    assert.ok(view);

    const keys = Object.keys(view);
    assert.deepEqual(keys.sort(), ['displayName', 'email', 'id']);
    const viewObj = view as unknown as Record<string, unknown>;
    assert.equal(viewObj.hash, undefined);
    assert.equal(viewObj.salt, undefined);
    assert.equal(viewObj.sessions, undefined);
    assert.equal(viewObj.resetPasswordToken, undefined);
  });

  it('T9. Normalização de e-mail aplica trim e lowercase de forma consistente', () => {
    assert.equal(normalizeEmail('  Lucas@NEX.Local  '), 'lucas@nex.local');
    assert.equal(normalizeEmail('USER@EXAMPLE.COM'), 'user@example.com');
    assert.equal(normalizeEmail(''), '');
    assert.equal(normalizeEmail(undefined), '');
    assert.equal(normalizeEmail(null), '');
  });

  it('Iniciais são derivadas deterministicamente a partir de displayName', () => {
    assert.equal(getInitials('Daniel Silva'), 'DS');
    assert.equal(getInitials('Lucas Silva Lima'), 'LL');
    assert.equal(getInitials('Roberto'), 'RO');
    assert.equal(getInitials(''), 'U');
    assert.equal(getInitials(undefined), 'U');
  });
});
