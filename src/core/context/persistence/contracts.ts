/**
 * NEX+ · Contratos de Persistência de Estado Operacional de Sessão
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 */

import type { SessionRef } from '../../../auth/session-ref.types';
import type {
  ContextSubjectRef,
  SessionOperationalState,
} from '../contracts';

export interface EnsureSessionOperationalStateParams {
  readonly sessionRef: SessionRef;
  readonly userId: string;
}

export interface SetContextSubjectParams {
  readonly sessionRef: SessionRef;
  readonly userId: string;
  readonly contextSubjectRef: ContextSubjectRef | null;
  readonly expectedRevision: number;
}

export interface SessionOperationalStateStore {
  /**
   * Recupera o estado operacional persistido de uma sessão garantindo ownership do usuário.
   * Retorna null se inexistente.
   * Lança SessionOperationalStateOwnershipMismatchError se o estado pertencer a outro usuário.
   */
  getState(sessionRef: SessionRef, expectedUserId: string): Promise<SessionOperationalState | null>;

  /**
   * Garante a existência do estado operacional para a sessão de forma atômica e idempotente.
   * Se já existir para o mesmo usuário, retorna o estado existente.
   * Se já existir para outro usuário, lança SessionOperationalStateOwnershipMismatchError.
   */
  ensureState(params: EnsureSessionOperationalStateParams): Promise<SessionOperationalState>;

  /**
   * Atualiza o sujeito contextual ativo da sessão sob concorrência otimista (expectedRevision).
   * Se contextSubjectRef for null, limpa o sujeito (retornando ao contexto pessoal).
   * Lança erro se houver conflito de revisão, divergência de ownership ou sessão inexistente.
   */
  setContextSubject(params: SetContextSubjectParams): Promise<SessionOperationalState>;
}
