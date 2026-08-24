/**
 * NEX+ · Camada de Domínio do Estado Operacional de Sessão
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 *
 * Responsabilidades:
 * - Operar sobre o SessionOperationalStateStore utilizando AuthenticatedSessionContext resolvido pelo B1.
 * - Garantir criação idempotente e conferência de ownership por sessão.
 * - Não autentica, não interpreta JWT, não acessa cookies e não lê _sid.
 */

import type { AuthenticatedSessionContext } from '../../auth/session-ref.types';
import type {
  ContextSubjectRef,
  SessionOperationalState,
} from './contracts';
import type { SessionOperationalStateStore } from './persistence/contracts';

/**
 * Garante que o estado operacional da sessão autenticada existe no store e o retorna.
 */
export async function ensureSessionOperationalState(
  sessionContext: AuthenticatedSessionContext,
  store: SessionOperationalStateStore
): Promise<SessionOperationalState> {
  return store.ensureState({
    sessionRef: sessionContext.sessionRef,
    userId: sessionContext.actor.humanId,
  });
}

/**
 * Consulta o estado operacional corrente da sessão autenticada.
 */
export async function getSessionOperationalState(
  sessionContext: AuthenticatedSessionContext,
  store: SessionOperationalStateStore
): Promise<SessionOperationalState | null> {
  return store.getState(sessionContext.sessionRef);
}

/**
 * Atualiza o sujeito contextual ativo (ex: Marca) da sessão sob concorrência otimista.
 *
 * NOTA DE DOMÍNIO / SEGURANÇA:
 * A existência e a legitimidade do subjectRef (e os papéis User ↔ Subject) serão validadas
 * pela camada de domínio/policy correspondente quando tal cadastro existir. O ContextSubjectRef
 * aqui apenas registra o sujeito contextual ativo da sessão e não concede autoridade por si só.
 */
export async function setSessionContextSubject(
  sessionContext: AuthenticatedSessionContext,
  params: {
    contextSubjectRef: ContextSubjectRef | null;
    expectedRevision: number;
  },
  store: SessionOperationalStateStore
): Promise<SessionOperationalState> {
  return store.setContextSubject({
    sessionRef: sessionContext.sessionRef,
    userId: sessionContext.actor.humanId,
    contextSubjectRef: params.contextSubjectRef,
    expectedRevision: params.expectedRevision,
  });
}

/**
 * Limpa o sujeito contextual ativo da sessão, retornando ao contexto pessoal.
 */
export async function clearSessionContextSubject(
  sessionContext: AuthenticatedSessionContext,
  expectedRevision: number,
  store: SessionOperationalStateStore
): Promise<SessionOperationalState> {
  return store.setContextSubject({
    sessionRef: sessionContext.sessionRef,
    userId: sessionContext.actor.humanId,
    contextSubjectRef: null,
    expectedRevision,
  });
}
