# NEX+ 0.86C-0 · pg-boss 12.34.0 final revalidation

Experimental spike only. No production code, main, Notion, or other runtimes were changed.

## Verdict

PG-BOSS 12.34.0 REVALIDADO · 0.86C-0 PODE SER CONGELADO

## Environment

- pg-boss: 12.34.0; schema: 42; database: nex086c_pgboss_revalidation; schema name: nex086c_pgboss.
- Node: v24.19.0; PostgreSQL: PostgreSQL 18.1 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit; Windows: true.
- LISTEN/NOTIFY enabled with polling fallback; cron monitor 1s; worker polling 0.5s; TestClock enabled only in the lab.

## Schema 38 → 42

- Chain: 38→39, 39→40, 40→41, 41→42.
- 12.28.0 installation via official PgBoss.start(), followed by 12.34.0 PgBoss.start() with migrate:true.
- Existing queue/job/schedule remained readable: yes.
- Sentinel outside pg-boss schema untouched: yes.
- Schema drift: {"ok":true,"missingTables":[],"missing":[],"building":[],"invalid":[],"extraIndexes":[],"mismatched":[],"missingFunctions":[],"mismatchedFunctions":[],"columnDrift":[],"constraintDrift":[],"enumDrift":null}.

## Authority mini-gate on 12.34.0

| Scenario | Result | Provider calls/effects | NEX state |
|---|---|---:|---|
| t9-stale-worker-a-pgboss-redelivery-worker-b | PASS | 1/1 | blocked_unknown |
| cancel-after-dispatch-conservative-no-repeat | PASS | 1/1 | blocked_unknown |
| pre-dispatch-authority-loss-suppresses-provider | PASS | 0/0 | recovery_pending |
| cancel-before-dispatch-no-provider-effect | PASS | 0/0 | cancelled |
| duplicate-delivery-one-nex-authority | PASS | 1/1 | succeeded |

T9 preserved blocked_unknown, one external effect, and stale Evidence rejection by fencing. Pre-dispatch and cancel-before remained at zero effects; cancel-after preserved the already factual effect. Duplicate delivery remained one NEX authority and one effect.

## Offline temporal catch-up

- Canonical NEX obligation: lastCheckedAt 2026-01-01T00:00:00.000Z; nextDueAt 2026-01-11T00:00:00.000Z; Home offline until 2026-02-01T00:00:00.000Z.
- Radar policy COALESCE_MISSED found 3 missed windows and produced 1 material catch-up observation.
- Two-worker duplicate wake-up: 2 deliveries, 1 material authority, 1 material effect.
- Deleting/recreating only the pg-boss schedule preserved and reconstructed the obligation from NEX state: yes.
- Human approval stayed pending across offline time; new Attempt was created only after explicit authorization.
- On-demand refresh was accepted before the automatic due date and recalculated the next date.

## TestClock / cleanup

- job_now() override and __pgboss_test_clock cleanup: PASS.
- No persistent clock override remained after all bosses stopped.

## Limitations

- Temporal NEX tables are disposable fixtures, not 0.86C-1 production implementation.
- TestClock validates deterministic runtime behavior; it does not prove physical clock drift, network partitions, or provider exactly-once semantics.
- The test does not adopt transactional workers; long waits remain outside open PostgreSQL transactions.
- No other runtime or full benchmark was repeated.

0.86C-0 · PG-BOSS 12.34.0 · REVALIDAÇÃO CONCLUÍDA PARA SÍNTESE HUMANA
