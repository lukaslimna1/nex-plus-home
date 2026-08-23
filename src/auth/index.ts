/**
 * NEX+ · Auth Layer
 * Exportações Públicas do Módulo de Autenticação — Escopo 0.8A / 0.86B-1 (Hardening)
 */

export * from './identity';
export * from './current-user';
export * from './actions';
export * from './edge-config';
export * from './session-ref.types';
export {
  resolveAuthenticatedSessionContext,
  requireAuthenticatedSessionContext,
  UnauthenticatedSessionError,
  AuthInternalError,
} from './session-boundary';
