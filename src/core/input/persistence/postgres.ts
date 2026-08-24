/**
 * NEX+ · PostgreSQL Adapters para Ingress Content e InputRecord
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-3)
 *
 * Implementação de persistência relacional append-only para IngressContentRecord,
 * InputRecord e InputPart[] relacionais ordenados.
 */

import type { SessionRef } from '../../../auth/session-ref.types';
import type {
  Actor,
  SourceRefId,
  EvidenceArtifactRefId,
} from '../../observations/contracts';
import type {
  ContextSubjectRef,
  ContextSubjectType,
  ContextSubjectId,
  OperationalChannel,
} from '../../context/contracts';
import type {
  CorrelationId,
  ResourceRef,
  EventId,
  ModuleKey,
  ResourceType,
  ResourceId,
} from '../../modules/contracts';
import type {
  InputRecordId,
  IngressContentId,
  SourceEventIdentity,
  InputPart,
  InputRecord,
  IngressContentRecord,
} from '../contracts';
import {
  validateIngressContentRecord,
  validateInputRecord,
  validateInputPart,
} from '../invariants';
import {
  InputInvariantViolationError,
} from '../errors';
import type {
  IngressContentStore,
  InputRecordStore,
} from './contracts';

export interface PgQueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface PgExecutor {
  query<T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
}

export interface PgTransactionalExecutor extends PgExecutor {
  connect?(): Promise<{
    query<T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
    release(): void;
  }>;
}

function formatPgTimestampToUtcInstant(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (typeof val === 'string') {
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  throw new InputInvariantViolationError(
    'INVALID_TIMESTAMP',
    `Cannot convert database timestamp value '${String(val)}' to canonical UTC instant ending with Z.`
  );
}

// ============================================================================
// 1. MAPPER: INGRESS CONTENT ROW -> RECORD
// ============================================================================

export function mapRowToIngressContentRecord(row: any): IngressContentRecord {
  if (!row || typeof row !== 'object') {
    throw new InputInvariantViolationError(
      'INVALID_ROW',
      'Database returned null or invalid row for IngressContentRecord.'
    );
  }

  let actor: Actor;
  if (typeof row.actor_payload === 'string') {
    actor = JSON.parse(row.actor_payload);
  } else {
    actor = row.actor_payload;
  }

  let contextSubjectRef: ContextSubjectRef | undefined;
  if (row.subject_type && row.subject_id) {
    contextSubjectRef = Object.freeze({
      subjectType: row.subject_type as ContextSubjectType,
      subjectId: row.subject_id as ContextSubjectId,
    });
  }

  const record: IngressContentRecord = Object.freeze({
    contentId: row.content_id as IngressContentId,
    actor: Object.freeze(actor),
    ...(row.user_id ? { userId: row.user_id } : {}),
    ...(row.session_ref ? { sessionRef: row.session_ref as SessionRef } : {}),
    ...(contextSubjectRef ? { contextSubjectRef } : {}),
    ...(row.source_ref_id ? { sourceRefId: row.source_ref_id as SourceRefId } : {}),
    ...(row.declared_mime_type ? { declaredMimeType: row.declared_mime_type } : {}),
    verifiedMimeType: row.verified_mime_type,
    sha256: row.sha256,
    byteSize: Number(row.byte_size),
    storageBackend: row.storage_backend,
    storageKey: row.storage_key,
    receivedAt: formatPgTimestampToUtcInstant(row.received_at),
    ...(row.expires_at ? { expiresAt: formatPgTimestampToUtcInstant(row.expires_at) } : {}),
  });

  validateIngressContentRecord(record);
  return record;
}

// ============================================================================
// 2. MAPPER: INPUT RECORD & PARTS ROWS -> INPUT RECORD
// ============================================================================

export function mapRowsToInputRecord(recordRow: any, partRows: any[]): InputRecord {
  if (!recordRow || typeof recordRow !== 'object') {
    throw new InputInvariantViolationError(
      'INVALID_ROW',
      'Database returned null or invalid row for InputRecord.'
    );
  }

  let actor: Actor;
  if (typeof recordRow.actor_payload === 'string') {
    actor = JSON.parse(recordRow.actor_payload);
  } else {
    actor = recordRow.actor_payload;
  }

  let contextSubjectRef: ContextSubjectRef | undefined;
  if (recordRow.subject_type && recordRow.subject_id) {
    contextSubjectRef = Object.freeze({
      subjectType: recordRow.subject_type as ContextSubjectType,
      subjectId: recordRow.subject_id as ContextSubjectId,
    });
  }

  let sourceEventIdentity: SourceEventIdentity | undefined;
  if (recordRow.source_event_source && recordRow.source_event_id) {
    sourceEventIdentity = Object.freeze({
      source: recordRow.source_event_source,
      id: recordRow.source_event_id,
    });
  }

  // Ordena parts por position asc
  const sortedPartRows = [...partRows].sort((a, b) => Number(a.position) - Number(b.position));

  const parts: InputPart[] = sortedPartRows.map((pRow) => {
    switch (pRow.kind) {
      case 'text':
        return Object.freeze({
          kind: 'text',
          text: pRow.text_value,
        });

      case 'content_ref':
        return Object.freeze({
          kind: 'content_ref',
          content: Object.freeze({
            contentId: pRow.ingress_content_id as IngressContentId,
          }),
        });

      case 'event_ref':
        return Object.freeze({
          kind: 'event_ref',
          eventId: pRow.event_id as EventId,
        });

      case 'resource_ref':
        return Object.freeze({
          kind: 'resource_ref',
          resource: Object.freeze({
            ownerModule: Object.freeze({ moduleKey: pRow.resource_module_key as ModuleKey }),
            resourceType: pRow.resource_type as ResourceType,
            resourceId: pRow.resource_id as ResourceId,
          } as ResourceRef),
        });

      case 'evidence_ref':
        return Object.freeze({
          kind: 'evidence_ref',
          evidenceArtifactId: pRow.evidence_artifact_id as EvidenceArtifactRefId,
        });

      default:
        throw new InputInvariantViolationError(
          'UNKNOWN_INPUT_PART_KIND',
          `Unknown InputPart kind in database row: '${String(pRow.kind)}'.`
        );
    }
  });

  for (const part of parts) {
    validateInputPart(part);
  }

  const inputRecord: InputRecord = Object.freeze({
    inputId: recordRow.input_id as InputRecordId,
    actor: Object.freeze(actor),
    ...(recordRow.user_id ? { userId: recordRow.user_id } : {}),
    ...(recordRow.session_ref ? { sessionRef: recordRow.session_ref as SessionRef } : {}),
    ...(contextSubjectRef ? { contextSubjectRef } : {}),
    ...(recordRow.source_ref_id ? { sourceRefId: recordRow.source_ref_id as SourceRefId } : {}),
    ...(sourceEventIdentity ? { sourceEventIdentity } : {}),
    ...(recordRow.occurred_at ? { occurredAt: formatPgTimestampToUtcInstant(recordRow.occurred_at) } : {}),
    receivedAt: formatPgTimestampToUtcInstant(recordRow.received_at),
    ...(recordRow.channel ? { channel: recordRow.channel as OperationalChannel } : {}),
    ...(recordRow.correlation_id ? { correlationId: recordRow.correlation_id as CorrelationId } : {}),
    parts: Object.freeze(parts),
  });

  validateInputRecord(inputRecord);
  return inputRecord;
}

// ============================================================================
// 3. POSTGRES INGRESS CONTENT STORE
// ============================================================================

export class PostgresIngressContentStore implements IngressContentStore {
  constructor(private readonly executor: PgExecutor) {}

  async saveContent(record: IngressContentRecord): Promise<IngressContentRecord> {
    validateIngressContentRecord(record);

    const subjectType = record.contextSubjectRef ? record.contextSubjectRef.subjectType.trim() : null;
    const subjectId = record.contextSubjectRef ? record.contextSubjectRef.subjectId.trim() : null;

    const sql = `
      INSERT INTO nex_ingress_contents (
        content_id,
        actor_kind,
        actor_payload,
        user_id,
        session_ref,
        subject_type,
        subject_id,
        source_ref_id,
        declared_mime_type,
        verified_mime_type,
        sha256,
        byte_size,
        storage_backend,
        storage_key,
        received_at,
        expires_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      )
      RETURNING *;
    `;

    const params = [
      record.contentId,
      record.actor.kind,
      JSON.stringify(record.actor),
      record.userId ?? null,
      record.sessionRef ?? null,
      subjectType,
      subjectId,
      record.sourceRefId ?? null,
      record.declaredMimeType ?? null,
      record.verifiedMimeType,
      record.sha256,
      record.byteSize,
      record.storageBackend,
      record.storageKey,
      record.receivedAt,
      record.expiresAt ?? null,
    ];

    const res = await this.executor.query(sql, params);
    if (res.rows.length === 0) {
      throw new InputInvariantViolationError(
        'INSERT_FAILED',
        `Failed to insert IngressContentRecord with contentId '${record.contentId}'.`
      );
    }

    return mapRowToIngressContentRecord(res.rows[0]);
  }

  async getContent(contentId: IngressContentId): Promise<IngressContentRecord | null> {
    const res = await this.executor.query(
      `SELECT * FROM nex_ingress_contents WHERE content_id = $1;`,
      [contentId]
    );

    if (res.rows.length === 0) {
      return null;
    }

    return mapRowToIngressContentRecord(res.rows[0]);
  }

  async hasContent(contentId: IngressContentId): Promise<boolean> {
    const res = await this.executor.query(
      `SELECT 1 FROM nex_ingress_contents WHERE content_id = $1 LIMIT 1;`,
      [contentId]
    );
    return res.rows.length > 0;
  }
}

// ============================================================================
// 4. POSTGRES INPUT RECORD STORE
// ============================================================================

export class PostgresInputRecordStore implements InputRecordStore {
  constructor(private readonly executor: PgTransactionalExecutor) {}

  private async executeInClient<T>(
    fn: (client: PgExecutor) => Promise<T>
  ): Promise<T> {
    if (typeof this.executor.connect === 'function') {
      const client = await this.executor.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } else {
      // Fallback para executor sem connect (ex: mock ou single connection)
      await this.executor.query('BEGIN');
      try {
        const result = await fn(this.executor);
        await this.executor.query('COMMIT');
        return result;
      } catch (err) {
        await this.executor.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }
  }

  async saveInputRecord(record: InputRecord): Promise<InputRecord> {
    validateInputRecord(record);

    return this.executeInClient(async (client) => {
      const subjectType = record.contextSubjectRef ? record.contextSubjectRef.subjectType.trim() : null;
      const subjectId = record.contextSubjectRef ? record.contextSubjectRef.subjectId.trim() : null;
      const sourceEventSource = record.sourceEventIdentity ? record.sourceEventIdentity.source : null;
      const sourceEventId = record.sourceEventIdentity ? record.sourceEventIdentity.id : null;

      const recordSql = `
        INSERT INTO nex_input_records (
          input_id,
          actor_kind,
          actor_payload,
          user_id,
          session_ref,
          subject_type,
          subject_id,
          source_ref_id,
          source_event_source,
          source_event_id,
          occurred_at,
          received_at,
          channel,
          correlation_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
        )
        RETURNING *;
      `;

      const recordParams = [
        record.inputId,
        record.actor.kind,
        JSON.stringify(record.actor),
        record.userId ?? null,
        record.sessionRef ?? null,
        subjectType,
        subjectId,
        record.sourceRefId ?? null,
        sourceEventSource,
        sourceEventId,
        record.occurredAt ?? null,
        record.receivedAt,
        record.channel ?? null,
        record.correlationId ?? null,
      ];

      const recordRes = await client.query(recordSql, recordParams);
      const insertedRecordRow = recordRes.rows[0];

      const partRows: any[] = [];

      for (let position = 0; position < record.parts.length; position++) {
        const part = record.parts[position];

        let textValue: string | null = null;
        let ingressContentId: string | null = null;
        let eventId: string | null = null;
        let resourceModuleKey: string | null = null;
        let resourceType: string | null = null;
        let resourceId: string | null = null;
        let evidenceArtifactId: string | null = null;

        switch (part.kind) {
          case 'text':
            textValue = part.text;
            break;
          case 'content_ref':
            ingressContentId = part.content.contentId;
            break;
          case 'event_ref':
            eventId = part.eventId;
            break;
          case 'resource_ref':
            resourceModuleKey = part.resource.ownerModule.moduleKey;
            resourceType = part.resource.resourceType;
            resourceId = part.resource.resourceId;
            break;
          case 'evidence_ref':
            evidenceArtifactId = part.evidenceArtifactId;
            break;
        }

        const partSql = `
          INSERT INTO nex_input_parts (
            input_id,
            position,
            kind,
            text_value,
            ingress_content_id,
            event_id,
            resource_module_key,
            resource_type,
            resource_id,
            evidence_artifact_id
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
          )
          RETURNING *;
        `;

        const partParams = [
          record.inputId,
          position,
          part.kind,
          textValue,
          ingressContentId,
          eventId,
          resourceModuleKey,
          resourceType,
          resourceId,
          evidenceArtifactId,
        ];

        const partRes = await client.query(partSql, partParams);
        partRows.push(partRes.rows[0]);
      }

      return mapRowsToInputRecord(insertedRecordRow, partRows);
    });
  }

  async getInputRecord(inputId: InputRecordId): Promise<InputRecord | null> {
    const recordRes = await this.executor.query(
      `SELECT * FROM nex_input_records WHERE input_id = $1;`,
      [inputId]
    );

    if (recordRes.rows.length === 0) {
      return null;
    }

    const partsRes = await this.executor.query(
      `SELECT * FROM nex_input_parts WHERE input_id = $1 ORDER BY position ASC;`,
      [inputId]
    );

    return mapRowsToInputRecord(recordRes.rows[0], partsRes.rows);
  }

  async findBySourceEventIdentity(identity: SourceEventIdentity): Promise<InputRecord | null> {
    const recordRes = await this.executor.query(
      `SELECT * FROM nex_input_records
       WHERE source_event_source = $1 AND source_event_id = $2
       LIMIT 1;`,
      [identity.source, identity.id]
    );

    if (recordRes.rows.length === 0) {
      return null;
    }

    const inputId = recordRes.rows[0].input_id;
    const partsRes = await this.executor.query(
      `SELECT * FROM nex_input_parts WHERE input_id = $1 ORDER BY position ASC;`,
      [inputId]
    );

    return mapRowsToInputRecord(recordRes.rows[0], partsRes.rows);
  }
}
