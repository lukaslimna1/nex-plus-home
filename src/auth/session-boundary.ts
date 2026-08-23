/**
 * NEX+ · Auth Layer
 * Server-Side Session Boundary (Fail-Closed) — Escopo 0.86B-1
 *
 * Princípios Fundamentais:
 * 1. Transforma sessão Payload autenticada em HumanActor (L0) + SessionRef (opaca).
 * 2. Rejeição explícita de identidades 'admins' e anônimas para ações de App User material.
 * 3. Falha fechada: erros internos do Payload não são convertidos silenciosamente em anônimos.
 * 4. _sid, JWT, cookies e user.sessions permanecem confinados na fronteira e não vazam no DTO.
 * 5. O cliente nunca fornece actor, humanId ou SessionRef confiáveis.
 */

import { headers as getNextHeaders } from 'next/headers';
import { getPayload, type Payload } from 'payload';
import type { HumanActor } from '../core/observations/contracts';
import { deriveSessionRef, type SessionRef } from './session-ref';
import { classifyIdentity } from './identity';

// ============================================================================
// 1. DTO E RESULTADOS DA FRONTEIRA
// ============================================================================

/**
 * Contexto de sessão autenticada exposto para as camadas Core do NEX+.
 * Não contém dados sensíveis de infraestrutura auth (_sid, JWT, cookies, sessions).
 */
export interface AuthenticatedSessionContext {
  readonly actor: HumanActor;
  readonly sessionRef: SessionRef;
}

export type UnauthenticatedReason = 'anonymous' | 'admin_rejected' | 'missing_session';

export type SessionResolutionResult =
  | {
      readonly status: 'authenticated';
      readonly context: AuthenticatedSessionContext;
    }
  | {
      readonly status: 'unauthenticated';
      readonly reason: UnauthenticatedReason;
      readonly detail?: string;
    }
  | {
      readonly status: 'error';
      readonly error: Error;
    };

// ============================================================================
// 2. ERROS TIPADOS DE AUTENTICAÇÃO MATERIAL
// ============================================================================

export class UnauthenticatedSessionError extends Error {
  readonly code = 'UNAUTHENTICATED_SESSION';
  readonly reason: UnauthenticatedReason;
  readonly detail?: string;

  constructor(reason: UnauthenticatedReason, detail?: string) {
    super(`[Auth SessionBoundary] Unauthenticated request: ${reason}.${detail ? ` ${detail}` : ''}`);
    this.name = 'UnauthenticatedSessionError';
    this.reason = reason;
    this.detail = detail;
  }
}

export class AuthInternalError extends Error {
  readonly code = 'AUTH_INTERNAL_ERROR';
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(`[Auth SessionBoundary] Internal authentication error: ${message}`);
    this.name = 'AuthInternalError';
    this.cause = cause;
  }
}

// ============================================================================
// 3. RESOLUÇÃO A PARTIR DO USUÁRIO PAYLOAD
// ============================================================================

/**
 * Deriva deterministicamente o contexto de sessão autenticada a partir do objeto `user` do Payload.
 * Função pura e síncrona adequada para isolamento de testes e chamadas diretas.
 */
export function resolveSessionContextFromAuthUser(
  user: unknown,
  secretOverride?: string,
): SessionResolutionResult {
  const identityClass = classifyIdentity(user);

  if (identityClass === 'anonymous' || !user || typeof user !== 'object') {
    return Object.freeze({
      status: 'unauthenticated',
      reason: 'anonymous',
      detail: 'No authenticated user document present.',
    });
  }

  if (identityClass === 'admin') {
    return Object.freeze({
      status: 'unauthenticated',
      reason: 'admin_rejected',
      detail: 'Admin identities are strictly rejected in App User material actions.',
    });
  }

  const rawUser = user as Record<string, unknown>;
  const rawId = rawUser.id;
  const rawSid = rawUser._sid;

  const userId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim() : '';
  const sid = typeof rawSid === 'string' ? rawSid.trim() : '';

  if (!userId) {
    return Object.freeze({
      status: 'unauthenticated',
      reason: 'anonymous',
      detail: 'User document is missing a valid id.',
    });
  }

  if (!sid) {
    return Object.freeze({
      status: 'unauthenticated',
      reason: 'missing_session',
      detail: 'User is authenticated but missing a valid session identifier (_sid).',
    });
  }

  try {
    const sessionRef = deriveSessionRef({
      collection: 'users',
      userId,
      sid,
      secret: secretOverride,
    });

    const actor: HumanActor = Object.freeze({
      kind: 'human',
      humanId: userId,
    });

    const context: AuthenticatedSessionContext = Object.freeze({
      actor,
      sessionRef,
    });

    return Object.freeze({
      status: 'authenticated',
      context,
    });
  } catch (err: any) {
    return Object.freeze({
      status: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }
}

// ============================================================================
// 4. RESOLUÇÃO SERVER-SIDE VIA HEADERS & PAYLOAD
// ============================================================================

export interface ResolveSessionContextOptions {
  readonly headers?: Headers | Record<string, string | string[] | undefined>;
  readonly payload?: Payload;
  readonly secret?: string;
}

/**
 * Resolve o contexto de sessão autenticada utilizando a autoridade oficial do Payload.
 * Falha fechado: não mascara erros de infraestrutura como anônimos.
 */
export async function resolveAuthenticatedSessionContext(
  options: ResolveSessionContextOptions = {},
): Promise<SessionResolutionResult> {
  try {
    let reqHeaders: any = options.headers;
    if (!reqHeaders) {
      reqHeaders = await getNextHeaders();
    }

    let payloadInstance = options.payload;
    if (!payloadInstance) {
      const { default: configPromise } = await import('@/payload.config');
      payloadInstance = await getPayload({ config: configPromise });
    }

    let authResult: { user?: unknown } | null = null;
    try {
      authResult = await payloadInstance.auth({ headers: reqHeaders });
    } catch (authError: any) {
      // Erro na execução de payload.auth() (ex: banco de dados indisponível, JWT decodificado com crash)
      return Object.freeze({
        status: 'error',
        error: new AuthInternalError(
          authError instanceof Error ? authError.message : String(authError),
          authError,
        ),
      });
    }

    if (!authResult || !authResult.user) {
      return Object.freeze({
        status: 'unauthenticated',
        reason: 'anonymous',
        detail: 'payload.auth() returned null/empty user.',
      });
    }

    return resolveSessionContextFromAuthUser(authResult.user, options.secret);
  } catch (outerError: any) {
    return Object.freeze({
      status: 'error',
      error: outerError instanceof Error ? outerError : new Error(String(outerError)),
    });
  }
}

/**
 * Requer uma sessão autenticada válida, lançando exceção se anônimo, admin ou em caso de erro.
 * Indicada para Server Actions, endpoints de mutação e pontos de entrada materiais do Core.
 *
 * @throws UnauthenticatedSessionError se o usuário for anônimo, admin ou sem sessão válida.
 * @throws Error se ocorrer erro interno ou falha de configuração de segredo.
 */
export async function requireAuthenticatedSessionContext(
  options: ResolveSessionContextOptions = {},
): Promise<AuthenticatedSessionContext> {
  const result = await resolveAuthenticatedSessionContext(options);

  if (result.status === 'authenticated') {
    return result.context;
  }

  if (result.status === 'unauthenticated') {
    throw new UnauthenticatedSessionError(result.reason, result.detail);
  }

  throw result.error;
}
