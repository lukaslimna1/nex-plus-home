/**
 * NEX+ · Server-Side Operational Context Boundary (Fail-Closed)
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 *
 * Princípios de Segurança & Trust Boundary:
 * 1. O contexto operacional de sessão humana é resolvido estritamente a partir do AuthenticatedSessionContext do B1.
 * 2. Nenhum entrypoint público deste módulo aceita actor, userId ou sessionRef do caller.
 * 3. O contextSubjectRef corrente provém do SessionOperationalState persistido, e nunca de um parâmetro arbitrário de composição.
 * 4. Operation hints permitidos pelo caller: location, focus, observedInteraction, flowRef, correlationId e channel.
 * 5. Módulo protegido por 'server-only' para impedir importação em Client Components.
 */

import 'server-only';

import pg from 'pg';
import { requireAuthenticatedSessionContext } from '../../auth/session-boundary';
import type { CorrelationId } from '../modules/contracts';
import type {
  ContextSubjectRef,
  FlowRef,
  OperationalLocation,
  OperationalFocus,
  ObservedInteractionContext,
  OperationalContext,
  OperationalChannel,
  SessionOperationalState,
} from './contracts';
import { composeOperationalContext } from './compose';
import {
  ensureSessionOperationalState,
  setSessionContextSubject,
  clearSessionContextSubject,
} from './session-state';
import type { SessionOperationalStateStore } from './persistence/contracts';
import { PgSessionOperationalStateStore } from './persistence/postgres';

const { Pool } = pg;

let defaultServerPool: pg.Pool | null = null;
let defaultServerStore: PgSessionOperationalStateStore | null = null;

function getDefaultStore(): SessionOperationalStateStore {
  if (!defaultServerStore) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error('[OperationalContext Server] DATABASE_URL is not defined in environment.');
    }
    if (!defaultServerPool) {
      defaultServerPool = new Pool({ connectionString: dbUrl });
    }
    defaultServerStore = new PgSessionOperationalStateStore(defaultServerPool);
  }
  return defaultServerStore;
}

export interface OperationalContextHints {
  readonly location?: OperationalLocation;
  readonly focus?: OperationalFocus;
  readonly observedInteraction?: ObservedInteractionContext;
  readonly flowRef?: FlowRef;
  readonly correlationId?: CorrelationId;
  readonly channel?: OperationalChannel;
}

/**
 * Resolve o contexto operacional corrente para a requisição autenticada.
 *
 * Obtém internamente a identidade e a sessão válidas do B1, recupera/garante
 * o estado operacional persistido da sessão (SessionOperationalState) e compõe
 * o OperationalContext imutável.
 *
 * @param hints - Sinais contextuais da operação (location, focus, flowRef, etc.)
 * @param store - Store opcional para injeção em testes/harnesses
 */
export async function resolveCurrentOperationalContext(
  hints?: OperationalContextHints,
  store?: SessionOperationalStateStore
): Promise<OperationalContext> {
  // 1. Obter identidade autenticada garantida pelo B1 (lança se não autenticado ou admin)
  const sessionContext = await requireAuthenticatedSessionContext();

  // 2. Garantir o estado operacional da sessão no PostgreSQL
  const activeStore = store ?? getDefaultStore();
  const sessionState = await ensureSessionOperationalState(sessionContext, activeStore);

  // 3. Compor o contexto operacional imutável
  return composeOperationalContext({
    actor: sessionContext.actor,
    userId: sessionContext.actor.humanId,
    sessionRef: sessionContext.sessionRef,
    contextSubjectRef: sessionState.contextSubjectRef,
    location: hints?.location,
    focus: hints?.focus,
    observedInteraction: hints?.observedInteraction,
    flowRef: hints?.flowRef,
    correlationId: hints?.correlationId,
    channel: hints?.channel,
  });
}

/**
 * Atualiza o sujeito contextual ativo da sessão corrente sob concorrência otimista.
 *
 * NOTA DE DOMÍNIO / SEGURANÇA:
 * A existência e legitimidade do subjectRef (e os papéis User ↔ Subject) serão validadas
 * pelo boundary de domínio/policy quando o cadastro de Marcas existir.
 */
export async function setCurrentContextSubject(
  params: {
    contextSubjectRef: ContextSubjectRef;
    expectedRevision: number;
  },
  store?: SessionOperationalStateStore
): Promise<SessionOperationalState> {
  const sessionContext = await requireAuthenticatedSessionContext();
  const activeStore = store ?? getDefaultStore();

  return setSessionContextSubject(
    sessionContext,
    {
      contextSubjectRef: params.contextSubjectRef,
      expectedRevision: params.expectedRevision,
    },
    activeStore
  );
}

/**
 * Limpa o sujeito contextual ativo da sessão corrente, retornando ao contexto pessoal.
 */
export async function clearCurrentContextSubject(
  expectedRevision: number,
  store?: SessionOperationalStateStore
): Promise<SessionOperationalState> {
  const sessionContext = await requireAuthenticatedSessionContext();
  const activeStore = store ?? getDefaultStore();

  return clearSessionContextSubject(sessionContext, expectedRevision, activeStore);
}
