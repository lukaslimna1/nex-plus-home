/**
 * NEX+ · Job Runtime Invariants & Defensive Validations
 * Validações Defensivas Fail-Closed — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3A)
 *
 * Princípios de Segurança e Integridade:
 * 1. O payload de wake-up DEVE ser um plain object contendo EXATAMENTE a chave 'jobId'.
 * 2. Qualquer campo adicional (como sessionRef, token, state, actor, headers, etc.) resulta em rejeição imediata.
 * 3. 'jobId' deve ser uma string não-vazia (rejeita undefined, null, vazia e whitespace-only).
 * 4. Preserva estritamente o valor textual do jobId sem mutação.
 * 5. Retorna o payload em estrutura profundamente imutável (Object.freeze).
 */

import type { JobWakeupPayload } from './contracts';

// ============================================================================
// 1. CÓDIGO E CLASSE DE ERRO DO PAYLOAD
// ============================================================================

export type JobWakeupErrorCode =
  | 'INVALID_WAKEUP_PAYLOAD_TYPE'
  | 'INVALID_WAKEUP_PAYLOAD_SHAPE'
  | 'FORBIDDEN_PAYLOAD_FIELD'
  | 'INVALID_JOB_ID';

export interface JobWakeupPayloadErrorOptions {
  readonly code: JobWakeupErrorCode;
  readonly message: string;
  readonly forbiddenFields?: readonly string[];
  readonly receivedType?: string;
}

export class JobWakeupPayloadError extends Error {
  readonly code: JobWakeupErrorCode;
  readonly forbiddenFields?: readonly string[];
  readonly receivedType?: string;

  constructor(options: JobWakeupPayloadErrorOptions) {
    super(options.message);
    this.name = 'JobWakeupPayloadError';
    this.code = options.code;
    this.forbiddenFields = options.forbiddenFields ? Object.freeze([...options.forbiddenFields]) : undefined;
    this.receivedType = options.receivedType;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ============================================================================
// 2. PARSER & VALIDADOR DEFENSIVO FAIL-CLOSED
// ============================================================================

/**
 * Valida e converte um valor bruto em JobWakeupPayload canônico imutável.
 * Rejeita qualquer estrutura que não seja um plain object com unicamente a propriedade 'jobId'.
 * Rejeita chaves extras (incluindo sessionRef, token, state, actor, headers, etc.), símbolos e tipos inválidos.
 */
export function parseJobWakeupPayload(raw: unknown): Readonly<JobWakeupPayload> {
  // 1. Não pode ser nulo ou indefinido
  if (raw === null || raw === undefined) {
    throw new JobWakeupPayloadError({
      code: 'INVALID_WAKEUP_PAYLOAD_TYPE',
      message: `[Job Wakeup] Payload must be a non-null plain object. Received: ${raw === null ? 'null' : 'undefined'}.`,
      receivedType: raw === null ? 'null' : 'undefined',
    });
  }

  // 2. Deve ser objeto e não array
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    const receivedType = Array.isArray(raw) ? 'array' : typeof raw;
    throw new JobWakeupPayloadError({
      code: 'INVALID_WAKEUP_PAYLOAD_TYPE',
      message: `[Job Wakeup] Payload must be a plain object. Received: ${receivedType}.`,
      receivedType,
    });
  }

  // 3. Deve ser plain object (prototype Object.prototype ou null)
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) {
    throw new JobWakeupPayloadError({
      code: 'INVALID_WAKEUP_PAYLOAD_TYPE',
      message: `[Job Wakeup] Payload must be a plain object without custom prototype.`,
      receivedType: 'custom_object',
    });
  }

  // 4. Verificação de símbolos (não permitidos)
  const symbols = Object.getOwnPropertySymbols(raw);
  if (symbols.length > 0) {
    throw new JobWakeupPayloadError({
      code: 'FORBIDDEN_PAYLOAD_FIELD',
      message: `[Job Wakeup] Payload must not contain symbol properties. Found: ${symbols.length} symbol(s).`,
      forbiddenFields: symbols.map((s) => s.toString()),
    });
  }

  // 5. Verificação estrita de chaves de propriedades: exatamente ['jobId']
  const keys = Object.keys(raw);
  const extraKeys = keys.filter((k) => k !== 'jobId');

  if (extraKeys.length > 0) {
    throw new JobWakeupPayloadError({
      code: 'FORBIDDEN_PAYLOAD_FIELD',
      message: `[Job Wakeup] Payload contains forbidden/unrecognized properties: [${extraKeys.join(', ')}]. Only 'jobId' is allowed.`,
      forbiddenFields: extraKeys,
    });
  }

  if (!keys.includes('jobId')) {
    throw new JobWakeupPayloadError({
      code: 'INVALID_WAKEUP_PAYLOAD_SHAPE',
      message: `[Job Wakeup] Payload missing required 'jobId' property.`,
    });
  }

  const candidate = raw as { jobId?: unknown };
  const rawJobId = candidate.jobId;

  // 6. jobId deve ser string
  if (typeof rawJobId !== 'string') {
    throw new JobWakeupPayloadError({
      code: 'INVALID_JOB_ID',
      message: `[Job Wakeup] Property 'jobId' must be a string. Received: ${typeof rawJobId}.`,
      receivedType: typeof rawJobId,
    });
  }

  // 7. jobId não pode ser vazio ou whitespace-only
  if (rawJobId.trim().length === 0) {
    throw new JobWakeupPayloadError({
      code: 'INVALID_JOB_ID',
      message: `[Job Wakeup] Property 'jobId' cannot be empty or whitespace-only.`,
      receivedType: rawJobId.length === 0 ? 'empty_string' : 'whitespace_string',
    });
  }

  // 8. Retorno imutável preservando exatamente o valor textual
  return Object.freeze({
    jobId: rawJobId,
  });
}

/**
 * Asserção TypeScript fail-closed para JobWakeupPayload.
 */
export function assertJobWakeupPayload(raw: unknown): asserts raw is JobWakeupPayload {
  parseJobWakeupPayload(raw);
}
