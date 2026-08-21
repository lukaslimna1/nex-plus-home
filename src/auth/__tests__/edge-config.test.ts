/**
 * NEX+ · Auth Layer
 * Testes Unitários de Hardening da Configuração de Borda e Cookies (Escopo 0.8B-L)
 *
 * Valida os requisitos L1 a L6 para PAYLOAD_PUBLIC_SERVER_URL, serverURL, csrf,
 * e a propagação de cookies seguros para as coleções Users e Admins.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseEdgeServerConfig, getEdgeServerConfig } from '../edge-config';
import { Users } from '@/collections/Users';
import { Admins } from '@/collections/Admins';

describe('NEX+ Auth · Edge & Cookie Configuration Hardening (0.8B-L)', () => {
  it('L1. Sem PAYLOAD_PUBLIC_SERVER_URL: configuração local preservada sem forçar cookies seguros', () => {
    const emptyValues = [undefined, null, '', '   ', '\t\n'];

    for (const val of emptyValues) {
      const config = parseEdgeServerConfig(val);
      assert.equal(config.serverURL, undefined);
      assert.equal(config.csrf, undefined);
      assert.equal(config.isSecureCookie, false);
      assert.deepEqual(config.cookies, {
        secure: false,
        sameSite: 'Lax',
      });
    }
  });

  it('L2. Com PAYLOAD_PUBLIC_SERVER_URL HTTPS: serverURL resolvida, origem em CSRF e cookie seguro ativo', () => {
    const config = parseEdgeServerConfig('https://nex.starlevel.com.br');
    assert.equal(config.serverURL, 'https://nex.starlevel.com.br');
    assert.deepEqual(config.csrf, ['https://nex.starlevel.com.br']);
    assert.equal(config.isSecureCookie, true);
    assert.deepEqual(config.cookies, {
      secure: true,
      sameSite: 'Lax',
    });

    // Variação com porta explícita
    const configWithPort = parseEdgeServerConfig('https://nex.starlevel.com.br:8443');
    assert.equal(configWithPort.serverURL, 'https://nex.starlevel.com.br:8443');
    assert.deepEqual(configWithPort.csrf, ['https://nex.starlevel.com.br:8443']);
    assert.equal(configWithPort.isSecureCookie, true);
    assert.equal(configWithPort.cookies.secure, true);

    // Variação com trailing slash normalizada
    const configTrailingSlash = parseEdgeServerConfig('https://nex.starlevel.com.br/');
    assert.equal(configTrailingSlash.serverURL, 'https://nex.starlevel.com.br');
    assert.deepEqual(configTrailingSlash.csrf, ['https://nex.starlevel.com.br']);
    assert.equal(configTrailingSlash.isSecureCookie, true);
  });

  it('L2b. Com PAYLOAD_PUBLIC_SERVER_URL HTTP: serverURL resolvida sem ativar cookie seguro', () => {
    const config = parseEdgeServerConfig('http://localhost:3000');
    assert.equal(config.serverURL, 'http://localhost:3000');
    assert.deepEqual(config.csrf, ['http://localhost:3000']);
    assert.equal(config.isSecureCookie, false);
    assert.deepEqual(config.cookies, {
      secure: false,
      sameSite: 'Lax',
    });
  });

  it('L3. Valor inválido da origem pública é rejeitado deterministicamente (fail-closed)', () => {
    const invalidProtocols = [
      'ftp://nex.starlevel.com.br',
      'ws://nex.starlevel.com.br',
      'wss://nex.starlevel.com.br',
      'javascript:alert(1)',
      'file:///path/to/file',
    ];

    for (const url of invalidProtocols) {
      assert.throws(
        () => parseEdgeServerConfig(url),
        (err: Error) => err.message.includes('Protocolo não suportado'),
        `Deve rejeitar protocolo não suportado: ${url}`,
      );
    }

    const malformedUrls = ['not-a-url', '://missing-scheme', 'http://', 'https://'];
    for (const url of malformedUrls) {
      assert.throws(
        () => parseEdgeServerConfig(url),
        (err: Error) => err.message.includes('inválida'),
        `Deve rejeitar URL malformada: ${url}`,
      );
    }

    const functionalPaths = [
      'https://nex.starlevel.com.br/admin',
      'https://nex.starlevel.com.br/api/auth',
      'https://nex.starlevel.com.br/home',
    ];
    for (const url of functionalPaths) {
      assert.throws(
        () => parseEdgeServerConfig(url),
        (err: Error) => err.message.includes('não deve conter path funcional'),
        `Deve rejeitar URL com path funcional: ${url}`,
      );
    }

    assert.throws(
      () => parseEdgeServerConfig('https://nex.starlevel.com.br?key=val'),
      (err: Error) => err.message.includes('não deve conter query string'),
    );

    assert.throws(
      () => parseEdgeServerConfig('https://nex.starlevel.com.br#section'),
      (err: Error) => err.message.includes('não deve conter fragmento'),
    );

    // Rejeição determinística de userinfo / credenciais na URL
    const userinfoUrls = [
      'https://user@nex.starlevel.com.br',
      'https://user:pass@nex.starlevel.com.br',
      'https://nex.starlevel.com.br@evil.example',
      'http://admin:secret@localhost:3000',
    ];
    for (const url of userinfoUrls) {
      assert.throws(
        () => parseEdgeServerConfig(url),
        (err: Error) => err.message.includes('não deve conter credenciais/userinfo'),
        `Deve rejeitar URL com userinfo: ${url}`,
      );
    }
  });

  it('L4. Configuração de cookie seguro aplica-se à coleção Users', () => {
    assert.ok(typeof Users.auth === 'object' && Users.auth !== null);
    const authConfig = Users.auth as { cookies?: { secure?: boolean; sameSite?: string } };
    assert.ok(authConfig.cookies);
    assert.equal(authConfig.cookies.sameSite, 'Lax');
    assert.equal(typeof authConfig.cookies.secure, 'boolean');
  });

  it('L5. Configuração de cookie seguro aplica-se à coleção Admins', () => {
    assert.ok(typeof Admins.auth === 'object' && Admins.auth !== null);
    const authConfig = Admins.auth as { cookies?: { secure?: boolean; sameSite?: string } };
    assert.ok(authConfig.cookies);
    assert.equal(authConfig.cookies.sameSite, 'Lax');
    assert.equal(typeof authConfig.cookies.secure, 'boolean');
  });

  it('L6. Nenhuma alteração reabre removeTokenFromResponses ou o workaround congelado do Payload 3.88.0', () => {
    assert.ok(typeof Users.auth === 'object' && Users.auth !== null);
    const usersAuth = Users.auth as {
      useSessions?: boolean;
      removeTokenFromResponses?: boolean;
    };

    // 1. useSessions permanece ativo
    assert.equal(usersAuth.useSessions, true);

    // 2. removeTokenFromResponses permanece omitido / undefined para não disparar o bug do Payload 3.88.0
    assert.equal(usersAuth.removeTokenFromResponses, undefined);

    // 3. Admins e Users mantêm slugs canônicos
    assert.equal(Admins.slug, 'admins');
    assert.equal(Users.slug, 'users');
  });

  it('getEdgeServerConfig consome process.env.PAYLOAD_PUBLIC_SERVER_URL', () => {
    const originalEnv = process.env.PAYLOAD_PUBLIC_SERVER_URL;
    try {
      delete process.env.PAYLOAD_PUBLIC_SERVER_URL;
      assert.equal(getEdgeServerConfig().isSecureCookie, false);

      process.env.PAYLOAD_PUBLIC_SERVER_URL = 'https://nex.starlevel.com.br';
      assert.equal(getEdgeServerConfig().isSecureCookie, true);
      assert.equal(getEdgeServerConfig().serverURL, 'https://nex.starlevel.com.br');
    } finally {
      if (originalEnv !== undefined) {
        process.env.PAYLOAD_PUBLIC_SERVER_URL = originalEnv;
      } else {
        delete process.env.PAYLOAD_PUBLIC_SERVER_URL;
      }
    }
  });
});
