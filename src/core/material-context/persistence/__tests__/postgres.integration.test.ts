/**
 * NEX+ · Testes de Integração PostgreSQL para Material Context Pin
 * Escopo 0.86 (Bloco 0.86B · Checkpoint 0.86B-4)
 *
 * Provas:
 * 1. Insert e Read de MaterialContextPin com todas as 7 variantes de MaterialContextItem.
 * 2. Reconstrução determinística da ordem dos items (position ASC).
 * 3. Preservação de JSON null em aspect_snapshot no PostgreSQL.
 * 4. Integridade referencial (Foreign Keys com ON DELETE RESTRICT para input, observation, projection, evidence, precedent).
 * 5. Atomicidade de transação: rollback completo se falhar qualquer item.
 * 6. Triggers de proteção append-only no PostgreSQL (rejeição de UPDATE, DELETE e TRUNCATE).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import type { SessionRef } from '../../../../auth/session-ref.types';
import type { HumanActor } from '../../../observations/contracts';
import type {
  ContextSubjectRef,
  FlowRef,
  ContextAspectRef,
  OperationalChannel,
} from '../../../context/contracts';
import type {
  CorrelationId,
  ResourceRef,
} from '../../../modules/contracts';
import type {
  MaterialContextPinId,
  MaterialContextPin,
  MaterialContextItem,
} from '../../contracts';
import { PostgresMaterialContextStore } from '../postgres';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

describe('0.86B-4 · Persistência PostgreSQL de Material Context Pin', { skip: !databaseUrl }, () => {
  let pool: pg.Pool;
  let store: PostgresMaterialContextStore;

  const sessionRefA = '1111111111111111111111111111111111111111111111111111111111111111' as SessionRef;
  const userLucas = 'usr_lucas_123';
  const humanLucas: HumanActor = { kind: 'human', humanId: userLucas, role: 'director' };

  const brandAlterstate: ContextSubjectRef = {
    subjectType: 'brand' as any,
    subjectId: 'alterstate' as any,
  };

  const flowCheckout: FlowRef = {
    flowType: 'checkout' as any,
    flowId: 'flw_chk_123' as any,
  };

  const SHA_A = 'a'.repeat(64);

  before(async () => {
    if (!databaseUrl) return;
    pool = new Pool({ connectionString: databaseUrl });
    store = new PostgresMaterialContextStore(pool);

    // 1. Fixture: SourceRef
    await pool.query(`
      INSERT INTO nex_source_refs (source_id, kind, name, location_or_uri, created_at)
      VALUES ('src_pin_1', 'url', 'Test Source', 'https://example.com', now())
      ON CONFLICT (source_id) DO NOTHING;
    `);

    // 2. Fixture: EvidenceArtifact
    await pool.query(`
      INSERT INTO nex_evidence_artifacts (
        artifact_id, kind, source_ref_id, sha256, byte_size, mime_type,
        storage_backend, storage_key, captured_at, sensitivity,
        contains_secret_material, redaction_applied, retention_class
      ) VALUES (
        'art_pin_1', 'document', 'src_pin_1', '${SHA_A}', 1024, 'application/pdf',
        'local_fs', 'sha256/aa/aa/${SHA_A}', now(), 'NORMAL',
        false, false, 'durable_evidence'
      ) ON CONFLICT (artifact_id) DO NOTHING;
    `);

    // 3. Fixture: InputRecord
    await pool.query(`
      INSERT INTO nex_input_records (
        input_id, actor_kind, actor_payload, user_id, received_at
      ) VALUES (
        'inp_pin_1', 'human', '{"kind":"human","humanId":"usr_lucas_123"}', '${userLucas}', now()
      ) ON CONFLICT (input_id) DO NOTHING;
    `);

    // 4. Fixture: ObservationRecord
    await pool.query(`
      INSERT INTO nex_observation_records (
        observation_id, domain, entity_type, entity_id, observed_claim,
        raw_value, actor_kind, actor_payload, observed_at, captured_at
      ) VALUES (
        'obs_pin_1', 'catalog', 'product', 'prod_1', 'price_observed',
        '{"price":79.9}', 'human', '{"kind":"human","humanId":"usr_lucas_123"}', now(), now()
      ) ON CONFLICT (observation_id) DO NOTHING;
    `);

    // 5. Fixture: ReviewEvent
    await pool.query(`
      INSERT INTO nex_review_events (
        review_id, actor_kind, actor_payload, decision,
        justification, reviewed_at
      ) VALUES (
        'rev_pin_1', 'human', '{"kind":"human","humanId":"usr_lucas_123"}', 'corroborated',
        'Verified price', now()
      ) ON CONFLICT (review_id) DO NOTHING;
    `);

    // 6. Fixture: CanonicalProjectionRevision
    await pool.query(`
      INSERT INTO nex_canonical_projection_revisions (
        projection_revision_id, domain, entity_type, entity_id, canonical_state,
        materialized_at, explanation
      ) VALUES (
        'proj_pin_1', 'catalog', 'product', 'prod_1', '{"price":79.9}',
        now(), 'Initial canonical promotion'
      ) ON CONFLICT (projection_revision_id) DO NOTHING;
    `);

    // 7. Fixture: ContextualPrecedent
    await pool.query(`
      INSERT INTO nex_contextual_precedents (
        precedent_id, review_event_id, context_summary, applicability_conditions, created_at
      ) VALUES (
        'prec_pin_1', 'rev_pin_1', 'Precedente de aprovação', '{"rule":"auto_approve"}', now()
      ) ON CONFLICT (precedent_id) DO NOTHING;
    `);
  });

  after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  it('1. salva e recupera MaterialContextPin completo com todas as 7 variantes de items no PostgreSQL', async () => {
    const resourceItem: ResourceRef = {
      ownerModule: { moduleKey: 'catalog' as any },
      resourceType: 'product' as any,
      resourceId: 'prod_1' as any,
    };

    const aspectResource: ContextAspectRef = {
      target: {
        kind: 'resource',
        resource: resourceItem,
      },
      aspectKey: 'price' as any,
    };

    const aspectScope: ContextAspectRef = {
      target: {
        kind: 'scope',
        scope: {
          module: { moduleKey: 'inventory' as any },
          scopeType: 'warehouse_section' as any,
          scopeId: 'sec_b' as any,
        },
      },
      aspectKey: 'capacity' as any,
    };

    const items: MaterialContextItem[] = [
      { kind: 'input_ref', inputId: 'inp_pin_1' as any },
      { kind: 'observation_ref', observationId: 'obs_pin_1' as any },
      { kind: 'canonical_projection_ref', projectionRevisionId: 'proj_pin_1' as any },
      { kind: 'evidence_ref', evidenceArtifactId: 'art_pin_1' as any },
      { kind: 'precedent_ref', precedentId: 'prec_pin_1' as any },
      { kind: 'resource_ref', resource: resourceItem },
      { kind: 'aspect_snapshot', aspect: aspectResource, value: { amount: 79.9, currency: 'BRL' } },
      { kind: 'aspect_snapshot', aspect: aspectScope, value: null }, // Prova JSON null
    ];

    const pin: MaterialContextPin = {
      pinId: 'pin_full_test_1' as MaterialContextPinId,
      actor: humanLucas,
      userId: userLucas,
      sessionRef: sessionRefA,
      contextSubjectRef: brandAlterstate,
      flowRef: flowCheckout,
      correlationId: 'corr_pin_test_1' as CorrelationId,
      channel: 'web' as OperationalChannel,
      pinnedAt: '2026-08-25T02:00:00.000Z',
      items,
    };

    const saved = await store.savePin(pin);
    assert.equal(saved.pinId, 'pin_full_test_1');
    assert.equal(saved.items.length, 8);

    const retrieved = await store.getPin('pin_full_test_1' as MaterialContextPinId);
    assert.ok(retrieved);
    assert.equal(retrieved.pinId, 'pin_full_test_1');
    assert.equal(retrieved.actor.kind, 'human');
    assert.equal((retrieved.actor as HumanActor).humanId, userLucas);
    assert.equal(retrieved.userId, userLucas);
    assert.equal(retrieved.sessionRef, sessionRefA);
    assert.deepEqual(retrieved.contextSubjectRef, brandAlterstate);
    assert.deepEqual(retrieved.flowRef, flowCheckout);
    assert.equal(retrieved.correlationId, 'corr_pin_test_1');
    assert.equal(retrieved.channel, 'web');
    assert.equal(retrieved.pinnedAt, '2026-08-25T02:00:00.000Z');

    // Verifica integridade de todos os 8 items na ordem correta
    assert.equal(retrieved.items.length, 8);
    assert.equal(retrieved.items[0].kind, 'input_ref');
    assert.equal((retrieved.items[0] as any).inputId, 'inp_pin_1');

    assert.equal(retrieved.items[1].kind, 'observation_ref');
    assert.equal((retrieved.items[1] as any).observationId, 'obs_pin_1');

    assert.equal(retrieved.items[2].kind, 'canonical_projection_ref');
    assert.equal((retrieved.items[2] as any).projectionRevisionId, 'proj_pin_1');

    assert.equal(retrieved.items[3].kind, 'evidence_ref');
    assert.equal((retrieved.items[3] as any).evidenceArtifactId, 'art_pin_1');

    assert.equal(retrieved.items[4].kind, 'precedent_ref');
    assert.equal((retrieved.items[4] as any).precedentId, 'prec_pin_1');

    assert.equal(retrieved.items[5].kind, 'resource_ref');
    assert.deepEqual((retrieved.items[5] as any).resource, resourceItem);

    assert.equal(retrieved.items[6].kind, 'aspect_snapshot');
    assert.deepEqual((retrieved.items[6] as any).aspect, aspectResource);
    assert.deepEqual((retrieved.items[6] as any).value, { amount: 79.9, currency: 'BRL' });

    assert.equal(retrieved.items[7].kind, 'aspect_snapshot');
    assert.deepEqual((retrieved.items[7] as any).aspect, aspectScope);
    assert.equal((retrieved.items[7] as any).value, null); // JSON null preservado

    // Congelamento profundo
    assert.ok(Object.isFrozen(retrieved));
    assert.ok(Object.isFrozen(retrieved.items));
  });

  it('2. Foreign Key: rejeita item com inputId inexistente (violação FK)', async () => {
    const invalidPin: MaterialContextPin = {
      pinId: 'pin_bad_fk_1' as MaterialContextPinId,
      actor: humanLucas,
      pinnedAt: '2026-08-25T02:00:00.000Z',
      items: [
        {
          kind: 'input_ref',
          inputId: 'inp_does_not_exist' as any,
        },
      ],
    };

    await assert.rejects(
      () => store.savePin(invalidPin),
      (err: any) => err.code === '23503' || /foreign key|chave estrangeira/i.test(err.message)
    );

    // Garante que o header não foi salvo (rollback atômico)
    const exists = await store.hasPin('pin_bad_fk_1' as MaterialContextPinId);
    assert.equal(exists, false);
  });

  it('3. Atomicidade da transação: erro no 2º item desfaz inserção do header e do 1º item', async () => {
    const atomicPin: MaterialContextPin = {
      pinId: 'pin_atomic_test' as MaterialContextPinId,
      actor: humanLucas,
      pinnedAt: '2026-08-25T02:00:00.000Z',
      items: [
        { kind: 'input_ref', inputId: 'inp_pin_1' as any }, // Válido
        { kind: 'observation_ref', observationId: 'obs_non_existent' as any }, // Falha de FK
      ],
    };

    await assert.rejects(
      () => store.savePin(atomicPin),
      (err: any) => err.code === '23503' || /foreign key|chave estrangeira/i.test(err.message)
    );

    const exists = await store.hasPin('pin_atomic_test' as MaterialContextPinId);
    assert.equal(exists, false);

    const checkHeader = await pool.query(
      `SELECT * FROM nex_material_context_pins WHERE pin_id = 'pin_atomic_test'`
    );
    assert.equal(checkHeader.rows.length, 0);

    const checkItems = await pool.query(
      `SELECT * FROM nex_material_context_items WHERE pin_id = 'pin_atomic_test'`
    );
    assert.equal(checkItems.rows.length, 0);
  });

  it('4. Invariante de Variant CHECK: rejeita SQL direto com item híbrido', async () => {
    // Insere um pin isolado para testar CHECK
    await pool.query(`
      INSERT INTO nex_material_context_pins (pin_id, actor_kind, actor_payload, pinned_at)
      VALUES ('pin_chk_test', 'human', '{"kind":"human","humanId":"usr_lucas_123"}', now());
    `);

    // Tenta inserir item híbrido (com input_id E observation_id preenchidos)
    await assert.rejects(
      () =>
        pool.query(`
          INSERT INTO nex_material_context_items (
            pin_id, position, kind, input_id, observation_id
          ) VALUES ('pin_chk_test', 0, 'input_ref', 'inp_pin_1', 'obs_pin_1');
        `),
      (err: any) => err.code === '23514' || err.message.includes('nex_item_variant_chk')
    );
  });

  it('5. Proteção Append-Only no PostgreSQL: rejeita UPDATE, DELETE e TRUNCATE em pins e items', async () => {
    // 1. UPDATE em nex_material_context_pins
    await assert.rejects(
      () =>
        pool.query(`
          UPDATE nex_material_context_pins
          SET channel = 'modified'
          WHERE pin_id = 'pin_full_test_1';
        `),
      (err: any) => err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || err.message.toLowerCase().includes('append-only')
    );

    // 2. DELETE em nex_material_context_pins
    await assert.rejects(
      () =>
        pool.query(`
          DELETE FROM nex_material_context_pins
          WHERE pin_id = 'pin_full_test_1';
        `),
      (err: any) => err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || err.message.toLowerCase().includes('append-only')
    );

    // 3. UPDATE em nex_material_context_items
    await assert.rejects(
      () =>
        pool.query(`
          UPDATE nex_material_context_items
          SET kind = 'resource_ref'
          WHERE pin_id = 'pin_full_test_1' AND position = 0;
        `),
      (err: any) => err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || err.message.toLowerCase().includes('append-only')
    );

    // 4. DELETE em nex_material_context_items
    await assert.rejects(
      () =>
        pool.query(`
          DELETE FROM nex_material_context_items
          WHERE pin_id = 'pin_full_test_1' AND position = 0;
        `),
      (err: any) => err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || err.message.toLowerCase().includes('append-only')
    );

    // 5. TRUNCATE em nex_material_context_items
    await assert.rejects(
      () => pool.query(`TRUNCATE nex_material_context_items;`),
      (err: any) => err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || err.message.toLowerCase().includes('append-only')
    );

    // 6. TRUNCATE em nex_material_context_pins (CASCADE ou direto)
    await assert.rejects(
      () => pool.query(`TRUNCATE nex_material_context_pins CASCADE;`),
      (err: any) => err.message.includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || err.message.toLowerCase().includes('append-only') || err.code === '0A000' || err.message.toLowerCase().includes('truncar')
    );
  });
});
