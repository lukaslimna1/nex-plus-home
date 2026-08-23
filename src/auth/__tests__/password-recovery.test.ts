/**
 * NEX+ · Auth Layer
 * Testes Unitários de Recuperação e Redefinição de Senha
 */

process.env.PAYLOAD_SECRET = 'test-payload-secret-12345678901234567890';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/test';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('NEX+ Auth · Password Recovery & Reset Validation', async () => {
  const { forgotPasswordAction, resetPasswordAction } = await import('../actions');

  it('1. forgotPasswordAction rejeita e-mail vazio ou inválido', async () => {
    const resEmpty = await forgotPasswordAction({ email: '' });
    assert.equal(resEmpty.success, false);
    assert.equal(resEmpty.error, 'Por favor, informe um endereço de e-mail válido.');

    const resInvalid = await forgotPasswordAction({ email: 'email-sem-arroba' });
    assert.equal(resInvalid.success, false);
    assert.equal(resInvalid.error, 'Por favor, informe um endereço de e-mail válido.');
  });

  it('2. resetPasswordAction rejeita ausência de token', async () => {
    const res = await resetPasswordAction({
      token: '',
      password: 'StrongPassword123!',
      confirmPassword: 'StrongPassword123!',
    });

    assert.equal(res.success, false);
    assert.match(res.error || '', /Token de recuperação ausente ou inválido/);
  });

  it('3. resetPasswordAction rejeita senha menor que 8 caracteres', async () => {
    const res = await resetPasswordAction({
      token: 'valid-token-format',
      password: '123',
      confirmPassword: '123',
    });

    assert.equal(res.success, false);
    assert.equal(res.error, 'A nova senha deve possuir pelo menos 8 caracteres.');
  });

  it('4. resetPasswordAction rejeita confirmação de senha divergente', async () => {
    const res = await resetPasswordAction({
      token: 'valid-token-format',
      password: 'Password123!',
      confirmPassword: 'DifferentPassword123!',
    });

    assert.equal(res.success, false);
    assert.equal(res.error, 'As senhas informadas não coincidem.');
  });
});

