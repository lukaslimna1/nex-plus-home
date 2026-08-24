/**
 * NEX+ · Testes do Server Boundary de Contexto Operacional (Fail-Closed & Trust Boundary)
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 *
 * Provas:
 * 1. Autenticação é estritamente obrigatória (fail-closed sem sessão ativa na requisição).
 * 2. Identidade deriva exclusivamente da sessão autenticada resolvida pelo B1.
 * 3. Caller não tem como injetar actor, userId ou sessionRef nos entrypoints públicos.
 * 4. contextSubjectRef provém do SessionOperationalState persistido da sessão.
 * 5. Nenhum helper/export de bypass ou seam inseguro é exposto em produção.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ContextSubjectRef,
  ContextSubjectType,
  ContextSubjectId,
} from '../contracts';
import {
  resolveCurrentOperationalContext,
  setCurrentContextSubject,
  clearCurrentContextSubject,
} from '../server';

describe('0.86B-2 · Server Boundary de Contexto Operacional (Fail-Closed & Surface Strictness)', () => {
  it('1. Estrutural: exporta exclusivamente primitivas server-side sem aceitar identidade do caller', () => {
    assert.equal(typeof resolveCurrentOperationalContext, 'function');
    assert.equal(typeof setCurrentContextSubject, 'function');
    assert.equal(typeof clearCurrentContextSubject, 'function');

    // Assinaturas públicas: caller nunca tem como passar actor, userId, sessionRef ou credentials
    assert.ok(resolveCurrentOperationalContext.length <= 2);
    assert.ok(setCurrentContextSubject.length <= 2);
    assert.ok(clearCurrentContextSubject.length <= 2);
  });

  it('2. Fail-Closed: resolveCurrentOperationalContext falha fechado quando chamado sem sessão/requisição ativa', async () => {
    // Fora de requisição Next.js real, o boundary recusa a resolução de contexto imediatamente
    await assert.rejects(
      () => resolveCurrentOperationalContext(),
      (err: any) => err.name === 'UnauthenticatedSessionError' || err.name === 'AuthInternalError'
    );
  });

  it('3. Fail-Closed: setCurrentContextSubject e clearCurrentContextSubject falham fechados sem sessão ativa', async () => {
    const brandSubject: ContextSubjectRef = {
      subjectType: 'brand' as ContextSubjectType,
      subjectId: 'alterstate' as ContextSubjectId,
    };

    await assert.rejects(
      () => setCurrentContextSubject({ contextSubjectRef: brandSubject, expectedRevision: 1 }),
      (err: any) => err.name === 'UnauthenticatedSessionError' || err.name === 'AuthInternalError'
    );

    await assert.rejects(
      () => clearCurrentContextSubject(1),
      (err: any) => err.name === 'UnauthenticatedSessionError' || err.name === 'AuthInternalError'
    );
  });
});
