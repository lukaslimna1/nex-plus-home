/**
 * NEX+ · Resource Governor & Local Runtime Lifecycle
 * Contratos Canônicos TypeScript — Escopo 0.6
 *
 * Plano de Autoridade e Governança Local de Recursos.
 * Suporta Telemetria de Sistema, Telemetria NVIDIA GPU, Observabilidade Ollama,
 * Ciclo de Vida Local, Perfis de Recursos, Leases de Workload e Decisão Soberana.
 */

import type { DecisionId, RouteEvaluationId } from '../execution/contracts';
import type { RouteRevisionId } from '../capabilities/contracts';
import type { DecisionMaterialContextId } from '../evaluation/contracts';

// ============================================================================
// 1. BRANDED ALIASES / IDENTIFICADORES OPACOS
// ============================================================================

export type ResourceSnapshotId = string & { readonly __brand?: 'ResourceSnapshotId' };
export type ResourceProfileKey = string & { readonly __brand?: 'ResourceProfileKey' };
export type ResourceProfileRevisionId = string & { readonly __brand?: 'ResourceProfileRevisionId' };
export type ResourceRequestId = string & { readonly __brand?: 'ResourceRequestId' };
export type ResourceLeaseId = string & { readonly __brand?: 'ResourceLeaseId' };
export type ResourceAdmissionId = string & { readonly __brand?: 'ResourceAdmissionId' };

// ============================================================================
// 2. SYSTEM TELEMETRY (node:os)
// ============================================================================

export type TelemetryStatus = 'available' | 'unavailable' | 'error';

export interface CpuTimes {
  readonly user: number;
  readonly nice: number;
  readonly sys: number;
  readonly idle: number;
  readonly irq: number;
}

export interface CpuCoreSample {
  readonly model: string;
  readonly speed: number;
  readonly times: CpuTimes;
}

export interface SystemTelemetry {
  readonly status: TelemetryStatus;
  readonly totalRamBytes: number;
  readonly freeRamBytes: number;
  readonly usedRamBytes: number;
  readonly logicalCpuCount: number;
  readonly cpuUtilizationPercent?: number;
  readonly observedAt: string; // ISO 8601 UTC
  readonly errorDetail?: string;
}

// ============================================================================
// 3. NVIDIA GPU TELEMETRY (nvidia-smi)
// ============================================================================

export interface GpuDeviceTelemetry {
  readonly index: number;
  readonly uuid: string;
  readonly name: string;
  readonly memoryTotalBytes: number;
  readonly memoryUsedBytes: number;
  readonly memoryFreeBytes: number;
  readonly gpuUtilizationPercent: number;
  readonly memoryUtilizationPercent: number;
  readonly temperatureCelsius?: number;
}

export interface GpuTelemetry {
  readonly status: TelemetryStatus;
  readonly devices: readonly GpuDeviceTelemetry[];
  readonly observedAt: string; // ISO 8601 UTC
  readonly errorDetail?: string;
}

// ============================================================================
// 4. OLLAMA RUNTIME OBSERVATION & LIFECYCLE
// ============================================================================

export interface OllamaLoadedModelObservation {
  readonly modelName: string;
  readonly digest?: string;
  readonly sizeBytes?: number;
  readonly sizeVramBytes?: number;
  readonly contextLength?: number;
  readonly expiresAt?: string; // ISO 8601 UTC
  readonly observedAt: string; // ISO 8601 UTC
}

export interface OllamaInstalledModelObservation {
  readonly modelName: string;
  readonly digest?: string;
  readonly sizeBytes?: number;
  readonly modifiedAt?: string;
}

export interface OllamaTelemetry {
  readonly status: TelemetryStatus;
  readonly loadedModels: readonly OllamaLoadedModelObservation[];
  readonly installedModels?: readonly OllamaInstalledModelObservation[];
  readonly observedAt: string; // ISO 8601 UTC
  readonly errorDetail?: string;
}

// ============================================================================
// 5. RESOURCE SNAPSHOT (Agregação de Telemetria sem Decisão)
// ============================================================================

export interface ResourceSnapshot {
  readonly snapshotId: ResourceSnapshotId;
  readonly collectedAt: string; // ISO 8601 UTC
  readonly system: SystemTelemetry;
  readonly gpu: GpuTelemetry;
  readonly ollama: OllamaTelemetry;
}

// ============================================================================
// 6. CATÁLOGO LOCAL APROVADO (Autoridade L0 para Modelos Locais)
// ============================================================================

export interface ApprovedLocalModelRef {
  readonly modelName: string;
  readonly digest?: string;
  readonly runtime: 'ollama_local';
  readonly estimatedVramBytes?: number;
  readonly estimatedRamBytes?: number;
}

// ============================================================================
// 7. LIFECYCLE EXECUTION RESULT (Preload / Unload)
// ============================================================================

export type LifecycleExecutionStatus =
  | 'verified_loaded'
  | 'verified_unloaded'
  | 'indeterminate'
  | 'transport_failed'
  | 'rejected';

export interface LifecycleExecutionResult {
  readonly status: LifecycleExecutionStatus;
  readonly modelName: string;
  readonly reasonCode: string;
  readonly observedAt: string;
  readonly detail?: string;
}

// ============================================================================
// 8. RESOURCE PROFILE REVISION (Políticas de Recursos e Thresholds)
// ============================================================================

export interface ResourceProfileRevision {
  readonly profileKey: ResourceProfileKey;
  readonly profileRevisionId: ResourceProfileRevisionId;
  readonly minimumFreeSystemRamBytes: number;
  readonly minimumFreeVramBytes: number;
  readonly maximumCpuUtilizationPercent?: number;
  readonly maximumGpuUtilizationPercent?: number;
  readonly maximumTelemetryAgeMs: number;
  readonly allowModelPreload: boolean;
  readonly allowModelUnload: boolean;
  readonly description?: string;
}

// ============================================================================
// 9. RESOURCE REQUEST & INTENTS
// ============================================================================

export type ResourceRequestIntent =
  | 'use_current_state'
  | 'ensure_model_loaded'
  | 'ensure_model_unloaded';

export interface ResourceRequest {
  readonly requestId: ResourceRequestId;
  readonly decisionId: DecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly routeEvaluationId: RouteEvaluationId;
  readonly routeRevisionId: RouteRevisionId;
  readonly profileRevisionId: ResourceProfileRevisionId;
  readonly targetModel?: string;
  readonly targetGpuUuid?: string;
  readonly estimatedAdditionalRamBytes?: number;
  readonly estimatedAdditionalVramBytes?: number;
  readonly requiresGpu?: boolean;
  readonly intent: ResourceRequestIntent;
  readonly requestedAt: string; // ISO 8601 UTC
}

// ============================================================================
// 10. RESOURCE LEASES (Reservas e Proteções de Recursos)
// ============================================================================

export type ResourceLeaseState = 'reserved' | 'active' | 'released' | 'expired';

export interface ResourceLease {
  readonly leaseId: ResourceLeaseId;
  readonly requestId: ResourceRequestId;
  readonly decisionId: DecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly routeRevisionId: RouteRevisionId;
  readonly targetModel?: string;
  readonly targetGpuUuid?: string;
  readonly reservedRamBytes: number;
  readonly reservedVramBytes: number;
  readonly state: ResourceLeaseState;
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly releasedAt?: string;
  readonly expiresAt?: string;
}

// ============================================================================
// 11. GOVERNOR DECISION & ACTIONS
// ============================================================================

export type GovernorDisposition = 'admit' | 'action_required' | 'defer' | 'deny';

export type LifecycleActionKind = 'preload_model' | 'unload_model';

export interface RequiredLifecycleAction {
  readonly kind: LifecycleActionKind;
  readonly targetModel: string;
  readonly targetGpuUuid?: string;
  readonly reasonCode: string;
}

export interface ResourceMaterialFacts {
  readonly freeRamBytes?: number;
  readonly freeVramBytes?: number;
  readonly cpuUtilizationPercent?: number;
  readonly gpuUtilizationPercent?: number;
  readonly targetModelLoaded?: boolean;
  readonly snapshotFreshness?: 'fresh' | 'stale';
  readonly pendingReservedRamBytes?: number;
  readonly pendingReservedVramBytes?: number;
  readonly evictionCandidates?: readonly string[];
}

export interface GovernorDecision {
  readonly disposition: GovernorDisposition;
  readonly reasonCode: string;
  readonly materialFacts: ResourceMaterialFacts;
  readonly requiredAction?: RequiredLifecycleAction;
  readonly admittedLeaseId?: ResourceLeaseId;
  readonly evaluatedAt: string;
}

// ============================================================================
// 12. RESOURCE ADMISSION (Admissão Formal de Recursos de L0)
// ============================================================================

export interface ResourceAdmission {
  readonly admissionId: ResourceAdmissionId;
  readonly requestId: ResourceRequestId;
  readonly decisionId: DecisionId;
  readonly materialContextId: DecisionMaterialContextId;
  readonly routeEvaluationId: RouteEvaluationId;
  readonly routeRevisionId: RouteRevisionId;
  readonly profileRevisionId: ResourceProfileRevisionId;
  readonly resourceSnapshotId: ResourceSnapshotId;
  readonly leaseId?: ResourceLeaseId;
  readonly targetModel?: string;
  readonly targetGpuUuid?: string;
  readonly materialFacts: ResourceMaterialFacts;
  readonly admittedAt: string;
}
