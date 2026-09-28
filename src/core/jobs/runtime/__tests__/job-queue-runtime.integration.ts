/**
 * NEX+ · pg-boss Runtime Isolated Integration Test Runner
 * Suíte de Prova Técnica do Provedor de Wake-up — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3A)
 *
 * Provas Executadas:
 * 1. Caso A: Runtime normal (migrate: false) FALHA em banco sem schema, executa cleanup interno e NÃO cria conexões ou schemas residuais.
 * 2. Caso B: Provisionamento explícito e controlado com API oficial instala schema e reporta schemaVersion = 43 sem drift.
 * 3. Caso C: Runtime normal (migrate: false) pós-provisionamento INICIA com sucesso na mesma instância e executa stop gracioso.
 * 4. Smoke Queue: Criação da queue 'nex_job_wakeup', envio de { jobId }, recebimento com retryCount e conclusão fenced.
 * 5. Smoke Duplicidade: Prova que a queue tolera duplicate wake-ups com o mesmo jobId sem quebrar integridade.
 * 6. Attempt Fence: Prova PostgreSQL real de que settlement com referência stale resulta em affected=0/settled=false e não afeta a nova tentativa.
 */

import { Client } from 'pg';
import { PgBoss } from 'pg-boss';
import {
  createPgBossRuntime,
  provisionPgBossSchema,
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
    // ========================================================================
    // CASO A: BANCO SEM SCHEMA & PROVA REAL DE CLEANUP (F-3A-01)
    // ========================================================================
    console.log('[PROVA 1/6] Caso A · Banco sem schema pg-boss: testando runtime migrate:false e cleanup...');

    // 1. Confirma que o schema pgboss NÃO existe previamente
    const preCheckRes = await pgClient.query(
      `SELECT count(*) FROM information_schema.schemata WHERE schema_name = $1;`,
      [PG_BOSS_CANONICAL_SCHEMA]
    );
    if (parseInt(preCheckRes.rows[0].count, 10) !== 0) {
      throw new Error(`[PRECHECK_FAIL] Schema '${PG_BOSS_CANONICAL_SCHEMA}' already exists in disposable database.`);
    }

    // Helper para capturar conexões ativas no banco descartável (excluindo pgClient do teste)
    const getActiveConnections = async (): Promise<number> => {
      const res = await pgClient.query(
        `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid();`
      );
      return res.rows[0].count;
    };

    const baselineConnections = await getActiveConnections();

    // 2. Tenta iniciar runtime normal com migrate: false
    const runtimeNormalPre = createPgBossRuntime({ connectionString });
    let failedAsExpected = false;
    try {
      await runtimeNormalPre.start();
    } catch (err) {
      failedAsExpected = true;
      console.log(`  [OK] Runtime normal migrate:false falhou como esperado: ${(err as Error).message}`);
    }

    if (!failedAsExpected) {
      throw new Error('[PROVA_FAIL] Runtime normal com migrate:false NÃO falhou em banco sem schema pg-boss!');
    }

    // Prova Real do Cleanup F-3A-01:
    // Polling curto para confirmar que a contagem de conexões voltou ao baseline
    // sem depender do stop() manual do chamador ou do cleanup final do harness.
    const pollDeadline = Date.now() + 3000;
    let connectionsAfterFail = await getActiveConnections();
    while (connectionsAfterFail > baselineConnections && Date.now() < pollDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      connectionsAfterFail = await getActiveConnections();
    }

    if (connectionsAfterFail > baselineConnections) {
      throw new Error(
        `[PROVA_FAIL] Conexão residual detectada após start falho! Baseline: ${baselineConnections}, Conexões atuais: ${connectionsAfterFail}`
      );
    }
    console.log(`  [OK] Prova real de cleanup: conexões ativas retornaram ao baseline (${connectionsAfterFail}/${baselineConnections}).`);

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
    // CASO B: PROVISIONAMENTO EXPLÍCITO (SCHEMA 43)
    // ========================================================================
    console.log('\n[PROVA 2/6] Caso B · Executando provisionamento explícito e controlado (schema 43)...');

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

    // Confirma via SQL direto que a tabela de versão do pgboss existe e registra a versão 43
    const versionQueryRes = await pgClient.query(
      `SELECT version FROM ${PG_BOSS_CANONICAL_SCHEMA}.version;`
    );
    if (versionQueryRes.rows.length === 0 || versionQueryRes.rows[0].version !== PG_BOSS_EXPECTED_SCHEMA_VERSION) {
      throw new Error(`[PROVA_FAIL] Tabela ${PG_BOSS_CANONICAL_SCHEMA}.version registra versão ${versionQueryRes.rows[0]?.version}, esperado ${PG_BOSS_EXPECTED_SCHEMA_VERSION}.`);
    }
    console.log(`  [OK] Catálogo do PostgreSQL confirma schema '${PG_BOSS_CANONICAL_SCHEMA}' na versão ${versionQueryRes.rows[0].version}.`);

    // ========================================================================
    // CASO C: RUNTIME NORMAL APÓS PROVISIONAMENTO (REUSO DO WRAPPER APÓS FALHA)
    // ========================================================================
    console.log('\n[PROVA 3/6] Caso C · Iniciando runtime normal pós-provisionamento (reutilizando a mesma instância cujo start falhou)...');

    await runtimeNormalPre.start();

    if (!runtimeNormalPre.isStarted) {
      throw new Error('[PROVA_FAIL] Instância após start falho e provisionamento não registrou isStarted=true.');
    }

    const versionPost = await runtimeNormalPre.getSchemaVersion();
    if (versionPost !== PG_BOSS_EXPECTED_SCHEMA_VERSION) {
      throw new Error(`[PROVA_FAIL] getSchemaVersion() retornou ${versionPost}, esperado ${PG_BOSS_EXPECTED_SCHEMA_VERSION}.`);
    }

    const driftPost = await runtimeNormalPre.detectDrift();
    if (!driftPost.ok) {
      throw new Error('[PROVA_FAIL] detectDrift() reportou ok=false no runtime normal.');
    }
    console.log(`  [OK] Runtime normal iniciado com migrate:false com sucesso. Versão: ${versionPost}, Drift: ok.`);

    // ========================================================================
    // SMOKE TEST DE QUEUE: CRIAÇÃO, ENVIO E RECEBIMENTO DE PAYLOAD { jobId }
    // ========================================================================
    console.log(`\n[PROVA 4/6] Smoke Queue · Criação, envio, recuperação e settlement de { jobId } na queue '${PG_BOSS_DEFAULT_WAKEUP_QUEUE}'...`);

    await runtimeNormalPre.createQueue(PG_BOSS_DEFAULT_WAKEUP_QUEUE);
    console.log(`  [OK] Queue '${PG_BOSS_DEFAULT_WAKEUP_QUEUE}' criada com sucesso.`);

    const testJobId = 'job_canonical_smoke_01J8NEXPLUS001';
    const sendResult = await runtimeNormalPre.sendWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      jobId: testJobId,
    });

    if (!sendResult.messageId) {
      throw new Error('[PROVA_FAIL] sendWakeup não retornou messageId.');
    }
    console.log(`  [OK] Mensagem de wake-up enviada com sucesso. MessageId: ${sendResult.messageId}`);

    // Recupera mensagem técnica
    const fetchedMessages = await runtimeNormalPre.fetchWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, 1);
    if (fetchedMessages.length !== 1) {
      throw new Error(`[PROVA_FAIL] fetchWakeup retornou ${fetchedMessages.length} mensagens, esperado 1.`);
    }

    const retrieved = fetchedMessages[0];
    if (retrieved.data.jobId !== testJobId) {
      throw new Error(`[PROVA_FAIL] Payload recuperado possui jobId '${retrieved.data.jobId}', esperado '${testJobId}'.`);
    }
    if (typeof retrieved.retryCount !== 'number' || retrieved.retryCount < 0) {
      throw new Error(`[PROVA_FAIL] Mensagem recuperada possui retryCount inválido: ${retrieved.retryCount}`);
    }
    console.log(`  [OK] Mensagem recuperada intacta com jobId: '${retrieved.data.jobId}', retryCount: ${retrieved.retryCount}.`);

    // Conclui mensagem técnica via completeWakeup com settlement fenced
    const settleSmokeResult = await runtimeNormalPre.completeWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      id: retrieved.id,
      retryCount: retrieved.retryCount,
    });

    if (!settleSmokeResult.settled || settleSmokeResult.affected !== 1) {
      throw new Error(`[PROVA_FAIL] completeWakeup não retornou settled=true / affected=1: ${JSON.stringify(settleSmokeResult)}`);
    }
    console.log(`  [OK] Mensagem técnica liquidada no pg-boss com sucesso (settled=true, affected=1).`);

    // ========================================================================
    // SMOKE TEST DE DUPLICIDADE: PROVA DE QUEUE COM DUPLICATE WAKE-UPS
    // ========================================================================
    console.log('\n[PROVA 5/6] Smoke Duplicidade · Prova de duplicate wake-ups permitidos e tolerados na fila...');

    const duplicateJobId = 'job_duplicate_wake_up_test_002';

    // Envia 1ª mensagem de wake-up
    const send1 = await runtimeNormalPre.sendWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      jobId: duplicateJobId,
    });
    // Envia 2ª mensagem de wake-up para o MESMO jobId
    const send2 = await runtimeNormalPre.sendWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
      jobId: duplicateJobId,
    });

    if (!send1.messageId || !send2.messageId) {
      throw new Error('[PROVA_FAIL] Falha ao enviar ambos os wake-ups duplicados.');
    }
    console.log(`  [OK] Dois wake-ups com o mesmo jobId enviados (IDs: ${send1.messageId}, ${send2.messageId}).`);

    // Recupera ambas as mensagens da fila padrão
    const duplicateFetched = await runtimeNormalPre.fetchWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, 2);
    if (duplicateFetched.length < 2) {
      throw new Error(`[PROVA_FAIL] Esperado recuperar 2 mensagens duplicadas da fila, recuperadas: ${duplicateFetched.length}.`);
    }

    for (const msg of duplicateFetched) {
      if (msg.data.jobId !== duplicateJobId) {
        throw new Error(`[PROVA_FAIL] Mensagem duplicada possui jobId '${msg.data.jobId}', esperado '${duplicateJobId}'.`);
      }
      const dupSettle = await runtimeNormalPre.completeWakeup(PG_BOSS_DEFAULT_WAKEUP_QUEUE, {
        id: msg.id,
        retryCount: msg.retryCount,
      });
      if (!dupSettle.settled || dupSettle.affected !== 1) {
        throw new Error(`[PROVA_FAIL] Falha no settlement de mensagem duplicada: ${JSON.stringify(dupSettle)}`);
      }
    }
    console.log(`  [OK] Ambas as mensagens duplicadas foram recuperadas e concluídas com integridade preservada.`);

    // ========================================================================
    // PROVA REAL DO ATTEMPT FENCE (SEÇÃO 13)
    // ========================================================================
    console.log('\n[PROVA 6/6] Attempt Fence · Prova PostgreSQL real de proteção contra settlement de tentativa stale...');

    const fenceQueueName = 'nex_job_wakeup_fence_test';
    await runtimeNormalPre.createQueue(fenceQueueName);

    const fenceJobId = 'job_fenced_attempt_test_003';
    const fenceSendRes = await runtimeNormalPre.sendWakeup(fenceQueueName, { jobId: fenceJobId });
    if (!fenceSendRes.messageId) {
      throw new Error('[PROVA_FAIL] Falha ao enviar wake-up para teste de fence.');
    }

    // 1. Fetch da 1ª tentativa
    const [oldAttemptMsg] = await runtimeNormalPre.fetchWakeup(fenceQueueName, 1);
    if (!oldAttemptMsg) {
      throw new Error('[PROVA_FAIL] Não foi possível recuperar a 1ª tentativa da fila.');
    }
    const oldAttemptRef = {
      id: oldAttemptMsg.id,
      retryCount: oldAttemptMsg.retryCount,
    };
    console.log(`  [OK] 1ª tentativa recuperada: ID=${oldAttemptRef.id}, retryCount=${oldAttemptRef.retryCount}`);

    // 2. Faz a tentativa antiga perder o claim usando primitiva direta do pg-boss apenas dentro do harness
    // fail() na tentativa ativa faz o pg-boss mover o job para 'retry' (pois retryLimit padrão é 2)
    const rawBossHarness = new PgBoss({
      connectionString,
      schema: PG_BOSS_CANONICAL_SCHEMA,
      backend: 'postgres',
      migrate: false,
    });
    await rawBossHarness.start();
    await rawBossHarness.fail(fenceQueueName, oldAttemptRef.id);
    await rawBossHarness.stop({ graceful: true });
    console.log(`  [OK] Primitiva direta do pg-boss executou fail() na tentativa antiga para provocar retry.`);

    // 3. Busca a nova tentativa do mesmo job técnico
    const [newAttemptMsg] = await runtimeNormalPre.fetchWakeup(fenceQueueName, 1);
    if (!newAttemptMsg) {
      throw new Error('[PROVA_FAIL] Não foi possível recuperar a nova tentativa do job.');
    }
    if (newAttemptMsg.id !== oldAttemptRef.id) {
      throw new Error(`[PROVA_FAIL] ID do job diverge: esperado ${oldAttemptRef.id}, recebido ${newAttemptMsg.id}.`);
    }
    if (newAttemptMsg.retryCount <= oldAttemptRef.retryCount) {
      throw new Error(
        `[PROVA_FAIL] newRetryCount (${newAttemptMsg.retryCount}) deve ser estritamente maior que oldRetryCount (${oldAttemptRef.retryCount}).`
      );
    }
    console.log(`  [OK] Nova tentativa recuperada: ID=${newAttemptMsg.id}, retryCount=${newAttemptMsg.retryCount} (> ${oldAttemptRef.retryCount}).`);

    // 4. Chama o boundary NEX com a referência ANTIGA
    const staleSettlement = await runtimeNormalPre.completeWakeup(fenceQueueName, oldAttemptRef);
    if (staleSettlement.settled !== false || staleSettlement.affected !== 0) {
      throw new Error(
        `[PROVA_FAIL] Settlement fenced com referência antiga deveria resultar em settled=false e affected=0! Retornou: settled=${staleSettlement.settled}, affected=${staleSettlement.affected}`
      );
    }
    console.log(`  [OK] Settlement com tentativa antiga foi rejeitado pelo fence: settled=false, affected=0.`);

    // 5. Confirma diretamente no PostgreSQL que a tentativa nova continua ativa
    const checkActiveSql = await pgClient.query(
      `SELECT state, retry_count FROM ${PG_BOSS_CANONICAL_SCHEMA}.job WHERE id = $1;`,
      [newAttemptMsg.id]
    );
    if (checkActiveSql.rows.length === 0 || checkActiveSql.rows[0].state !== 'active') {
      throw new Error(
        `[PROVA_FAIL] Tentativa nova não está ativa no banco após settlement stale! Estado: ${checkActiveSql.rows[0]?.state}`
      );
    }
    if (checkActiveSql.rows[0].retry_count !== newAttemptMsg.retryCount) {
      throw new Error(`[PROVA_FAIL] retry_count no banco diverge do newAttemptMsg.`);
    }
    console.log(`  [OK] Catálogo do PostgreSQL confirma que o job permanece em estado 'active' com retry_count=${checkActiveSql.rows[0].retry_count}.`);

    // 6. Conclui usando a referência NOVA
    const newSettlement = await runtimeNormalPre.completeWakeup(fenceQueueName, {
      id: newAttemptMsg.id,
      retryCount: newAttemptMsg.retryCount,
    });
    if (newSettlement.settled !== true || newSettlement.affected !== 1) {
      throw new Error(
        `[PROVA_FAIL] Settlement com referência nova deveria ter sucesso com settled=true e affected=1! Retornou: settled=${newSettlement.settled}, affected=${newSettlement.affected}`
      );
    }
    console.log(`  [OK] Settlement com referência nova concluído com sucesso: settled=true, affected=1.`);

    // 7. Confirma estado final no PostgreSQL
    const checkCompletedSql = await pgClient.query(
      `SELECT state FROM ${PG_BOSS_CANONICAL_SCHEMA}.job WHERE id = $1;`,
      [newAttemptMsg.id]
    );
    if (checkCompletedSql.rows[0]?.state !== 'completed') {
      throw new Error(`[PROVA_FAIL] Estado final no banco não é 'completed'! Estado: ${checkCompletedSql.rows[0]?.state}`);
    }
    console.log(`  [OK] Catálogo do PostgreSQL confirma job em estado 'completed'.`);

    // Encerra runtime com stop gracioso
    await runtimeNormalPre.stop({ graceful: true });
    console.log('\n[SUCCESS] Todas as 6 provas técnicas do checkpoint 0.86C-3A foram concluídas com sucesso!');
  } finally {
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error('\n[FATAL ERROR]', err);
  process.exit(1);
});
