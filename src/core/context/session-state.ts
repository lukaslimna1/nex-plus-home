/**
 * NEX+ · Camada de Domínio do Estado Operacional de Sessão
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 *
 * Responsabilidades:
 * - Operar sobre o SessionOperationalStateStore utilizando AuthenticatedSessionContext resolvido pelo B1.
 * - Garantir criação idempotente e conferência de ownership por sessão em todas as operações (leitura e escrita).
 * - Não autentica, não interpreta JWT, não acessa cookies e não lê _sid.
 */

import type { AuthenticatedSessionContext } from '../../auth/session-ref.types';
import type {
  ContextSubjectRef,
  SessionOperationalState,
} from './contracts';
import type { SessionOperationalStateStore } from './persistence/contracts';
import { validateSessionOperationalState } from './invariants';
import { SessionOperationalStateOwnershipMismatchError } from './errors';

/**
 * Garante que o estado operacional da sessão autenticada existe no store e o retorna.
 * Valida a estrutura e a posse (ownership) do estado retornado.
 */
export async function ensureSessionOperationalState(
  sessionContext: AuthenticatedSessionContext,
  store: SessionOperationalStateStore
): Promise<SessionOperationalState> {
  const userId = sessionContext.actor.humanId;
  const state = await store.ensureState({
    sessionRef: sessionContext.sessionRef,
    userId,
  });

  validateSessionOperationalState(state);

  if (state.userId !== userId) {
    throw new SessionOperationalStateOwnershipMismatchError({
      sessionRef: sessionContext.sessionRef,
      expectedUserId: userId,
      actualUserId: state.userId,
    });
  }

  return state;
}

/**
 * Consulta o estado operacional corrente da sessão autenticada.
 * Exige conferência de ownership (user-aware) e valida o shape mínimo retornado.
 */
export async function getSessionOperationalState(
  sessionContext: AuthenticatedSessionContext,
  store: SessionOperationalStateStore
): Promise<SessionOperationalState | null> {
  const userId = sessionContext.actor.humanId;
  const state = await store.getState(sessionContext.sessionRef, userId);

  if (state === null) {
    return null;
  }

  validateSessionOperationalState(state);

  if (state.userId !== userId) {
    throw new SessionOperationalStateOwnershipMismatchError({
      sessionRef: sessionContext.sessionRef,
      expectedUserId: userId,
      actualUserId: state.userId,
    });
  }

  return state;
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
  const userId = sessionContext.actor.humanId;
  const state = await store.setContextSubject({
    sessionRef: sessionContext.sessionRef,
    userId,
    contextSubjectRef: params.contextSubjectRef,
    expectedRevision: params.expectedRevision,
  });

  validateSessionOperationalState(state);

  if (state.userId !== userId) {
    throw new SessionOperationalStateOwnershipMismatchError({
      sessionRef: sessionContext.sessionRef,
      expectedUserId: userId,
      actualUserId: state.userId,
    });
  }

  return state;
}

/**
 * Limpa o sujeito contextual ativo da sessão, retornando ao contexto pessoal.
 */
export async function clearSessionContextSubject(
  sessionContext: AuthenticatedSessionContext,
  expectedRevision: number,
  store: SessionOperationalStateStore
): Promise<SessionOperationalState> {
  return setSessionContextSubject(
    sessionContext,
    {
      contextSubjectRef: null,
      expectedRevision,
    },
    store
  );
}
