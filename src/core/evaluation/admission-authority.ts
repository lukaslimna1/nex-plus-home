/**
 * NEX+ · Route Eligibility, Selection & Escalation
 * Runtime Interno de DispatchAdmission (Single-Use & Issuer Privado) — Escopo 0.85D (Passagem 2)
 *
 * Plano de Autoridade (L0).
 * Garante que DispatchAdmission seja emitida EXCLUSIVAMENTE pelo fluxo interno de evaluateDecision()
 * e consumida de forma estritamente SINGLE-USE por AttemptCreatedEvent via claim atômico e síncrono.
 *
 * NOTA DE ESCOPO: Este runtime opera estritamente em memória no boundary L0 atual.
 * Persistência durável, rehydration e scheduler pertencem exclusivamente ao Escopo 0.86C.
 */

import type { AttemptId } from '../execution/contracts';
import type {
  DecisionMaterialContextId,
  DispatchAdmission,
  DispatchAdmissionId,
} from './contracts';

export class DispatchAdmissionNotFoundError extends Error {
  readonly code = 'DISPATCH_ADMISSION_NOT_FOUND';
  readonly admissionId: DispatchAdmissionId;

  constructor(admissionId: DispatchAdmissionId) {
    super(
      `[L0 Admission Authority] DispatchAdmission '${admissionId}' was not found in runtime authority. Re-evaluation is required.`,
    );
    this.name = 'DispatchAdmissionNotFoundError';
    this.admissionId = admissionId;
  }
}

export class DispatchAdmissionConflictError extends Error {
  readonly code = 'DISPATCH_ADMISSION_CONFLICT';
  readonly admissionId: DispatchAdmissionId;

  constructor(admissionId: DispatchAdmissionId) {
    super(
      `[L0 Admission Authority] DispatchAdmission '${admissionId}' already exists with different payload. Overwrite is strictly prohibited.`,
    );
    this.name = 'DispatchAdmissionConflictError';
    this.admissionId = admissionId;
  }
}

export class DispatchAdmissionAlreadyConsumedError extends Error {
  readonly code = 'DISPATCH_ADMISSION_ALREADY_CONSUMED';
  readonly admissionId: DispatchAdmissionId;
  readonly consumedByAttemptId?: AttemptId;

  constructor(admissionId: DispatchAdmissionId, consumedByAttemptId?: AttemptId) {
    super(
      `[L0 Admission Authority] DispatchAdmission '${admissionId}' has already been consumed${
        consumedByAttemptId ? ` by Attempt '${consumedByAttemptId}'` : ''
      }. Admissions are single-use. Re-evaluation is required.`,
    );
    this.name = 'DispatchAdmissionAlreadyConsumedError';
    this.admissionId = admissionId;
    this.consumedByAttemptId = consumedByAttemptId;
  }
}

interface AdmissionStoreEntry {
  readonly admission: DispatchAdmission;
  consumed: boolean;
  consumedByAttemptId?: AttemptId;
}

const internalStore = new Map<DispatchAdmissionId, AdmissionStoreEntry>();

function deepFreezeAdmission(admission: DispatchAdmission): DispatchAdmission {
  const scopeCopy = admission.authorizationScope
    ? Object.freeze({
        operation: admission.authorizationScope.operation,
        resourceTarget: admission.authorizationScope.resourceTarget,
      })
    : undefined;

  return Object.freeze({
    admissionId: admission.admissionId,
    decisionId: admission.decisionId,
    materialContextId: admission.materialContextId,
    routeEvaluationId: admission.routeEvaluationId,
    capabilityRevisionId: admission.capabilityRevisionId,
    bindingRevisionId: admission.bindingRevisionId,
    routeRevisionId: admission.routeRevisionId,
    policyRevisionId: admission.policyRevisionId,
    authorizationDecisionId: admission.authorizationDecisionId,
    confirmationDecisionId: admission.confirmationDecisionId,
    authorizationScope: scopeCopy,
    admittedAt: admission.admittedAt,
  });
}

function areAdmissionsEqual(a: DispatchAdmission, b: DispatchAdmission): boolean {
  if (
    a.admissionId !== b.admissionId ||
    a.decisionId !== b.decisionId ||
    a.materialContextId !== b.materialContextId ||
    a.routeEvaluationId !== b.routeEvaluationId ||
    a.capabilityRevisionId !== b.capabilityRevisionId ||
    a.bindingRevisionId !== b.bindingRevisionId ||
    a.routeRevisionId !== b.routeRevisionId ||
    a.policyRevisionId !== b.policyRevisionId ||
    a.authorizationDecisionId !== b.authorizationDecisionId ||
    a.confirmationDecisionId !== b.confirmationDecisionId ||
    a.admittedAt !== b.admittedAt
  ) {
    return false;
  }

  if (!a.authorizationScope && !b.authorizationScope) {
    return true;
  }
  if (!a.authorizationScope || !b.authorizationScope) {
    return false;
  }
  return (
    a.authorizationScope.operation === b.authorizationScope.operation &&
    a.authorizationScope.resourceTarget === b.authorizationScope.resourceTarget
  );
}

/**
 * Função interna de emissão de DispatchAdmission.
 * Invocada EXCLUSIVAMENTE por evaluateDecision() no momento da seleção de rota.
 * NÃO exportada no barrel público (src/core/evaluation/index.ts).
 */
export function issueDispatchAdmissionInternal(rawAdmission: DispatchAdmission): DispatchAdmission {
  if (!rawAdmission || !rawAdmission.admissionId) {
    throw new Error('[L0 Admission Runtime] Cannot issue admission without valid admissionId.');
  }

  const existing = internalStore.get(rawAdmission.admissionId);
  if (existing) {
    if (areAdmissionsEqual(existing.admission, rawAdmission)) {
      return existing.admission;
    }
    throw new DispatchAdmissionConflictError(rawAdmission.admissionId);
  }

  const frozen = deepFreezeAdmission(rawAdmission);
  internalStore.set(rawAdmission.admissionId, {
    admission: frozen,
    consumed: false,
  });
  return frozen;
}

export interface ClaimAdmissionParams {
  readonly admissionId: DispatchAdmissionId;
  readonly attemptId: AttemptId;
  readonly currentMaterialContextId: DecisionMaterialContextId;
  readonly effectiveOperation?: string;
  readonly effectiveResourceTarget?: string;
}

/**
 * Operação atômica e síncrona de claim de DispatchAdmission para criação de Attempt.
 * Invocada internamente por buildAttemptCreatedEvent().
 * NÃO exportada no barrel público (src/core/evaluation/index.ts).
 *
 * Regras:
 * 1. Localiza a entry no store. Se não existir -> DispatchAdmissionNotFoundError.
 * 2. Se já consumida -> DispatchAdmissionAlreadyConsumedError.
 * 3. Valida materialContextId, effectiveOperation e effectiveResourceTarget.
 *    Se qualquer validação falhar, lança erro e NÃO consome a admission (previne DoS por request inválido).
 * 4. Após todos os checks passarem -> marca consumed=true e consumedByAttemptId=attemptId.
 * 5. Retorna o snapshot canônico e imutável da admissão.
 */
export function claimAdmissionForAttempt(params: ClaimAdmissionParams): DispatchAdmission {
  const {
    admissionId,
    attemptId,
    currentMaterialContextId,
    effectiveOperation,
    effectiveResourceTarget,
  } = params;

  if (!admissionId) {
    throw new Error('[L0 Admission Runtime] admissionId is required to claim DispatchAdmission.');
  }
  if (!attemptId) {
    throw new Error('[L0 Admission Runtime] attemptId is required to claim DispatchAdmission.');
  }

  const entry = internalStore.get(admissionId);
  if (!entry) {
    throw new DispatchAdmissionNotFoundError(admissionId);
  }

  if (entry.consumed) {
    throw new DispatchAdmissionAlreadyConsumedError(admissionId, entry.consumedByAttemptId);
  }

  // 1. Validação de Contexto Material (NÃO consome em caso de falha)
  if (entry.admission.materialContextId !== currentMaterialContextId) {
    throw new Error(
      `[L0 Admission] DispatchAdmission material context mismatch: admission was issued for '${entry.admission.materialContextId}', but current context is '${currentMaterialContextId}'. Re-evaluation is required.`,
    );
  }

  // 2. Validação de Operação Efetiva (NÃO consome em caso de falha)
  if (entry.admission.authorizationScope?.operation) {
    if (!effectiveOperation || effectiveOperation !== entry.admission.authorizationScope.operation) {
      throw new Error(
        `[L0 Admission] Operation mismatch: admission was authorized for operation '${entry.admission.authorizationScope.operation}', but attempt requested '${effectiveOperation ?? 'none'}'.`,
      );
    }
  }

  // 3. Validação de ResourceTarget Efetivo (NÃO consome em caso de falha)
  if (entry.admission.authorizationScope?.resourceTarget !== undefined) {
    if (effectiveResourceTarget !== entry.admission.authorizationScope.resourceTarget) {
      throw new Error(
        `[L0 Admission] ResourceTarget mismatch: admission was authorized for resourceTarget '${entry.admission.authorizationScope.resourceTarget}', but attempt requested '${effectiveResourceTarget ?? 'none'}'.`,
      );
    }
  }

  // 4. Somente após todos os checks passarem: claim atômico e síncrono
  entry.consumed = true;
  entry.consumedByAttemptId = attemptId;

  return entry.admission;
}

/**
 * Helper estritamente de teste para isolamento de suítes de teste.
 * NÃO exportado no barrel público (src/core/evaluation/index.ts).
 */
export function __resetAdmissionRuntimeForTestsOnly(): void {
  internalStore.clear();
}
