/**
 * NEX+ · PostgreSQL Adapter para Estado Operacional de Sessão
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 *
 * Implementação isolada de persistência em PostgreSQL com concorrência otimista,
 * atomicidade na inicialização, validação de ownership em todas as operações e diagnóstico de conflitos.
 */

import { isValidSessionRef, type SessionRef } from '../../../auth/session-ref.types';
import type {
  ContextSubjectId,
  ContextSubjectRef,
  ContextSubjectType,
  SessionOperationalState,
} from '../contracts';
import {
  isCanonicalUtcInstant,
  isNonEmptyString,
  validateContextSubjectRef,
  validateSessionOperationalState,
} from '../invariants';
import {
  SessionOperationalStateInvariantError,
  SessionOperationalStateNotFoundError,
  SessionOperationalStateOwnershipMismatchError,
  SessionOperationalStateRevisionConflictError,
} from '../errors';
import type {
  EnsureSessionOperationalStateParams,
  SessionOperationalStateStore,
  SetContextSubjectParams,
} from './contracts';

export interface PgQueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface PgExecutor {
  query<T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
}

function formatPgTimestampToUtcInstant(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (typeof val === 'string') {
    if (isCanonicalUtcInstant(val)) {
      return val;
    }
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  throw new SessionOperationalStateInvariantError(
    'INVALID_TIMESTAMP',
    `Cannot convert database timestamp value '${String(val)}' to canonical UTC instant ending with Z.`
  );
}

function mapRowToSessionOperationalState(row: any): SessionOperationalState {
  if (!row || typeof row !== 'object') {
    throw new SessionOperationalStateInvariantError(
      'INVALID_ROW',
      'Database returned null or invalid row for SessionOperationalState.'
    );
  }

  const sessionRef = String(row.session_ref) as SessionRef;
  const userId = String(row.user_id);
  const revision = Number(row.revision);
  const createdAt = formatPgTimestampToUtcInstant(row.created_at);
  const updatedAt = formatPgTimestampToUtcInstant(row.updated_at);

  let contextSubjectRef: ContextSubjectRef | undefined = undefined;
  if (row.subject_type !== null && row.subject_id !== null && row.subject_type !== undefined && row.subject_id !== undefined) {
    contextSubjectRef = Object.freeze({
      subjectType: String(row.subject_type) as ContextSubjectType,
      subjectId: String(row.subject_id) as ContextSubjectId,
    });
  }

  const state: SessionOperationalState = {
    sessionRef,
    userId,
    ...(contextSubjectRef ? { contextSubjectRef } : {}),
    revision,
    createdAt,
    updatedAt,
  };

  validateSessionOperationalState(state);

  return Object.freeze(state);
}

export class PgSessionOperationalStateStore implements SessionOperationalStateStore {
  private readonly executor: PgExecutor;

  constructor(executor: PgExecutor) {
    this.executor = executor;
  }

  async getState(sessionRef: SessionRef, expectedUserId: string): Promise<SessionOperationalState | null> {
    if (!isValidSessionRef(sessionRef)) {
      throw new SessionOperationalStateInvariantError(
        'INVALID_SESSION_REF',
        `Cannot retrieve state: '${String(sessionRef)}' is not a valid 64-char lowercase hexadecimal SessionRef.`
      );
    }

    if (!isNonEmptyString(expectedUserId)) {
      throw new SessionOperationalStateInvariantError(
        'INVALID_USER_ID',
        'Cannot retrieve state: expectedUserId must be a non-empty string.'
      );
    }

    const normalizedExpectedUserId = expectedUserId.trim();

    const res = await this.executor.query(
      `SELECT session_ref, user_id, subject_type, subject_id, revision, created_at, updated_at
       FROM nex_session_operational_state
       WHERE session_ref = $1;`,
      [sessionRef]
    );

    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0];

    // Verificação estrita de ownership na leitura
    if (row.user_id !== normalizedExpectedUserId) {
      throw new SessionOperationalStateOwnershipMismatchError({
        sessionRef,
        expectedUserId: normalizedExpectedUserId,
        actualUserId: row.user_id,
      });
    }

    return mapRowToSessionOperationalState(row);
  }

  async ensureState(params: EnsureSessionOperationalStateParams): Promise<SessionOperationalState> {
    const { sessionRef, userId } = params;

    if (!isValidSessionRef(sessionRef)) {
      throw new SessionOperationalStateInvariantError(
        'INVALID_SESSION_REF',
        `Cannot ensure state: '${String(sessionRef)}' is not a valid 64-char lowercase hexadecimal SessionRef.`
      );
    }

    if (!isNonEmptyString(userId)) {
      throw new SessionOperationalStateInvariantError(
        'INVALID_USER_ID',
        'Cannot ensure state: userId must be a non-empty string.'
      );
    }

    const normalizedUserId = userId.trim();

    // 1. Tentar inserção atômica com ON CONFLICT DO NOTHING
    const insertRes = await this.executor.query(
      `INSERT INTO nex_session_operational_state (
         session_ref, user_id, subject_type, subject_id, revision, created_at, updated_at
       ) VALUES (
         $1, $2, NULL, NULL, 1, NOW(), NOW()
       )
       ON CONFLICT (session_ref) DO NOTHING
       RETURNING session_ref, user_id, subject_type, subject_id, revision, created_at, updated_at;`,
      [sessionRef, normalizedUserId]
    );

    if (insertRes.rows.length === 1) {
      return mapRowToSessionOperationalState(insertRes.rows[0]);
    }

    // 2. Se não inseriu (já existia), consulta a linha existente e verifica ownership
    const selectRes = await this.executor.query(
      `SELECT session_ref, user_id, subject_type, subject_id, revision, created_at, updated_at
       FROM nex_session_operational_state
       WHERE session_ref = $1;`,
      [sessionRef]
    );

    if (selectRes.rows.length === 0) {
      throw new SessionOperationalStateInvariantError(
        'STATE_CONCURRENCY_ANOMALY',
        `Failed to retrieve existing session operational state for sessionRef '${sessionRef}'.`
      );
    }

    const existingRow = selectRes.rows[0];
    if (existingRow.user_id !== normalizedUserId) {
      throw new SessionOperationalStateOwnershipMismatchError({
        sessionRef,
        expectedUserId: existingRow.user_id,
        actualUserId: normalizedUserId,
      });
    }

    return mapRowToSessionOperationalState(existingRow);
  }

  async setContextSubject(params: SetContextSubjectParams): Promise<SessionOperationalState> {
    const { sessionRef, userId, contextSubjectRef, expectedRevision } = params;

    if (!isValidSessionRef(sessionRef)) {
      throw new SessionOperationalStateInvariantError(
        'INVALID_SESSION_REF',
        `Cannot set context subject: '${String(sessionRef)}' is not a valid 64-char lowercase hexadecimal SessionRef.`
      );
    }

    if (!isNonEmptyString(userId)) {
      throw new SessionOperationalStateInvariantError(
        'INVALID_USER_ID',
        'Cannot set context subject: userId must be a non-empty string.'
      );
    }

    if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new SessionOperationalStateInvariantError(
        'INVALID_EXPECTED_REVISION',
        `expectedRevision must be an integer >= 1, got ${String(expectedRevision)}.`
      );
    }

    if (contextSubjectRef !== null && contextSubjectRef !== undefined) {
      validateContextSubjectRef(contextSubjectRef);
    }

    const normalizedUserId = userId.trim();
    const subjectType = contextSubjectRef ? contextSubjectRef.subjectType.trim() : null;
    const subjectId = contextSubjectRef ? contextSubjectRef.subjectId.trim() : null;

    // 1. Tentar update com verificação atômica de sessionRef, user_id e expectedRevision
    const updateRes = await this.executor.query(
      `UPDATE nex_session_operational_state
       SET subject_type = $1,
           subject_id = $2,
           revision = revision + 1,
           updated_at = NOW()
       WHERE session_ref = $3
         AND user_id = $4
         AND revision = $5
       RETURNING session_ref, user_id, subject_type, subject_id, revision, created_at, updated_at;`,
      [subjectType, subjectId, sessionRef, normalizedUserId, expectedRevision]
    );

    if (updateRes.rows.length === 1) {
      return mapRowToSessionOperationalState(updateRes.rows[0]);
    }

    // 2. Classificação de falha: verificar o estado atual no banco
    const checkRes = await this.executor.query(
      `SELECT session_ref, user_id, subject_type, subject_id, revision, created_at, updated_at
       FROM nex_session_operational_state
       WHERE session_ref = $1;`,
      [sessionRef]
    );

    if (checkRes.rows.length === 0) {
      throw new SessionOperationalStateNotFoundError(sessionRef);
    }

    const existingRow = checkRes.rows[0];

    if (existingRow.user_id !== normalizedUserId) {
      throw new SessionOperationalStateOwnershipMismatchError({
        sessionRef,
        expectedUserId: existingRow.user_id,
        actualUserId: normalizedUserId,
      });
    }

    const currentRevision = Number(existingRow.revision);
    if (currentRevision !== expectedRevision) {
      throw new SessionOperationalStateRevisionConflictError({
        sessionRef,
        expectedRevision,
        actualRevision: currentRevision,
      });
    }

    throw new SessionOperationalStateInvariantError(
      'UNEXPECTED_UPDATE_FAILURE',
      `Optimistic update failed unexpectedly for sessionRef '${sessionRef}'.`
    );
  }
}
