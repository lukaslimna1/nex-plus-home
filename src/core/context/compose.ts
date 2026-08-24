/**
 * NEX+ · Composição Pura de Contexto Operacional
 * Escopo 0.86 (Bloco 0.86B · Hardening 0.86B-2)
 *
 * Função determinística pura para compor, validar e congelar a estrutura
 * imutável de OperationalContext.
 */

import type { Actor } from '../observations/contracts';
import type { SessionRef } from '../../auth/session-ref.types';
import type { CorrelationId } from '../modules/contracts';
import type {
  ContextSubjectRef,
  FlowRef,
  ContextAnchorRef,
  OperationalLocation,
  ContextAspectRef,
  OperationalFocus,
  ObservedInteractionContext,
  OperationalContext,
  OperationalChannel,
} from './contracts';
import { validateOperationalContext } from './invariants';

export interface ComposeOperationalContextParams {
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

function freezeAnchor(anchor: ContextAnchorRef): ContextAnchorRef {
  if (anchor.kind === 'resource') {
    return Object.freeze({
      kind: 'resource',
      resource: Object.freeze({
        ownerModule: Object.freeze({ moduleKey: anchor.resource.ownerModule.moduleKey }),
        resourceType: anchor.resource.resourceType,
        resourceId: anchor.resource.resourceId,
      }),
    });
  }

  return Object.freeze({
    kind: 'scope',
    scope: Object.freeze({
      module: Object.freeze({ moduleKey: anchor.scope.module.moduleKey }),
      scopeType: anchor.scope.scopeType,
      scopeId: anchor.scope.scopeId,
    }),
  });
}

function freezeAspect(aspect: ContextAspectRef): ContextAspectRef {
  return Object.freeze({
    target: freezeAnchor(aspect.target),
    aspectKey: aspect.aspectKey,
  });
}

function freezeLocation(loc?: OperationalLocation): OperationalLocation | undefined {
  if (!loc) return undefined;
  const copiedTrail = loc.trail.map(freezeAnchor);
  return Object.freeze({
    module: Object.freeze({ moduleKey: loc.module.moduleKey }),
    trail: Object.freeze(copiedTrail),
  });
}

function freezeFocus(focus?: OperationalFocus): OperationalFocus | undefined {
  if (!focus) return undefined;
  return Object.freeze({
    ...(focus.primaryTarget ? { primaryTarget: freezeAnchor(focus.primaryTarget) } : {}),
    ...(focus.relatedTargets ? { relatedTargets: Object.freeze(focus.relatedTargets.map(freezeAnchor)) } : {}),
    ...(focus.activeAspects ? { activeAspects: Object.freeze(focus.activeAspects.map(freezeAspect)) } : {}),
    ...(focus.visibleAspects ? { visibleAspects: Object.freeze(focus.visibleAspects.map(freezeAspect)) } : {}),
    ...(focus.action ? { action: focus.action } : {}),
  });
}

function freezeObservedInteraction(
  observed?: ObservedInteractionContext
): ObservedInteractionContext | undefined {
  if (!observed) return undefined;
  return Object.freeze({
    origin: 'client_observed',
    observedAt: observed.observedAt,
    ...(observed.location ? { location: freezeLocation(observed.location) } : {}),
    ...(observed.focus ? { focus: freezeFocus(observed.focus) } : {}),
  });
}

/**
 * Compõe uma instância imutável de OperationalContext.
 * Valida todas as invariantes e congela recursivamente a estrutura de objetos e arrays.
 * Nunca muta os objetos passados por parâmetro.
 */
export function composeOperationalContext(
  params: ComposeOperationalContextParams
): OperationalContext {
  // 1. Validação estrita de invariantes
  validateOperationalContext(params);

  // 2. Cópia defensiva e congelamento estrutural
  const frozenActor = Object.freeze({ ...params.actor });
  const frozenSubjectRef = params.contextSubjectRef
    ? Object.freeze({
        subjectType: params.contextSubjectRef.subjectType,
        subjectId: params.contextSubjectRef.subjectId,
      })
    : undefined;

  const frozenFlowRef = params.flowRef
    ? Object.freeze({
        flowType: params.flowRef.flowType,
        flowId: params.flowRef.flowId,
      })
    : undefined;

  const frozenLocation = freezeLocation(params.location);
  const frozenFocus = freezeFocus(params.focus);
  const frozenObserved = freezeObservedInteraction(params.observedInteraction);

  const context: OperationalContext = {
    actor: frozenActor,
    ...(params.userId !== undefined ? { userId: params.userId } : {}),
    ...(params.sessionRef !== undefined ? { sessionRef: params.sessionRef } : {}),
    ...(frozenSubjectRef !== undefined ? { contextSubjectRef: frozenSubjectRef } : {}),
    ...(frozenLocation !== undefined ? { location: frozenLocation } : {}),
    ...(frozenFocus !== undefined ? { focus: frozenFocus } : {}),
    ...(frozenObserved !== undefined ? { observedInteraction: frozenObserved } : {}),
    ...(frozenFlowRef !== undefined ? { flowRef: frozenFlowRef } : {}),
    ...(params.correlationId !== undefined ? { correlationId: params.correlationId } : {}),
    ...(params.channel !== undefined ? { channel: params.channel } : {}),
  };

  return Object.freeze(context);
}
