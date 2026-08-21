import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
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
import { EvidenceArtifactService } from '../service';
import { auditArtifactStore } from '../integrity';
import { backupArtifactStore, restoreArtifactStore } from '../backup';
import {
  ArtifactIdentityConflictError,
  ArtifactIntegrityError,
  ArtifactNotFoundError,
  SecretMaterialRejectedError,
  ArtifactAccessDeniedError,
  ArtifactInvariantViolationError,
} from '../errors';
import { PgObservationPersistenceAdapter } from '../../persistence/postgres';
import { AllowAllTestArtifactAuthorizer } from './authorizer.test';
import type { ArtifactAccessContext } from '../contracts';
import { buildStorageKeyFromSha256, validateEvidenceBackupManifest } from '../validators';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

const testAuthContext: ArtifactAccessContext = {
  operation: 'write',
  actor: { kind: 'system', component: 'integration_test_harness' },
};

const testReadContext: ArtifactAccessContext = {
  operation: 'read',
  actor: { kind: 'system', component: 'integration_test_harness' },
};

const testBackupContext: ArtifactAccessContext = {
  operation: 'backup',
  actor: { kind: 'system', component: 'integration_test_harness' },
};

const testRestoreContext: ArtifactAccessContext = {
  operation: 'restore',
  actor: { kind: 'system', component: 'integration_test_harness' },
};

const testAuditContext: ArtifactAccessContext = {
  operation: 'integrity_inspect',
  actor: { kind: 'system', component: 'integration_test_harness' },
};

describe('Escopo 0.85C · Evidence Artifact Store & Integridade (Integração PostgreSQL & Filesystem)', { skip: !databaseUrl }, () => {
  let pool: pg.Pool;
  let tempRoot: string;
  let blobStore: LocalFsArtifactBlobStore;
  let persistence: PgEvidenceArtifactPersistenceAdapter;
  let testAuthorizer: AllowAllTestArtifactAuthorizer;
  let service: EvidenceArtifactService;
  let obsAdapter: PgObservationPersistenceAdapter;

  before(async () => {
    if (!databaseUrl) return;
    pool = new Pool({ connectionString: databaseUrl });
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nex_evidence_integration_'));
    blobStore = new LocalFsArtifactBlobStore({ rootDir: tempRoot });
    persistence = new PgEvidenceArtifactPersistenceAdapter(pool);
    testAuthorizer = new AllowAllTestArtifactAuthorizer();
    service = new EvidenceArtifactService({
      blobStore,
      persistence,
      authorizer: testAuthorizer,
    });
    obsAdapter = new PgObservationPersistenceAdapter(pool);

    // Inicializa blob físico da fixture compatível de 0.85B
    await blobStore.putBlob(Buffer.alloc(0), {
      expectedSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
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
    it('K: SourceRef round-trip com persistência PostgreSQL e contexto ACL obrigatório', async () => {
      const now = Date.now();
      const sourceId = `src_test_${now}` as SourceRefId;

      const source = await service.recordSourceRef(
        {
          sourceId,
          kind: 'url',
          name: 'Portal Fornecedor Oficial',
          locationOrUri: 'https://fornecedor.exemplo.com.br/produtos',
          safeMetadata: { provider: 'external_catalog', httpStatus: 200 },
          createdAt: '2026-08-21T15:00:00.000Z',
        },
        testAuthContext
      );

      assert.equal(source.sourceId, sourceId);
      assert.equal(source.kind, 'url');

      const fetched = await service.getSourceRef(sourceId, testReadContext);
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

      const record = await service.materializeArtifact(
        content,
        {
          artifactId,
          kind: 'screenshot',
          mimeType: 'image/png',
          safeDescription: 'Captura da tela de preços do fornecedor',
          containsSecretMaterial: false,
          sensitivity: 'NORMAL',
          capturedAt: '2026-08-21T15:30:00.000Z',
        },
        testAuthContext
      );

      assert.equal(record.artifactId, artifactId);
      assert.equal(record.kind, 'screenshot');
      assert.equal(record.mimeType, 'image/png');
      assert.equal(record.byteSize, content.length);
      assert.equal(record.containsSecretMaterial, false);
      assert.equal(record.storageKey, buildStorageKeyFromSha256(record.sha256));

      const readResult = await service.readArtifact(artifactId, testReadContext);
      assert.equal(readResult.metadata.artifactId, artifactId);
      assert.deepEqual(readResult.bytes, content);
    });

    it('M: Mesmo artifactId com toda metadata idêntica é estritamente idempotente', async () => {
      const now = Date.now();
      const artifactId = `art_idem_${now}` as EvidenceArtifactRefId;
      const content = Buffer.from('Idempotent artifact test bytes');

      const first = await service.materializeArtifact(
        content,
        {
          artifactId,
          kind: 'document',
          mimeType: 'application/pdf',
          containsSecretMaterial: false,
          capturedAt: '2026-08-21T15:30:00.000Z',
        },
        testAuthContext
      );

      const second = await service.materializeArtifact(
        content,
        {
          artifactId,
          kind: 'document',
          mimeType: 'application/pdf',
          containsSecretMaterial: false,
          capturedAt: '2026-08-21T15:30:00.000Z',
        },
        testAuthContext
      );

      assert.equal(first.artifactId, second.artifactId);
      assert.equal(first.sha256, second.sha256);
    });

    it('N: Mesmo artifactId com qualquer metadata divergente gera ArtifactIdentityConflictError', async () => {
      const now = Date.now();
      const artifactId = `art_conflict_${now}` as EvidenceArtifactRefId;

      await service.materializeArtifact(
        Buffer.from('Initial Content'),
        {
          artifactId,
          kind: 'document',
          containsSecretMaterial: false,
          safeDescription: 'Description V1',
        },
        testAuthContext
      );

      // Tenta gravar mesmo ID com safeDescription divergente
      await assert.rejects(
        async () => {
          await service.materializeArtifact(
            Buffer.from('Initial Content'),
            {
              artifactId,
              kind: 'document',
              containsSecretMaterial: false,
              safeDescription: 'Description V2 Divergent',
            },
            testAuthContext
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactIdentityConflictError);
          assert.equal(err.artifactId, artifactId);
          return true;
        }
      );
    });

    it('O: Mesmo hash com artifactIds diferentes produz dois registros PostgreSQL independentes compartilhando blob físico', async () => {
      const now = Date.now();
      const sharedContent = Buffer.from('Shared bytes captured at different times 2026');
      const art1Id = `art_shared_1_${now}` as EvidenceArtifactRefId;
      const art2Id = `art_shared_2_${now}` as EvidenceArtifactRefId;

      const r1 = await service.materializeArtifact(
        sharedContent,
        {
          artifactId: art1Id,
          kind: 'screenshot',
          safeDescription: 'Screenshot A às 10h',
          containsSecretMaterial: false,
          capturedAt: '2026-08-21T10:00:00.000Z',
        },
        testAuthContext
      );

      const r2 = await service.materializeArtifact(
        sharedContent,
        {
          artifactId: art2Id,
          kind: 'screenshot',
          safeDescription: 'Screenshot B às 11h',
          containsSecretMaterial: false,
          capturedAt: '2026-08-21T11:00:00.000Z',
        },
        testAuthContext
      );

      assert.equal(r1.sha256, r2.sha256);
      assert.equal(r1.storageKey, r2.storageKey);
      assert.notEqual(r1.artifactId, r2.artifactId);
      assert.notEqual(r1.capturedAt, r2.capturedAt);

      const f1 = await service.getArtifactMetadata(art1Id, testReadContext);
      const f2 = await service.getArtifactMetadata(art2Id, testReadContext);
      assert.ok(f1);
      assert.ok(f2);
      assert.equal(f1.safeDescription, 'Screenshot A às 10h');
      assert.equal(f2.safeDescription, 'Screenshot B às 11h');
    });

    it('U: Vínculo de Attempt é preservado e consultável', async () => {
      const now = Date.now();
      const artifactId = `art_attempt_${now}` as EvidenceArtifactRefId;
      const attemptId = `att_exec_test_${now}` as AttemptId;

      await service.materializeArtifact(
        Buffer.from('Attempt evidence payload'),
        {
          artifactId,
          kind: 'api_response',
          containsSecretMaterial: false,
          attemptId,
        },
        testAuthContext
      );

      const attempts = await persistence.getAttemptsForArtifact(artifactId);
      assert.deepEqual(attempts, [attemptId]);
    });
  });

  describe('2. Sanitização de Secret Keys em safeMetadata e URLs', () => {
    it('Rejeita safeMetadata que contenha chave sensível como token/password/secret recursivamente', async () => {
      const now = Date.now();

      await assert.rejects(
        async () => {
          await service.recordSourceRef(
            {
              sourceId: `src_secret_meta_${now}` as SourceRefId,
              kind: 'api_endpoint',
              name: 'Secret Source',
              safeMetadata: { nested: { access_token: 'secret123' } },
              createdAt: '2026-08-21T10:00:00.000Z',
            },
            testAuthContext
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactInvariantViolationError);
          assert.equal(err.violationType, 'SAFE_METADATA_SECRET_KEY_FORBIDDEN');
          return true;
        }
      );
    });

    it('Rejeita locationOrUri com basic auth credentials ou query param de segredo', async () => {
      const now = Date.now();

      await assert.rejects(
        async () => {
          await service.recordSourceRef(
            {
              sourceId: `src_uri_secret_${now}` as SourceRefId,
              kind: 'url',
              name: 'Bad URL',
              locationOrUri: 'https://admin:pass123@exemplo.com/api',
              createdAt: '2026-08-21T10:00:00.000Z',
            },
            testAuthContext
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactInvariantViolationError);
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await service.recordSourceRef(
            {
              sourceId: `src_uri_query_${now}` as SourceRefId,
              kind: 'url',
              name: 'Bad URL Query',
              locationOrUri: 'https://exemplo.com/api?api_key=12345',
              createdAt: '2026-08-21T10:00:00.000Z',
            },
            testAuthContext
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactInvariantViolationError);
          return true;
        }
      );
    });

    it('Rejeita fragmentos de URI que contenham parâmetros de segredo estruturados e aceita fragmentos inocentes', async () => {
      const now = Date.now();

      // Fragmentos Proibidos
      const badFragments = [
        'https://exemplo.com/#token=secret123',
        'https://exemplo.com/#access_token=secret123',
        'https://exemplo.com/#api_key=secret123',
        'https://exemplo.com/#authorization=Bearer_secret',
        'https://exemplo.com/#foo=1&cookie=secret123',
        'https://exemplo.com/#section?token=secret123',
      ];

      for (let i = 0; i < badFragments.length; i++) {
        await assert.rejects(
          async () => {
            await service.recordSourceRef(
              {
                sourceId: `src_bad_frag_${now}_${i}` as SourceRefId,
                kind: 'url',
                name: 'Bad Frag',
                locationOrUri: badFragments[i],
                createdAt: '2026-08-21T10:00:00.000Z',
              },
              testAuthContext
            );
          },
          (err: unknown) => {
            assert.ok(err instanceof ArtifactInvariantViolationError);
            assert.equal(err.violationType, 'LOCATION_URI_SECRET_FRAGMENT_FORBIDDEN');
            return true;
          }
        );
      }

      // Fragmentos Inocentes Permitidos
      const goodFragments = [
        'https://exemplo.com/#overview',
        'https://exemplo.com/#tokenization',
        'https://exemplo.com/#cookie-policy',
      ];

      for (let i = 0; i < goodFragments.length; i++) {
        const okSource = await service.recordSourceRef(
          {
            sourceId: `src_good_frag_${now}_${i}` as SourceRefId,
            kind: 'url',
            name: 'Good Frag',
            locationOrUri: goodFragments[i],
            createdAt: '2026-08-21T10:00:00.000Z',
          },
          testAuthContext
        );
        assert.ok(okSource);
      }
    });
  });

  describe('3. Concorrência e Idempotência de Metadados', () => {
    it('20 gravações concorrentes de mesmo artifactId e mesma metadata convergem sem erro 23505 cru', async () => {
      const now = Date.now();
      const artifactId = `art_concurrent_idem_${now}` as EvidenceArtifactRefId;
      const content = Buffer.from('Idempotent concurrent payload');

      const promises = Array.from({ length: 20 }, () =>
        service.materializeArtifact(
          content,
          {
            artifactId,
            kind: 'document',
            containsSecretMaterial: false,
            capturedAt: '2026-08-21T12:00:00.000Z',
          },
          testAuthContext
        )
      );

      const results = await Promise.all(promises);
      for (const r of results) {
        assert.equal(r.artifactId, artifactId);
      }
    });

    it('20 gravações concorrentes de mesmo artifactId com metadatas divergentes: 1 vence e 19 recebem ArtifactIdentityConflictError', async () => {
      const now = Date.now();
      const artifactId = `art_concurrent_conflict_${now}` as EvidenceArtifactRefId;

      const promises = Array.from({ length: 20 }, (_, i) =>
        service.materializeArtifact(
          Buffer.from(`Content variation ${i}`),
          {
            artifactId,
            kind: 'document',
            containsSecretMaterial: false,
            safeDescription: `Desc ${i}`,
            capturedAt: `2026-08-21T12:00:${String(i).padStart(2, '0')}.000Z`,
          },
          testAuthContext
        )
      );

      const outcomes = await Promise.allSettled(promises);
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o) => o.status === 'rejected');

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 19);

      for (const r of rejected) {
        if (r.status === 'rejected') {
          assert.ok(r.reason instanceof ArtifactIdentityConflictError);
        }
      }
    });
  });

  describe('4. Integridade Relacional com 0.85B (Foreign Keys)', () => {
    it('P & Q: ObservationRecord pode referenciar artefato existente e falha com inexistente', async () => {
      const now = Date.now();
      const validArtifactId = `art_fk_valid_${now}` as EvidenceArtifactRefId;

      await service.materializeArtifact(
        Buffer.from('Valid artifact bytes for observation FK'),
        {
          artifactId: validArtifactId,
          kind: 'document',
          containsSecretMaterial: false,
        },
        testAuthContext
      );

      // Observation com artefato válido
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

      // Observation com artefato inexistente -> Falha por FK
      await assert.rejects(async () => {
        await obsAdapter.recordObservation({
          observationId: `obs_fail_fk_${now}` as ObservationRecordId,
          subject: { domain: 'd', entityType: 't', entityId: `fk_test_${now}` },
          observedClaim: 'claim_fail',
          rawValue: 20,
          actor: { kind: 'max', maxVersion: '1.0' },
          sourceRefs: [],
          evidenceRefs: ['art_missing_123' as EvidenceArtifactRefId],
          observedAt: '2026-08-21T10:00:00.000Z',
          capturedAt: '2026-08-21T10:00:01.000Z',
        });
      });
    });

    it('R & S: ReviewEvent pode referenciar artefato existente e falha com inexistente', async () => {
      const now = Date.now();
      const validArtifactId = `art_review_fk_${now}` as EvidenceArtifactRefId;

      await service.materializeArtifact(
        Buffer.from('Review artifact content'),
        {
          artifactId: validArtifactId,
          kind: 'screenshot',
          containsSecretMaterial: false,
        },
        testAuthContext
      );

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

      await assert.rejects(async () => {
        await obsAdapter.recordNonCanonicalReview({
          reviewId: `rev_fk_fail_${now}` as ReviewEventId,
          actor: { kind: 'human', humanId: 'user_lucas', role: 'auditor' },
          targetObservationIds: [obsId],
          consideredEvidenceIds: ['art_missing_rev' as EvidenceArtifactRefId],
          decision: 'corroborated',
          justification: 'FK inválida',
          reviewedAt: '2026-08-21T11:00:00.000Z',
        });
      });
    });
  });

  describe('5. Auditoria de Integridade e Detecção de Tamper/Orphan', () => {
    it('AE & 35: Tamper test - alteração manual no disco gera ArtifactIntegrityError na leitura e mismatch na auditoria', async () => {
      const now = Date.now();
      const artifactId = `art_tamper_${now}` as EvidenceArtifactRefId;
      const content = Buffer.from('Original authentic uncorrupted content');

      const record = await service.materializeArtifact(
        content,
        {
          artifactId,
          kind: 'document',
          containsSecretMaterial: false,
        },
        testAuthContext
      );

      const filePath = path.join(tempRoot, ...record.storageKey.split('/'));
      await fs.writeFile(filePath, Buffer.from('HACKED CONTENT!'));

      await assert.rejects(
        async () => {
          await service.readArtifact(artifactId, testReadContext);
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactIntegrityError);
          return true;
        }
      );

      const audit = await auditArtifactStore(blobStore, persistence, testAuthorizer, testAuditContext);
      const finding = audit.findings.find((f) => f.artifactId === artifactId);
      assert.ok(finding);
      assert.ok(finding.type === 'hash_mismatch' || finding.type === 'size_mismatch');

      await fs.writeFile(filePath, content);
    });

    it('AG & 51: Falha no DB após criação de blob deixa orphan blob detectado pela auditoria', async () => {
      const orphanData = Buffer.from('Orphan blob without PostgreSQL metadata row');
      const putRes = await blobStore.putBlob(orphanData);

      const audit = await auditArtifactStore(blobStore, persistence, testAuthorizer, testAuditContext);
      const orphanFinding = audit.findings.find(
        (f) => f.type === 'orphan_blob' && f.storageKey === putRes.storageKey
      );

      assert.ok(orphanFinding);
      assert.equal(orphanFinding.storageKey, putRes.storageKey);
    });
  });

  describe('6. Backup Estruturado & Restore Criptográfico Atômico', () => {
    it('BK-1: Se qualquer artefato registrado estiver com blob ausente, o backup inteiro falha', async () => {
      const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nex_backup_missing_test_'));
      const now = Date.now();
      const missingArtId = `art_missing_for_backup_${now}` as EvidenceArtifactRefId;

      const dummyPayload = Buffer.from(`DUMMY_FOR_BK1_MISSING_BLOB_${now}`);
      const expectedSha = createHash('sha256').update(dummyPayload).digest('hex');
      const canonicalKey = buildStorageKeyFromSha256(expectedSha);

      // Grava metadados direto no PostgreSQL sem criar o blob no disco
      await pool.query(
        `INSERT INTO nex_evidence_artifacts (
          artifact_id, kind, sha256, byte_size, mime_type, storage_backend, storage_key,
          captured_at, sensitivity, contains_secret_material, redaction_applied, retention_class
        ) VALUES (
          $1, 'document', $2, $3,
          'application/pdf', 'local_fs', $4,
          '2026-08-21T00:00:00.000Z', 'NORMAL', false, false, 'durable_evidence'
        )`,
        [missingArtId, expectedSha, dummyPayload.length, canonicalKey]
      );

      await assert.rejects(
        async () => {
          await backupArtifactStore(service, backupDir, testAuthorizer, testBackupContext);
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactNotFoundError || err instanceof ArtifactIntegrityError);
          return true;
        }
      );

      // Prova que nenhum manifest final foi publicado
      const manifestExists = await fs
        .stat(path.join(backupDir, 'nex-evidence-backup-v1.json'))
        .then(() => true)
        .catch(() => false);
      assert.equal(manifestExists, false);

      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});

      // Restaura a consistência física do store gravando o blob legítimo
      await blobStore.putBlob(dummyPayload, { expectedSha256: expectedSha });
    });

    it('BK-4 & RS-1 a RS-10: Backup de store saudável gera manifest íntegro e Restore atômico recupera tudo', async () => {
      const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nex_backup_success_'));
      const restoreRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nex_restore_root_'));

      try {
        // Grava um artefato novo e fonte
        const artId = `art_bk_test_${Date.now()}` as EvidenceArtifactRefId;
        await service.materializeArtifact(
          Buffer.from('Durable evidence for backup test 2026'),
          {
            artifactId: artId,
            kind: 'document',
            containsSecretMaterial: false,
          },
          testAuthContext
        );

        // Backup
        const backupRes = await backupArtifactStore(service, backupDir, testAuthorizer, testBackupContext);
        assert.ok(backupRes.artifactsCount >= 1);
        assert.ok(backupRes.manifestSha256);

        // Restore em novo store limpo
        const restoreBlobStore = new LocalFsArtifactBlobStore({ rootDir: restoreRoot });
        const restoreService = new EvidenceArtifactService({
          blobStore: restoreBlobStore,
          persistence,
          authorizer: testAuthorizer,
        });

        const restoreRes = await restoreArtifactStore(restoreService, backupDir, testAuthorizer, testRestoreContext);
        assert.ok(restoreRes.restoredCount >= 1);

        // Prova que blob foi instalado no novo store
        const hasInRestore = await restoreBlobStore.hasBlob(buildStorageKeyFromSha256(createHash('sha256').update(Buffer.from('Durable evidence for backup test 2026')).digest('hex')));
        assert.equal(hasInRestore, true);
      } finally {
        await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(restoreRoot, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('RS-11: AttemptLink com linkedAt divergente no restore gera ArtifactIdentityConflictError e aborta transação', async () => {
      const now = Date.now();
      const artId = `art_link_conflict_${now}` as EvidenceArtifactRefId;
      const attId = `att_link_conflict_${now}` as AttemptId;

      const materialized = await service.materializeArtifact(
        Buffer.from('Attempt Link conflict payload'),
        {
          artifactId: artId,
          kind: 'document',
          containsSecretMaterial: false,
          attemptId: attId,
        },
        testAuthContext
      );

      // Manifest contendo o mesmo artifact e mesmo link mas com linkedAt divergente
      const manifestPayload = {
        schemaVersion: '1.0',
        createdAt: '2026-08-21T12:00:00.000Z',
        artifacts: [materialized],
        sourceRefs: [],
        attemptLinks: [
          {
            artifactId: artId,
            attemptId: attId,
            linkedAt: '2026-08-21T00:00:00.000Z', // Divergente do registrado
          },
        ],
      };

      await assert.rejects(
        async () => {
          await persistence.restoreManifestMetadataAtomically(manifestPayload as any);
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactIdentityConflictError);
          assert.ok(err.message.includes('divergent linkedAt'));
          return true;
        }
      );
    });

    it('RS-12 & RS-13: Manifest com duplicatas ou dangling references é rejeitado pelo validador', () => {
      const now = Date.now();
      const artId = `art_manifest_dup_${now}` as EvidenceArtifactRefId;
      const srcId = `src_manifest_dup_${now}` as SourceRefId;

      const dummyArt = {
        artifactId: artId,
        kind: 'document',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        byteSize: 0,
        mimeType: 'application/pdf',
        storageBackend: 'local_fs',
        storageKey: 'sha256/e3/b0/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        capturedAt: '2026-08-21T12:00:00.000Z',
        sensitivity: 'NORMAL',
        containsSecretMaterial: false,
        redactionApplied: false,
        retentionClass: 'durable_evidence',
      };

      const dummySrc = {
        sourceId: srcId,
        kind: 'url',
        name: 'Dummy Source',
        createdAt: '2026-08-21T12:00:00.000Z',
      };

      // 1. Duplicate artifactId
      assert.throws(
        () => {
          validateEvidenceBackupManifest({
            schemaVersion: '1.0',
            createdAt: '2026-08-21T12:00:00.000Z',
            artifacts: [dummyArt, dummyArt] as any,
            sourceRefs: [],
            attemptLinks: [],
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactInvariantViolationError);
          assert.equal(err.violationType, 'MANIFEST_DUPLICATE_ARTIFACT_ID');
          return true;
        }
      );

      // 2. Duplicate sourceId
      assert.throws(
        () => {
          validateEvidenceBackupManifest({
            schemaVersion: '1.0',
            createdAt: '2026-08-21T12:00:00.000Z',
            artifacts: [],
            sourceRefs: [dummySrc, dummySrc] as any,
            attemptLinks: [],
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactInvariantViolationError);
          assert.equal(err.violationType, 'MANIFEST_DUPLICATE_SOURCE_ID');
          return true;
        }
      );

      // 3. Dangling sourceRefId
      assert.throws(
        () => {
          validateEvidenceBackupManifest({
            schemaVersion: '1.0',
            createdAt: '2026-08-21T12:00:00.000Z',
            artifacts: [{ ...dummyArt, sourceRefId: 'non_existent_src' }] as any,
            sourceRefs: [],
            attemptLinks: [],
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactInvariantViolationError);
          assert.equal(err.violationType, 'MANIFEST_DANGLING_SOURCE_REF');
          return true;
        }
      );

      // 4. Dangling AttemptLink.artifactId
      assert.throws(
        () => {
          validateEvidenceBackupManifest({
            schemaVersion: '1.0',
            createdAt: '2026-08-21T12:00:00.000Z',
            artifacts: [],
            sourceRefs: [],
            attemptLinks: [
              {
                artifactId: 'non_existent_art',
                attemptId: 'att_1',
                linkedAt: '2026-08-21T12:00:00.000Z',
              },
            ] as any,
          });
        },
        (err: unknown) => {
          assert.ok(err instanceof ArtifactInvariantViolationError);
          assert.equal(err.violationType, 'MANIFEST_DANGLING_ATTEMPT_LINK_ARTIFACT');
          return true;
        }
      );
    });
  });

  describe('7. SQL Checks Diretos no PostgreSQL', () => {
    it('53: CHECK constraints rejeitam storage_backend inválido, storage_key incompatível e segredos', async () => {
      // 1. storage_backend != local_fs
      await assert.rejects(async () => {
        await pool.query(`
          INSERT INTO nex_evidence_artifacts (
            artifact_id, kind, sha256, byte_size, mime_type, storage_backend, storage_key,
            captured_at, sensitivity, contains_secret_material, redaction_applied, retention_class
          ) VALUES (
            'art_bad_backend', 'document', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 0,
            'application/pdf', 's3_bucket', 'sha256/e3/b0/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            '2026-08-21T00:00:00.000Z', 'NORMAL', false, false, 'durable_evidence'
          )
        `);
      });

      // 2. storage_key com hash incompatível com a coluna sha256
      await assert.rejects(async () => {
        await pool.query(`
          INSERT INTO nex_evidence_artifacts (
            artifact_id, kind, sha256, byte_size, mime_type, storage_backend, storage_key,
            captured_at, sensitivity, contains_secret_material, redaction_applied, retention_class
          ) VALUES (
            'art_bad_key', 'document', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 0,
            'application/pdf', 'local_fs', 'sha256/00/00/0000000000000000000000000000000000000000000000000000000000000000',
            '2026-08-21T00:00:00.000Z', 'NORMAL', false, false, 'durable_evidence'
          )
        `);
      });

      // 3. contains_secret_material = true é rejeitado por CHECK
      await assert.rejects(async () => {
        await pool.query(`
          INSERT INTO nex_evidence_artifacts (
            artifact_id, kind, sha256, byte_size, mime_type, storage_backend, storage_key,
            captured_at, sensitivity, contains_secret_material, redaction_applied, retention_class
          ) VALUES (
            'art_secret_sql', 'document', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 0,
            'application/pdf', 'local_fs', 'sha256/e3/b0/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            '2026-08-21T00:00:00.000Z', 'NORMAL', true, false, 'durable_evidence'
          )
        `);
      });
    });
  });
});
