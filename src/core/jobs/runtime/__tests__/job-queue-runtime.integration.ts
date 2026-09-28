/**
 * NEX+ · pg-boss Runtime Isolated Integration Test Runner
 * Suíte de Prova Técnica do Provedor de Wake-up — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3A)
 *
 * Provas Executadas:
 * 1. Caso A: Runtime normal (migrate: false) FALHA em banco sem schema e NÃO cria schema como efeito colateral.
 * 2. Caso B: Provisionamento explícito e controlado com API oficial instala schema e reporta schemaVersion = 42 sem drift.
 * 3. Caso C: Runtime normal (migrate: false) pós-provisioning INICIA com sucesso e executa stop gracioso.
 * 4. Smoke Queue: Criação da queue 'nex_job_wakeup', envio de { jobId }, recebimento e conclusão técnica.
 * 5. Smoke de Duplicidade: Prova que a queue tolera duplicate wake-ups com o mesmo jobId sem quebrar integridade.
 */

import { Client } from 'pg';
import {
  createPgBossRuntime,
  provisionPgBossSchema,
  PgBossRuntimeError,
  PG_BOSS_CANONICAL_SCHEMA,
  PG_BOSS_DEFAULT_WAKEUP_QUEUE,
  PG_BOSS_EXPECTED_SCHEMA_VERSION,
} from '../index';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('[FAIL] DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  const pgClient = new Client({ connectionString });
  await pgClient.connect();

  try {
    console.log('[PROVA 1/5] Caso A · Banco sem schema pg-boss: testando runtime migrate:false...');

    // 1. Confirma que o schema pgboss NÃO existe previamente
    const preCheckRes = await pgClient.query(
      `SELECT count(*) FROM information_schema.schemata WHERE schema_name = $1;`,
      [PG_BOSS_CANONICAL_SCHEMA]
    );
    if (parseInt(preCheckRes.rows[0].count, 10) !== 0) {
      throw new Error(`[PRECHECK_FAIL] Schema '${PG_BOSS_CANONICAL_SCHEMA}' already exists in disposable database.`);
    }

    // 2. Tenta iniciar runtime normal com migrate: false
    const runtimeNormalPre = createPgBossRuntime({ connectionString });
    let failedAsExpected = false;
    try {
      await runtimeNormalPre.start();
    } catch (err) {
      failedAsExpected = true;
      console.log(`  [OK] Runtime normal migrate:false falhou como esperado: ${(err as Error).message}`);
    } finally {
      await runtimeNormalPre.stop({ graceful: true });
    }

    if (!failedAsExpected) {
      throw new Error('[PROVA_FAIL] Runtime normal com migrate:false NÃO falhou em banco sem schema pg-boss!');
    }

    // 3. Confirma que o schema NÃO foi criado silenciosamente como efeito colateral
    const postFailCheckRes = await pgClient.query(
      `SELECT count(*) FROM information_schema.schemata WHERE schema_name = $1;`,
      [PG_BOSS_CANONICAL_SCHEMA]
    );
    if (parseInt(postFailCheckRes.rows[0].count, 10) !== 0) {
      throw new Error('[PROVA_FAIL] Schema pgboss foi criado silenciosamente após falha de runtime migrate:false!');
    }
    console.log(`  [OK] Confirmado: nenhum schema '${PG_BOSS_CANONICAL_SCHEMA}' foi criado silenciosamente.`);

    // ========================================================================
    // CASO B: PROVISIONAMENTO EXPLÍCITO
    // ========================================================================
    console.log('\n[PROVA 2/5] Caso B · Executando provisionamento explícito e controlado...');

    const provisionResult = await provisionPgBossSchema(connectionString);
    console.log(`  [OK] Provisionamento concluído:`, provisionResult);

    if (!provisionResult.success) {
      throw new Error('[PROVA_FAIL] provisionPgBossSchema reportou success=false.');
    }
    if (provisionResult.schemaVersion !== PG_BOSS_EXPECTED_SCHEMA_VERSION) {
      throw new Error(`[PROVA_FAIL] Schema version ${provisionResult.schemaVersion} diverge do esperado ${PG_BOSS_EXPECTED_SCHEMA_VERSION}.`);
    }
    if (!provisionResult.driftOk) {
      throw new Error('[PROVA_FAIL] Schema drift reportou driftOk=false após provisionamento.');
    }

    // Confirma via SQL direto que a tabela de versão do pgboss existe e registra a versão 42
    const versionQueryRes = await pgClient.query(
      `SELECT version FROM ${PG_BOSS_CANONICAL_SCHEMA}.version;`
    );
    if (versionQueryRes.rows.length === 0 || versionQueryRes.rows[0].version !== PG_BOSS_EXPECTED_SCHEMA_VERSION) {
      throw new Error(`[PROVA_FAIL] Tabela ${PG_BOSS_CANONICAL_SCHEMA}.version registra versão ${versionQueryRes.rows[0]?.version}, esperado ${PG_BOSS_EXPECTED_SCHEMA_VERSION}.`);
    }
    console.log(`  [OK] Catálogo do PostgreSQL confirma schema '${PG_BOSS_CANONICAL_SCHEMA}' na versão ${versionQueryRes.rows[0].version}.`);

    // ========================================================================
    // CASO C: RUNTIME NORMAL APÓS PROVISIONAMENTO
    // ========================================================================
    console.log('\n[PROVA 3/5] Caso C · Iniciando runtime normal (migrate: false) após provisionamento...');

    const runtimeNormalPost = createPgBossRuntime({ connectionString });
    await runtimeNormalPost.start();

    if (!runtimeNormalPost.isStarted) {
      throw new Error('[PROVA_FAIL] Runtime normal não registrou isStarted=true após start() bem-sucedido.');
    }

    const versionPost = await runtimeNormalPost.getSchemaVersion();
    if (versionPost !== PG_BOSS_EXPECTED_SCHEMA_VERSION) {
      throw new Error(`[PROVA_FAIL] getSchemaVersion() retornou ${versionPost}, esperado ${PG_BOSS_EXPECTED_SCHEMA_VERSION}.`);
    }

    const driftPost = await runtimeNormalPost.detectDrift();
    if (!driftPost.ok) {
      throw new Error('[PROVA_FAIL] detectDrift() reportou ok=false no runtime normal.');
    }
    console.log(`  [OK] Runtime normal iniciado com migrate:false com sucesso. Versão: ${versionPost}, Drift: ok.`);

    // ========================================================================
    // SMOKE TEST DE QUEUE: CRIAÇÃO, ENVIO E RECEBIMENTO DE PAYLOAD { jobId }
    // ========================================================================
    console.log(`\n[PROVA 4/5] Smoke Queue · Criação, envio e recuperação de payload canônico { jobId } na queue '${PG_BOSS_DEFAULT_WAKEUP_QUEUE}'...`);

    // Cria a queue técnica smoke com política standard (padrão do pg-boss)
    await runtimeNormalPost.createQueue(PG_BOSS_DEFAULT_WAKEUP_QUEUE);
    console.log(`  [OK] Queue '${PG_BOSS_DEFAULT_WAKEUP_QUEUE}' criada com sucesso.`);

    const testJobId = 'job_canonical_smoke_01J8NEXPLUS001';
    const sendResult = await runtimeNormalPost.sendWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      jobId: testJobId,
    });

    if (!sendResult.messageId) {
      throw new Error('[PROVA_FAIL] sendWakeup não retornou messageId.');
    }
    console.log(`  [OK] Mensagem de wake-up enviada com sucesso. MessageId: ${sendResult.messageId}`);

    // Recupera mensagem técnica
    const fetchedMessages = await runtimeNormalPost.fetchWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, 1);
    if (fetchedMessages.length !== 1) {
      throw new Error(`[PROVA_FAIL] fetchWakeup retornou ${fetchedMessages.length} mensagens, esperado 1.`);
    }

    const retrieved = fetchedMessages[0];
    if (retrieved.data.jobId !== testJobId) {
      throw new Error(`[PROVA_FAIL] Payload recuperado possui jobId '${retrieved.data.jobId}', esperado '${testJobId}'.`);
    }
    console.log(`  [OK] Mensagem recuperada intacta com jobId: '${retrieved.data.jobId}'.`);

    // Conclui mensagem técnica
    await runtimeNormalPost.completeJob(PG_BOSS_DEFAULT_WAKEUP_QUEUE, retrieved.id);
    console.log(`  [OK] Mensagem técnica concluída no pg-boss com sucesso.`);

    // ========================================================================
    // SMOKE TEST DE DUPLICIDADE: PROVA DE QUEUE COM DUPLICATE WAKE-UPS
    // ========================================================================
    console.log('\n[PROVA 5/5] Smoke Duplicidade · Prova de duplicate wake-ups permitidos e tolerados na fila...');

    const duplicateJobId = 'job_duplicate_wake_up_test_002';

    // Envia 1ª mensagem de wake-up
    const send1 = await runtimeNormalPost.sendWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      jobId: duplicateJobId,
    });
    // Envia 2ª mensagem de wake-up para o MESMO jobId
    const send2 = await runtimeNormalPost.sendWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      jobId: duplicateJobId,
    });

    if (!send1.messageId || !send2.messageId) {
      throw new Error('[PROVA_FAIL] Falha ao enviar ambos os wake-ups duplicados.');
    }
    console.log(`  [OK] Dois wake-ups com o mesmo jobId enviados (IDs: ${send1.messageId}, ${send2.messageId}).`);

    // Recupera ambas as mensagens da fila padrão
    const duplicateFetched = await runtimeNormalPost.fetchWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, 2);
    if (duplicateFetched.length < 2) {
      throw new Error(`[PROVA_FAIL] Esperado recuperar 2 mensagens duplicadas da fila, recuperadas: ${duplicateFetched.length}.`);
    }

    for (const msg of duplicateFetched) {
      if (msg.data.jobId !== duplicateJobId) {
        throw new Error(`[PROVA_FAIL] Mensagem duplicada possui jobId '${msg.data.jobId}', esperado '${duplicateJobId}'.`);
      }
      await runtimeNormalPost.completeJob(PG_BOSS_DEFAULT_WAKEUP_QUEUE, msg.id);
    }
    console.log(`  [OK] Ambas as mensagens duplicadas foram recuperadas e concluídas com integridade preservada.`);

    // Encerra runtime com stop gracioso
    await runtimeNormalPost.stop({ graceful: true });
    console.log('\n[SUCCESS] Todas as 5 provas técnicas do checkpoint 0.86C-3A foram concluídas com sucesso!');
  } finally {
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error('\n[FATAL ERROR]', err);
  process.exit(1);
});
