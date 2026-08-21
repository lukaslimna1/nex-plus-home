/**
 * NEX+ · Auth Layer
 * Configuração Environment-Aware de Borda / Edge e Cookies — Escopo 0.8B-L Hardening
 *
 * Determina a partir de PAYLOAD_PUBLIC_SERVER_URL e PAYLOAD_TRUSTED_ORIGINS:
 * 1. serverURL canônica da aplicação no Payload (exclusivamente a partir de PAYLOAD_PUBLIC_SERVER_URL)
 * 2. Origens confiáveis para CSRF e CORS (união deduplicada de serverURL e trusted origins)
 * 3. Flag de cookie Seguro (secure: true em HTTPS, false em HTTP/local)
 */

export interface EdgeAuthCookiesConfig {
  readonly secure: boolean;
  readonly sameSite: 'Lax';
}

export interface EdgeServerConfig {
  readonly serverURL?: string;
  readonly csrf?: string[];
  readonly cors?: string[];
  readonly isSecureCookie: boolean;
  readonly cookies: EdgeAuthCookiesConfig;
}

/**
 * Valida determinísticamente uma URL de origem.
 * Aceita unicamente protocolos http: ou https: sem caminhos funcionais, query ou fragmentos.
 *
 * @param rawUrl URL bruta a validar
 * @param varName Nome da variável para mensagens de erro contextualizadas
 * @returns Origem canônica resolvida (ex: 'https://nex.starlevel.com.br')
 * @throws Error se o valor for malformado, possuir protocolo não suportado ou contiver path/query/fragment/userinfo
 */
export function validateEdgeOrigin(rawUrl: string, varName: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `[EDGE_CONFIG_ERROR] ${varName} contém entrada vazia inválida.`,
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error(
      `[EDGE_CONFIG_ERROR] ${varName} inválida: '${trimmed}'. Deve ser uma URL válida com protocolo e host.`,
    );
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `[EDGE_CONFIG_ERROR] Protocolo não suportado em ${varName}: '${parsedUrl.protocol}'. Permitido apenas 'http:' ou 'https:'.`,
    );
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error(
      `[EDGE_CONFIG_ERROR] ${varName} não deve conter credenciais/userinfo (username/password).`,
    );
  }

  if (parsedUrl.pathname !== '' && parsedUrl.pathname !== '/') {
    throw new Error(
      `[EDGE_CONFIG_ERROR] ${varName} não deve conter path funcional: '${parsedUrl.pathname}'. Informe apenas a origem base (ex: 'https://nex.starlevel.com.br').`,
    );
  }

  if (parsedUrl.search) {
    throw new Error(
      `[EDGE_CONFIG_ERROR] ${varName} não deve conter query string: '${parsedUrl.search}'.`,
    );
  }

  if (parsedUrl.hash) {
    throw new Error(
      `[EDGE_CONFIG_ERROR] ${varName} não deve conter fragmento: '${parsedUrl.hash}'.`,
    );
  }

  return parsedUrl.origin;
}

/**
 * Faz o parsing e validação determinística da origem canônica e das origens confiáveis adicionais.
 *
 * @param rawPublicUrl URL bruta da variável PAYLOAD_PUBLIC_SERVER_URL
 * @param rawTrustedOrigins Lista separada por vírgula de origens em PAYLOAD_TRUSTED_ORIGINS
 * @returns Configuração resolvida para o Payload e auth collections
 */
export function parseEdgeServerConfig(
  rawPublicUrl?: string | null,
  rawTrustedOrigins?: string | null,
): EdgeServerConfig {
  let canonicalOrigin: string | undefined;
  let isSecure = false;

  if (rawPublicUrl && typeof rawPublicUrl === 'string' && rawPublicUrl.trim().length > 0) {
    canonicalOrigin = validateEdgeOrigin(rawPublicUrl, 'PAYLOAD_PUBLIC_SERVER_URL');
    isSecure = canonicalOrigin.startsWith('https:');
  }

  const additionalOrigins: string[] = [];

  if (rawTrustedOrigins && typeof rawTrustedOrigins === 'string' && rawTrustedOrigins.trim().length > 0) {
    const rawTokens = rawTrustedOrigins.split(',');
    for (const rawToken of rawTokens) {
      const trimmedToken = rawToken.trim();
      if (trimmedToken.length === 0) {
        throw new Error(
          `[EDGE_CONFIG_ERROR] PAYLOAD_TRUSTED_ORIGINS contém entrada vazia inválida na lista separada por vírgulas.`,
        );
      }
      const validatedOrigin = validateEdgeOrigin(trimmedToken, 'PAYLOAD_TRUSTED_ORIGINS');
      additionalOrigins.push(validatedOrigin);
    }
  }

  const combinedOrigins: string[] = [];
  if (canonicalOrigin) {
    combinedOrigins.push(canonicalOrigin);
  }
  for (const origin of additionalOrigins) {
    if (!combinedOrigins.includes(origin)) {
      combinedOrigins.push(origin);
    }
  }

  const csrfList = combinedOrigins.length > 0 ? combinedOrigins : undefined;
  const corsList = combinedOrigins.length > 0 ? combinedOrigins : undefined;

  return {
    serverURL: canonicalOrigin,
    csrf: csrfList,
    cors: corsList,
    isSecureCookie: isSecure,
    cookies: {
      secure: isSecure,
      sameSite: 'Lax',
    },
  };
}

/**
 * Retorna a configuração de borda ativa lendo process.env.PAYLOAD_PUBLIC_SERVER_URL e process.env.PAYLOAD_TRUSTED_ORIGINS.
 */
export function getEdgeServerConfig(): EdgeServerConfig {
  return parseEdgeServerConfig(
    process.env.PAYLOAD_PUBLIC_SERVER_URL,
    process.env.PAYLOAD_TRUSTED_ORIGINS,
  );
}
