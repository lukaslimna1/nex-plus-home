# NEX+ 0.86C-0 — Scorecard factual, não mecânico

Escala: 5 = evidência forte no lab; 3 = parcial/condicionada; 1 = falha ou incompatibilidade material; — = não testado. Não somar colunas. Correctness e authority dominam qualquer decisão.

## Garantias e autoridade

| Candidato | Crash raw | Side effect via boundary | Authority purity | Tx enqueue | Claim/fencing | Multi-worker | Restart PG |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Runner próprio | 5 | 5 | 5 | 5 | 5 | 5 | 5 |
| pg-boss | 4 | 5 | 4 | 5 | 4 | 4 | 4 |
| Graphile OSS | 3 | 5 | 3 | 5 | 3 | 4 | — |
| DBOS | 4 | 5 | 2 | 5 | 2 | — | — |
| OpenWorkflow | 3 | 5 | 2 | — | 2 | — | — |
| Absurd | 4 | 5 | 2 | — | 3 | — | — |
| Payload 3.88.0 | 1 | 3, manual requeue | 1 | — | 1 | 1 | 1 |

## Waits, operação e schema

| Candidato | Wait/sleep | Signal durável | Cancel pré-exec | Migration/schema | Footprint | Windows | Observabilidade |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Runner próprio | 1 | 1 | 5 | 5 | 4 | 4 | 2 |
| pg-boss | 1 | 1 | — | 4 | 3 | 4 | 4 |
| Graphile OSS | 1 | 1 | — | 2 | 4 | 2 | 3 |
| DBOS | 5 | 5 | — | 4 | 2 | 3 | 4 |
| OpenWorkflow | 5 | 1 | — | 3 | 3 | 3 | 3 |
| Absurd | 5 | 5 | — | 2 | 3 | 2 | 3 |
| Payload 3.88.0 | 2 | 1 | 4 | 2 | 2 | 2 | 2 |

## Saúde, manutenção e performance

| Candidato | Node/TS fit | Maturidade | License | Maintenance burden para NEX | Performance evidenciada | Status |
| --- | ---: | ---: | --- | ---: | --- | --- |
| Runner próprio | 5 | 3 | NEX | 1 | 100/1k/10k baseline | baseline controlado |
| pg-boss | 5 | 4 | MIT | 4 | não comparado | delivery provisório |
| Graphile OSS | 5 | 3 | MIT | 3 | não comparado | condicional |
| DBOS | 5 | 3 | MIT | 2 | não comparado | wait/workflow condicional |
| OpenWorkflow | 5 | 2 | Apache-2.0 | 2 | não comparado | signal adapter obrigatório |
| Absurd | 5 | 1 | Apache-2.0 | 2 | não comparado | experimental |
| Payload 3.88.0 | 5 | 4, CMS | MIT | 1 para jobs | não comparado | não usar como delivery canônica |

## Leitura humana

- Melhor prova de delivery subordinada: pg-boss + boundary NEX.
- Melhor prova de autoridade total: runner próprio, com custo de manutenção explicitamente alto.
- Melhor evidência de waits/signal: DBOS e Absurd, porém ambos precisam provar que seu store não ganha autoridade concorrente.
- Risco crítico: Payload 3.88.0, OpenWorkflow signal-before-waiter e Graphile recovery de lock de quatro horas.
