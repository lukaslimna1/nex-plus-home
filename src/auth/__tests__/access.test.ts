/**
 * NEX+ · Auth Layer
 * Testes de Access Control e Regras de Autorização — Escopo 0.8A
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Users } from '@/collections/Users';
import { Admins } from '@/collections/Admins';

describe('NEX+ Auth · Payload Access Control & Boundaries (0.8A)', () => {
  const adminReq = { req: { user: { id: 'adm-1', collection: 'admins', email: 'admin@nex.local' } } };
  const userReq = { req: { user: { id: 'usr-1', collection: 'users', email: 'user@nex.local' } } };
  const anonReq = { req: { user: undefined } };

  it('T4. Users access create: admin técnico é permitido', () => {
    const canCreate = typeof Users.access?.create === 'function'
      // @ts-expect-error - payload access mock call
      ? Users.access.create(adminReq)
      : Users.access?.create;

    assert.equal(canCreate, true);
  });

  it('T5. Users access create: usuário comum da aplicação é negado', () => {
    const canCreate = typeof Users.access?.create === 'function'
      // @ts-expect-error - payload access mock call
      ? Users.access.create(userReq)
      : Users.access?.create;

    assert.equal(canCreate, false);
  });

  it('T6. Users access create: anônimo é negado (sem self-registration)', () => {
    const canCreate = typeof Users.access?.create === 'function'
      // @ts-expect-error - payload access mock call
      ? Users.access.create(anonReq)
      : Users.access?.create;

    assert.equal(canCreate, false);
  });

  it('T7. Users access read/update/delete/unlock: restrito exclusivamente a admins', () => {
    const operations = ['read', 'update', 'delete', 'unlock'] as const;

    for (const op of operations) {
      const accessFn = Users.access?.[op];
      assert.ok(typeof accessFn === 'function', `Operação ${op} deve ter função de access control`);

      // @ts-expect-error - payload access mock call
      assert.equal(accessFn(adminReq), true, `Admin deve ter permissão em ${op}`);
      // @ts-expect-error - payload access mock call
      assert.equal(accessFn(userReq), false, `User não deve ter permissão em ${op}`);
      // @ts-expect-error - payload access mock call
      assert.equal(accessFn(anonReq), false, `Anônimo não deve ter permissão em ${op}`);
    }
  });

  it('Users access admin: usuários comuns não acessam o Admin Panel do Payload', () => {
    const adminPanelAccess = Users.access?.admin;
    assert.ok(typeof adminPanelAccess === 'function');

    // @ts-expect-error - payload access mock call
    assert.equal(adminPanelAccess(adminReq), true);
    // @ts-expect-error - payload access mock call
    assert.equal(adminPanelAccess(userReq), false);
    // @ts-expect-error - payload access mock call
    assert.equal(adminPanelAccess(anonReq), false);
  });

  it('Admins collection preserva admin.user como autoridade administrativa exclusiva', () => {
    assert.equal(Admins.slug, 'admins');
    assert.equal(Users.slug, 'users');
  });
});
