/**
 * NEX+ · Auth Layer
 * Derivação Criptográfica Server-Side de SessionRef — Escopo 0.86B-1 (Hardening)
 *
 * Princípios Fundamentais:
 * 1. SessionRef é um identificador opaco derivado exclusivamente server-side via HMAC-SHA-256.
 * 2. Domain separation com serialização canônica inequívoca (JSON array tupla):
 *    JSON.stringify(['nex-session-ref:v1', collection, userId, sid])
 *    Impede ataques de injeção de delimitadores (ex: valores contendo dois-pontos ':').
 * 3. Resolução Server-Only de Segredo:
 *    - SESSION_REF_SECRET dedicada (permite rotação independente de segredo de auditoria/sessão);
 *    - Fallback para PAYLOAD_SECRET (mantém ciclo de vida acoplado ao auth; rotação invalida JWTs).
 *    - Segredo ausente ou vazio falha fechado imediatamente.
 * 4. User != Session: sessões distintas (diferentes sids) do mesmo usuário produzem SessionRefs distintas.
 * 5. SessionRef NÃO autentica nem autoriza requisições.
 */

import * as crypto from 'node:crypto';
import {
  SESSION_REF_DOMAIN_NAMESPACE,
  type SessionRef,
} from './session-ref.types';

// ============================================================================
// 1. ERROS TIPADOS DE DERIVAÇÃO
// ============================================================================

export class SessionSecretMissingError extends Error {
  readonly code = 'SESSION_SECRET_MISSING';

  constructor(detail?: string) {
    super(
      `[Auth SessionRef] Server secret is missing or empty. ${
        detail || 'PAYLOAD_SECRET or SESSION_REF_SECRET is required to derive SessionRef.'
      }`,
    );
    this.name = 'SessionSecretMissingError';
  }
}

export class InvalidSessionRefInputError extends Error {
  readonly code = 'INVALID_SESSION_REF_INPUT';
  readonly fieldName: string;

  constructor(fieldName: string, reason: string) {
    super(`[Auth SessionRef] Invalid input for '${fieldName}': ${reason}.`);
    this.name = 'InvalidSessionRefInputError';
    this.fieldName = fieldName;
  }
}

// ============================================================================
// 2. DERIVAÇÃO CRIPTOGRÁFICA
// ============================================================================

export interface DeriveSessionRefParams {
  readonly collection: string;
  readonly userId: string;
  readonly sid: string;
  readonly secret?: string;
}

/**
 * Deriva deterministicamente um SessionRef utilizando HMAC-SHA-256 com serialização canônica JSON.
 *
 * @throws InvalidSessionRefInputError se collection, userId ou sid forem vazios ou inválidos.
 * @throws SessionSecretMissingError se o segredo server-side estiver ausente ou vazio.
 */
export function deriveSessionRef(params: DeriveSessionRefParams): SessionRef {
  const { collection, userId, sid } = params;

  if (!collection || typeof collection !== 'string' || collection.trim().length === 0) {
    throw new InvalidSessionRefInputError('collection', 'must be a non-empty string');
  }

  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    throw new InvalidSessionRefInputError('userId', 'must be a non-empty string');
  }

  if (!sid || typeof sid !== 'string' || sid.trim().length === 0) {
    throw new InvalidSessionRefInputError('sid', 'must be a non-empty string');
  }

  const rawSecret = params.secret ?? process.env.SESSION_REF_SECRET ?? process.env.PAYLOAD_SECRET;
  if (!rawSecret || typeof rawSecret !== 'string' || rawSecret.trim().length === 0) {
    throw new SessionSecretMissingError();
  }

  const normalizedCollection = collection.trim();
  const normalizedUserId = userId.trim();
  const normalizedSid = sid.trim();
  const secret = rawSecret.trim();

  // Serialização canônica inequívoca em tupla JSON fixa para impedir colisão de delimitadores
  const canonicalMessage = JSON.stringify([
    SESSION_REF_DOMAIN_NAMESPACE,
    normalizedCollection,
    normalizedUserId,
    normalizedSid,
  ]);

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(canonicalMessage, 'utf8');
  const digest = hmac.digest('hex');

  return digest as SessionRef;
}
