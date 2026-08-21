/**
 * NEX+ · Auth Layer
 * Configuração Environment-Aware de Borda / Edge e Cookies — Escopo 0.8B-L Hardening
 *
 * Determina a partir de PAYLOAD_PUBLIC_SERVER_URL:
 * 1. serverURL canônica da aplicação no Payload
 * 2. Origem confiável para CSRF e cookie authentication
 * 3. Flag de cookie Seguro (secure: true em HTTPS, false em HTTP/local)
 */

export interface EdgeAuthCookiesConfig {
  readonly secure: boolean;
  readonly sameSite: 'Lax';
}

export interface EdgeServerConfig {
  readonly serverURL?: string;
  readonly csrf?: string[];
  readonly isSecureCookie: boolean;
  readonly cookies: EdgeAuthCookiesConfig;
}

/**
 * Faz o parsing e validação determinística de uma URL de origem pública.
 * Aceita unicamente protocolos http: ou https: sem caminhos funcionais, query ou fragmentos.
 *
 * @param rawUrl URL bruta da variável de ambiente
 * @returns Configuração resolvida para o Payload e auth collections
 * @throws Error se o valor for malformado, possuir protocolo não suportado ou contiver path/query/fragment
 */
export function parseEdgeServerConfig(rawUrl?: string | null): EdgeServerConfig {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return {
      serverURL: undefined,
      csrf: undefined,
      isSecureCookie: false,
      cookies: {
        secure: false,
        sameSite: 'Lax',
      },
    };
  }

  const trimmed = rawUrl.trim();
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error(
      `[EDGE_CONFIG_ERROR] PAYLOAD_PUBLIC_SERVER_URL inválida: '${trimmed}'. Deve ser uma URL válida com protocolo e host.`,
    );
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `[EDGE_CONFIG_ERROR] Protocolo não suportado em PAYLOAD_PUBLIC_SERVER_URL: '${parsedUrl.protocol}'. Permitido apenas 'http:' ou 'https:'.`,
    );
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error(
      `[EDGE_CONFIG_ERROR] PAYLOAD_PUBLIC_SERVER_URL não deve conter credenciais/userinfo (username/password).`,
    );
  }

  if (parsedUrl.pathname !== '' && parsedUrl.pathname !== '/') {
    throw new Error(
      `[EDGE_CONFIG_ERROR] PAYLOAD_PUBLIC_SERVER_URL não deve conter path funcional: '${parsedUrl.pathname}'. Informe apenas a origem base (ex: 'https://nex.starlevel.com.br').`,
    );
  }

  if (parsedUrl.search) {
    throw new Error(
      `[EDGE_CONFIG_ERROR] PAYLOAD_PUBLIC_SERVER_URL não deve conter query string: '${parsedUrl.search}'.`,
    );
  }

  if (parsedUrl.hash) {
    throw new Error(
      `[EDGE_CONFIG_ERROR] PAYLOAD_PUBLIC_SERVER_URL não deve conter fragmento: '${parsedUrl.hash}'.`,
    );
  }

  const origin = parsedUrl.origin;
  const isSecure = parsedUrl.protocol === 'https:';

  return {
    serverURL: origin,
    csrf: [origin],
    isSecureCookie: isSecure,
    cookies: {
      secure: isSecure,
      sameSite: 'Lax',
    },
  };
}

/**
 * Retorna a configuração de borda ativa lendo process.env.PAYLOAD_PUBLIC_SERVER_URL.
 */
export function getEdgeServerConfig(): EdgeServerConfig {
  return parseEdgeServerConfig(process.env.PAYLOAD_PUBLIC_SERVER_URL);
}
