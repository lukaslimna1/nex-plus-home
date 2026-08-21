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
    const originalPublicEnv = process.env.PAYLOAD_PUBLIC_SERVER_URL;
    const originalTrustedEnv = process.env.PAYLOAD_TRUSTED_ORIGINS;
    try {
      delete process.env.PAYLOAD_PUBLIC_SERVER_URL;
      delete process.env.PAYLOAD_TRUSTED_ORIGINS;
      assert.equal(getEdgeServerConfig().isSecureCookie, false);
      assert.equal(getEdgeServerConfig().serverURL, undefined);
      assert.equal(getEdgeServerConfig().csrf, undefined);
      assert.equal(getEdgeServerConfig().cors, undefined);

      process.env.PAYLOAD_PUBLIC_SERVER_URL = 'https://nex.starlevel.com.br';
      assert.equal(getEdgeServerConfig().isSecureCookie, true);
      assert.equal(getEdgeServerConfig().serverURL, 'https://nex.starlevel.com.br');
      assert.deepEqual(getEdgeServerConfig().csrf, ['https://nex.starlevel.com.br']);
      assert.deepEqual(getEdgeServerConfig().cors, ['https://nex.starlevel.com.br']);

      process.env.PAYLOAD_TRUSTED_ORIGINS = 'https://admin.nex.starlevel.com.br';
      assert.equal(getEdgeServerConfig().serverURL, 'https://nex.starlevel.com.br');
      assert.deepEqual(getEdgeServerConfig().csrf, [
        'https://nex.starlevel.com.br',
        'https://admin.nex.starlevel.com.br',
      ]);
      assert.deepEqual(getEdgeServerConfig().cors, [
        'https://nex.starlevel.com.br',
        'https://admin.nex.starlevel.com.br',
      ]);
    } finally {
      if (originalPublicEnv !== undefined) {
        process.env.PAYLOAD_PUBLIC_SERVER_URL = originalPublicEnv;
      } else {
        delete process.env.PAYLOAD_PUBLIC_SERVER_URL;
      }
      if (originalTrustedEnv !== undefined) {
        process.env.PAYLOAD_TRUSTED_ORIGINS = originalTrustedEnv;
      } else {
        delete process.env.PAYLOAD_TRUSTED_ORIGINS;
      }
    }
  });

  it('L7. PAYLOAD_TRUSTED_ORIGINS: suporta origem única e múltiplas origens adicionais para CSRF e CORS', () => {
    // 1. Somente serverURL
    const config1 = parseEdgeServerConfig('https://nex.starlevel.com.br');
    assert.equal(config1.serverURL, 'https://nex.starlevel.com.br');
    assert.deepEqual(config1.csrf, ['https://nex.starlevel.com.br']);
    assert.deepEqual(config1.cors, ['https://nex.starlevel.com.br']);

    // 2. serverURL + 1 trusted origin
    const config2 = parseEdgeServerConfig(
      'https://nex.starlevel.com.br',
      'https://admin.nex.starlevel.com.br',
    );
    assert.equal(config2.serverURL, 'https://nex.starlevel.com.br');
    assert.deepEqual(config2.csrf, [
      'https://nex.starlevel.com.br',
      'https://admin.nex.starlevel.com.br',
    ]);
    assert.deepEqual(config2.cors, [
      'https://nex.starlevel.com.br',
      'https://admin.nex.starlevel.com.br',
    ]);

    // 3. serverURL + múltiplas trusted origins
    const config3 = parseEdgeServerConfig(
      'https://nex.starlevel.com.br',
      'https://admin.nex.starlevel.com.br, https://api.nex.starlevel.com.br, https://app.nex.starlevel.com.br:8443',
    );
    assert.equal(config3.serverURL, 'https://nex.starlevel.com.br');
    assert.deepEqual(config3.csrf, [
      'https://nex.starlevel.com.br',
      'https://admin.nex.starlevel.com.br',
      'https://api.nex.starlevel.com.br',
      'https://app.nex.starlevel.com.br:8443',
    ]);
    assert.deepEqual(config3.cors, [
      'https://nex.starlevel.com.br',
      'https://admin.nex.starlevel.com.br',
      'https://api.nex.starlevel.com.br',
      'https://app.nex.starlevel.com.br:8443',
    ]);

    // 4. Sem serverURL (modo local), mas com trusted origins
    const config4 = parseEdgeServerConfig(null, 'http://localhost:3000, http://127.0.0.1:3000');
    assert.equal(config4.serverURL, undefined);
    assert.deepEqual(config4.csrf, ['http://localhost:3000', 'http://127.0.0.1:3000']);
    assert.deepEqual(config4.cors, ['http://localhost:3000', 'http://127.0.0.1:3000']);
    assert.equal(config4.isSecureCookie, false);
  });

  it('L8. Deduplicação e normalização determinística de origens em CSRF e CORS', () => {
    // 1. Origem repetida entre serverURL e trusted origins
    const config1 = parseEdgeServerConfig(
      'https://nex.starlevel.com.br',
      'https://nex.starlevel.com.br, https://admin.nex.starlevel.com.br',
    );
    assert.deepEqual(config1.csrf, [
      'https://nex.starlevel.com.br',
      'https://admin.nex.starlevel.com.br',
    ]);
    assert.deepEqual(config1.cors, [
      'https://nex.starlevel.com.br',
      'https://admin.nex.starlevel.com.br',
    ]);

    // 2. Origem repetida em trusted origins com variações de trailing slash e espaços
    const config2 = parseEdgeServerConfig(
      'https://nex.starlevel.com.br/',
      ' https://admin.nex.starlevel.com.br/ , https://admin.nex.starlevel.com.br , https://nex.starlevel.com.br ',
    );
    assert.equal(config2.serverURL, 'https://nex.starlevel.com.br');
    assert.deepEqual(config2.csrf, [
      'https://nex.starlevel.com.br',
      'https://admin.nex.starlevel.com.br',
    ]);
    assert.deepEqual(config2.cors, [
      'https://nex.starlevel.com.br',
      'https://admin.nex.starlevel.com.br',
    ]);

    // 3. Validação de que serverURL não é alterada pela inclusão de trusted origins
    assert.equal(config2.serverURL, 'https://nex.starlevel.com.br');
  });

  it('L9. Rejeição determinística de entradas inválidas ou maliciosas em PAYLOAD_TRUSTED_ORIGINS (fail-closed)', () => {
    // 1. Protocolo não suportado
    assert.throws(
      () =>
        parseEdgeServerConfig(
          'https://nex.starlevel.com.br',
          'ftp://admin.nex.starlevel.com.br',
        ),
      (err: Error) => err.message.includes('Protocolo não suportado'),
    );

    // 2. URL malformada
    assert.throws(
      () =>
        parseEdgeServerConfig(
          'https://nex.starlevel.com.br',
          'https://admin.nex.starlevel.com.br, not-a-url',
        ),
      (err: Error) => err.message.includes('inválida'),
    );

    // 3. Userinfo / credenciais na URL
    assert.throws(
      () =>
        parseEdgeServerConfig(
          'https://nex.starlevel.com.br',
          'https://admin:secret@admin.nex.starlevel.com.br',
        ),
      (err: Error) => err.message.includes('não deve conter credenciais/userinfo'),
    );

    // 4. Path funcional
    assert.throws(
      () =>
        parseEdgeServerConfig(
          'https://nex.starlevel.com.br',
          'https://admin.nex.starlevel.com.br/admin',
        ),
      (err: Error) => err.message.includes('não deve conter path funcional'),
    );

    // 5. Query string
    assert.throws(
      () =>
        parseEdgeServerConfig(
          'https://nex.starlevel.com.br',
          'https://admin.nex.starlevel.com.br?debug=true',
        ),
      (err: Error) => err.message.includes('não deve conter query string'),
    );

    // 6. Fragmento
    assert.throws(
      () =>
        parseEdgeServerConfig(
          'https://nex.starlevel.com.br',
          'https://admin.nex.starlevel.com.br#top',
        ),
      (err: Error) => err.message.includes('não deve conter fragmento'),
    );

    // 7. Entrada vazia na lista separada por vírgulas (ex: vírgula solta / elemento vazio)
    const emptyEntries = [
      'https://admin.nex.starlevel.com.br,',
      ',https://admin.nex.starlevel.com.br',
      'https://a.com, ,https://b.com',
      'https://a.com,,https://b.com',
    ];
    for (const entry of emptyEntries) {
      assert.throws(
        () => parseEdgeServerConfig('https://nex.starlevel.com.br', entry),
        (err: Error) => err.message.includes('contém entrada vazia inválida'),
        `Deve rejeitar entrada com token vazio na lista: '${entry}'`,
      );
    }
  });
});
