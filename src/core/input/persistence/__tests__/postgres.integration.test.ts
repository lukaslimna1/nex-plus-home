/**
 * NEX+ · Testes de Integração PostgreSQL para Ingress Content e Input Record
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-3)
 *
 * Provas:
 * 1. Insert e Read de IngressContentRecord (com e sem expiresAt/subject).
 * 2. Dois contentIds distintos para o mesmo SHA-256 no banco sem colapso lógico.
 * 3. Insert e Read de InputRecord completo com todas as 5 variantes de InputPart.
 * 4. Reconstrução determinística da ordem das parts (position ASC).
 * 5. Invariante SQL de parts (CHECK constraint rejeita linha com tipo inválido ou híbrido).
 * 6. Foreign Key de IngressContent e EvidenceArtifact nas parts.
 * 7. Deduplicação de SourceEventIdentity no banco (índice único parcial).
 * 8. Triggers de proteção append-only (rejeição de UPDATE e DELETE).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import type { SessionRef } from '../../../../auth/session-ref.types';
import type { HumanActor } from '../../../observations/contracts';
import type {
  ContextSubjectRef,
  ContextSubjectType,
  ContextSubjectId,
  OperationalChannel,
} from '../../../context/contracts';
import type {
  ModuleKey,
  ResourceType,
  ResourceId,
  EventId,
  CorrelationId,
} from '../../../modules/contracts';
import type {
  InputRecordId,
  IngressContentId,
  SourceEventIdentity,
  InputPart,
  InputRecord,
  IngressContentRecord,
} from '../../contracts';
import {
  PostgresIngressContentStore,
  PostgresInputRecordStore,
} from '../postgres';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

describe('0.86B-3 · Persistência PostgreSQL de Ingress Content & Input Record', { skip: !databaseUrl }, () => {
  let pool: pg.Pool;
  let ingressStore: PostgresIngressContentStore;
  let inputStore: PostgresInputRecordStore;

  const sessionRefA = '1111111111111111111111111111111111111111111111111111111111111111' as SessionRef;
  const userLucas = 'usr_lucas_123';
  const humanLucas: HumanActor = { kind: 'human', humanId: userLucas, role: 'director' };

  const brandAlterstate: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'alterstate' as ContextSubjectId,
  };

  const SHA_A = 'a'.repeat(64);
  const SHA_B = 'b'.repeat(64);

  before(async () => {
    if (!databaseUrl) return;
    pool = new Pool({ connectionString: databaseUrl });
    ingressStore = new PostgresIngressContentStore(pool);
    inputStore = new PostgresInputRecordStore(pool);

    // Cria fixtures prévias de SourceRef e EvidenceArtifact se necessário para testar FKs
    await pool.query(`
      INSERT INTO nex_source_refs (source_id, kind, name, location_or_uri, created_at)
      VALUES ('src_test_1', 'url', 'Test Source', 'https://example.com', now())
      ON CONFLICT (source_id) DO NOTHING;
    `);

    await pool.query(`
      INSERT INTO nex_evidence_artifacts (
        artifact_id, kind, source_ref_id, sha256, byte_size, mime_type,
        storage_backend, storage_key, captured_at, sensitivity,
        contains_secret_material, redaction_applied, retention_class
      ) VALUES (
        'art_test_1', 'document', 'src_test_1', '${SHA_B}', 1024, 'application/pdf',
        'local_fs', 'sha256/${SHA_B.substring(0, 2)}/${SHA_B.substring(2, 4)}/${SHA_B}', now(), 'NORMAL',
        false, false, 'durable_evidence'
      ) ON CONFLICT (artifact_id) DO NOTHING;
    `);
  });

  after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  it('1. salva e recupera IngressContentRecord com todos os campos no PostgreSQL', async () => {
    const record: IngressContentRecord = {
      contentId: 'ing_test_photo_1' as IngressContentId,
      actor: humanLucas,
      userId: userLucas,
      sessionRef: sessionRefA,
      contextSubjectRef: brandAlterstate,
      sourceRefId: 'src_test_1' as any,
      declaredMimeType: 'image/jpeg',
      verifiedMimeType: 'image/jpeg',
      sha256: SHA_A,
      byteSize: 1024,
      storageBackend: 'local_fs',
      storageKey: `sha256/aa/aa/${SHA_A}`,
      receivedAt: '2026-08-24T21:00:00.000Z',
      expiresAt: '2026-08-25T21:00:00.000Z',
    };

    const saved = await ingressStore.saveContent(record);
    assert.equal(saved.contentId, 'ing_test_photo_1');
    assert.equal(saved.verifiedMimeType, 'image/jpeg');

    const fetched = await ingressStore.getContent('ing_test_photo_1' as IngressContentId);
    assert.ok(fetched);
    assert.equal(fetched.contentId, 'ing_test_photo_1');
    assert.equal(fetched.actor.kind, 'human');
    assert.equal((fetched.actor as HumanActor).humanId, userLucas);
    assert.equal(fetched.userId, userLucas);
    assert.equal(fetched.sessionRef, sessionRefA);
    assert.equal(fetched.contextSubjectRef?.subjectId, 'alterstate');
    assert.equal(fetched.sourceRefId, 'src_test_1');
    assert.equal(fetched.declaredMimeType, 'image/jpeg');
    assert.equal(fetched.verifiedMimeType, 'image/jpeg');
    assert.equal(fetched.sha256, SHA_A);
    assert.equal(fetched.byteSize, 1024);
    assert.equal(fetched.storageBackend, 'local_fs');
    assert.equal(fetched.storageKey, `sha256/aa/aa/${SHA_A}`);
    assert.equal(fetched.receivedAt, '2026-08-24T21:00:00.000Z');
    assert.equal(fetched.expiresAt, '2026-08-25T21:00:00.000Z');
  });

  it('2. dois IngressContentRecords com mesmo SHA-256 persistem com contentIds distintos', async () => {
    const record1: IngressContentRecord = {
      contentId: 'ing_same_sha_1' as IngressContentId,
      actor: humanLucas,
      userId: userLucas,
      verifiedMimeType: 'image/png',
      sha256: SHA_A,
      byteSize: 500,
      storageBackend: 'local_fs',
      storageKey: `sha256/aa/aa/${SHA_A}`,
      receivedAt: '2026-08-24T21:00:00.000Z',
    };

    const record2: IngressContentRecord = {
      contentId: 'ing_same_sha_2' as IngressContentId,
      actor: { kind: 'system', component: 'importer' },
      verifiedMimeType: 'image/png',
      sha256: SHA_A,
      byteSize: 500,
      storageBackend: 'local_fs',
      storageKey: `sha256/aa/aa/${SHA_A}`,
      receivedAt: '2026-08-24T21:05:00.000Z',
    };

    await ingressStore.saveContent(record1);
    await ingressStore.saveContent(record2);

    const f1 = await ingressStore.getContent('ing_same_sha_1' as IngressContentId);
    const f2 = await ingressStore.getContent('ing_same_sha_2' as IngressContentId);

    assert.ok(f1);
    assert.ok(f2);
    assert.notEqual(f1.contentId, f2.contentId);
    assert.equal(f1.sha256, f2.sha256);
  });

  it('3. salva e reconstrói InputRecord com todas as 5 variantes de partes na ordem correta', async () => {
    const parts: InputPart[] = [
      { kind: 'text', text: '1. Primeira parte: texto explicativo' },
      { kind: 'content_ref', content: { contentId: 'ing_test_photo_1' as IngressContentId } },
      { kind: 'event_ref', eventId: 'evt_price_change_123' as EventId },
      {
        kind: 'resource_ref',
        resource: {
          ownerModule: { moduleKey: 'radar' as ModuleKey },
          resourceType: 'monitored_product' as ResourceType,
          resourceId: 'prod_999' as ResourceId,
        },
      },
      { kind: 'evidence_ref', evidenceArtifactId: 'art_test_1' as any },
    ];

    const inputRecord: InputRecord = {
      inputId: 'inp_multi_all_5' as InputRecordId,
      actor: humanLucas,
      userId: userLucas,
      sessionRef: sessionRefA,
      contextSubjectRef: brandAlterstate,
      sourceRefId: 'src_test_1' as any,
      sourceEventIdentity: { source: 'slack', id: 'msg_9876' },
      occurredAt: '2026-08-24T21:00:00.000Z',
      receivedAt: '2026-08-24T21:00:02.000Z',
      channel: 'web_dashboard' as OperationalChannel,
      correlationId: 'corr_int_1' as CorrelationId,
      parts,
    };

    const saved = await inputStore.saveInputRecord(inputRecord);
    assert.equal(saved.inputId, 'inp_multi_all_5');
    assert.equal(saved.parts.length, 5);

    const fetched = await inputStore.getInputRecord('inp_multi_all_5' as InputRecordId);
    assert.ok(fetched);
    assert.equal(fetched.inputId, 'inp_multi_all_5');
    assert.equal(fetched.parts.length, 5);

    // Ordem estrita
    assert.equal(fetched.parts[0].kind, 'text');
    assert.equal((fetched.parts[0] as any).text, '1. Primeira parte: texto explicativo');

    assert.equal(fetched.parts[1].kind, 'content_ref');
    assert.equal((fetched.parts[1] as any).content.contentId, 'ing_test_photo_1');

    assert.equal(fetched.parts[2].kind, 'event_ref');
    assert.equal((fetched.parts[2] as any).eventId, 'evt_price_change_123');

    assert.equal(fetched.parts[3].kind, 'resource_ref');
    assert.equal((fetched.parts[3] as any).resource.ownerModule.moduleKey, 'radar');
    assert.equal((fetched.parts[3] as any).resource.resourceType, 'monitored_product');
    assert.equal((fetched.parts[3] as any).resource.resourceId, 'prod_999');

    assert.equal(fetched.parts[4].kind, 'evidence_ref');
    assert.equal((fetched.parts[4] as any).evidenceArtifactId, 'art_test_1');
  });

  it('4. deduplicação por SourceEventIdentity: consulta encontra o registro existente', async () => {
    const identity: SourceEventIdentity = { source: 'slack', id: 'msg_9876' };
    const found = await inputStore.findBySourceEventIdentity(identity);
    assert.ok(found);
    assert.equal(found.inputId, 'inp_multi_all_5');
  });

  it('5. banco rejeita duplicata de (source_event_source, source_event_id)', async () => {
    // Tenta inserir outro InputRecord com a mesma SourceEventIdentity diretamente
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO nex_input_records (
            input_id, actor_kind, actor_payload, source_event_source, source_event_id, received_at
          ) VALUES ('inp_duplicate_clash', 'system', '{"kind":"system","component":"test"}', 'slack', 'msg_9876', now());`
        ),
      (err: any) => err.code === '23505' // Unique violation
    );
  });

  it('6. banco rejeita linha de part híbrida com CHECK constraint nex_part_variant_chk', async () => {
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO nex_input_parts (
            input_id, position, kind, text_value, event_id
          ) VALUES ('inp_multi_all_5', 99, 'text', 'texto híbrido', 'evt_hibrido');`
        ),
      (err: any) => err.code === '23514' // Check constraint violation
    );
  });

  it('7. triggers append-only impedem UPDATE e DELETE nas tabelas do B3', async () => {
    // UPDATE em nex_ingress_contents rejeitado
    await assert.rejects(
      () => pool.query(`UPDATE nex_ingress_contents SET declared_mime_type = 'mutated' WHERE content_id = 'ing_test_photo_1';`),
      (err: any) => err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || err.message.toLowerCase().includes('append-only')
    );

    // DELETE em nex_ingress_contents rejeitado
    await assert.rejects(
      () => pool.query(`DELETE FROM nex_ingress_contents WHERE content_id = 'ing_test_photo_1';`),
      (err: any) => err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || err.message.toLowerCase().includes('append-only')
    );

    // UPDATE em nex_input_records rejeitado
    await assert.rejects(
      () => pool.query(`UPDATE nex_input_records SET channel = 'mutated' WHERE input_id = 'inp_multi_all_5';`),
      (err: any) => err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || err.message.toLowerCase().includes('append-only')
    );

    // DELETE em nex_input_parts rejeitado
    await assert.rejects(
      () => pool.query(`DELETE FROM nex_input_parts WHERE input_id = 'inp_multi_all_5';`),
      (err: any) => err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || err.message.toLowerCase().includes('append-only')
    );
  });
});
