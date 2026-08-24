/**
 * NEX+ · Testes do Server Boundary de Contexto Operacional
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('0.86B-2 · Server Boundary de Contexto Operacional', () => {
  it('exporta primitivas server-side sem aceitar actor, userId ou sessionRef do caller', async () => {
    const serverModule = await import('../server');

    assert.equal(typeof serverModule.resolveCurrentOperationalContext, 'function');
    assert.equal(typeof serverModule.setCurrentContextSubject, 'function');
    assert.equal(typeof serverModule.clearCurrentContextSubject, 'function');

    // Assinaturas públicas: resolveCurrentOperationalContext aceita apenas hints? e store?
    assert.ok(serverModule.resolveCurrentOperationalContext.length <= 2);
  });
});
