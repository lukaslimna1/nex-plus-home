/**
 * NEX+ · Auth Layer
 * Server-Side Session Boundary (Fail-Closed) — Escopo 0.86B-1 (Hardening)
 *
 * Princípios Fundamentais:
 * 1. Existe APENAS UM entrypoint confiável para produzir AuthenticatedSessionContext material:
 *    request server-side → headers() → getPayload({ config }) → payload.auth({ headers }) → user → HumanActor + SessionRef.
 * 2. Impossibilidade de Bypass: callers não conseguem fabricar contextos fornecendo user, _sid, payload, headers ou secret.
 * 3. Rejeição explícita de identidades 'admins' para ações de App User material.
 * 4. Honestidade Semântica (INV-CTX-AUTH-10): quando payload.auth() retorna user: null (por ausência de token, token inválido, expirado ou revogado), o boundary classifica honestamente como 'not_authenticated' sem suposições diagnósticas infundadas.
 * 5. Falhas de infraestrutura (banco indisponível, crash interno) propagam status 'error' / AuthInternalError.
 * 6. _sid, JWT, cookies e user.sessions permanecem confinados na fronteira e não vazam no DTO.
 */

import { headers as getNextHeaders } from 'next/headers';
import { getPayload } from 'payload';
import type { HumanActor } from '../core/observations/contracts';
import {
  type AuthenticatedSessionContext,
  type SessionResolutionResult,
  type UnauthenticatedReason,
} from './session-ref.types';
import { deriveSessionRef } from './session-ref';
import { classifyIdentity } from './identity';

// ============================================================================
// 1. ERROS TIPADOS DE AUTENTICAÇÃO MATERIAL
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
// 2. HELPER INTERNO DE CONVERSÃO DO RESULTADO AUTENTICADO
// ============================================================================

/**
 * Converte o resultado autenticado do Payload em AuthenticatedSessionContext.
 * Helper interno estritamente confinado ao módulo.
 */
function processPayloadAuthUser(user: unknown): SessionResolutionResult {
  if (!user || typeof user !== 'object') {
    return Object.freeze({
      status: 'unauthenticated',
      reason: 'not_authenticated',
      detail: 'payload.auth() returned null/empty user.',
    });
  }

  const identityClass = classifyIdentity(user);

  if (identityClass === 'admin') {
    return Object.freeze({
      status: 'unauthenticated',
      reason: 'admin_rejected',
      detail: 'Admin identities are strictly rejected in App User material actions.',
    });
  }

  if (identityClass !== 'app_user') {
    return Object.freeze({
      status: 'unauthenticated',
      reason: 'not_authenticated',
      detail: 'Authenticated identity does not belong to users collection.',
    });
  }

  const rawUser = user as Record<string, unknown>;
  const rawId = rawUser.id;
  const rawSid = rawUser._sid;

  const userId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim() : '';
  const sid = typeof rawSid === 'string' ? rawSid.trim() : '';

  if (!userId || !sid) {
    return Object.freeze({
      status: 'unauthenticated',
      reason: 'invalid_or_unavailable_auth',
      detail: 'User document is missing valid userId or session identifier (_sid).',
    });
  }

  try {
    const sessionRef = deriveSessionRef({
      collection: 'users',
      userId,
      sid,
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
// 3. ENTRYPOINTS PÚBLICOS DA FRONTEIRA MATERIAL
// ============================================================================

/**
 * Resolve o contexto de sessão autenticada obtendo headers e Payload reais internamente.
 * Não aceita injeção de parâmetros por callers para garantir integridade do trust boundary.
 */
export async function resolveAuthenticatedSessionContext(): Promise<SessionResolutionResult> {
  try {
    let reqHeaders: Headers;
    try {
      reqHeaders = await getNextHeaders();
    } catch (headersError: any) {
      return Object.freeze({
        status: 'error',
        error: new AuthInternalError(
          `Failed to retrieve request headers: ${headersError instanceof Error ? headersError.message : String(headersError)}`,
          headersError,
        ),
      });
    }

    let payloadInstance: any;
    try {
      const { default: configPromise } = await import('@/payload.config');
      payloadInstance = await getPayload({ config: configPromise });
    } catch (configError: any) {
      return Object.freeze({
        status: 'error',
        error: new AuthInternalError(
          `Failed to initialize Payload instance: ${configError instanceof Error ? configError.message : String(configError)}`,
          configError,
        ),
      });
    }

    let authResult: { user?: unknown } | null = null;
    try {
      authResult = await payloadInstance.auth({ headers: reqHeaders });
    } catch (authError: any) {
      return Object.freeze({
        status: 'error',
        error: new AuthInternalError(
          `payload.auth() execution failed: ${authError instanceof Error ? authError.message : String(authError)}`,
          authError,
        ),
      });
    }

    return processPayloadAuthUser(authResult?.user);
  } catch (outerError: any) {
    return Object.freeze({
      status: 'error',
      error: outerError instanceof Error ? outerError : new Error(String(outerError)),
    });
  }
}

/**
 * Requer uma sessão autenticada válida, lançando exceção se não autenticado, admin ou em erro.
 * Ponto de entrada canônico para Server Actions e rotas materiais do Core.
 *
 * @throws UnauthenticatedSessionError se o usuário não estiver autenticado ou for admin.
 * @throws AuthInternalError se ocorrer falha interna de execução.
 */
export async function requireAuthenticatedSessionContext(): Promise<AuthenticatedSessionContext> {
  const result = await resolveAuthenticatedSessionContext();

  if (result.status === 'authenticated') {
    return result.context;
  }

  if (result.status === 'unauthenticated') {
    throw new UnauthenticatedSessionError(result.reason, result.detail);
  }

  throw result.error;
}
