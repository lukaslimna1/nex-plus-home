/**
 * NEX+ · Auth Layer
 * Server-Only Entrypoint do Módulo de Autenticação — Escopo 0.86B-1 (Hardening)
 *
 * Confinado estritamente ao runtime de servidor através de `import 'server-only'`.
 * Deve ser importado exclusivamente por Server Components, Server Actions e rotas server-side.
 */

import 'server-only';

export * from './session-ref.types';
export * from './identity';
export * from './current-user';
export * from './session-ref';
export {
  resolveAuthenticatedSessionContext,
  requireAuthenticatedSessionContext,
  UnauthenticatedSessionError,
  AuthInternalError,
} from './session-boundary';
export * from './edge-config';
