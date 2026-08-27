# 0.86C-0 PG-BOSS subordinate mini-gate

This is a disposable, experimental spike under tools/benchmarks/086c-runtime. It does not implement 0.86C-1 or change src/core/**.

## Verdict

PG-BOSS SUBORDINADO PASSA MINI-GATE

## Scope and exact configuration

- PG-BOSS: 12.28.0; schema: nex086c_pgboss; PostgreSQL: nex086c_pgboss.
- queue: nex086c_minigate; LISTEN/NOTIFY enabled; polling: 0.5s; notify polling: 0.5s.
- delivery: expireInSeconds=1, heartbeatSeconds=10, retryLimit=2, retryDelay=0.
- worker: heartbeatRefreshSeconds=2, localConcurrency=1.

The redelivery trigger is the PG-BOSS active-delivery expiration. NEX's 200ms operational lease is independently fenced. The observed rule is: PG-BOSS state alone never authorizes an external side effect; the handler must rehydrate and consult NEX.

## Scenarios

| Scenario | Result | Provider count | NEX final state |
|---|---:|---:|---|
| t9-stale-worker-a-pgboss-redelivery-worker-b | PASS | 1 calls / 1 effects | blocked_unknown |
| cancel-after-dispatch-conservative-no-repeat | PASS | 1 calls / 1 effects | blocked_unknown |
| pre-dispatch-authority-loss-suppresses-provider | PASS | 0 calls / 0 effects | recovery_pending |
| cancel-before-dispatch-no-provider-effect | PASS | 0 calls / 0 effects | cancelled |
| duplicate-delivery-one-nex-authority | PASS | 1 calls / 1 effects | succeeded |

## Dual authority table: T9 main timeline

| Stage | PG-BOSS state | NEX Job | NEX Attempt | Worker | lease_epoch | provider effects |
|---|---|---|---|---|---:|---:|
| Delivery created | created | queued | none | none | 0 | 0 |
| A owns and passes first check | active | running | started | pgboss-minigate-stale-a-19524 | 1 | 0 |
| A applied provider effect; Evidence held | active | running | started | pgboss-minigate-stale-a-19524 | 1 | 1 |
| A authority expired; B is next | retry | recovery_pending | started | A stale / B not started | 1 | 1 |
| B redelivery rehydrates NEX | active | recovery_pending | started | B; A stale | 1 | 1 |
| B commits blocked_unknown before ack | completed | blocked_unknown | unknown_completion | B completed; A stale | 1 | 1 |
| A stale Evidence write rejected | completed | blocked_unknown | unknown_completion | A stale / B completed | 1 | 1 |

## Ack and completion order

1. **A handler begins** — PG-BOSS delivery 727ad4f7-8c23-4d82-bf74-cf66638a14dc is active; NEX has lease_epoch=1.
2. **A external effect** — Provider count becomes calls=1/effects=1; NEX Evidence is intentionally not committed.
3. **PG-BOSS retry/redelivery** — The active delivery expires at 1s; observed state before B: retry.
4. **B canonical decision** — B rehydrates NEX, classifies blocked_unknown, and returns without a provider call.
5. **B delivery completion** — PG-BOSS reports completed; canonical NEX state is already blocked_unknown.
6. **A late Evidence attempt** — A's old lease_epoch=1 is rejected (fenced: worker no longer owns the current operational lease); Evidence count remains 0.

The canonical NEX state is committed before a delivery is allowed to complete when the handler has a definitive outcome. A crash after that NEX commit and before PG-BOSS ack is harmless: the next delivery sees the canonical state and does not call the provider. In T9, B's PG-BOSS delivery completed while A's late Evidence write was rejected by the old lease epoch.

## Limitations

- This is an experimental spike only; it does not select the 0.86C-1 architecture and does not modify src/core/**, migrations, Notion, or main.
- The provider fixture is an independent PostgreSQL database, so the external effect is deliberately outside the NEX JobStore transaction.
- PG-BOSS expiration and NEX lease expiry are separate clocks. A real deployment must size and monitor both; PG-BOSS state is never treated as mutative authority.
- The pre-dispatch test demonstrates the final-check suppression boundary, but no software can eliminate the inherent check-to-external-I/O race; only an external idempotency/commit protocol can change that fact.

## Artifact

Machine-readable evidence: .artifacts/pgboss-minigate-results.json.

0.86C-0 MINI-GATE PG-BOSS CONCLUÍDO PARA SÍNTESE HUMANA
