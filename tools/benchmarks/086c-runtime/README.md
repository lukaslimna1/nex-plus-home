# NEX+ 0.86C runtime benchmark laboratory

This directory is an isolated experimental spike. It does not implement 0.86C-1, modify canonical NEX+ contracts, use the operational `nex_home` database, or select an architecture.

The harness creates only explicitly named disposable Docker/PostgreSQL resources:

- container: `nex086c-postgres`
- volume: `nex086c_pgdata`
- databases: `nex086c_jobstore`, `nex086c_provider`, and candidate-specific `nex086c_*` databases
- host ports: `127.0.0.1:55432` for PostgreSQL and an ephemeral loopback port for the provider fixture

The provider fixture persists independently in `nex086c_provider`; it cannot share a transaction with the experimental JobStore. This makes the crash-after-side-effect test meaningful.

Run only from this directory:

```powershell
npm install
npm run lab:setup
npm run test:all
npm run test:performance
npm run measure:footprint
npm run report
npm run lab:cleanup
```

`test:all` is intentionally correctness-first. It records raw-engine behavior separately from the NEX-safe boundary behavior. `test:performance` is an own-runner-only baseline, not a cross-runtime ranking. Generated raw results remain under `.artifacts/`; the reviewed synthesis is in [BENCHMARK_REPORT.md](BENCHMARK_REPORT.md) and [SCORECARD.md](SCORECARD.md).
