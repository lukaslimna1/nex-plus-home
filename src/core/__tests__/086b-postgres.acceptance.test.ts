/**
 * NEX+ · 0.86B-5 Acceptance Gate · PostgreSQL Transversal Integration Test
 * Contrato Canônico de Acceptance (0.86B-5 · 26/08/2026)
 *
 * Provas Transversais em Banco de Dados Real:
 * 1. Pipeline completo SessionOperationalState -> OperationalContext -> Ingress -> InputRecord -> MaterialContextPin.
 * 2. Evolução de estado de sessão sem contaminação ou mutação de registros históricos em tabelas PostgreSQL reais.
 * 3. Integridade referencial relacional (Foreign Keys e ON DELETE RESTRICT entre pins e inputs).
 * 4. Triggers de proteção append-only no PostgreSQL (rejeição de UPDATE, DELETE e TRUNCATE).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import type { SessionRef } from '../../auth/session-ref.types';
import type { HumanActor } from '../observations/contracts';
import type {
  ContextSubjectRef,
  ContextSubjectType,
  ContextSubjectId,
  FlowRef,
  OperationalChannel,
} from '../context/contracts';
import type {
  CorrelationId,
  ResourceRef,
} from '../modules/contracts';
import type {
  InputRecordId,
  IngressContentId,
  InputRecord,
  IngressContentRecord,
} from '../input/contracts';
import type {
  MaterialContextPinId,
  MaterialContextPin,
} from '../material-context/contracts';

import { PgSessionOperationalStateStore } from '../context/persistence/postgres';
import { PostgresInputRecordStore, PostgresIngressContentStore } from '../input/persistence/postgres';
import { PostgresMaterialContextStore } from '../material-context/persistence/postgres';
import { composeOperationalContext } from '../context/compose';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;

describe('0.86B-5 Acceptance Gate · Transversal PostgreSQL Acceptance', { skip: !databaseUrl }, () => {
  let pool: pg.Pool;
  let sessionStore: PgSessionOperationalStateStore;
  let inputStore: PostgresInputRecordStore;
  let ingressStore: PostgresIngressContentStore;
  let materialStore: PostgresMaterialContextStore;

  const sessionRefA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as SessionRef;
  const userLucas = 'usr_lucas_acc_123';
  const humanLucas: HumanActor = { kind: 'human', humanId: userLucas, role: 'director' };

  const brandAlterstate: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'alterstate' as ContextSubjectId,
  };

  const brandArkana: ContextSubjectRef = {
    subjectType: 'brand' as ContextSubjectType,
    subjectId: 'arkana' as ContextSubjectId,
  };

  const SHA_1 = '1'.repeat(64);

  before(async () => {
    if (!databaseUrl) return;
    pool = new Pool({ connectionString: databaseUrl });
    sessionStore = new PgSessionOperationalStateStore(pool);
    inputStore = new PostgresInputRecordStore(pool);
    ingressStore = new PostgresIngressContentStore(pool);
    materialStore = new PostgresMaterialContextStore(pool);

    // Inserir SourceRef base para integridade
    await pool.query(`
      INSERT INTO nex_source_refs (source_id, kind, name, location_or_uri, created_at)
      VALUES ('src_acc_1', 'system_feed', 'Acceptance Source', 'https://example.com/acc', now())
      ON CONFLICT (source_id) DO NOTHING;
    `);
  });

  after(async () => {
    if (pool) {
      await pool.end();
    }
  });

  it('1. Pipeline Completo: SessionState -> Context -> Ingress -> InputRecord -> MaterialPin com evolução de sessão no PostgreSQL', async () => {
    // 1. Inicializar SessionOperationalState em Alterstate
    await sessionStore.ensureState({ sessionRef: sessionRefA, userId: userLucas });
    const stateAlterstate = await sessionStore.setContextSubject({
      sessionRef: sessionRefA,
      userId: userLucas,
      contextSubjectRef: brandAlterstate,
      expectedRevision: 1,
    });
    assert.strictEqual(stateAlterstate.revision, 2);
    assert.strictEqual(stateAlterstate.contextSubjectRef?.subjectId, 'alterstate');

    // 2. Compor OperationalContext sob Alterstate
    const ctxA = composeOperationalContext({
      actor: humanLucas,
      userId: userLucas,
      sessionRef: sessionRefA,
      contextSubjectRef: stateAlterstate.contextSubjectRef,
      channel: 'web_admin' as OperationalChannel,
      correlationId: 'corr_acc_1' as CorrelationId,
    });

    // 3. Salvar IngressContent
    const contentIdA = 'ing_acc_doc_1' as IngressContentId;
    const ingressRecordA: IngressContentRecord = {
      contentId: contentIdA,
      actor: humanLucas,
      userId: userLucas,
      sessionRef: sessionRefA,
      contextSubjectRef: brandAlterstate,
      declaredMimeType: 'application/pdf',
      verifiedMimeType: 'application/pdf',
      sha256: SHA_1,
      byteSize: 4096,
      storageBackend: 'local_fs',
      storageKey: `sha256/11/11/${SHA_1}`,
      receivedAt: new Date().toISOString(),
    };
    await ingressStore.saveContent(ingressRecordA);

    // 4. Salvar InputRecord A (contendo texto e content_ref)
    const inputIdA = 'inp_acc_1' as InputRecordId;
    const inputRecordA: InputRecord = {
      inputId: inputIdA,
      actor: humanLucas,
      userId: userLucas,
      sessionRef: sessionRefA,
      contextSubjectRef: brandAlterstate,
      channel: 'web_admin' as OperationalChannel,
      correlationId: 'corr_acc_1' as CorrelationId,
      receivedAt: new Date().toISOString(),
      parts: [
        { kind: 'text', text: 'Entrada operacional sob Alterstate' },
        { kind: 'content_ref', content: { contentId: contentIdA } },
      ],
    };
    await inputStore.saveInputRecord(inputRecordA);

    // 5. Salvar MaterialContextPin A (contendo input_ref e aspect_snapshot)
    const pinIdA = 'pin_acc_1' as MaterialContextPinId;
    const pinA: MaterialContextPin = {
      pinId: pinIdA,
      actor: humanLucas,
      userId: userLucas,
      sessionRef: sessionRefA,
      contextSubjectRef: brandAlterstate,
      channel: 'web_admin' as OperationalChannel,
      correlationId: 'corr_acc_1' as CorrelationId,
      pinnedAt: new Date().toISOString(),
      items: [
        { kind: 'input_ref', inputId: inputIdA },
        {
          kind: 'aspect_snapshot',
          aspect: {
            target: {
              kind: 'resource',
              resource: { ownerModule: { moduleKey: 'catalog' as any }, resourceType: 'product' as any, resourceId: 'p_acc_1' as any },
            },
            aspectKey: 'price' as any,
          },
          value: 149.9,
        },
      ],
    };
    await materialStore.savePin(pinA);

    // 6. Evolução de Sessão: Transição de Alterstate para Arkana no PostgreSQL
    const stateArkana = await sessionStore.setContextSubject({
      sessionRef: sessionRefA,
      userId: userLucas,
      contextSubjectRef: brandArkana,
      expectedRevision: 2,
    });
    assert.strictEqual(stateArkana.revision, 3);
    assert.strictEqual(stateArkana.contextSubjectRef?.subjectId, 'arkana');

    // 7. Criar novo InputRecord B e novo MaterialContextPin B sob Arkana
    const ctxB = composeOperationalContext({
      actor: humanLucas,
      userId: userLucas,
      sessionRef: sessionRefA,
      contextSubjectRef: stateArkana.contextSubjectRef,
      channel: 'web_admin' as OperationalChannel,
      correlationId: 'corr_acc_2' as CorrelationId,
    });

    const inputIdB = 'inp_acc_2' as InputRecordId;
    const inputRecordB: InputRecord = {
      inputId: inputIdB,
      actor: humanLucas,
      userId: userLucas,
      sessionRef: sessionRefA,
      contextSubjectRef: brandArkana,
      channel: 'web_admin' as OperationalChannel,
      correlationId: 'corr_acc_2' as CorrelationId,
      receivedAt: new Date().toISOString(),
      parts: [{ kind: 'text', text: 'Entrada operacional sob Arkana' }],
    };
    await inputStore.saveInputRecord(inputRecordB);

    const pinIdB = 'pin_acc_2' as MaterialContextPinId;
    const pinB: MaterialContextPin = {
      pinId: pinIdB,
      actor: humanLucas,
      userId: userLucas,
      sessionRef: sessionRefA,
      contextSubjectRef: brandArkana,
      channel: 'web_admin' as OperationalChannel,
      correlationId: 'corr_acc_2' as CorrelationId,
      pinnedAt: new Date().toISOString(),
      items: [{ kind: 'input_ref', inputId: inputIdB }],
    };
    await materialStore.savePin(pinB);

    // 8. Verificação Direta no PostgreSQL: Provar Imutabilidade Histórica
    const dbInputA = await pool.query('SELECT * FROM nex_input_records WHERE input_id = $1', [inputIdA]);
    assert.strictEqual(dbInputA.rows.length, 1);
    assert.strictEqual(dbInputA.rows[0].subject_id, 'alterstate');

    const dbPinA = await pool.query('SELECT * FROM nex_material_context_pins WHERE pin_id = $1', [pinIdA]);
    assert.strictEqual(dbPinA.rows.length, 1);
    assert.strictEqual(dbPinA.rows[0].subject_id, 'alterstate');

    const dbInputB = await pool.query('SELECT * FROM nex_input_records WHERE input_id = $1', [inputIdB]);
    assert.strictEqual(dbInputB.rows.length, 1);
    assert.strictEqual(dbInputB.rows[0].subject_id, 'arkana');

    const dbPinB = await pool.query('SELECT * FROM nex_material_context_pins WHERE pin_id = $1', [pinIdB]);
    assert.strictEqual(dbPinB.rows.length, 1);
    assert.strictEqual(dbPinB.rows[0].subject_id, 'arkana');

    // Estado da sessão é Arkana, histórico preservado
    const dbSession = await pool.query('SELECT * FROM nex_session_operational_state WHERE session_ref = $1', [sessionRefA]);
    assert.strictEqual(dbSession.rows.length, 1);
    assert.strictEqual(dbSession.rows[0].subject_id, 'arkana');
    assert.strictEqual(dbSession.rows[0].revision, 3);
  });

  it('2. Integridade Referencial no PostgreSQL: FKs e ON DELETE RESTRICT entre Pin e InputRecord', async () => {
    // 1. Tentar criar Pin referenciando input_id inexistente -> rejeitado por FK no PostgreSQL (23503)
    const pinInvalidInput: MaterialContextPin = {
      pinId: 'pin_acc_fk_invalid' as MaterialContextPinId,
      actor: humanLucas,
      pinnedAt: new Date().toISOString(),
      items: [
        { kind: 'input_ref', inputId: 'inp_non_existent_99999' as InputRecordId },
      ],
    };

    await assert.rejects(
      () => materialStore.savePin(pinInvalidInput),
      (err: any) => err.code === '23503' || String(err.message).includes('violates foreign key')
    );

    // 2. Tentar deletar InputRecord referenciado por nex_material_context_items -> rejeitado por RESTRICT (23503)
    await assert.rejects(
      () => pool.query('DELETE FROM nex_input_records WHERE input_id = $1', ['inp_acc_1']),
      (err: any) =>
        err.code === '23503' ||
        String(err.message).includes('violates foreign key') ||
        String(err.message).includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') ||
        String(err.message).toLowerCase().includes('append-only')
    );
  });

  it('3. Append-Only Trigger Protection: UPDATE, DELETE e TRUNCATE são bloqueados no PostgreSQL', async () => {
    // 1. UPDATE em nex_input_records
    await assert.rejects(
      () => pool.query("UPDATE nex_input_records SET user_id = 'hacked' WHERE input_id = 'inp_acc_1'"),
      (err: any) => String(err.message).includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || String(err.message).toLowerCase().includes('append-only')
    );

    // 2. DELETE em nex_input_records
    await assert.rejects(
      () => pool.query("DELETE FROM nex_input_records WHERE input_id = 'inp_acc_2'"),
      (err: any) => String(err.message).includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || String(err.message).toLowerCase().includes('append-only')
    );

    // 3. UPDATE em nex_material_context_pins
    await assert.rejects(
      () => pool.query("UPDATE nex_material_context_pins SET user_id = 'hacked' WHERE pin_id = 'pin_acc_1'"),
      (err: any) => String(err.message).includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || String(err.message).toLowerCase().includes('append-only')
    );

    // 4. DELETE em nex_material_context_pins
    await assert.rejects(
      () => pool.query("DELETE FROM nex_material_context_pins WHERE pin_id = 'pin_acc_2'"),
      (err: any) => String(err.message).includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || String(err.message).toLowerCase().includes('append-only')
    );

    // 5. TRUNCATE em nex_material_context_items / nex_input_records
    await assert.rejects(
      () => pool.query('TRUNCATE nex_material_context_items;'),
      (err: any) => String(err.message).includes('NEX_PERSISTENCE_APPEND_ONLY_VIOLATION') || String(err.message).toLowerCase().includes('append-only')
    );
  });
});
