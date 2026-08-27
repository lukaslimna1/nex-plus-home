# NEX+ 0.86C-0 — Benchmark experimental PostgreSQL-first

Status: concluído como spike de evidência. Não é implementação do 0.86C-1, decisão arquitetural, migration operacional, nem atualização de Notion.

Execução de referência: 26–27/08/2026, Windows, branch spike/086c0-runtime-benchmark.

## 1. Resultado executivo

O laboratório confirmou o princípio central: o runtime pode redeliver; o boundary NEX+ não pode inferir autorização para repetir uma mutação externa. Em todos os runtimes com redelivery automática testada, o modo raw repetiu o efeito não idempotente após kill entre o efeito externo e a Evidence. Com o boundary experimental NEX-safe, a mesma redelivery reidratou o Job canônico e terminou em blocked_unknown, mantendo um único efeito no provider de laboratório.

O resultado mais negativo é o Payload Jobs exato 3.88.0: kill deixa processing=true e um novo runner informa que não há job a executar; além disso, cinco workers produziram quatro efeitos externos para o mesmo job raw durante a repetição formal da Phase A. Portanto ele é baseline/controle, não candidato a autoridade de delivery canônica.

As três opções que a evidência permite levar à síntese humana são:

- Opção recomendada, confiança média: Job, Attempt e Evidence canônicos no NEX+ com pg-boss subordinado somente para wake-up, schedule e retry técnico de delivery. Há evidência de enqueue transacional, restart PostgreSQL e wake-up duplicado em dois workers sem repetir efeito quando o boundary NEX mantém a lease.
- Alternativa, confiança média: runner PostgreSQL próprio mínimo se o NEX+ precisar possuir diretamente claim, lease epoch, fencing e outbox. Ele passou T1, T2, T3, T5, T9, restart e dois/cinco workers, mas transfere manutenção para o NEX+.
- Composição ainda não recomendada, confiança baixa a média: DBOS ou Absurd podem ser reavaliados para waits duráveis, sempre atrás de adapter que recebe somente jobId e sem tornar seu workflow store autoridade de Decision, Attempt ou Evidence. OpenWorkflow só avança se signals relevantes forem persistidos pelo NEX antes do wait, pois signal anterior ao waiter foi perdido no teste.

Não existe vencedor automático ou decisão de produção neste relatório.

## 2. Guardrails, precheck e contexto

- Repo: G:\Nex+\NEX-Home.
- Baseline verificada: origin/main = 64757eed28923027a813c8aa2e7098e7b0264680.
- Branch usada: spike/086c0-runtime-benchmark.
- Não foram alterados src/core, src/auth, src/migrations, payload.config.ts, contratos canônicos, banco operacional nex_home, main ou Notion.
- Notion lido antes do lab: 0.1 Método supervisionado; 0.86 Fechamento do Core Adaptativo; 0.86C Jobs Duráveis & Rehydration; 0.5A Contratos & Invariantes; 0.5B Capability Registry/Route Terms; 0.5D ExecutionEvidence & Attempt Ledger; 0.85B Persistência Append-only; 0.86B Contexto Operacional; Nova Visão Arquitetural e Radar de Evolução. Nenhuma página foi alterada.
- Invariante aplicado: Job != Attempt != Delivery. Retry técnico não autoriza nova mutação; Attempt terminal não volta a running; delivery é apenas wake-up.

## 3. Stack real e isolamento

| Item | Evidência |
| --- | --- |
| Node / npm | Node 24.19.0; npm 12.0.2 |
| PostgreSQL | postgres:18.1-alpine, Docker 29.6.2, 127.0.0.1:55432 |
| Host Windows | psql e pg_isready ausentes; o lab usa Node pg e Docker |
| Payload | exatamente payload 3.88.0 e @payloadcms/db-postgres 3.88.0 já instalados no repo |
| Dependências isoladas | pg-boss 12.28.0; Graphile Worker 0.17.3; DBOS SDK 4.27.6; OpenWorkflow 0.9.2; absurd-sdk 0.5.0 |
| Recursos descartáveis | container nex086c-postgres; volume nex086c_pgdata; databases com prefixo nex086c_; provider HTTP em porta loopback efêmera |

O provider POST /mutate persiste em nex086c_provider, separado do JobStore e sem transação compartilhada. Ele registra chamada, effectKey, hash, timestamp e efeito. Foram testados provider não-idempotente e provider com idempotency key: a chave evita efeito duplicado, mas não transforma delivery em exactly-once.

## 4. Arquitetura do laboratório

O runtime recebe apenas delivery/jobId no modo NEX-safe. O boundary reidrata Job + Attempt + Evidence no JobStore canônico.

- Lease válida de outro worker: in_flight_elsewhere.
- Attempt sem Evidence após expiração: blocked_unknown.
- Novo Attempt autorizado: chamada ao provider HTTP independente.

O runner próprio implementa apenas o baseline mínimo: SKIP LOCKED, LISTEN/NOTIFY, polling fallback, lease, lease_epoch, fencing, outbox relay e reaper. O boundary foi corrigido durante o spike para não classificar wake-up duplicado durante lease válida como conclusão desconhecida.

## 5. Fase A reproduzível

| Suite | Duração da repetição final |
| --- | ---: |
| setup.mjs | 4.44 s |
| run-own-runner.mjs | 4.13 s |
| run-pg-boss.mjs | 10.01 s |
| run-graphile-worker.mjs | 3.98 s |
| run-dbos.mjs | 16.94 s |
| run-openworkflow.mjs | 75.30 s |
| run-absurd.mjs | 15.56 s |
| run-payload.mjs | 37.47 s |

Artefatos brutos: [Phase A](.artifacts/phase-a-run.json), [runner próprio](.artifacts/own-runner-results.json), [pg-boss](.artifacts/pg-boss-results.json), [Graphile](.artifacts/graphile-worker-results.json), [DBOS](.artifacts/dbos-results.json), [OpenWorkflow](.artifacts/openworkflow-results.json), [Absurd](.artifacts/absurd-results.json) e [Payload](.artifacts/payload-results.json).

| Candidato | Topologia / licença | Cobertura | Resultado factual |
| --- | --- | --- | --- |
| Runner próprio | JobStore NEX PostgreSQL | 12/12 | Notify + poll fallback, rollback, outbox, cancel, T5, T9, restart, 2 e 5 workers passaram. |
| pg-boss 12.28.0 | queue PostgreSQL subordinada; MIT | 5/5 | Enqueue transacional rollback, raw T5 duplicou, boundary bloqueou, 2 workers e restart PG passaram; schema v38. |
| Graphile Worker OSS 0.17.3 | schema nex086c_graphile no JobStore; MIT | 5/5 | add_job transacional, T5, 2 workers e atraso passaram; recovery automático de lock encontrado em 4 horas. |
| DBOS 4.27.6 | workflow/queue store PostgreSQL; MIT | 6/6 | T5 raw/safe, enqueueInTransaction, signal antes/depois de waiter e sleep passaram. |
| OpenWorkflow 0.9.2 | workflow engine PostgreSQL; Apache-2.0 | 5/5 | T5 raw/safe, waits e sleep passaram; signal antes do waiter foi perdido; lease observada em cerca de 30 s. |
| Absurd 0.5.0 | durable steps PostgreSQL; Apache-2.0 | 5/5 | T5 raw/safe, events antes/depois e sleep passaram; recovery em 1.1–1.2 s; CLI tem atrito Windows. |
| Payload Jobs 3.88.0 | jobs do CMS em PostgreSQL; MIT | 5/5 | job preso pós-kill, requeue manual safe, atraso, cancel e corrida de 5 workers; duplicação raw reproduzida. |

## 6. Raw engine versus NEX-safe boundary

| Runtime | Raw depois de efeito + kill | Boundary NEX-safe |
| --- | --- | --- |
| Runner próprio | blind redelivery em provider não-idempotente: duas chamadas/dois efeitos | unknown_completion para blocked_unknown; um efeito |
| pg-boss | retry técnico redeliver: dois efeitos | redelivery reidrata Job; um efeito e bloqueio |
| Graphile | reprocessa lock envelhecido: dois efeitos | um efeito; bloqueio, mas lock OSS exige quatro horas sem intervenção |
| DBOS | step replay: dois efeitos | step recebe boundary; um efeito e bloqueio |
| OpenWorkflow | step replay: dois efeitos | um efeito e bloqueio após lease |
| Absurd | step replay: dois efeitos | um efeito e bloqueio após claim timeout |
| Payload 3.88.0 | sem recovery nativa do job preso; cinco workers: quatro efeitos | somente após processing=false manual; boundary bloqueia e mantém um efeito |

Conclusão: duplicate delivery não equivale a duplicate side effect, mas somente se o handler não possuir autoridade para repetir a mutação.

## 7. Chaos matrix

| Teste | Evidência executada | Resultado |
| --- | --- | --- |
| T0 crash antes de persistir Job | não isolado como caso próprio | limitação declarada |
| T1 Job commitado antes de wake-up | runner próprio LISTEN registration race | polling fallback processou o Job |
| T2 enqueue com rollback | runner próprio, pg-boss, Graphile e DBOS | nenhum Job/enqueue residual |
| T3 crash após claim | coberto indiretamente por leases/recovery | parcial |
| T4 AttemptStarted antes de side effect | estado pré-dispatch persistido pelo boundary | parcial |
| T5 efeito externo antes de Evidence | todos os sete candidatos | raw pode duplicar; boundary bloqueia onde aplicável |
| T6 Evidence antes de terminalização | não isolado | limitação |
| T7 checkpoint em crash | steps DBOS/OpenWorkflow/Absurd, sem kill específico no checkpoint | parcial |
| T8 pause/cancel corrida | cancel pré-execução no runner e Payload | parcial |
| T9 lease expira / stale writer | runner próprio | write stale foi fenced; Graphile mediu unlock de lock |

## 8. Claim, fencing e multi-worker

O teste obrigatório T9 passou no runner próprio: worker A perdeu lease, worker B assumiu e A não conseguiu persistir Evidence por causa de lease_epoch. O mesmo modelo foi exercitado contra pg-boss e Graphile com duas deliveries para o mesmo Job canônico: uma concluiu e a outra retornou in_flight_elsewhere, sem segundo efeito.

- Runner próprio: 2 workers/10 jobs e 5 workers/20 jobs, todos exatamente um efeito.
- pg-boss: 2 workers/2 deliveries duplicadas do mesmo Job NEX-safe, um efeito.
- Graphile: 2 workers/2 deliveries duplicadas do mesmo Job NEX-safe, um efeito.
- Payload: 5 workers no mesmo job raw, quatro efeitos; condição de corrida reproduzida.
- DBOS, OpenWorkflow e Absurd: multi-worker de 2/5 processos não concluído; não recebem crédito nessa dimensão.

## 9. Transactional enqueue e outbox

- Runner próprio: Job + delivery direta na mesma transação e comparação Job + Outbox + relay; ambos corretos. Outbox é opção de desacoplamento, não obrigação quando queue participa da transação.
- pg-boss: boss.send dentro da transação passou rollback.
- Graphile: add_job na mesma transação que o Job canônico passou rollback.
- DBOS: enqueueInTransaction passou rollback.
- OpenWorkflow, Absurd e Payload: não foi provada API de enqueue transacional equivalente no boundary NEX; devem usar outbox/adapter até que isso seja demonstrado.

## 10. Waits, signals e pause/cancel

| Runtime | Sleep | Signal antes do waiter | Signal depois do waiter | Observação |
| --- | --- | --- | --- | --- |
| DBOS | passou | bufferizado/persistido | passou | melhor evidência de signal durável nesta rodada |
| OpenWorkflow | passou | perdido (lista vazia) | passou | NEX deve persistir sinal crítico antes de delegar |
| Absurd | passou | persistido | passou | eventos cacheados; primeiro emit vence |
| Runner/pg-boss/Graphile | não são workflow wait engines | — | — | não tratados como tal |
| Payload | atraso de job passou | — | — | não equivale a wait humano durável |

Cancel antes de execução passou no runner próprio e Payload. Pause pendente, pause/resume após restart, cancel durante handler/wait e cancel depois do side effect não foram elevados a prova de Phase A. Nenhuma semântica de cancel prova ausência de efeito externo.

## 11. PostgreSQL restart e Windows

- Runner próprio: restart do PostgreSQL descartável com Job persistido reidratou e concluiu.
- pg-boss: delivery persistida antes do restart foi processada depois do restart por novo boss/worker.
- Graphile: warning Windows observado: Executable file detection not yet supported on win32.
- Absurd: uvx absurdctl init tenta usar psql do host. Como o host Windows não possui psql, o lab aplicou o schema bundled oficial via Node pg. É atrito operacional, não prova de incompatibilidade do SDK.
- Payload 3.88.0: destroy() do adapter zera schema interno mas não encerra o Pool pg; o fixture precisou liberar a conexão de saúde retida e fechar o pool para não deixar processo vivo.
- Todos os workers Node foram exercitados com IPC, shutdown e SIGKILL em Windows. Não restou processo de benchmark após cada suite.

## 12. Migrations, schemas e footprint

| Runtime | Migration / schema observada | Nota |
| --- | --- | --- |
| pg-boss | schema nex086c_pgboss, versão 38 | migra no start; versionamento explícito |
| Graphile | schema nex086c_graphile dentro do JobStore | release notes tratam tabelas como privadas; atualização exige cuidado/scale-to-zero |
| DBOS | schema nex086c_dbos | migrations no launch |
| OpenWorkflow | schema nex086c_openworkflow | migrations no backend |
| Absurd | SQL bundled oficial 0.5.0 | init CLI Windows não foi diretamente viável |
| Payload | schema dev push em database descartável | não é migration operacional NEX |

Snapshot após Phase A: jobstore 8670 kB; provider 7950 kB; pg-boss 8422 kB; DBOS 8590 kB; OpenWorkflow 8070 kB; Absurd 8174 kB; Payload 8606 kB. Container idle na foto: 77.88 MiB, CPU 0.05%, 10 PIDs. Isto é footprint de laboratório, não perfil de produção. Veja [footprint.json](.artifacts/footprint.json).

## 13. Performance: linha de base, não ranking

| Jobs | Workers | Jobs/s | enqueue→Attempt p50/p95 ms | enqueue→Evidence p50/p95 ms |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 1 | 22.20 | 2275.02 / 4114.38 | 2288.75 / 4126.50 |
| 100 | 5 | 134.44 | 366.89 / 569.78 | 379.19 / 581.90 |
| 1000 | 5 | 137.57 | 3624.26 / 5933.24 | 3635.57 / 5945.30 |
| 10000 | 5 | 111.46 | 45860.19 / 74651.88 | 45873.90 / 74679.24 |

Somente o runner próprio foi medido em 100, 1.000 e 10.000 jobs. Provider HTTP loopback e PostgreSQL Docker fazem parte da medição; os números não comparam candidatos nem devem decidir a arquitetura. O backlog de 10.000 expõe custo do runner deliberadamente simples. Veja [own-performance-results.json](.artifacts/own-performance-results.json).

## 14. Saúde, maturidade e fontes primárias

Snapshot documental em 26/08/2026. Versões executadas são as do lockfile do lab, não uma recomendação de upgrade.

- pg-boss — MIT, [repositório](https://github.com/timgit/pg-boss) e [releases](https://github.com/timgit/pg-boss/releases). Boa maturidade relativa para queue PostgreSQL; releases registram schema/migrations e mudanças de comportamento.
- Graphile Worker OSS — MIT, [repositório](https://github.com/graphile/worker) e [release notes](https://github.com/graphile/worker/blob/main/RELEASE_NOTES.md). As notes avisam que mudanças de schema podem exigir scale-to-zero e que tabelas privadas não são contrato público.
- DBOS — MIT, [repositório](https://github.com/dbos-inc/dbos-transact-ts) e [docs](https://docs.dbos.dev/). O workflow store amplia risco de autoridade dual.
- OpenWorkflow — Apache-2.0, [repositório](https://github.com/openworkflowdev/openworkflow) e [docs](https://openworkflow.dev/docs). A linha 0.x e signal anterior ao waiter exigem adapter NEX.
- Absurd — Apache-2.0, [repositório](https://github.com/earendil-works/absurd) se descreve como experiment in durability; baixa maturidade/bus factor é risco apesar de primitives interessantes.
- Payload — MIT, [repositório](https://github.com/payloadcms/payload) e [docs de jobs](https://github.com/payloadcms/payload/blob/main/docs/jobs-queue/jobs.mdx). O veredito usa auditoria local da versão 3.88.0, não releases posteriores.
- Segunda linha, somente documental: [BullMQ PostgreSQL backend](https://docs.bullmq.io/guide/connections), [PGMQ](https://pgmq.github.io/pgmq/api/sql/functions/), [Hatchet](https://github.com/hatchet-dev/hatchet) e [Awa](https://github.com/hardbyte/awa). Nenhum entrou no lab por não fechar lacuna sem adicionar infra/escopo material.
- Referências de desenho, não benchmarkadas: Temporal, Restate, River, Oban, pg_durable, Trigger.dev, Inngest e Effect.ts.

## 15. Eliminados, finalistas provisórios e composição

Eliminado como delivery canônica nesta fase: Payload Jobs 3.88.0, por job preso pós-kill e duplicação externa reproduzível em cinco workers. Pode continuar como job interno de CMS sem receber autoridade NEX.

Retido com penalidade: Graphile OSS, porque recovery automático do lock observado depende de janela hard-coded de quatro horas e houve warning Windows.

Finalistas provisórios para decisão humana:

1. runner próprio PostgreSQL — referência de máxima autoridade NEX / maior custo de manutenção;
2. pg-boss subordinado — melhor evidência de delivery PostgreSQL com enqueue transacional e restart nesta rodada;
3. DBOS e Absurd — candidatos de primitives de wait/checkpoint, não autoridade canônica;
4. OpenWorkflow — candidato apenas condicionado a signal ledger/outbox NEX.

Composições exercitadas: Job NEX + cada runtime por boundary de jobId. A composição de dois runtimes não foi promovida: ainda faltam testes de dual authority, migration conjunta, dois signals, restart durante wait e cancel ativo.

## 16. Scorecard

Ver [SCORECARD.md](SCORECARD.md). A escala é qualitativa e não possui soma/vencedor automático; traço significa não testado, não zero.

## 17. Riscos, dívida e limitações

- Não foram executados 20 workers, multi-worker completo para DBOS/OpenWorkflow/Absurd, nem restart PostgreSQL durante wait em todos os engines.
- T0, T6 e T7 não têm kill isolado para cada candidato; T8 é parcial.
- Métricas de RAM/CPU sob carga, WAL/bloat longitudinal, downgrade real e DLQ/archive completo não foram comparadas.
- A lógica NEX-safe é experimental; sua contractuação canônica, projection/head e gates de autorização pertencem ao 0.86C-1, não a este spike.
- A safety boundary bloqueia unknown completion e cria trabalho humano/reconciliation; isso é preferível a repetir mutação não idempotente.
- Não há decisão de produção, migration, schema ownership final ou mudança de dependência implícita.

## 18. O que construir, reutilizar e não reimplementar

- Construir no NEX+: Job/Attempt/Evidence/Outcome canônicos, gates de novo Attempt, status blocked_unknown, reconciliation humana, idempotency policy por provider, lease epoch/fencing se NEX possuir claim e ledger/outbox de signal crítico.
- Reutilizar com boundary: mecanismo PostgreSQL de wake-up/scheduling/retry técnico; pg-boss é a opção com melhor prova neste laboratório. DBOS/Absurd somente para waits se autoridade permanecer no NEX.
- Não reimplementar agora: linguagem de workflow genérica, DAG engine, checkpoint runtime amplo ou connector platform. O runner próprio já quantifica o mínimo que seria preciso manter.

## 19. Arquivos, reprodução e limpeza

Todo o trabalho está isolado em tools/benchmarks/086c-runtime: fixtures, provider, JobStore mínimo, boundary, runners de sete candidatos, orquestrador, medição de footprint/performance e este relatório. node_modules, bancos e logs grandes permanecem ignorados.

Para reproduzir:

1. npm install
2. npm run test:all
3. npm run test:performance
4. npm run measure:footprint
5. npm run report
6. npm run lab:cleanup

Após a limpeza, devem desaparecer databases nex086c_*, container nex086c-postgres, volume nex086c_pgdata, porta 55432, portas loopback e workers filhos. A limpeza gera cleanup.json.
