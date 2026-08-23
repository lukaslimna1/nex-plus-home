/**
 * NEX+ · Auth Layer
 * Derivação Segura e Determinística de SessionRef — Escopo 0.86B-1
 *
 * Princípios Fundamentais:
 * 1. SessionRef é um identificador opaco (branded type) derivado exclusivamente server-side via HMAC-SHA-256.
 * 2. Domain separation e versionamento canônico: 'nex-session-ref:v1:${collection}:${userId}:${sid}'.
 * 3. Segredo server-only (PAYLOAD_SECRET / SESSION_REF_SECRET), nunca hardcodado e nunca exposto.
 * 4. User != Session: o mesmo usuário com diferentes sids produz SessionRefs distintas.
 * 5. SessionRef NÃO autentica nem autoriza: serve unicamente para correlação, proveniência e isolamento.
 * 6. _sid, tokens e sessões brutas permanecem confinados na fronteira auth.
 */

import * as crypto from 'node:crypto';

// ============================================================================
// 1. IDENTIFICADOR BRANDED
// ============================================================================

export type SessionRef = string & { readonly __brand?: 'SessionRef' };

// ============================================================================
// 2. CONSTANTES DE DOMÍNIO
// ============================================================================

export const SESSION_REF_DOMAIN_NAMESPACE = 'nex-session-ref:v1';
const SESSION_REF_HEX_REGEX = /^[a-f0-9]{64}$/;

// ============================================================================
// 3. ERROS TIPADOS
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
// 4. PARÂMETROS E DERIVAÇÃO
// ============================================================================

export interface DeriveSessionRefParams {
  readonly collection: string;
  readonly userId: string;
  readonly sid: string;
  readonly secret?: string;
}

/**
 * Deriva deterministicamente um SessionRef opaco usando HMAC-SHA-256 com separação de domínio.
 *
 * @throws InvalidSessionRefInputError se collection, userId ou sid forem vazios/inválidos.
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

  const message = `${SESSION_REF_DOMAIN_NAMESPACE}:${normalizedCollection}:${normalizedUserId}:${normalizedSid}`;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(message, 'utf8');
  const digest = hmac.digest('hex');

  return digest as SessionRef;
}

/**
 * Valida o formato estrutural de um SessionRef (digest SHA-256 em 64 caracteres hexadecimais minúsculos).
 */
export function isValidSessionRef(value: unknown): value is SessionRef {
  return typeof value === 'string' && SESSION_REF_HEX_REGEX.test(value);
}
