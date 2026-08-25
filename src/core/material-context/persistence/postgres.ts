/**
 * NEX+ · PostgreSQL Adapter para Material Context Pin
 * Escopo 0.86 (Bloco 0.86B · Checkpoint 0.86B-4)
 *
 * Implementação de persistência relacional append-only para MaterialContextPin
 * e MaterialContextItem[] ordenados por position.
 */

import type { SessionRef } from '../../../auth/session-ref.types';
import type {
  Actor,
  ObservationRecordId,
  CanonicalProjectionRevisionId,
  EvidenceArtifactRefId,
  ContextualPrecedentRefId,
} from '../../observations/contracts';
import type {
  ContextSubjectRef,
  FlowRef,
  ContextAspectRef,
  ContextAnchorRef,
  OperationalChannel,
} from '../../context/contracts';
import type {
  CorrelationId,
  ResourceRef,
  JsonValue,
} from '../../modules/contracts';
import type { InputRecordId } from '../../input/contracts';
import type {
  MaterialContextPinId,
  MaterialContextItem,
  MaterialContextPin,
  MaterialInputRef,
  MaterialObservationRef,
  MaterialCanonicalProjectionRef,
  MaterialEvidenceRef,
  MaterialPrecedentRef,
  MaterialResourceRef,
  MaterialAspectSnapshot,
} from '../contracts';
import {
  validateMaterialContextPin,
  sanitizeJsonMaterialValue,
} from '../invariants';
import {
  MaterialContextInvariantViolationError,
} from '../errors';
import type { MaterialContextStore } from './contracts';

export interface PgQueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface PgExecutor {
  query<T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
}

export interface PgTransactionalExecutor extends PgExecutor {
  connect?(): Promise<{
    query<T = any>(sql: string, params?: unknown[]): Promise<PgQueryResult<T>>;
    release(): void;
  }>;
}

function formatPgTimestampToUtcInstant(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString();
  }
  if (typeof val === 'string') {
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  throw new MaterialContextInvariantViolationError(
    'INVALID_TIMESTAMP',
    `Cannot convert database timestamp value '${String(val)}' to canonical UTC instant ending with Z.`
  );
}

// ============================================================================
// 1. MAPPER: ITEM ROW -> MATERIAL CONTEXT ITEM
// ============================================================================

export function mapRowToMaterialContextItem(row: any): MaterialContextItem {
  if (!row || typeof row !== 'object') {
    throw new MaterialContextInvariantViolationError(
      'INVALID_ITEM_ROW',
      'Database returned null or invalid row for MaterialContextItem.'
    );
  }

  switch (row.kind) {
    case 'input_ref': {
      if (!row.input_id) {
        throw new MaterialContextInvariantViolationError(
          'CORRUPTED_ITEM_ROW',
          'Database item row with kind=input_ref is missing input_id.'
        );
      }
      return Object.freeze<MaterialInputRef>({
        kind: 'input_ref',
        inputId: row.input_id as InputRecordId,
      });
    }

    case 'observation_ref': {
      if (!row.observation_id) {
        throw new MaterialContextInvariantViolationError(
          'CORRUPTED_ITEM_ROW',
          'Database item row with kind=observation_ref is missing observation_id.'
        );
      }
      return Object.freeze<MaterialObservationRef>({
        kind: 'observation_ref',
        observationId: row.observation_id as ObservationRecordId,
      });
    }

    case 'canonical_projection_ref': {
      if (!row.projection_revision_id) {
        throw new MaterialContextInvariantViolationError(
          'CORRUPTED_ITEM_ROW',
          'Database item row with kind=canonical_projection_ref is missing projection_revision_id.'
        );
      }
      return Object.freeze<MaterialCanonicalProjectionRef>({
        kind: 'canonical_projection_ref',
        projectionRevisionId: row.projection_revision_id as CanonicalProjectionRevisionId,
      });
    }

    case 'evidence_ref': {
      if (!row.evidence_artifact_id) {
        throw new MaterialContextInvariantViolationError(
          'CORRUPTED_ITEM_ROW',
          'Database item row with kind=evidence_ref is missing evidence_artifact_id.'
        );
      }
      return Object.freeze<MaterialEvidenceRef>({
        kind: 'evidence_ref',
        evidenceArtifactId: row.evidence_artifact_id as EvidenceArtifactRefId,
      });
    }

    case 'precedent_ref': {
      if (!row.precedent_id) {
        throw new MaterialContextInvariantViolationError(
          'CORRUPTED_ITEM_ROW',
          'Database item row with kind=precedent_ref is missing precedent_id.'
        );
      }
      return Object.freeze<MaterialPrecedentRef>({
        kind: 'precedent_ref',
        precedentId: row.precedent_id as ContextualPrecedentRefId,
      });
    }

    case 'resource_ref': {
      if (!row.resource_module_key || !row.resource_type || !row.resource_id) {
        throw new MaterialContextInvariantViolationError(
          'CORRUPTED_ITEM_ROW',
          'Database item row with kind=resource_ref is missing resource triple columns.'
        );
      }
      const resource: ResourceRef = Object.freeze({
        ownerModule: Object.freeze({ moduleKey: row.resource_module_key }),
        resourceType: row.resource_type,
        resourceId: row.resource_id,
      });
      return Object.freeze<MaterialResourceRef>({
        kind: 'resource_ref',
        resource,
      });
    }

    case 'aspect_snapshot': {
      if (!row.aspect_target_kind || !row.aspect_key) {
        throw new MaterialContextInvariantViolationError(
          'CORRUPTED_ITEM_ROW',
          'Database item row with kind=aspect_snapshot is missing aspect metadata.'
        );
      }

      let target: ContextAnchorRef;
      if (row.aspect_target_kind === 'resource') {
        if (!row.aspect_target_module_key || !row.aspect_target_resource_type || !row.aspect_target_resource_id) {
          throw new MaterialContextInvariantViolationError(
            'CORRUPTED_ITEM_ROW',
            'Database aspect_snapshot row with target_kind=resource is missing target resource triple.'
          );
        }
        target = Object.freeze({
          kind: 'resource',
          resource: Object.freeze({
            ownerModule: Object.freeze({ moduleKey: row.aspect_target_module_key }),
            resourceType: row.aspect_target_resource_type,
            resourceId: row.aspect_target_resource_id,
          }),
        });
      } else if (row.aspect_target_kind === 'scope') {
        if (!row.aspect_target_module_key || !row.aspect_target_scope_type || !row.aspect_target_scope_id) {
          throw new MaterialContextInvariantViolationError(
            'CORRUPTED_ITEM_ROW',
            'Database aspect_snapshot row with target_kind=scope is missing target scope triple.'
          );
        }
        target = Object.freeze({
          kind: 'scope',
          scope: Object.freeze({
            module: Object.freeze({ moduleKey: row.aspect_target_module_key }),
            scopeType: row.aspect_target_scope_type,
            scopeId: row.aspect_target_scope_id,
          }),
        });
      } else {
        throw new MaterialContextInvariantViolationError(
          'CORRUPTED_ITEM_ROW',
          `Database aspect_snapshot row has unrecognized aspect_target_kind '${row.aspect_target_kind}'.`
        );
      }

      const aspect: ContextAspectRef = Object.freeze({
        target,
        aspectKey: row.aspect_key,
      });

      const value: JsonValue = sanitizeJsonMaterialValue(row.snapshot_value);

      return Object.freeze<MaterialAspectSnapshot>({
        kind: 'aspect_snapshot',
        aspect,
        value,
      });
    }

    default:
      throw new MaterialContextInvariantViolationError(
        'CORRUPTED_ITEM_ROW',
        `Database item row has unsupported kind '${String(row.kind)}'.`
      );
  }
}

// ============================================================================
// 2. MAPPER: PIN HEADER ROW + ITEM ROWS -> MATERIAL CONTEXT PIN
// ============================================================================

export function mapRowsToMaterialContextPin(headerRow: any, itemRows: any[]): MaterialContextPin {
  if (!headerRow || typeof headerRow !== 'object') {
    throw new MaterialContextInvariantViolationError(
      'INVALID_PIN_ROW',
      'Database returned null or invalid row for MaterialContextPin.'
    );
  }

  let actor: Actor;
  if (typeof headerRow.actor_payload === 'string') {
    actor = JSON.parse(headerRow.actor_payload);
  } else {
    actor = headerRow.actor_payload;
  }

  let contextSubjectRef: ContextSubjectRef | undefined;
  if (headerRow.subject_type && headerRow.subject_id) {
    contextSubjectRef = Object.freeze({
      subjectType: headerRow.subject_type,
      subjectId: headerRow.subject_id,
    });
  }

  let flowRef: FlowRef | undefined;
  if (headerRow.flow_type && headerRow.flow_id) {
    flowRef = Object.freeze({
      flowType: headerRow.flow_type,
      flowId: headerRow.flow_id,
    });
  }

  const items = itemRows.map(mapRowToMaterialContextItem);

  const pin: MaterialContextPin = Object.freeze({
    pinId: headerRow.pin_id as MaterialContextPinId,
    actor: Object.freeze(actor),
    ...(headerRow.user_id ? { userId: headerRow.user_id } : {}),
    ...(headerRow.session_ref ? { sessionRef: headerRow.session_ref as SessionRef } : {}),
    ...(contextSubjectRef ? { contextSubjectRef } : {}),
    ...(flowRef ? { flowRef } : {}),
    ...(headerRow.correlation_id ? { correlationId: headerRow.correlation_id as CorrelationId } : {}),
    ...(headerRow.channel ? { channel: headerRow.channel as OperationalChannel } : {}),
    pinnedAt: formatPgTimestampToUtcInstant(headerRow.pinned_at),
    items: Object.freeze(items),
  });

  validateMaterialContextPin(pin);
  return pin;
}

// ============================================================================
// 3. POSTGRES STORE IMPLEMENTATION
// ============================================================================

export class PostgresMaterialContextStore implements MaterialContextStore {
  constructor(private readonly executor: PgTransactionalExecutor) {}

  async savePin(pin: MaterialContextPin): Promise<MaterialContextPin> {
    validateMaterialContextPin(pin);

    // Usa conexão dedicada para transação se disponível
    const client = typeof this.executor.connect === 'function'
      ? await this.executor.connect()
      : null;
    const runner: PgExecutor = client ?? this.executor;

    try {
      await runner.query('BEGIN');

      // 1. Inserir Header
      const headerSql = `
        INSERT INTO "nex_material_context_pins" (
          "pin_id",
          "actor_kind",
          "actor_payload",
          "user_id",
          "session_ref",
          "subject_type",
          "subject_id",
          "flow_type",
          "flow_id",
          "correlation_id",
          "channel",
          "pinned_at"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `;

      const headerParams = [
        pin.pinId,
        pin.actor.kind,
        JSON.stringify(pin.actor),
        pin.userId ?? null,
        pin.sessionRef ?? null,
        pin.contextSubjectRef?.subjectType ?? null,
        pin.contextSubjectRef?.subjectId ?? null,
        pin.flowRef?.flowType ?? null,
        pin.flowRef?.flowId ?? null,
        pin.correlationId ?? null,
        pin.channel ?? null,
        pin.pinnedAt,
      ];

      await runner.query(headerSql, headerParams);

      // 2. Inserir Items
      const itemSql = `
        INSERT INTO "nex_material_context_items" (
          "pin_id",
          "position",
          "kind",
          "input_id",
          "observation_id",
          "projection_revision_id",
          "evidence_artifact_id",
          "precedent_id",
          "resource_module_key",
          "resource_type",
          "resource_id",
          "aspect_target_kind",
          "aspect_target_module_key",
          "aspect_target_resource_type",
          "aspect_target_resource_id",
          "aspect_target_scope_type",
          "aspect_target_scope_id",
          "aspect_key",
          "snapshot_value"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      `;

      for (let i = 0; i < pin.items.length; i++) {
        const item = pin.items[i];
        let inputId: string | null = null;
        let observationId: string | null = null;
        let projectionRevisionId: string | null = null;
        let evidenceArtifactId: string | null = null;
        let precedentId: string | null = null;
        let resourceModuleKey: string | null = null;
        let resourceType: string | null = null;
        let resourceId: string | null = null;
        let aspectTargetKind: string | null = null;
        let aspectTargetModuleKey: string | null = null;
        let aspectTargetResourceType: string | null = null;
        let aspectTargetResourceId: string | null = null;
        let aspectTargetScopeType: string | null = null;
        let aspectTargetScopeId: string | null = null;
        let aspectKey: string | null = null;
        let snapshotValue: string | null = null;

        switch (item.kind) {
          case 'input_ref':
            inputId = item.inputId;
            break;
          case 'observation_ref':
            observationId = item.observationId;
            break;
          case 'canonical_projection_ref':
            projectionRevisionId = item.projectionRevisionId;
            break;
          case 'evidence_ref':
            evidenceArtifactId = item.evidenceArtifactId;
            break;
          case 'precedent_ref':
            precedentId = item.precedentId;
            break;
          case 'resource_ref':
            resourceModuleKey = item.resource.ownerModule.moduleKey;
            resourceType = item.resource.resourceType;
            resourceId = item.resource.resourceId;
            break;
          case 'aspect_snapshot':
            if (item.aspect.target.kind === 'resource') {
              aspectTargetKind = 'resource';
              aspectTargetModuleKey = item.aspect.target.resource.ownerModule.moduleKey;
              aspectTargetResourceType = item.aspect.target.resource.resourceType;
              aspectTargetResourceId = item.aspect.target.resource.resourceId;
            } else {
              aspectTargetKind = 'scope';
              aspectTargetModuleKey = item.aspect.target.scope.module.moduleKey;
              aspectTargetScopeType = item.aspect.target.scope.scopeType;
              aspectTargetScopeId = item.aspect.target.scope.scopeId;
            }
            aspectKey = item.aspect.aspectKey;
            snapshotValue = JSON.stringify(item.value);
            break;
        }

        const itemParams = [
          pin.pinId,
          i,
          item.kind,
          inputId,
          observationId,
          projectionRevisionId,
          evidenceArtifactId,
          precedentId,
          resourceModuleKey,
          resourceType,
          resourceId,
          aspectTargetKind,
          aspectTargetModuleKey,
          aspectTargetResourceType,
          aspectTargetResourceId,
          aspectTargetScopeType,
          aspectTargetScopeId,
          aspectKey,
          snapshotValue,
        ];

        await runner.query(itemSql, itemParams);
      }

      await runner.query('COMMIT');
      return pin;
    } catch (err) {
      try {
        await runner.query('ROLLBACK');
      } catch {
        // ignora erro no rollback
      }
      throw err;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  async getPin(pinId: MaterialContextPinId): Promise<MaterialContextPin | null> {
    const headerResult = await this.executor.query(
      `SELECT * FROM "nex_material_context_pins" WHERE "pin_id" = $1`,
      [pinId]
    );

    if (headerResult.rows.length === 0) {
      return null;
    }

    const itemsResult = await this.executor.query(
      `SELECT * FROM "nex_material_context_items" WHERE "pin_id" = $1 ORDER BY "position" ASC`,
      [pinId]
    );

    return mapRowsToMaterialContextPin(headerResult.rows[0], itemsResult.rows);
  }

  async hasPin(pinId: MaterialContextPinId): Promise<boolean> {
    const res = await this.executor.query(
      `SELECT 1 FROM "nex_material_context_pins" WHERE "pin_id" = $1 LIMIT 1`,
      [pinId]
    );
    return res.rows.length > 0;
  }
}
