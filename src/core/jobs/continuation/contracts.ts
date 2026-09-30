/**
 * NEX+ · Continuation Checkpoint Contracts
 * Contratos Canônicos — Escopo 0.86 (Bloco 0.86C · Checkpoint 0.86C-4A)
 *
 * Princípios Fundamentais:
 * 1. Checkpoint durável representa o desfecho formal e imutável de uma tentativa (Attempt) associada a um Job.
 * 2. Autocontido: preserva a DomainEffectBasis para garantir Safe Resume sem reconsultar registries voláteis.
 * 3. Determinismo estrito: diretiva e reasonCode são materializados a partir da avaliação canônica de continuação.
 * 4. Não terminaliza o Job: a diretiva 'stop' apenas indica que nenhum novo Attempt automático deve nascer daquele desfecho.
 * 5. Append-only no banco de dados e imutável em memória.
 */

import type {
  CapabilityRevisionId,
  BindingRevisionId,
  RouteRevisionId,
  DomainEffect,
} from '../../capabilities/contracts';

import type {
  ContinuationDirective,
  DecisionMaterialContextId,
} from '../../evaluation/contracts';

import type {
  AttemptId,
  OutcomeAssessmentId,
  AttemptState,
  OutcomeAssessment,
} from '../../execution/contracts';

import type {
  JobId,
  JobState,
} from '../contracts';

// ============================================================================
// 1. IDENTIFICADORES BRANDED
// ============================================================================

export type JobCheckpointId = string & { readonly __brand?: 'JobCheckpointId' };

// ============================================================================
// 2. DOMAIN EFFECT BASIS (Base Factual Autocontida para Safe Resume)
// ============================================================================

export interface DomainEffectBasis {
  readonly capabilityRevisionId: CapabilityRevisionId;
  readonly capabilityDomainEffect: DomainEffect;
  readonly bindingRevisionId: BindingRevisionId;
  readonly bindingDomainEffectAttested: DomainEffect;
  readonly routeRevisionId: RouteRevisionId;
  readonly routeDomainEffect: DomainEffect;
  readonly effectiveIsDomainMutating: boolean;
}

// ============================================================================
// 3. JOB CHECKPOINT (Estrutura Durável)
// ============================================================================

export interface JobCheckpoint {
  readonly checkpointId: JobCheckpointId;
  readonly jobId: JobId;
  readonly jobRevision: number;
  readonly attemptId: AttemptId;
  readonly outcomeAssessmentId: OutcomeAssessmentId;
  readonly decisionMaterialContextId: DecisionMaterialContextId;
  readonly domainEffectBasis: DomainEffectBasis;
  readonly continuationDirective: ContinuationDirective;
  readonly continuationReasonCode: string;
  readonly recordedAt: string; // ISO 8601 UTC
}

// ============================================================================
// 4. PARÂMETROS DE CRIAÇÃO E VALIDAÇÃO
// ============================================================================

export interface CreateJobCheckpointParams {
  readonly checkpointId: JobCheckpointId;
  readonly job: JobState;
  readonly jobRevision: number;
  readonly attempt: AttemptState;
  readonly outcomeAssessment: OutcomeAssessment;
  readonly decisionMaterialContextId: DecisionMaterialContextId;
  readonly capabilityRevisionId: CapabilityRevisionId;
  readonly capabilityDomainEffect: DomainEffect;
  readonly bindingRevisionId: BindingRevisionId;
  readonly bindingDomainEffectAttested: DomainEffect;
  readonly routeRevisionId: RouteRevisionId;
  readonly routeDomainEffect: DomainEffect;
  readonly recordedAt: string; // ISO 8601 UTC
}

export interface ValidateJobCheckpointParams {
  readonly checkpoint: JobCheckpoint;
  readonly job: JobState;
  readonly attempt: AttemptState;
  readonly latestOutcomeAssessment: OutcomeAssessment;
}

// ============================================================================
// 5. PORTA DE PERSISTÊNCIA
// ============================================================================

export interface JobCheckpointStore {
  appendCheckpoint(checkpoint: JobCheckpoint): Promise<void>;
  getCheckpoint(checkpointId: JobCheckpointId): Promise<JobCheckpoint | undefined>;
  listCheckpointsByJob(jobId: JobId): Promise<readonly JobCheckpoint[]>;
}

export interface JobCheckpointPgQueryResult<T = unknown> {
  readonly rows: T[];
  readonly rowCount: number | null;
}

export interface JobCheckpointPgExecutor {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<JobCheckpointPgQueryResult<T>>;
}
