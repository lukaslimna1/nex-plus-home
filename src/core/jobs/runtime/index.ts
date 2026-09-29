/**
 * NEX+ · Job Runtime Boundary & Provider Module
 * Exportações do Boundary de Runtime — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-3A)
 *
 * Isola o provider pg-boss do Core canônico e expõe apenas contratos,
 * validações e fábricas de runtime explicitamente autorizadas.
 */

export * from './contracts';
export * from './invariants';
export * from './pg-boss';
export * from './coordinator';
export * from './worker-bridge';
