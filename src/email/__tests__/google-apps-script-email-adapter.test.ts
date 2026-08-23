/**
 * NEX+ · Google Apps Script Email Adapter & Templates Tests
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  googleAppsScriptEmailAdapter,
  emailTestBuffer,
  clearEmailTestBuffer,
} from '../google-apps-script-email-adapter';
import {
  generateResetPasswordEmailHtml,
  generateResetPasswordEmailText,
} from '../templates/reset-password-email';

describe('NEX+ Email · Google Apps Script Adapter & Templates', () => {
  beforeEach(() => {
    clearEmailTestBuffer();
  });

  it('1. Adapter inicializa com nome, defaultFromAddress e defaultFromName corretos', () => {
    const adapterFactory = googleAppsScriptEmailAdapter({
      defaultFromAddress: 'test@starlevel.com.br',
      defaultFromName: 'NEX+ Support',
    });

    const initialized = adapterFactory({ payload: { logger: { info() {}, error() {} } } as any });
    assert.equal(initialized.name, 'google-apps-script');
    assert.equal(initialized.defaultFromAddress, 'test@starlevel.com.br');
    assert.equal(initialized.defaultFromName, 'NEX+ Support');
  });

  it('2. Modo mock/local armazena mensagem no emailTestBuffer sem disparar fetch', async () => {
    const adapterFactory = googleAppsScriptEmailAdapter();
    const initialized = adapterFactory({ payload: { logger: { info() {}, error() {} } } as any });

    await initialized.sendEmail({
      to: 'user@example.com',
      subject: 'Teste de Recuperação',
      html: '<p>Olá</p>',
      text: 'Olá',
    });

    assert.equal(emailTestBuffer.length, 1);
    assert.equal(emailTestBuffer[0].to, 'user@example.com');
    assert.equal(emailTestBuffer[0].subject, 'Teste de Recuperação');
    assert.equal(emailTestBuffer[0].html, '<p>Olá</p>');
    assert.equal(emailTestBuffer[0].text, 'Olá');
  });

  it('3. generateResetPasswordEmailHtml gera HTML válido contendo a URL de redefinição e branding', () => {
    const html = generateResetPasswordEmailHtml({
      resetUrl: 'https://nex.starlevel.com.br/reset-password?token=secret123',
      recipientEmail: 'lucas@starlevel.com.br',
      displayName: 'Lucas',
    });

    assert.match(html, /NEX\+/);
    assert.match(html, /Recuperação de Senha/);
    assert.match(html, /https:\/\/nex\.starlevel\.com\.br\/reset-password\?token=secret123/);
    assert.match(html, /Olá, Lucas\./);
  });

  it('4. generateResetPasswordEmailText gera texto plano legível contendo o link', () => {
    const text = generateResetPasswordEmailText({
      resetUrl: 'https://nex.starlevel.com.br/reset-password?token=secret123',
      recipientEmail: 'lucas@starlevel.com.br',
    });

    assert.match(text, /NEX\+ · Sistema Operacional Inteligente/);
    assert.match(text, /https:\/\/nex\.starlevel\.com\.br\/reset-password\?token=secret123/);
    assert.match(text, /1 hora/);
  });

  it('5. Adapter remoto envia payload com secret correto via fetch', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      } as any;
    }) as any;

    try {
      const adapterFactory = googleAppsScriptEmailAdapter({
        relayUrl: 'https://script.google.com/macros/s/TEST/exec',
        relaySecret: 'test-secret-12345',
      });
      const initialized = adapterFactory({ payload: { logger: { info() {}, error() {} } } as any });

      await initialized.sendEmail({
        to: 'destinatario@exemplo.com',
        subject: 'Redefinição de Senha NEX+',
        html: '<p>Link</p>',
        text: 'Link',
      });

      assert.equal(capturedUrl, 'https://script.google.com/macros/s/TEST/exec');
      assert.equal(capturedBody.secret, 'test-secret-12345');
      assert.equal(capturedBody.to, 'destinatario@exemplo.com');
      assert.equal(capturedBody.subject, 'Redefinição de Senha NEX+');
      assert.equal(capturedBody.fromName, 'NEX+');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('6. Adapter lança erro se o relay retornar HTTP status não-200', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 500,
        text: async () => 'Internal Error',
      } as any;
    }) as any;

    try {
      const adapterFactory = googleAppsScriptEmailAdapter({
        relayUrl: 'https://script.google.com/macros/s/TEST/exec',
        relaySecret: 'test-secret-12345',
      });
      const initialized = adapterFactory({ payload: { logger: { info() {}, error() {} } } as any });

      await assert.rejects(
        async () => {
          await initialized.sendEmail({
            to: 'destinatario@exemplo.com',
            subject: 'Erro esperado',
            html: '<p>Texto</p>',
          });
        },
        /Email relay returned status 500/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
