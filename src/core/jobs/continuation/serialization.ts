/**
 * NEX+ · Continuation Checkpoint Serialization & Trust Boundary
 * Mappers Defensivos e Sanitização — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-4A)
 *
 * Princípios Fundamentais:
 * 1. Allowlist estrita na escrita: seleciona exclusivamente campos canônicos, descartando extras/segredos.
 * 2. Leitura fail-closed: tudo do banco é untrusted; corrupções disparam CorruptedJobCheckpointStorageError.
 * 3. Validação defensiva de enums, discriminants e timestamps UTC canônicos.
 * 4. Imutabilidade profunda (Object.freeze) nos objetos reconstruídos.
 */

import type { DomainEffect } from '../../capabilities/contracts';
import { isCanonicalUtcInstant } from '../../context/invariants';
import type { ContinuationDirective } from '../../evaluation/contracts';
import { assertCanonicalJobCheckpoint, computeEffectiveDomainMutating } from './invariants';
import type {
  DomainEffectBasis,
  JobCheckpoint,
  JobCheckpointId,
} from './contracts';
import { CorruptedJobCheckpointStorageError } from './errors';
import type { JobId } from '../contracts';
import type { AttemptId, OutcomeAssessmentId } from '../../execution/contracts';
import type { DecisionMaterialContextId } from '../../evaluation/contracts';
import type {
  CapabilityRevisionId,
  BindingRevisionId,
  RouteRevisionId,
} from '../../capabilities/contracts';

export interface SerializedJobCheckpointRow {
  readonly checkpoint_id: string;
  readonly job_id: string;
  readonly job_revision: number;
  readonly attempt_id: string;
  readonly outcome_assessment_id: string;
  readonly decision_material_context_id: string;
  readonly capability_revision_id: string;
  readonly capability_domain_effect: string;
  readonly binding_revision_id: string;
  readonly binding_domain_effect_attested: string;
  readonly route_revision_id: string;
  readonly route_domain_effect: string;
  readonly effective_is_domain_mutating: boolean;
  readonly continuation_directive: string;
  readonly continuation_reason_code: string;
  readonly recorded_at: string;
}

const VALID_DOMAIN_EFFECTS: ReadonlySet<string> = new Set(['none', 'may_mutate_domain']);
const VALID_CONTINUATION_DIRECTIVES: ReadonlySet<string> = new Set([
  'stop',
  'new_route_evaluation_required',
  'human_escalation_required',
]);

const REQUIRED_ROW_KEYS = [
  'checkpoint_id',
  'job_id',
  'job_revision',
  'attempt_id',
  'outcome_assessment_id',
  'decision_material_context_id',
  'capability_revision_id',
  'capability_domain_effect',
  'binding_revision_id',
  'binding_domain_effect_attested',
  'route_revision_id',
  'route_domain_effect',
  'effective_is_domain_mutating',
  'continuation_directive',
  'continuation_reason_code',
  'recorded_at',
] as const;

const ALLOWED_ROW_KEYS: ReadonlySet<string> = new Set([
  ...REQUIRED_ROW_KEYS,
  'append_sequence',
]);

export function parseStrictJobRevision(val: unknown, checkpointId?: string): number {
  if (typeof val === 'number') {
    if (Number.isSafeInteger(val) && val >= 1) {
      return val;
    }
    throw new CorruptedJobCheckpointStorageError(
      `Field 'job_revision' must be a safe integer >= 1, received '${val}'.`,
      checkpointId,
    );
  }

  if (typeof val === 'string') {
    if (!/^[1-9]\d*$/.test(val)) {
      throw new CorruptedJobCheckpointStorageError(
        `Field 'job_revision' contains invalid string representation: '${val}'.`,
        checkpointId,
      );
    }
    const parsed = Number(val);
    if (Number.isSafeInteger(parsed) && parsed >= 1) {
      return parsed;
    }
  }

  throw new CorruptedJobCheckpointStorageError(
    `Field 'job_revision' must be a safe integer >= 1 or strict decimal string, received '${String(val)}'.`,
    checkpointId,
  );
}

/**
 * Serializa um JobCheckpoint para persistência via allowlist estrita.
 * Descarta propriedades extras, prototypes e dados não autorizados.
 */
export function serializeJobCheckpoint(checkpoint: JobCheckpoint): SerializedJobCheckpointRow {
  return {
    checkpoint_id: checkpoint.checkpointId,
    job_id: checkpoint.jobId,
    job_revision: checkpoint.jobRevision,
    attempt_id: checkpoint.attemptId,
    outcome_assessment_id: checkpoint.outcomeAssessmentId,
    decision_material_context_id: checkpoint.decisionMaterialContextId,
    capability_revision_id: checkpoint.domainEffectBasis.capabilityRevisionId,
    capability_domain_effect: checkpoint.domainEffectBasis.capabilityDomainEffect,
    binding_revision_id: checkpoint.domainEffectBasis.bindingRevisionId,
    binding_domain_effect_attested: checkpoint.domainEffectBasis.bindingDomainEffectAttested,
    route_revision_id: checkpoint.domainEffectBasis.routeRevisionId,
    route_domain_effect: checkpoint.domainEffectBasis.routeDomainEffect,
    effective_is_domain_mutating: checkpoint.domainEffectBasis.effectiveIsDomainMutating,
    continuation_directive: checkpoint.continuationDirective,
    continuation_reason_code: checkpoint.continuationReasonCode,
    recorded_at: checkpoint.recordedAt,
  };
}

/**
 * Converte data/timestamp vindo do driver PostgreSQL para string ISO 8601 UTC canônica normalizada (.SSSZ).
 */
function parseDbTimestampUtc(val: unknown, fieldName: string, checkpointId?: string): string {
  if (val instanceof Date) {
    if (isNaN(val.getTime())) {
      throw new CorruptedJobCheckpointStorageError(
        `Field '${fieldName}' contains invalid Date object.`,
        checkpointId,
      );
    }
    return val.toISOString();
  }

  if (typeof val === 'string' && val.trim().length > 0) {
    if (!isCanonicalUtcInstant(val)) {
      // Tentar conversão se for formato Postgres com espaço "YYYY-MM-DD HH:MM:SS.mmm+00"
      const parsedDate = new Date(val);
      if (!isNaN(parsedDate.getTime())) {
        const iso = parsedDate.toISOString();
        if (isCanonicalUtcInstant(iso)) {
          return iso;
        }
      }
      throw new CorruptedJobCheckpointStorageError(
        `Field '${fieldName}' contains non-canonical timestamp string: '${val}'.`,
        checkpointId,
      );
    }
    return new Date(val).toISOString();
  }

  throw new CorruptedJobCheckpointStorageError(
    `Field '${fieldName}' must be a valid timestamp, received: '${String(val)}'.`,
    checkpointId,
  );
}

/**
 * Desserializa defensivamente uma linha do PostgreSQL para JobCheckpoint.
 * Aplica fail-closed estrito contra corrupções ou dados adulterados.
 */
export function mapRowToJobCheckpoint(row: unknown): JobCheckpoint {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new CorruptedJobCheckpointStorageError('Row must be a non-null object.');
  }

  const r = row as Record<string, unknown>;

  // Checagem de propriedades próprias obrigatórias
  for (const key of REQUIRED_ROW_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(r, key)) {
      throw new CorruptedJobCheckpointStorageError(
        `Missing required own property '${key}' in checkpoint row.`,
        typeof r.checkpoint_id === 'string' ? r.checkpoint_id : undefined,
      );
    }
  }

  // Rejeição de propriedades próprias inesperadas
  for (const key of Object.keys(r)) {
    if (!ALLOWED_ROW_KEYS.has(key)) {
      throw new CorruptedJobCheckpointStorageError(
        `Unexpected own property '${key}' in checkpoint row.`,
        typeof r.checkpoint_id === 'string' ? r.checkpoint_id : undefined,
      );
    }
  }

  const checkpointId = r.checkpoint_id;
  if (typeof checkpointId !== 'string' || checkpointId.trim().length === 0) {
    throw new CorruptedJobCheckpointStorageError("Field 'checkpoint_id' must be a non-empty string.");
  }

  const jobId = r.job_id;
  if (typeof jobId !== 'string' || jobId.trim().length === 0) {
    throw new CorruptedJobCheckpointStorageError("Field 'job_id' must be a non-empty string.", checkpointId);
  }

  const jobRevision = parseStrictJobRevision(r.job_revision, checkpointId);

  const attemptId = r.attempt_id;
  if (typeof attemptId !== 'string' || attemptId.trim().length === 0) {
    throw new CorruptedJobCheckpointStorageError("Field 'attempt_id' must be a non-empty string.", checkpointId);
  }

  const outcomeAssessmentId = r.outcome_assessment_id;
  if (typeof outcomeAssessmentId !== 'string' || outcomeAssessmentId.trim().length === 0) {
    throw new CorruptedJobCheckpointStorageError(
      "Field 'outcome_assessment_id' must be a non-empty string.",
      checkpointId,
    );
  }

  const decisionMaterialContextId = r.decision_material_context_id;
  if (typeof decisionMaterialContextId !== 'string' || decisionMaterialContextId.trim().length === 0) {
    throw new CorruptedJobCheckpointStorageError(
      "Field 'decision_material_context_id' must be a non-empty string.",
      checkpointId,
    );
  }

  const capabilityRevisionId = r.capability_revision_id;
  if (typeof capabilityRevisionId !== 'string' || capabilityRevisionId.trim().length === 0) {
    throw new CorruptedJobCheckpointStorageError(
      "Field 'capability_revision_id' must be a non-empty string.",
      checkpointId,
    );
  }

  const capabilityDomainEffect = r.capability_domain_effect;
  if (typeof capabilityDomainEffect !== 'string' || !VALID_DOMAIN_EFFECTS.has(capabilityDomainEffect)) {
    throw new CorruptedJobCheckpointStorageError(
      `Field 'capability_domain_effect' contains invalid domainEffect '${String(capabilityDomainEffect)}'.`,
      checkpointId,
    );
  }

  const bindingRevisionId = r.binding_revision_id;
  if (typeof bindingRevisionId !== 'string' || bindingRevisionId.trim().length === 0) {
    throw new CorruptedJobCheckpointStorageError(
      "Field 'binding_revision_id' must be a non-empty string.",
      checkpointId,
    );
  }

  const bindingDomainEffectAttested = r.binding_domain_effect_attested;
  if (typeof bindingDomainEffectAttested !== 'string' || !VALID_DOMAIN_EFFECTS.has(bindingDomainEffectAttested)) {
    throw new CorruptedJobCheckpointStorageError(
      `Field 'binding_domain_effect_attested' contains invalid domainEffect '${String(bindingDomainEffectAttested)}'.`,
      checkpointId,
    );
  }

  const routeRevisionId = r.route_revision_id;
  if (typeof routeRevisionId !== 'string' || routeRevisionId.trim().length === 0) {
    throw new CorruptedJobCheckpointStorageError(
      "Field 'route_revision_id' must be a non-empty string.",
      checkpointId,
    );
  }

  const routeDomainEffect = r.route_domain_effect;
  if (typeof routeDomainEffect !== 'string' || !VALID_DOMAIN_EFFECTS.has(routeDomainEffect)) {
    throw new CorruptedJobCheckpointStorageError(
      `Field 'route_domain_effect' contains invalid domainEffect '${String(routeDomainEffect)}'.`,
      checkpointId,
    );
  }

  const effectiveIsDomainMutating = r.effective_is_domain_mutating;
  if (typeof effectiveIsDomainMutating !== 'boolean') {
    throw new CorruptedJobCheckpointStorageError(
      `Field 'effective_is_domain_mutating' must be a boolean, received '${String(effectiveIsDomainMutating)}'.`,
      checkpointId,
    );
  }

  // Cross-check da base factual de DomainEffect
  const expectedMutating = computeEffectiveDomainMutating({
    capabilityDomainEffect: capabilityDomainEffect as DomainEffect,
    bindingDomainEffectAttested: bindingDomainEffectAttested as DomainEffect,
    routeDomainEffect: routeDomainEffect as DomainEffect,
  });
  if (expectedMutating !== effectiveIsDomainMutating) {
    throw new CorruptedJobCheckpointStorageError(
      `effective_is_domain_mutating '${effectiveIsDomainMutating}' does not match computed value '${expectedMutating}' from domainEffect components.`,
      checkpointId,
    );
  }

  const continuationDirective = r.continuation_directive;
  if (typeof continuationDirective !== 'string' || !VALID_CONTINUATION_DIRECTIVES.has(continuationDirective)) {
    throw new CorruptedJobCheckpointStorageError(
      `Field 'continuation_directive' contains invalid directive '${String(continuationDirective)}'.`,
      checkpointId,
    );
  }

  const continuationReasonCode = r.continuation_reason_code;
  if (typeof continuationReasonCode !== 'string' || continuationReasonCode.trim().length === 0) {
    throw new CorruptedJobCheckpointStorageError(
      "Field 'continuation_reason_code' must be a non-empty string.",
      checkpointId,
    );
  }

  const recordedAt = parseDbTimestampUtc(r.recorded_at, 'recorded_at', checkpointId);

  const domainEffectBasis: DomainEffectBasis = Object.freeze({
    capabilityRevisionId: capabilityRevisionId as CapabilityRevisionId,
    capabilityDomainEffect: capabilityDomainEffect as DomainEffect,
    bindingRevisionId: bindingRevisionId as BindingRevisionId,
    bindingDomainEffectAttested: bindingDomainEffectAttested as DomainEffect,
    routeRevisionId: routeRevisionId as RouteRevisionId,
    routeDomainEffect: routeDomainEffect as DomainEffect,
    effectiveIsDomainMutating,
  });

  return Object.freeze({
    checkpointId: checkpointId as JobCheckpointId,
    jobId: jobId as JobId,
    jobRevision,
    attemptId: attemptId as AttemptId,
    outcomeAssessmentId: outcomeAssessmentId as OutcomeAssessmentId,
    decisionMaterialContextId: decisionMaterialContextId as DecisionMaterialContextId,
    domainEffectBasis,
    continuationDirective: continuationDirective as ContinuationDirective,
    continuationReasonCode,
    recordedAt,
  });
}
