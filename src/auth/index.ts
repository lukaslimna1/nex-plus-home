/**
 * NEX+ · Auth Layer
 * Barrel Público e Client-Safe do Módulo de Autenticação — Escopo 0.8A / 0.86B-1 (Hardening)
 *
 * Exporta unicamente tipos, DTOs, validadores estruturais puros e projeções de identidade.
 * NÃO reexporta módulos server-only (que devem ser importados de '@/auth/server' ou subpaths dedicados).
 */

export * from './identity';
export * from './session-ref.types';
