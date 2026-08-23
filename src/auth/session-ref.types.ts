/**
 * NEX+ · Auth Layer
 * Tipos e Contratos de SessionRef — Escopo 0.86B-1 (Hardening)
 *
 * Módulo seguro para importação transversal (isento de dependências server-only ou secrets).
 */

import type { HumanActor } from '../core/observations/contracts';

// ============================================================================
// 1. IDENTIFICADOR BRANDED
// ============================================================================

/**
 * Referência opaca de sessão do NEX+.
 * Não autentica nem autoriza requisições. Serve unicamente para proveniência,
 * rastreabilidade e isolamento de contexto no Core.
 */
export type SessionRef = string & { readonly __brand?: 'SessionRef' };

// ============================================================================
// 2. CONSTANTES DE DOMÍNIO & FORMATO
// ============================================================================

export const SESSION_REF_DOMAIN_NAMESPACE = 'nex-session-ref:v1';
const SESSION_REF_HEX_REGEX = /^[a-f0-9]{64}$/;

/**
 * Validação estrutural de formato do SessionRef (64 caracteres hexadecimais minúsculos).
 */
export function isValidSessionRef(value: unknown): value is SessionRef {
  return typeof value === 'string' && SESSION_REF_HEX_REGEX.test(value);
}

// ============================================================================
// 3. CONTEXTO DE SESSÃO AUTENTICADA & RESULTADOS
// ============================================================================

/**
 * Contexto de sessão autenticada exposto para as camadas Core do NEX+.
 * Não contém dados sensíveis de infraestrutura auth (_sid, JWT, cookies, sessions).
 */
export interface AuthenticatedSessionContext {
  readonly actor: HumanActor;
  readonly sessionRef: SessionRef;
}

export type UnauthenticatedReason =
  | 'not_authenticated'
  | 'admin_rejected'
  | 'invalid_or_unavailable_auth';

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
