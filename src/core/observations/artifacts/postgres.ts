/**
 * NEX+ · PostgreSQL Evidence Artifact Persistence Adapter
 * Escopo 0.85 (Bloco 0.85C · Hardening Pós-Red-Team)
 *
 * Persistência append-only de metadados de artefatos duráveis, fontes e vínculos de attempts
 * com idempotência completa de todos os campos imutáveis e restauração transacional atômica.
 */

import { isDeepStrictEqual } from 'node:util';
import type {
  EvidenceArtifactRefId,
  SourceRefId,
} from '../contracts';
import type { AttemptId } from '../../execution/contracts';
import type {
  EvidenceArtifactRecord,
  SourceRefRecord,
  EvidenceArtifactAttemptLink,
  EvidenceBackupManifest,
} from './contracts';
import {
  ArtifactIdentityConflictError,
  ArtifactInvariantViolationError,
} from './errors';
import {
  validateEvidenceArtifactRecord,
  validateSourceRefRecord,
  validateEvidenceBackupManifest,
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
        const existing = await this.getSourceRef(validated.sourceId);
        if (existing) {
          // Idempotência profunda e estrita
          if (
            existing.kind === validated.kind &&
            existing.name === validated.name &&
            existing.locationOrUri === validated.locationOrUri &&
            existing.createdAt === validated.createdAt &&
            isDeepStrictEqual(existing.safeMetadata, validated.safeMetadata)
          ) {
            return existing;
          }
        }
        throw new ArtifactIdentityConflictError(
          validated.sourceId,
          `SourceRef '${validated.sourceId}' already exists with divergent historical metadata.`
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

      // Se SourceRef especificada, valida existência no DB
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
          // Reverte até o savepoint para manter o bloco de transação limpo para checagem
          await client.query('ROLLBACK TO SAVEPOINT sp_insert_artifact');

          const existingRes = await client.query(
            `SELECT * FROM nex_evidence_artifacts WHERE artifact_id = $1`,
            [validated.artifactId]
          );

          if (existingRes.rows.length > 0) {
            const existing = this.mapRowToRecord(existingRes.rows[0]);

            // Idempotência estrita em TODOS os campos imutáveis
            const isIdempotentMatch =
              existing.artifactId === validated.artifactId &&
              existing.kind === validated.kind &&
              existing.sourceRefId === validated.sourceRefId &&
              existing.sha256 === validated.sha256 &&
              existing.byteSize === validated.byteSize &&
              existing.mimeType === validated.mimeType &&
              existing.storageBackend === validated.storageBackend &&
              existing.storageKey === validated.storageKey &&
              existing.safeDescription === validated.safeDescription &&
              existing.capturedAt === validated.capturedAt &&
              existing.sensitivity === validated.sensitivity &&
              existing.containsSecretMaterial === validated.containsSecretMaterial &&
              existing.redactionApplied === validated.redactionApplied &&
              existing.redactionMethodRef === validated.redactionMethodRef &&
              existing.retentionClass === validated.retentionClass;

            if (isIdempotentMatch) {
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
            `ArtifactId '${validated.artifactId}' already exists with divergent historical metadata.`
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
      await client.query('ROLLBACK').catch(() => {});
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

  // ==========================================================================
  // 4. ATOMIC RESTORE METADATA (Single PostgreSQL Transaction)
  // ==========================================================================

  async restoreManifestMetadataAtomically(manifest: EvidenceBackupManifest): Promise<void> {
    const validated = validateEvidenceBackupManifest(manifest);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Restaura SourceRefs dentro da transação única
      for (const source of validated.sourceRefs) {
        const safeMetaJson = source.safeMetadata
          ? serializeToPgJsonb(source.safeMetadata, 'safeMetadata')
          : null;

        await client.query('SAVEPOINT sp_restore_src');
        try {
          await client.query(
            `INSERT INTO nex_source_refs (
              source_id, kind, name, location_or_uri, safe_metadata, created_at
            ) VALUES (
              $1, $2, $3, $4, $5::jsonb, $6
            )`,
            [
              source.sourceId,
              source.kind,
              source.name,
              source.locationOrUri ?? null,
              safeMetaJson,
              source.createdAt,
            ]
          );
          await client.query('RELEASE SAVEPOINT sp_restore_src');
        } catch (srcErr: any) {
          if (srcErr?.code === '23505') {
            await client.query('ROLLBACK TO SAVEPOINT sp_restore_src');
            const exRes = await client.query(`SELECT * FROM nex_source_refs WHERE source_id = $1`, [source.sourceId]);
            if (exRes.rows.length > 0) {
              const existing = validateSourceRefRecord({
                sourceId: exRes.rows[0].source_id,
                kind: exRes.rows[0].kind,
                name: exRes.rows[0].name,
                locationOrUri: exRes.rows[0].location_or_uri ?? undefined,
                safeMetadata: exRes.rows[0].safe_metadata ? parsePgJsonb(exRes.rows[0].safe_metadata) : undefined,
                createdAt: formatPgTimestampToUtcInstant(exRes.rows[0].created_at),
              });
              if (
                existing.kind === source.kind &&
                existing.name === source.name &&
                existing.locationOrUri === source.locationOrUri &&
                existing.createdAt === source.createdAt &&
                isDeepStrictEqual(existing.safeMetadata, source.safeMetadata)
              ) {
                continue; // Idempotente
              }
            }
            throw new ArtifactIdentityConflictError(
              source.sourceId,
              `SourceRef '${source.sourceId}' already exists with divergent metadata during restore.`
            );
          }
          throw srcErr;
        }
      }

      // 2. Restaura EvidenceArtifacts dentro da transação única
      for (const artifact of validated.artifacts) {
        await client.query('SAVEPOINT sp_restore_art');
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
              artifact.artifactId,
              artifact.kind,
              artifact.sourceRefId ?? null,
              artifact.sha256,
              artifact.byteSize,
              artifact.mimeType,
              artifact.storageBackend,
              artifact.storageKey,
              artifact.safeDescription ?? null,
              artifact.capturedAt,
              artifact.sensitivity,
              false,
              artifact.redactionApplied,
              artifact.redactionMethodRef ?? null,
              artifact.retentionClass,
            ]
          );
          await client.query('RELEASE SAVEPOINT sp_restore_art');
        } catch (artErr: any) {
          if (artErr?.code === '23505') {
            await client.query('ROLLBACK TO SAVEPOINT sp_restore_art');
            const exRes = await client.query(`SELECT * FROM nex_evidence_artifacts WHERE artifact_id = $1`, [artifact.artifactId]);
            if (exRes.rows.length > 0) {
              const existing = this.mapRowToRecord(exRes.rows[0]);
              const isIdempotentMatch =
                existing.artifactId === artifact.artifactId &&
                existing.kind === artifact.kind &&
                existing.sourceRefId === artifact.sourceRefId &&
                existing.sha256 === artifact.sha256 &&
                existing.byteSize === artifact.byteSize &&
                existing.mimeType === artifact.mimeType &&
                existing.storageBackend === artifact.storageBackend &&
                existing.storageKey === artifact.storageKey &&
                existing.safeDescription === artifact.safeDescription &&
                existing.capturedAt === artifact.capturedAt &&
                existing.sensitivity === artifact.sensitivity &&
                existing.containsSecretMaterial === artifact.containsSecretMaterial &&
                existing.redactionApplied === artifact.redactionApplied &&
                existing.redactionMethodRef === artifact.redactionMethodRef &&
                existing.retentionClass === artifact.retentionClass;

              if (isIdempotentMatch) {
                continue; // Idempotente
              }
            }
            throw new ArtifactIdentityConflictError(
              artifact.artifactId,
              `ArtifactId '${artifact.artifactId}' already exists with divergent metadata during restore.`
            );
          }
          throw artErr;
        }
      }

      // 3. Restaura AttemptLinks dentro da transação única com validação estrita de linkedAt
      for (const link of validated.attemptLinks) {
        await client.query('SAVEPOINT sp_restore_link');
        try {
          await client.query(
            `INSERT INTO nex_evidence_artifact_attempt_links (artifact_id, attempt_id, linked_at)
             VALUES ($1, $2, $3)`,
            [link.artifactId, link.attemptId, link.linkedAt]
          );
          await client.query('RELEASE SAVEPOINT sp_restore_link');
        } catch (linkErr: any) {
          if (linkErr?.code === '23505') {
            await client.query('ROLLBACK TO SAVEPOINT sp_restore_link');
            const exRes = await client.query(
              `SELECT artifact_id, attempt_id, linked_at FROM nex_evidence_artifact_attempt_links
               WHERE artifact_id = $1 AND attempt_id = $2`,
              [link.artifactId, link.attemptId]
            );
            if (exRes.rows.length > 0) {
              const existingLinkedAt = formatPgTimestampToUtcInstant(exRes.rows[0].linked_at);
              if (existingLinkedAt === link.linkedAt) {
                continue; // Idempotente
              }
            }
            throw new ArtifactIdentityConflictError(
              link.artifactId,
              `AttemptLink for artifactId '${link.artifactId}' and attemptId '${link.attemptId}' already exists with divergent linkedAt.`
            );
          }
          throw linkErr;
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      if (typeof client.release === 'function') {
        client.release();
      }
    }
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
