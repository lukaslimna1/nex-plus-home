import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pg from 'pg';

import type {
  EvidenceArtifactRefId,
  SourceRefId,
  ObservationRecordId,
  ReviewEventId,
} from '../../contracts';
import type { AttemptId } from '../../../execution/contracts';
import { LocalFsArtifactBlobStore } from '../local-fs';
import { PgEvidenceArtifactPersistenceAdapter } from '../postgres';
import { DefaultArtifactAccessAuthorizer } from '../authorizer';
import { EvidenceArtifactService } from '../service';
import { auditArtifactStore } from '../integrity';
import { backupArtifactStore, restoreArtifactStore } from '../backup';
import {
  ArtifactIdentityConflictError,
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  SecretMaterialRejectedError,
  ArtifactAccessDeniedError,
} from '../errors';
import { PgObservationPersistenceAdapter } from '../../persistence/postgres';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

describe('Escopo 0.85C · Evidence Artifact Store & Integridade (Integração PostgreSQL & Filesystem)', { skip: !databaseUrl }, () => {
  let pool: pg.Pool;
  let tempRoot: string;
  let blobStore: LocalFsArtifactBlobStore;
  let persistence: PgEvidenceArtifactPersistenceAdapter;
  let authorizer: DefaultArtifactAccessAuthorizer;
  let service: EvidenceArtifactService;
  let obsAdapter: PgObservationPersistenceAdapter;

  before(async () => {
    if (!databaseUrl) return;
    pool = new Pool({ connectionString: databaseUrl });
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nex_evidence_integration_'));
    blobStore = new LocalFsArtifactBlobStore({ rootDir: tempRoot });
    persistence = new PgEvidenceArtifactPersistenceAdapter(pool);
    authorizer = new DefaultArtifactAccessAuthorizer();
    service = new EvidenceArtifactService({
      blobStore,
      persistence,
      authorizer,
    });
    obsAdapter = new PgObservationPersistenceAdapter(pool);
  });

  after(async () => {
    if (pool) {
      await pool.end();
    }
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('1. Metadados, Identidade vs Hash e SourceRef', () => {
    it('K: SourceRef round-trip com persistência PostgreSQL', async () => {
      const now = Date.now();
      const sourceId = `src_test_${now}` as SourceRefId;

      const source = await service.recordSourceRef({
        sourceId,
        kind: 'url',
        name: 'Portal Fornecedor Oficial',
        locationOrUri: 'https://fornecedor.exemplo.com.br/produtos',
        safeMetadata: { provider: 'external_catalog', httpStatus: 200 },
        createdAt: '2026-08-21T15:00:00.000Z',
      });

      assert.equal(source.sourceId, sourceId);
      assert.equal(source.kind, 'url');

      const fetched = await service.getSourceRef(sourceId);
      assert.ok(fetched);
      assert.equal(fetched.sourceId, sourceId);
      assert.equal(fetched.name, 'Portal Fornecedor Oficial');
      assert.equal(fetched.createdAt, '2026-08-21T15:00:00.000Z');
      assert.deepEqual(fetched.safeMetadata, { provider: 'external_catalog', httpStatus: 200 });
    });

    it('L: ArtifactRecord round-trip com gravação física e leitura verificada', async () => {
      const now = Date.now();
      const artifactId = `art_screenshot_${now}` as EvidenceArtifactRefId;
      const content = Buffer.from('RAW PNG BINARY CONTENT OF SCREENSHOT 2026');

      const record = await service.materializeArtifact(content, {
        artifactId,
        kind: 'screenshot',
        mimeType: 'image/png',
        safeDescription: 'Captura da tela de preços do fornecedor',
        containsSecretMaterial: false,
        sensitivity: 'NORMAL',
        capturedAt: '2026-08-21T15:30:00.000Z',
      });

      assert.equal(record.artifactId, artifactId);
      assert.equal(record.kind, 'screenshot');
      assert.equal(record.mimeType, 'image/png');
      assert.equal(record.byteSize, content.length);
      assert.equal(record.containsSecretMaterial, false);

      const readResult = await service.readArtifact(artifactId, {
        operation: 'read',
        bypassForTesting: true,
      });

      assert.equal(readResult.metadata.artifactId, artifactId);
      assert.deepEqual(readResult.bytes, content);
    });

    it('M: Mesmo artifactId com mesma metadata é idempotente', async () => {
      const now = Date.now();
      const artifactId = `art_idem_${now}` as EvidenceArtifactRefId;
      const content = Buffer.from('Idempotent artifact test bytes');

      const first = await service.materializeArtifact(content, {
        artifactId,
        kind: 'document',
        mimeType: 'application/pdf',
        containsSecretMaterial: false,
        capturedAt: '2026-08-21T15:30:00.000Z',
      });

      const second = await service.materializeArtifact(content, {
        artifactId,
        kind: 'document',
        mimeType: 'application/pdf',
        containsSecretMaterial: false,
        capturedAt: '2026-08-21T15:30:00.000Z',
      });

      assert.equal(first.artifactId, second.artifactId);
      assert.equal(first.sha256, second.sha256);
    });

    it('N: Mesmo artifactId com conteúdo (hash) diferente gera ArtifactIdentityConflictError', async () => {
      const now = Date.now();
      const artifactId = `art_conflict_${now}` as EvidenceArtifactRefId;

      await service.materializeArtifact(Buffer.from('Initial Content'), {
        artifactId,
        kind: 'document',
        containsSecretMaterial: false,
      });

      await assert.rejects(
        async () => {
          await service.materializeArtifact(Buffer.from('Mutated Content with same ID'), {
            artifactId,
            kind: 'document',
            containsSecretMaterial: false,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactIdentityConflictError);
          assert.equal(err.artifactId, artifactId);
          return true;
        }
      );
    });

    it('O: Mesmo hash com artifactIds diferentes produz dois registros PostgreSQL independentes', async () => {
      const now = Date.now();
      const sharedContent = Buffer.from('Shared bytes captured at different times');
      const art1Id = `art_shared_1_${now}` as EvidenceArtifactRefId;
      const art2Id = `art_shared_2_${now}` as EvidenceArtifactRefId;

      const r1 = await service.materializeArtifact(sharedContent, {
        artifactId: art1Id,
        kind: 'screenshot',
        safeDescription: 'Screenshot A às 10h',
        containsSecretMaterial: false,
        capturedAt: '2026-08-21T10:00:00.000Z',
      });

      const r2 = await service.materializeArtifact(sharedContent, {
        artifactId: art2Id,
        kind: 'screenshot',
        safeDescription: 'Screenshot B às 11h',
        containsSecretMaterial: false,
        capturedAt: '2026-08-21T11:00:00.000Z',
      });

      assert.equal(r1.sha256, r2.sha256);
      assert.equal(r1.storageKey, r2.storageKey);
      assert.notEqual(r1.artifactId, r2.artifactId);
      assert.notEqual(r1.capturedAt, r2.capturedAt);

      const f1 = await persistence.getArtifactMetadata(art1Id);
      const f2 = await persistence.getArtifactMetadata(art2Id);
      assert.ok(f1);
      assert.ok(f2);
      assert.equal(f1.safeDescription, 'Screenshot A às 10h');
      assert.equal(f2.safeDescription, 'Screenshot B às 11h');
    });

    it('U: Vínculo de Attempt é preservado e consultável', async () => {
      const now = Date.now();
      const artifactId = `art_attempt_${now}` as EvidenceArtifactRefId;
      const attemptId = `att_exec_test_${now}` as AttemptId;

      await service.materializeArtifact(Buffer.from('Attempt evidence payload'), {
        artifactId,
        kind: 'api_response',
        containsSecretMaterial: false,
        attemptId,
      });

      const attempts = await persistence.getAttemptsForArtifact(artifactId);
      assert.deepEqual(attempts, [attemptId]);
    });
  });

  describe('2. Integridade Relacional com 0.85B (Foreign Keys)', () => {
    it('P & Q: ObservationRecord pode referenciar artefato existente, e falha ao referenciar inexistente', async () => {
      const now = Date.now();
      const validArtifactId = `art_fk_valid_${now}` as EvidenceArtifactRefId;

      await service.materializeArtifact(Buffer.from('Valid artifact bytes'), {
        artifactId: validArtifactId,
        kind: 'document',
        containsSecretMaterial: false,
      });

      // 1. Observation com artefato válido -> Sucesso
      const validObsId = `obs_with_art_${now}` as ObservationRecordId;
      const obsRes = await obsAdapter.recordObservation({
        observationId: validObsId,
        subject: { domain: 'd', entityType: 't', entityId: `fk_test_${now}` },
        observedClaim: 'claim_fk',
        rawValue: 10,
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [validArtifactId],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });
      assert.equal(obsRes.record.observationId, validObsId);

      // 2. Observation com artefato inexistente -> Falha por FK
      const invalidObsId = `obs_invalid_art_${now}` as ObservationRecordId;
      await assert.rejects(async () => {
        await obsAdapter.recordObservation({
          observationId: invalidObsId,
          subject: { domain: 'd', entityType: 't', entityId: `fk_test_${now}` },
          observedClaim: 'claim_fk_fail',
          rawValue: 20,
          actor: { kind: 'max', maxVersion: '1.0' },
          sourceRefs: [],
          evidenceRefs: ['art_non_existent_123' as EvidenceArtifactRefId],
          observedAt: '2026-08-21T10:00:00.000Z',
          capturedAt: '2026-08-21T10:00:01.000Z',
        });
      });
    });

    it('R & S: ReviewEvent pode referenciar artefato existente, e falha ao referenciar inexistente', async () => {
      const now = Date.now();
      const validArtifactId = `art_review_fk_${now}` as EvidenceArtifactRefId;

      await service.materializeArtifact(Buffer.from('Review artifact bytes'), {
        artifactId: validArtifactId,
        kind: 'screenshot',
        containsSecretMaterial: false,
      });

      const obsId = `obs_rev_target_${now}` as ObservationRecordId;
      await obsAdapter.recordObservation({
        observationId: obsId,
        subject: { domain: 'd', entityType: 't', entityId: `rev_fk_${now}` },
        observedClaim: 'claim',
        rawValue: 1,
        actor: { kind: 'max', maxVersion: '1.0' },
        sourceRefs: [],
        evidenceRefs: [],
        observedAt: '2026-08-21T10:00:00.000Z',
        capturedAt: '2026-08-21T10:00:01.000Z',
      });

      // 1. Review com artefato existente -> Sucesso
      const validRevId = `rev_fk_ok_${now}` as ReviewEventId;
      const revRes = await obsAdapter.recordNonCanonicalReview({
        reviewId: validRevId,
        actor: { kind: 'human', humanId: 'user_lucas', role: 'auditor' },
        targetObservationIds: [obsId],
        consideredEvidenceIds: [validArtifactId],
        decision: 'corroborated',
        justification: 'Corroborado com artefato válido',
        reviewedAt: '2026-08-21T11:00:00.000Z',
      });
      assert.equal(revRes.reviewId, validRevId);

      // 2. Review com artefato inexistente -> Falha por FK
      const invalidRevId = `rev_fk_fail_${now}` as ReviewEventId;
      await assert.rejects(async () => {
        await obsAdapter.recordNonCanonicalReview({
          reviewId: invalidRevId,
          actor: { kind: 'human', humanId: 'user_lucas', role: 'auditor' },
          targetObservationIds: [obsId],
          consideredEvidenceIds: ['art_missing_review_evidence' as EvidenceArtifactRefId],
          decision: 'corroborated',
          justification: 'FK inválida',
          reviewedAt: '2026-08-21T11:00:00.000Z',
        });
      });
    });

    it('T: ObservationRecord com SourceRef inexistente é rejeitada por FK', async () => {
      const now = Date.now();
      const obsId = `obs_dangling_src_${now}` as ObservationRecordId;

      await assert.rejects(async () => {
        await obsAdapter.recordObservation({
          observationId: obsId,
          subject: { domain: 'd', entityType: 't', entityId: `src_fk_${now}` },
          observedClaim: 'claim',
          rawValue: 1,
          actor: { kind: 'max', maxVersion: '1.0' },
          sourceRefs: ['src_non_existent_dangling' as SourceRefId],
          evidenceRefs: [],
          observedAt: '2026-08-21T10:00:00.000Z',
          capturedAt: '2026-08-21T10:00:01.000Z',
        });
      });
    });
  });

  describe('3. Segurança, Segredos e Sensitivity', () => {
    it('V, W, X: containsSecretMaterial=true é rejeitado e não deixa linha no PostgreSQL nem blob no disco', async () => {
      const now = Date.now();
      const secretArtifactId = `art_secret_${now}` as EvidenceArtifactRefId;
      const secretContent = Buffer.from('API_SECRET_KEY=super_confidential_token_12345');

      await assert.rejects(
        async () => {
          await service.materializeArtifact(secretContent, {
            artifactId: secretArtifactId,
            kind: 'document',
            containsSecretMaterial: true, // Erro imediato!
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof SecretMaterialRejectedError);
          return true;
        }
      );

      // W: Zero metadata row no PostgreSQL
      const meta = await persistence.getArtifactMetadata(secretArtifactId);
      assert.equal(meta, null);

      // X: Zero blob no disco
      const audit = await auditArtifactStore(blobStore, persistence, authorizer);
      const secretKeyFound = audit.findings.find((f) => f.details?.includes(secretArtifactId));
      assert.equal(secretKeyFound, undefined);
    });

    it('Y & Z: Artefato LOCAL_ONLY é salvo no filesystem local controlado', async () => {
      const now = Date.now();
      const localArtifactId = `art_local_only_${now}` as EvidenceArtifactRefId;
      const content = Buffer.from('Internal on-premise sensory metrics');

      const record = await service.materializeArtifact(content, {
        artifactId: localArtifactId,
        kind: 'text_snippet',
        containsSecretMaterial: false,
        sensitivity: 'LOCAL_ONLY',
      });

      assert.equal(record.sensitivity, 'LOCAL_ONLY');

      const readRes = await service.readArtifact(localArtifactId, {
        operation: 'read',
        bypassForTesting: true,
      });

      assert.equal(readRes.metadata.sensitivity, 'LOCAL_ONLY');
      assert.deepEqual(readRes.bytes, content);
    });
  });

  describe('4. Auditoria de Integridade e Detecção de Tamper/Orphan', () => {
    it('AE & 35: Tamper test - alteração manual no disco gera ArtifactIntegrityError na leitura e hash_mismatch na auditoria', async () => {
      const now = Date.now();
      const artifactId = `art_tamper_${now}` as EvidenceArtifactRefId;
      const content = Buffer.from('Original authentic uncorrupted content');

      const record = await service.materializeArtifact(content, {
        artifactId,
        kind: 'document',
        containsSecretMaterial: false,
      });

      // 1. Leitura inicial saudável
      const initialRead = await service.readArtifact(artifactId, {
        operation: 'read',
        bypassForTesting: true,
      });
      assert.deepEqual(initialRead.bytes, content);

      // 2. Corrompe o arquivo físico diretamente no disco
      const filePath = path.join(tempRoot, record.storageKey);
      await fs.writeFile(filePath, Buffer.from('HACKED AND TAMPERED CONTENT!'));

      // 3. Leitura ativa deve falhar com ArtifactIntegrityError
      await assert.rejects(
        async () => {
          await service.readArtifact(artifactId, {
            operation: 'read',
            bypassForTesting: true,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactIntegrityError);
          assert.equal(err.storageKey, record.storageKey);
          return true;
        }
      );

      // 4. Auditoria técnica detecta hash_mismatch
      const audit = await auditArtifactStore(blobStore, persistence, authorizer);
      const finding = audit.findings.find((f) => f.artifactId === artifactId);
      assert.ok(finding);
      assert.ok(finding.type === 'hash_mismatch' || finding.type === 'size_mismatch');

      // Restaura para não poluir outros testes
      await fs.writeFile(filePath, content);
    });

    it('AG & 51: Falha no DB após criação de blob deixa orphan blob detectado pela auditoria', async () => {
      const orphanData = Buffer.from('Orphan blob without PostgreSQL metadata row');
      const putRes = await blobStore.putBlob(orphanData);

      // O blob existe fisicamente no disco mas não foi registrado em nex_evidence_artifacts
      const audit = await auditArtifactStore(blobStore, persistence, authorizer);
      const orphanFinding = audit.findings.find(
        (f) => f.type === 'orphan_blob' && f.storageKey === putRes.storageKey
      );

      assert.ok(orphanFinding);
      assert.equal(orphanFinding.storageKey, putRes.storageKey);
    });

    it('AH: auditArtifactStore é uma operação de inspeção estritamente read-only', async () => {
      const initialRecords = await persistence.listAllArtifactMetadata();
      const initialKeys = await blobStore.listStorageKeys();

      await auditArtifactStore(blobStore, persistence, authorizer);

      const postRecords = await persistence.listAllArtifactMetadata();
      const postKeys = await blobStore.listStorageKeys();

      assert.equal(initialRecords.length, postRecords.length);
      assert.equal(initialKeys.length, postKeys.length);
    });
  });

  describe('5. Backup Estruturado & Restore Criptográfico', () => {
    it('AI a AR: Backup gera manifest versionado com SHA-256 e Restore em novo store recupera tudo', async () => {
      const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nex_evidence_backup_dest_'));
      const restoreRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nex_evidence_restore_live_'));

      try {
        // 1. Executa Backup
        const backupResult = await backupArtifactStore(service, backupDir, authorizer);
        assert.ok(backupResult.artifactsCount >= 1);
        assert.ok(backupResult.manifestSha256);

        // 2. Confirma existência dos arquivos de backup
        const manifestStat = await fs.stat(backupResult.manifestPath);
        assert.ok(manifestStat.isFile());

        // 3. Cria novo blob store limpo para simular restore
        const restoreBlobStore = new LocalFsArtifactBlobStore({ rootDir: restoreRoot });
        const restoreService = new EvidenceArtifactService({
          blobStore: restoreBlobStore,
          persistence,
          authorizer,
        });

        // 4. Executa Restore
        const restoreResult = await restoreArtifactStore(restoreService, backupDir, authorizer);
        assert.ok(restoreResult.restoredCount >= 1);

        // 5. Manifest adulterado é rejeitado
        await fs.writeFile(backupResult.manifestPath, '{"schemaVersion":"1.0","corrupted":true}');
        await assert.rejects(async () => {
          await restoreArtifactStore(restoreService, backupDir, authorizer);
        });
      } finally {
        await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(restoreRoot, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe('6. Proteção Estrutural Append-Only (Triggers no PostgreSQL)', () => {
    it('52: SQL direto UPDATE, DELETE e TRUNCATE em tabelas 0.85C é rejeitado', async () => {
      // 1. UPDATE em nex_evidence_artifacts
      await assert.rejects(
        async () => {
          await pool.query(`UPDATE nex_evidence_artifacts SET safe_description = 'hacked' WHERE 1=1`);
        },
        (err: any) => {
          assert.ok(err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION'));
          return true;
        }
      );

      // 2. DELETE em nex_evidence_artifacts
      await assert.rejects(
        async () => {
          await pool.query(`DELETE FROM nex_evidence_artifacts WHERE 1=1`);
        },
        (err: any) => {
          assert.ok(err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION'));
          return true;
        }
      );

      // 3. TRUNCATE em nex_evidence_artifacts
      await assert.rejects(
        async () => {
          await pool.query(`TRUNCATE nex_evidence_artifacts CASCADE`);
        },
        (err: any) => {
          assert.ok(err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION'));
          return true;
        }
      );

      // 4. UPDATE em nex_source_refs
      await assert.rejects(
        async () => {
          await pool.query(`UPDATE nex_source_refs SET name = 'hacked' WHERE 1=1`);
        },
        (err: any) => {
          assert.ok(err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION'));
          return true;
        }
      );

      // 5. DELETE em nex_evidence_artifact_attempt_links
      await assert.rejects(
        async () => {
          await pool.query(`DELETE FROM nex_evidence_artifact_attempt_links WHERE 1=1`);
        },
        (err: any) => {
          assert.ok(err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION'));
          return true;
        }
      );
    });
  });
});
