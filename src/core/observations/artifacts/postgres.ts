/**
 * NEX+ · PostgreSQL Evidence Artifact Persistence Adapter
 * Escopo 0.85 (Bloco 0.85C)
 *
 * Persistência append-only de metadados de artefatos duráveis, fontes e vínculos de attempts.
 */

import type {
  EvidenceArtifactRefId,
  SourceRefId,
} from '../contracts';
import type { AttemptId } from '../../execution/contracts';
import type {
  EvidenceArtifactRecord,
  SourceRefRecord,
  EvidenceArtifactAttemptLink,
} from './contracts';
import {
  ArtifactIdentityConflictError,
  ArtifactInvariantViolationError,
} from './errors';
import {
  validateEvidenceArtifactRecord,
  validateSourceRefRecord,
} from './validators';
import {
  serializeToPgJsonb,
  parsePgJsonb,
  formatPgTimestampToUtcInstant,
} from '../persistence/serialization';
import type { PgPoolLike } from '../persistence/postgres';

export class PgEvidenceArtifactPersistenceAdapter {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  // ==========================================================================
  // 1. SOURCE REFS
  // ==========================================================================

  async recordSourceRef(source: SourceRefRecord): Promise<SourceRefRecord> {
    const validated = validateSourceRefRecord(source);

    const safeMetaJson = validated.safeMetadata
      ? serializeToPgJsonb(validated.safeMetadata, 'safeMetadata')
      : null;

    try {
      await this.pool.query(
        `INSERT INTO nex_source_refs (
          source_id, kind, name, location_or_uri, safe_metadata, created_at
        ) VALUES (
          $1, $2, $3, $4, $5::jsonb, $6
        )`,
        [
          validated.sourceId,
          validated.kind,
          validated.name,
          validated.locationOrUri ?? null,
          safeMetaJson,
          validated.createdAt,
        ]
      );
      return validated;
    } catch (err: any) {
      if (err?.code === '23505') {
        // Se já existe, verifica se é exatamente idêntico (idempotência)
        const existing = await this.getSourceRef(validated.sourceId);
        if (existing) {
          if (
            existing.kind === validated.kind &&
            existing.name === validated.name &&
            existing.locationOrUri === validated.locationOrUri
          ) {
            return existing;
          }
        }
        throw new ArtifactIdentityConflictError(
          validated.sourceId,
          `SourceRef '${validated.sourceId}' already exists with different data.`
        );
      }
      throw err;
    }
  }

  async getSourceRef(sourceId: SourceRefId): Promise<SourceRefRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM nex_source_refs WHERE source_id = $1`,
      [sourceId]
    );

    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0];
    return validateSourceRefRecord({
      sourceId: row.source_id,
      kind: row.kind,
      name: row.name,
      locationOrUri: row.location_or_uri ?? undefined,
      safeMetadata: row.safe_metadata ? parsePgJsonb(row.safe_metadata) : undefined,
      createdAt: formatPgTimestampToUtcInstant(row.created_at),
    });
  }

  async listAllSourceRefs(): Promise<readonly SourceRefRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM nex_source_refs ORDER BY created_at ASC`
    );

    return res.rows.map((row) =>
      validateSourceRefRecord({
        sourceId: row.source_id,
        kind: row.kind,
        name: row.name,
        locationOrUri: row.location_or_uri ?? undefined,
        safeMetadata: row.safe_metadata ? parsePgJsonb(row.safe_metadata) : undefined,
        createdAt: formatPgTimestampToUtcInstant(row.created_at),
      })
    );
  }

  // ==========================================================================
  // 2. EVIDENCE ARTIFACTS METADATA
  // ==========================================================================

  async recordArtifactMetadata(
    record: EvidenceArtifactRecord,
    attemptId?: AttemptId
  ): Promise<EvidenceArtifactRecord> {
    const validated = validateEvidenceArtifactRecord(record);

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Se SourceRef especificada, valida existência
      if (validated.sourceRefId) {
        const srcRes = await client.query(
          `SELECT source_id FROM nex_source_refs WHERE source_id = $1`,
          [validated.sourceRefId]
        );
        if (srcRes.rows.length === 0) {
          throw new ArtifactInvariantViolationError(
            'SOURCE_REF_NOT_FOUND',
            `Referenced sourceRefId '${validated.sourceRefId}' does not exist in persistence.`
          );
        }
      }

      await client.query('SAVEPOINT sp_insert_artifact');
      try {
        await client.query(
          `INSERT INTO nex_evidence_artifacts (
            artifact_id, kind, source_ref_id, sha256, byte_size,
            mime_type, storage_backend, storage_key, safe_description,
            captured_at, sensitivity, contains_secret_material,
            redaction_applied, redaction_method_ref, retention_class
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9,
            $10, $11, $12,
            $13, $14, $15
          )`,
          [
            validated.artifactId,
            validated.kind,
            validated.sourceRefId ?? null,
            validated.sha256,
            validated.byteSize,
            validated.mimeType,
            validated.storageBackend,
            validated.storageKey,
            validated.safeDescription ?? null,
            validated.capturedAt,
            validated.sensitivity,
            false,
            validated.redactionApplied,
            validated.redactionMethodRef ?? null,
            validated.retentionClass,
          ]
        );
        await client.query('RELEASE SAVEPOINT sp_insert_artifact');
      } catch (insertErr: any) {
        if (insertErr?.code === '23505') {
          // Reverte até o savepoint para manter a transação válida para o SELECT de checagem
          await client.query('ROLLBACK TO SAVEPOINT sp_insert_artifact');

          const existingRes = await client.query(
            `SELECT * FROM nex_evidence_artifacts WHERE artifact_id = $1`,
            [validated.artifactId]
          );
          if (existingRes.rows.length > 0) {
            const existing = this.mapRowToRecord(existingRes.rows[0]);
            if (
              existing.sha256 === validated.sha256 &&
              existing.byteSize === validated.byteSize &&
              existing.kind === validated.kind
            ) {
              // Idempotência perfeita
              if (attemptId) {
                await client.query(
                  `INSERT INTO nex_evidence_artifact_attempt_links (artifact_id, attempt_id)
                   VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                  [validated.artifactId, attemptId]
                );
              }
              await client.query('COMMIT');
              return existing;
            }
          }
          await client.query('ROLLBACK');
          throw new ArtifactIdentityConflictError(
            validated.artifactId,
            `ArtifactId '${validated.artifactId}' already exists with different hash or metadata.`
          );
        }
        throw insertErr;
      }

      if (attemptId) {
        await client.query(
          `INSERT INTO nex_evidence_artifact_attempt_links (artifact_id, attempt_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [validated.artifactId, attemptId]
        );
      }

      await client.query('COMMIT');
      return validated;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      if (typeof client.release === 'function') {
        client.release();
      }
    }
  }

  async getArtifactMetadata(artifactId: EvidenceArtifactRefId): Promise<EvidenceArtifactRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM nex_evidence_artifacts WHERE artifact_id = $1`,
      [artifactId]
    );

    if (res.rows.length === 0) {
      return null;
    }

    return this.mapRowToRecord(res.rows[0]);
  }

  async getArtifactMetadataBySha256(sha256: string): Promise<readonly EvidenceArtifactRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM nex_evidence_artifacts WHERE sha256 = $1 ORDER BY captured_at ASC`,
      [sha256.toLowerCase()]
    );

    return res.rows.map((row) => this.mapRowToRecord(row));
  }

  async listAllArtifactMetadata(): Promise<readonly EvidenceArtifactRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM nex_evidence_artifacts ORDER BY captured_at ASC`
    );

    return res.rows.map((row) => this.mapRowToRecord(row));
  }

  // ==========================================================================
  // 3. ATTEMPT LINKS
  // ==========================================================================

  async linkArtifactToAttempt(artifactId: EvidenceArtifactRefId, attemptId: AttemptId): Promise<void> {
    await this.pool.query(
      `INSERT INTO nex_evidence_artifact_attempt_links (artifact_id, attempt_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [artifactId, attemptId]
    );
  }

  async listAllAttemptLinks(): Promise<readonly EvidenceArtifactAttemptLink[]> {
    const res = await this.pool.query(
      `SELECT artifact_id, attempt_id, linked_at FROM nex_evidence_artifact_attempt_links ORDER BY linked_at ASC`
    );

    return res.rows.map((row) => ({
      artifactId: row.artifact_id as EvidenceArtifactRefId,
      attemptId: row.attempt_id as AttemptId,
      linkedAt: formatPgTimestampToUtcInstant(row.linked_at),
    }));
  }

  async getAttemptsForArtifact(artifactId: EvidenceArtifactRefId): Promise<readonly AttemptId[]> {
    const res = await this.pool.query<{ attempt_id: string }>(
      `SELECT attempt_id FROM nex_evidence_artifact_attempt_links WHERE artifact_id = $1 ORDER BY linked_at ASC`,
      [artifactId]
    );

    return res.rows.map((r) => r.attempt_id as AttemptId);
  }

  private mapRowToRecord(row: any): EvidenceArtifactRecord {
    return validateEvidenceArtifactRecord({
      artifactId: row.artifact_id,
      kind: row.kind,
      sourceRefId: row.source_ref_id ?? undefined,
      sha256: row.sha256,
      byteSize: Number(row.byte_size),
      mimeType: row.mime_type,
      storageBackend: row.storage_backend,
      storageKey: row.storage_key,
      safeDescription: row.safe_description ?? undefined,
      capturedAt: formatPgTimestampToUtcInstant(row.captured_at),
      sensitivity: row.sensitivity,
      containsSecretMaterial: false,
      redactionApplied: row.redaction_applied,
      redactionMethodRef: row.redaction_method_ref ?? undefined,
      retentionClass: row.retention_class,
    });
  }
}
