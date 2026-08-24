/**
 * NEX+ · Contexto Operacional & Sujeito Representado
 * Contratos Canônicos TypeScript — Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 *
 * Princípios Fundamentais:
 * 1. Separação Estrita de Eixos:
 *    - QUEM agiu (Actor)
 *    - QUEM é a identidade humana estável (userId)
 *    - QUAL é a instância temporária autenticada (SessionRef)
 *    - EM NOME DE QUAL contexto/sujeito a operação ocorre (ContextSubjectRef, ex: Marca)
 *    - ONDE ela ocorre (OperationalLocation = ModuleRef + trail)
 *    - COM O QUÊ (ContextAnchorRef: ResourceRef ou ContextScopeRef)
 *    - O QUE ESTÁ EM FOCO (OperationalFocus: primaryTarget, relatedTargets, activeAspects, visibleAspects, action)
 * 2. Contexto é Sinal, NUNCA Autoridade (INV-CTX-NO-AUTHORITY).
 * 3. Contexto Rico porém Seletivo:
 *    Captura referências e sinais estruturados sem copiar objetos inteiros de domínio para o OperationalContext.
 * 4. Extensibilidade:
 *    ContextSubjectRef não é fechado em 'brand'; aceita novos tipos de sujeitos futuros.
 * 5. Ausência de ContextSubjectRef:
 *    Representa contexto pessoal do usuário; nunca representado pela string 'personal'.
 */

import type { Actor } from '../observations/contracts';
import type { SessionRef } from '../../auth/session-ref.types';
import type {
  ModuleRef,
  ResourceRef,
  CorrelationId,
} from '../modules/contracts';

// ============================================================================
// 1. IDENTIFICADORES BRANDED (Semantic Aliases)
// ============================================================================

export type ContextSubjectType = string & { readonly __brand?: 'ContextSubjectType' };
export type ContextSubjectId = string & { readonly __brand?: 'ContextSubjectId' };

export type FlowType = string & { readonly __brand?: 'FlowType' };
export type FlowId = string & { readonly __brand?: 'FlowId' };

export type ContextScopeType = string & { readonly __brand?: 'ContextScopeType' };
export type ContextScopeId = string & { readonly __brand?: 'ContextScopeId' };

export type ContextAspectKey = string & { readonly __brand?: 'ContextAspectKey' };
export type OperationVerb = string & { readonly __brand?: 'OperationVerb' };
export type OperationalChannel = string & { readonly __brand?: 'OperationalChannel' };

// ============================================================================
// 2. CONTEXT SUBJECT REF (Sujeito Representado)
// ============================================================================

/**
 * Referência opaca ao sujeito contextual em cujo interesse a operação ocorre (ex: Marca).
 * Não carrega cadastro, dados fiscais, logotipo, permissões ou autoridade.
 * O subjectType é extensível (ex: 'brand').
 */
export interface ContextSubjectRef {
  readonly subjectType: ContextSubjectType;
  readonly subjectId: ContextSubjectId;
}

// ============================================================================
// 3. FLOW REF (Referência Leve de Fluxo)
// ============================================================================

/**
 * Referência contextual a um fluxo operacional em andamento.
 * Não é workflow engine, não é job, não contém steps nem concede autoridade.
 */
export interface FlowRef {
  readonly flowType: FlowType;
  readonly flowId: FlowId;
}

// ============================================================================
// 4. CONTEXT SCOPE REF & ANCHOR REF
// ============================================================================

/**
 * Referência a um agrupamento ou escopo sem entidade canônica própria no módulo.
 * Regra: Se existir um ResourceRef canônico para a entidade, usar ResourceRef em vez de ContextScopeRef.
 */
export interface ContextScopeRef {
  readonly module: ModuleRef;
  readonly scopeType: ContextScopeType;
  readonly scopeId: ContextScopeId;
}

/**
 * União discriminada estrita de âncoras contextuais:
 * - 'resource': aponta para um ResourceRef canônico gerenciado por um módulo.
 * - 'scope': aponta para um ContextScopeRef sem entidade própria.
 */
export type ContextAnchorRef =
  | {
      readonly kind: 'resource';
      readonly resource: ResourceRef;
    }
  | {
      readonly kind: 'scope';
      readonly scope: ContextScopeRef;
    };

// ============================================================================
// 5. OPERATIONAL LOCATION (Localização Primária & Trilha)
// ============================================================================

/**
 * Localização operacional primária de uma operação.
 * A trilha (trail) é ordenada do mais amplo ao mais específico e contém apenas refs (sem valores materiais).
 */
export interface OperationalLocation {
  readonly module: ModuleRef;
  readonly trail: readonly ContextAnchorRef[];
}

// ============================================================================
// 6. CONTEXT ASPECT REF & OPERATIONAL FOCUS
// ============================================================================

/**
 * Identifica um aspecto ou campo material de um alvo sem carregar seu valor concreto.
 * Exemplo semântico: target = produto, aspectKey = 'price' | 'dimensions'.
 */
export interface ContextAspectRef {
  readonly target: ContextAnchorRef;
  readonly aspectKey: ContextAspectKey;
}

/**
 * Recorte explícito do foco material e atenção da operação corrente.
 * Não contém objetos de domínio inteiros, nem payloads arbitrários.
 */
export interface OperationalFocus {
  readonly primaryTarget?: ContextAnchorRef;
  readonly relatedTargets?: readonly ContextAnchorRef[];
  readonly activeAspects?: readonly ContextAspectRef[];
  readonly visibleAspects?: readonly ContextAspectRef[];
  readonly action?: OperationVerb;
}

// ============================================================================
// 7. OBSERVED INTERACTION CONTEXT (Contexto Observado pelo Cliente)
// ============================================================================

/**
 * Contexto de interação observado pelo cliente (UI).
 * SEMPRE tratado como sinal contextual externo e NUNCA como autorização ou verdade canônica.
 */
export interface ObservedInteractionContext {
  readonly origin: 'client_observed';
  readonly observedAt: string; // ISO 8601 UTC ('Z')
  readonly location?: OperationalLocation;
  readonly focus?: OperationalFocus;
}

// ============================================================================
// 8. OPERATIONAL CONTEXT (Projeção Imutável da Operação)
// ============================================================================

/**
 * Projeção imutável de contexto operacional para uma operação material no NEX+.
 * Sem JWT, cookie, _sid, segredos, estado inteiro de banco ou memória do MAX.
 */
export interface OperationalContext {
  readonly actor: Actor;
  readonly userId?: string;
  readonly sessionRef?: SessionRef;
  readonly contextSubjectRef?: ContextSubjectRef;

  readonly location?: OperationalLocation;
  readonly focus?: OperationalFocus;

  readonly observedInteraction?: ObservedInteractionContext;

  readonly flowRef?: FlowRef;
  readonly correlationId?: CorrelationId;
  readonly channel?: OperationalChannel;
}

// ============================================================================
// 9. SESSION OPERATIONAL STATE (Estado Mínimo da Sessão)
// ============================================================================

/**
 * Estado operacional mínimo persistido por sessão em PostgreSQL.
 * Contém apenas o estado estritamente session-scoped (sujeito contextual ativo).
 * Não armazena módulo, recurso, foco, aba ou réplica de frontend.
 */
export interface SessionOperationalState {
  readonly sessionRef: SessionRef;
  readonly userId: string;
  readonly contextSubjectRef?: ContextSubjectRef;
  readonly revision: number;
  readonly createdAt: string; // ISO 8601 UTC ('Z')
  readonly updatedAt: string; // ISO 8601 UTC ('Z')
}
